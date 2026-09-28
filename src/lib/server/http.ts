import 'server-only';
import type { ZodType } from 'zod';
import type { ProviderId } from '@/lib/core/providers';
import { ProviderError, describeError } from '@/lib/net/errors';
import type { JsonFetcher, JsonRequest } from '@/lib/net/types';

export { ProviderError, isProviderError, describeError } from '@/lib/net/errors';
export type { ProviderErrorCode } from '@/lib/net/errors';

/**
 * Resilient JSON fetch used by server-side provider adapters (route handlers).
 *
 * - per-request timeout (AbortSignal), caller abort propagation
 * - bounded retries with exponential backoff + jitter for network errors / 5xx
 * - 429 handling: provider enters a cooldown (Retry-After or exponential),
 *   during which calls fail fast so composite chains can fail over
 * - per-provider request budget (sliding window) and concurrency cap so one
 *   worker can't burst through an upstream's rate limit
 * - in-flight de-duplication of identical requests
 * - optional zod schema validation (malformed payloads become ProviderError)
 * - health bookkeeping for /api/v1/health
 */

// ---------------------------------------------------------------------------
// Per-provider limits & state
// ---------------------------------------------------------------------------

interface ProviderBudget {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
  /** Max concurrent in-flight requests from this worker. */
  concurrency: number;
}

/**
 * Conservative per-worker budgets, below published limits because several
 * serverless workers share the same upstream quota. Keyed plans have higher
 * limits; these values are safe for the free tiers.
 */
const BUDGETS: Partial<Record<ProviderId, ProviderBudget>> = {
  geckoterminal: { limit: 8, windowMs: 60_000, concurrency: 2 },
  coingecko: { limit: 90, windowMs: 60_000, concurrency: 6 },
  dexscreener: { limit: 240, windowMs: 60_000, concurrency: 8 },
  jupiter: { limit: 9, windowMs: 10_000, concurrency: 4 },
  'solana-rpc': { limit: 40, windowMs: 10_000, concurrency: 6 },
  helius: { limit: 90, windowMs: 10_000, concurrency: 10 },
  birdeye: { limit: 10, windowMs: 10_000, concurrency: 4 },
  solanatracker: { limit: 25, windowMs: 10_000, concurrency: 4 },
};

interface ProviderState {
  timestamps: number[];
  active: number;
  queue: Array<() => void>;
  cooldownUntil: number;
  consecutive429: number;
  lastOkAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  okCount: number;
  errorCount: number;
}

const g = globalThis as unknown as { __orbytProviderState?: Map<ProviderId, ProviderState> };
const states: Map<ProviderId, ProviderState> = g.__orbytProviderState ?? (g.__orbytProviderState = new Map());

function state(provider: ProviderId): ProviderState {
  let s = states.get(provider);
  if (!s) {
    s = { timestamps: [], active: 0, queue: [], cooldownUntil: 0, consecutive429: 0, okCount: 0, errorCount: 0 };
    states.set(provider, s);
  }
  return s;
}

export interface ProviderHealth {
  provider: ProviderId;
  lastOkAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  coolingDownUntil?: number;
  okCount: number;
  errorCount: number;
}

export function providerHealth(): ProviderHealth[] {
  return [...states.entries()].map(([provider, s]) => ({
    provider,
    lastOkAt: s.lastOkAt,
    lastErrorAt: s.lastErrorAt,
    lastError: s.lastError,
    coolingDownUntil: s.cooldownUntil > Date.now() ? s.cooldownUntil : undefined,
    okCount: s.okCount,
    errorCount: s.errorCount,
  }));
}

export function isCoolingDown(provider: ProviderId): boolean {
  return state(provider).cooldownUntil > Date.now();
}

function markOk(provider: ProviderId) {
  const s = state(provider);
  s.lastOkAt = Date.now();
  s.okCount++;
  s.consecutive429 = 0;
}

function markError(provider: ProviderId, e: ProviderError) {
  const s = state(provider);
  s.lastErrorAt = Date.now();
  s.lastError = describeError(e);
  s.errorCount++;
}

function enterCooldown(provider: ProviderId, retryAfterMs?: number): number {
  const s = state(provider);
  s.consecutive429++;
  const backoff = Math.min(60_000, 2_000 * 2 ** (s.consecutive429 - 1));
  const wait = Math.max(retryAfterMs ?? 0, backoff);
  s.cooldownUntil = Date.now() + wait;
  return wait;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait for a slot within the provider's rate window and concurrency cap. */
async function acquire(provider: ProviderId, deadline: number): Promise<() => void> {
  const budget = BUDGETS[provider];
  const s = state(provider);
  if (!budget) {
    s.active++;
    return () => {
      s.active--;
    };
  }
  for (;;) {
    const now = Date.now();
    s.timestamps = s.timestamps.filter((t) => now - t < budget.windowMs);
    if (s.timestamps.length < budget.limit && s.active < budget.concurrency) {
      s.timestamps.push(now);
      s.active++;
      return () => {
        s.active--;
        const next = s.queue.shift();
        next?.();
      };
    }
    const oldest = s.timestamps[0] ?? now;
    const waitForWindow = s.timestamps.length >= budget.limit ? budget.windowMs - (now - oldest) + 5 : 25;
    if (now + waitForWindow > deadline) {
      throw new ProviderError(provider, 'rate_limited', `${provider}: local request budget exhausted`);
    }
    if (s.active >= budget.concurrency) {
      await new Promise<void>((resolve) => {
        s.queue.push(resolve);
        setTimeout(resolve, Math.min(waitForWindow, 1_000));
      });
    } else {
      await sleep(Math.min(waitForWindow, 1_000));
    }
  }
}

// ---------------------------------------------------------------------------
// fetchJson
// ---------------------------------------------------------------------------

export interface FetchJsonOptions<T> extends JsonRequest {
  /** Validate and narrow the payload. */
  schema?: ZodType<T>;
  /** Total time budget including rate-limit waits. Default timeoutMs * 2. */
  budgetMs?: number;
}

const inflight = new Map<string, Promise<unknown>>();

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export async function fetchJson<T = unknown>(provider: ProviderId, url: string, opts: FetchJsonOptions<T> = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  // Requests carrying a caller AbortSignal are not shared (one caller's abort must not cancel another's).
  if (opts.signal) return doFetch<T>(provider, url, method, body, opts);
  const dedupeKey = `${provider}|${method}|${url}|${body ?? ''}`;
  const existing = inflight.get(dedupeKey) as Promise<T> | undefined;
  if (existing) return existing;
  const run = doFetch<T>(provider, url, method, body, opts).finally(() => inflight.delete(dedupeKey));
  inflight.set(dedupeKey, run);
  return run;
}

async function doFetch<T>(provider: ProviderId, url: string, method: 'GET' | 'POST', body: string | undefined, opts: FetchJsonOptions<T>): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const retries = opts.retries ?? (method === 'GET' ? 1 : 0);
  const deadline = Date.now() + (opts.budgetMs ?? timeoutMs * 2);
  const label = opts.label ?? provider;

  let attempt = 0;
  for (;;) {
    const s = state(provider);
    if (s.cooldownUntil > Date.now()) {
      throw new ProviderError(provider, 'rate_limited', `${label}: cooling down after rate limit`, {
        retryAfterMs: s.cooldownUntil - Date.now(),
      });
    }

    const release = await acquire(provider, deadline);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        body,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      });
    } catch (cause) {
      release();
      if (opts.signal?.aborted) throw new ProviderError(provider, 'aborted', `${label}: aborted`, { cause });
      const timedOut = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
      const err = new ProviderError(provider, timedOut ? 'timeout' : 'network', `${label}: ${timedOut ? 'timeout' : 'network error'}`, { cause });
      if (attempt < retries && Date.now() < deadline) {
        attempt++;
        await sleep(backoffDelay(attempt));
        continue;
      }
      markError(provider, err);
      throw err;
    }
    release();

    if (res.status === 429) {
      const wait = enterCooldown(provider, parseRetryAfter(res.headers.get('retry-after')));
      const err = new ProviderError(provider, 'rate_limited', `${label}: HTTP 429`, { status: 429, retryAfterMs: wait });
      markError(provider, err);
      throw err;
    }

    if (res.status === 404 && opts.notFoundAs404 !== false) {
      // A 404 is a valid answer (unknown token), not a provider outage.
      markOk(provider);
      throw new ProviderError(provider, 'not_found', `${label}: not found`, { status: 404 });
    }

    if (!res.ok) {
      const err = new ProviderError(provider, 'http', `${label}: HTTP ${res.status}`, { status: res.status });
      if (res.status >= 500 && attempt < retries && Date.now() < deadline) {
        attempt++;
        await sleep(backoffDelay(attempt));
        continue;
      }
      markError(provider, err);
      throw err;
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (cause) {
      const err = new ProviderError(provider, 'malformed', `${label}: invalid JSON`, { cause });
      markError(provider, err);
      throw err;
    }

    if (opts.schema) {
      const parsed = opts.schema.safeParse(json);
      if (!parsed.success) {
        const err = new ProviderError(provider, 'malformed', `${label}: unexpected response shape`, { cause: parsed.error });
        markError(provider, err);
        throw err;
      }
      markOk(provider);
      return parsed.data;
    }
    markOk(provider);
    return json as T;
  }
}

function backoffDelay(attempt: number): number {
  const base = 250 * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * base);
}

/** Record an outcome for calls that don't go through fetchJson. */
export function recordProviderOutcome(provider: ProviderId, ok: boolean, message?: string) {
  if (ok) markOk(provider);
  else markError(provider, new ProviderError(provider, 'network', message ?? `${provider}: error`));
}

/** Server transport for isomorphic provider adapters. */
export const serverFetcher: JsonFetcher = (provider, url, init) => fetchJson(provider, url, init);
