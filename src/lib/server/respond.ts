import 'server-only';
import { NextResponse } from 'next/server';
import type { ApiEnvelope, ApiErrorBody, ApiMeta, SourceStatus } from '@/lib/core/api';
import type { ChainAttempt } from '@/lib/core/chain';
import type { ProviderId } from '@/lib/core/providers';
import type { Freshness, Sourced } from '@/lib/core/types';
import { ChainError } from '@/lib/core/chain';
import { describeError, isProviderError } from './http';

/**
 * CDN cache policy for API responses. `sMaxAge` lets Vercel's edge cache
 * collapse identical requests from many users into one function invocation;
 * `swr` serves the previous response while revalidating in the background.
 */
export interface CachePolicy {
  sMaxAge: number;
  swr?: number;
}

export const CACHE = {
  none: { sMaxAge: 0 },
  live: { sMaxAge: 2, swr: 4 },
  trades: { sMaxAge: 2, swr: 6 },
  market: { sMaxAge: 5, swr: 20 },
  discovery: { sMaxAge: 8, swr: 30 },
  holders: { sMaxAge: 30, swr: 120 },
  candles: { sMaxAge: 10, swr: 30 },
  metadata: { sMaxAge: 300, swr: 3_600 },
} as const satisfies Record<string, CachePolicy>;

function cacheHeader(policy: CachePolicy): string {
  if (policy.sMaxAge <= 0) return 'no-store';
  return `public, max-age=0, s-maxage=${policy.sMaxAge}, stale-while-revalidate=${policy.swr ?? policy.sMaxAge * 4}`;
}

export function buildMeta(
  sources: SourceStatus[],
  opts: { notes?: Array<string | undefined | false>; primary?: ProviderId; freshness?: Freshness } = {},
): ApiMeta {
  const fetched = sources.map((s) => s.fetchedAt).filter((t): t is number => typeof t === 'number');
  const cleanNotes = opts.notes?.filter((n): n is string => typeof n === 'string' && n.length > 0);
  return {
    generatedAt: Date.now(),
    dataAsOf: fetched.length ? Math.min(...fetched) : undefined,
    ...(opts.primary ? { primary: opts.primary } : {}),
    ...(opts.freshness ? { freshness: opts.freshness } : {}),
    sources,
    stale: sources.some((s) => s.stale),
    ...(cleanNotes && cleanNotes.length ? { notes: cleanNotes } : {}),
  };
}

/** Build an envelope response straight from a Sourced<T> result. */
export function okSourced<T>(result: Sourced<T> & { attempts?: ChainAttempt[] }, policy: CachePolicy, extraNotes: string[] = []) {
  const sources: SourceStatus[] = result.attempts?.length
    ? result.attempts.map((a) => ({
        provider: a.provider,
        ok: a.ok,
        ...(a.error ? { error: a.error } : {}),
        ...(a.ok ? { fetchedAt: result.fetchedAt } : {}),
      }))
    : [{ provider: result.source, ok: true, fetchedAt: result.fetchedAt }];
  for (const c of result.contributors ?? []) {
    if (!sources.some((s) => s.provider === c)) sources.push({ provider: c, ok: true, role: 'enrichment' });
  }
  return ok(result.data, buildMeta(sources, { notes: [...(result.notes ?? []), ...extraNotes], primary: result.source, freshness: result.freshness }), policy);
}

export function ok<T>(data: T, meta: ApiMeta, policy: CachePolicy): NextResponse<ApiEnvelope<T>> {
  // Degraded/stale payloads are cached briefly so recovery is picked up quickly.
  const effective = meta.stale ? { sMaxAge: Math.min(policy.sMaxAge, 2), swr: 4 } : policy;
  return NextResponse.json({ data, meta }, { headers: { 'Cache-Control': cacheHeader(effective) } });
}

export function fail(status: number, code: string, message: string, sources: SourceStatus[] = []): NextResponse<ApiErrorBody> {
  return NextResponse.json(
    { error: { code, message }, meta: buildMeta(sources) },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export function badRequest(message: string) {
  return fail(400, 'bad_request', message);
}

/** Map an unexpected error to a 502/503 without leaking upstream URLs or keys. */
export function upstreamFailure(error: unknown, sources: SourceStatus[] = []) {
  if (error instanceof ChainError) {
    const chainSources: SourceStatus[] = error.attempts.map((a) => ({ provider: a.provider, ok: a.ok, ...(a.error ? { error: a.error } : {}) }));
    if (error.allNotConfigured || error.attempts.length === 0) {
      return fail(501, 'not_configured', 'No server-side provider is configured for this data. The browser uses public sources instead.', chainSources);
    }
    if (error.allNotFound) return fail(404, 'not_found', 'Not found by any provider.', chainSources);
    const rateLimited = error.attempts.some((a) => a.code === 'rate_limited');
    return fail(rateLimited ? 503 : 502, rateLimited ? 'rate_limited' : 'upstream_unavailable', 'Live data providers are unavailable right now. Retrying shortly.', chainSources);
  }
  if (isProviderError(error) && error.code === 'not_configured') {
    return fail(501, 'not_configured', describeError(error), sources);
  }
  if (isProviderError(error) && error.code === 'not_found') {
    return fail(404, 'not_found', describeError(error), sources);
  }
  const rateLimited = isProviderError(error) && error.code === 'rate_limited';
  return fail(rateLimited ? 503 : 502, rateLimited ? 'rate_limited' : 'upstream_unavailable', 'Live data providers are unavailable right now. Retrying shortly.', sources);
}

/** 501 for capabilities that need a server-side key the deployment doesn't have. */
export function notConfigured(message: string) {
  return fail(501, 'not_configured', message);
}
