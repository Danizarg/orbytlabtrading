import 'server-only';
import type { SourceStatus } from '@/lib/core/api';
import { ChainError, type ChainAttempt } from '@/lib/core/chain';
import type { Freshness, Sourced } from '@/lib/core/types';
import { cached } from '@/lib/server/cache';
import { describeError, isProviderError } from '@/lib/server/http';
import { badRequest, buildMeta, notConfigured, ok, okSourced, upstreamFailure, type CachePolicy } from '@/lib/server/respond';
import { BadRequestError, NotConfiguredError } from './errors';

/**
 * Glue between route services and the shared response helpers: error
 * mapping, envelope sources (including stale-if-error), per-worker memory
 * caching and route-specific CDN policies.
 */

/** Route-specific CDN policies (the shared CACHE presets cover the rest). */
export const ROUTE_CACHE = {
  pulse: { sMaxAge: 5, swr: 10 },
  mint: { sMaxAge: 60, swr: 300 },
  /** Older candle pages: history before a fixed time barely changes. */
  historicCandles: { sMaxAge: 300, swr: 3_600 },
  activityFirstPage: { sMaxAge: 5, swr: 10 },
  /** Older activity pages are immutable once confirmed. */
  activityOlderPage: { sMaxAge: 300, swr: 3_600 },
  /** Confirmed transactions never change. */
  transaction: { sMaxAge: 3_600, swr: 86_400 },
} as const satisfies Record<string, CachePolicy>;

export const STALE_NOTE = 'Live providers failed just now; showing the last good response.';

const URL_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const CREDENTIAL_TEXT = /\b(api[-_]?key|apikey|access[-_]?token|token|key)=[^&\s"']+/gi;

/**
 * Defence in depth for provider error text that reaches clients or logs:
 * adapters already describe failures by code, but a non-ProviderError
 * message is passed through verbatim by describeError, so URLs (which can
 * carry keys in the query) and key=value credentials are stripped here.
 */
export function safeErrorText(text: string): string {
  return text.replace(URL_TEXT, '[url]').replace(CREDENTIAL_TEXT, '$1=***').slice(0, 160);
}

export function safeAttempts(attempts: readonly ChainAttempt[]): ChainAttempt[] {
  return attempts.map((a) => (a.error ? { ...a, error: safeErrorText(a.error) } : a));
}

/** Envelope sources for a result, mirroring okSourced (attempts first, then enrichment contributors). */
export function sourcesOf(result: Sourced<unknown> & { attempts?: ChainAttempt[] }, stale = false): SourceStatus[] {
  const sources: SourceStatus[] = result.attempts?.length
    ? result.attempts.map((a) => ({
        provider: a.provider,
        ok: a.ok,
        ...(a.error ? { error: a.error } : {}),
        ...(a.ok ? { fetchedAt: result.fetchedAt } : {}),
        ...(a.ok && stale ? { stale: true } : {}),
      }))
    : [{ provider: result.source, ok: true, fetchedAt: result.fetchedAt, ...(stale ? { stale: true } : {}) }];
  for (const c of result.contributors ?? []) {
    if (!sources.some((s) => s.provider === c)) sources.push({ provider: c, ok: true, role: 'enrichment', ...(stale ? { stale: true } : {}) });
  }
  return sources;
}

/** Respond with a Sourced result; a stale (served-after-failure) result is flagged and cached only briefly. */
export function sendSourced<T>(
  result: Sourced<T> & { attempts?: ChainAttempt[] },
  policy: CachePolicy,
  opts: { stale?: boolean; notes?: string[] } = {},
) {
  const safe = result.attempts ? { ...result, attempts: safeAttempts(result.attempts) } : result;
  if (!opts.stale) return okSourced(safe, policy, opts.notes ?? []);
  const meta = buildMeta(sourcesOf(safe, true), {
    notes: [...(result.notes ?? []), ...(opts.notes ?? []), STALE_NOTE],
    primary: result.source,
    freshness: result.freshness,
  });
  return ok(result.data, meta, policy);
}

export interface CacheHit<T> {
  value: T;
  /** The loader failed and an older value is being served. */
  stale: boolean;
}

/**
 * Per-worker memory cache in front of a service call: de-duplicates
 * concurrent identical requests and serves the last good value (flagged
 * stale) for `staleMs` when the upstream fails. Cached values are shared
 * between requests and must never be mutated.
 */
export async function withCache<T>(key: string, ttlMs: number, staleMs: number, load: () => Promise<T>): Promise<CacheHit<T>> {
  const hit = await cached(`api:${key}`, { ttlMs, staleMs }, load);
  return { value: hit.value, stale: hit.stale };
}

/** Run a route body; map thrown errors to 400 / 501 / upstream failures without leaking internals. */
export async function handle(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BadRequestError) return badRequest(error.message);
    if (error instanceof NotConfiguredError) return notConfigured(error.message);
    // Chain attempts are echoed in the error body's sources: sanitize them first.
    if (error instanceof ChainError) return upstreamFailure(new ChainError(error.name, safeAttempts(error.attempts)));
    if (!isProviderError(error)) {
      // Unexpected (programming) errors: log a bounded, key-free summary for the deployment logs.
      console.error(`[orbyt api] ${safeErrorText(describeError(error))}`);
    }
    return upstreamFailure(error);
  }
}

const FRESHNESS_ORDER: readonly Freshness[] = ['stream', 'realtime', 'fast', 'indexed'];

/** The least fresh of several freshness labels (a merged payload is only as fresh as its oldest part). */
export function leastFresh(values: readonly Freshness[]): Freshness | undefined {
  let worst: Freshness | undefined;
  for (const v of values) {
    if (worst === undefined || FRESHNESS_ORDER.indexOf(v) > FRESHNESS_ORDER.indexOf(worst)) worst = v;
  }
  return worst;
}
