import type { ProviderId } from '@/lib/core/providers';
import { ProviderError } from './errors';
import type { JsonFetcher, JsonRequest } from './types';

/**
 * Browser transport for keyless public APIs (GeckoTerminal, DEX Screener,
 * Jupiter keyless, publicnode RPC). Each visitor spends their own per-IP
 * quota, so budgets here mirror the documented per-IP limits:
 *
 * - GeckoTerminal keyless: ~10 calls/min/IP (fluctuates). Its 429 carries no
 *   CORS header, so the browser sees a TypeError: treat network errors from
 *   it as rate limiting.
 * - Jupiter keyless: 5 requests / rolling 10 s; exposes x-ratelimit-reset.
 * - DEX Screener: 300/min for pair endpoints (edge cached 30 s).
 * - publicnode Solana RPC: undocumented; keep modest.
 *
 * Features: sliding-window budgets with bounded queueing, cooldown after rate
 * limiting, in-flight de-duplication, short response cache, timeout + abort.
 */

interface Budget {
  limit: number;
  windowMs: number;
  concurrency: number;
  /** Max time a call may wait for budget before failing fast (ms). */
  maxWaitMs: number;
}

const BUDGETS: Partial<Record<ProviderId, Budget>> = {
  geckoterminal: { limit: 8, windowMs: 60_000, concurrency: 2, maxWaitMs: 4_000 },
  jupiter: { limit: 4, windowMs: 10_000, concurrency: 2, maxWaitMs: 6_000 },
  dexscreener: { limit: 200, windowMs: 60_000, concurrency: 4, maxWaitMs: 4_000 },
  'solana-rpc': { limit: 30, windowMs: 10_000, concurrency: 4, maxWaitMs: 4_000 },
};

interface State {
  stamps: number[];
  active: number;
  cooldownUntil: number;
  strikes: number;
  lastOkAt?: number;
  lastError?: string;
}

const states = new Map<ProviderId, State>();
const inflight = new Map<string, Promise<unknown>>();
const responses = new Map<string, { at: number; ttl: number; value: unknown }>();
const listeners = new Set<() => void>();

function st(p: ProviderId): State {
  let s = states.get(p);
  if (!s) states.set(p, (s = { stamps: [], active: 0, cooldownUntil: 0, strikes: 0 }));
  return s;
}

function emit() {
  listeners.forEach((l) => l());
}

/** Subscribe to browser-side provider health changes (for status UI). */
export function subscribeBrowserHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface BrowserProviderHealth {
  provider: ProviderId;
  lastOkAt?: number;
  lastError?: string;
  coolingDownUntil?: number;
}

export function browserHealth(): BrowserProviderHealth[] {
  const now = Date.now();
  return [...states.entries()].map(([provider, s]) => ({
    provider,
    lastOkAt: s.lastOkAt,
    lastError: s.lastError,
    coolingDownUntil: s.cooldownUntil > now ? s.cooldownUntil : undefined,
  }));
}

export function isBrowserCoolingDown(p: ProviderId): boolean {
  return st(p).cooldownUntil > Date.now();
}

function cooldown(p: ProviderId, untilMs?: number) {
  const s = st(p);
  s.strikes++;
  const backoff = Math.min(90_000, 5_000 * 2 ** (s.strikes - 1));
  s.cooldownUntil = Math.max(untilMs ?? 0, Date.now() + backoff);
  emit();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function acquire(p: ProviderId, signal?: AbortSignal): Promise<() => void> {
  const s = st(p);
  const b = BUDGETS[p];
  if (!b) {
    s.active++;
    return () => void s.active--;
  }
  const deadline = Date.now() + b.maxWaitMs;
  for (;;) {
    if (signal?.aborted) throw new ProviderError(p, 'aborted', `${p}: aborted`);
    const now = Date.now();
    s.stamps = s.stamps.filter((t) => now - t < b.windowMs);
    if (s.stamps.length < b.limit && s.active < b.concurrency) {
      s.stamps.push(now);
      s.active++;
      return () => void s.active--;
    }
    const wait = s.stamps.length >= b.limit ? b.windowMs - (now - (s.stamps[0] ?? now)) + 10 : 50;
    if (now + wait > deadline) throw new ProviderError(p, 'rate_limited', `${p}: request budget exhausted`);
    await sleep(Math.min(wait, 500));
  }
}

async function run<T>(p: ProviderId, url: string, init: JsonRequest): Promise<T> {
  const s = st(p);
  const label = init.label ?? p;
  if (s.cooldownUntil > Date.now()) {
    throw new ProviderError(p, 'rate_limited', `${label}: cooling down`, { retryAfterMs: s.cooldownUntil - Date.now() });
  }
  const method = init.method ?? 'GET';
  const retries = init.retries ?? (method === 'GET' ? 1 : 0);
  const timeoutMs = init.timeoutMs ?? 10_000;

  for (let attempt = 0; ; attempt++) {
    const release = await acquire(p, init.signal);
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      res = await fetch(url, {
        method,
        headers: { accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch (cause) {
      release();
      if (init.signal?.aborted) throw new ProviderError(p, 'aborted', `${label}: aborted`, { cause });
      const timedOut = cause instanceof DOMException && cause.name === 'TimeoutError';
      // GeckoTerminal's 429 lacks CORS headers and surfaces as a TypeError.
      if (!timedOut && p === 'geckoterminal') {
        cooldown(p);
        s.lastError = `${p}: rate limited or unreachable`;
        throw new ProviderError(p, 'rate_limited', `${label}: rate limited or unreachable`, { cause });
      }
      if (attempt < retries) {
        await sleep(300 * 2 ** attempt + Math.random() * 200);
        continue;
      }
      s.lastError = `${p}: ${timedOut ? 'timed out' : 'network error'}`;
      emit();
      throw new ProviderError(p, timedOut ? 'timeout' : 'network', `${label}: ${timedOut ? 'timeout' : 'network error'}`, { cause });
    }
    release();

    if (res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      cooldown(p, Number.isFinite(reset) && reset > 0 ? reset * 1000 + 250 : undefined);
      s.lastError = `${p}: rate limited`;
      throw new ProviderError(p, 'rate_limited', `${label}: HTTP 429`, { status: 429 });
    }
    if (res.status === 404 && init.notFoundAs404 !== false) {
      throw new ProviderError(p, 'not_found', `${label}: not found`, { status: 404 });
    }
    if (!res.ok) {
      if (res.status >= 500 && attempt < retries) {
        await sleep(300 * 2 ** attempt + Math.random() * 200);
        continue;
      }
      s.lastError = `${p}: HTTP ${res.status}`;
      emit();
      throw new ProviderError(p, 'http', `${label}: HTTP ${res.status}`, { status: res.status });
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (cause) {
      throw new ProviderError(p, 'malformed', `${label}: invalid JSON`, { cause });
    }
    s.strikes = 0;
    s.lastOkAt = Date.now();
    s.lastError = undefined;
    emit();
    return json as T;
  }
}

export const browserFetcher: JsonFetcher = async <T,>(provider: ProviderId, url: string, init: JsonRequest = {}): Promise<T> => {
  const key = `${provider}|${init.method ?? 'GET'}|${url}|${init.body === undefined ? '' : JSON.stringify(init.body)}`;
  if (init.cacheMs) {
    const hit = responses.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value as T;
  }
  // Calls with their own AbortSignal are not shared.
  if (!init.signal) {
    const pending = inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;
  }
  const promise = run<T>(provider, url, init).then((value) => {
    if (init.cacheMs) {
      responses.set(key, { at: Date.now(), ttl: init.cacheMs, value });
      if (responses.size > 300) responses.delete(responses.keys().next().value as string);
    }
    return value;
  });
  if (!init.signal) {
    inflight.set(key, promise);
    promise.finally(() => inflight.delete(key)).catch(() => {});
  }
  return promise;
};
