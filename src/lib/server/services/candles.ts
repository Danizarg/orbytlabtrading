import 'server-only';
import { ChainError, runChain, type ChainResult } from '@/lib/core/chain';
import type { ChartDataProvider, ProviderId } from '@/lib/core/providers';
import type { CandleSeries, Interval } from '@/lib/core/types';
import { isAbortError, isProviderError, ProviderError, type ProviderErrorCode } from '@/lib/net/errors';
import type { CachePolicy } from '@/lib/server/respond';
import { NotConfiguredError } from './errors';

/**
 * /api/v1/candles: native candles from the configured keyed chart providers
 * that serve the requested interval, then keyless GeckoTerminal OHLCV (1m–1d)
 * as the last step. Without any key the route still answers through
 * GeckoTerminal (the server's own per-IP quota, with the conservative server
 * budget), and the CDN shares one upstream call across every visitor.
 * Unsupported intervals are never fabricated: without a native source the
 * route answers 501 and the client derives short intervals from real trades.
 */

export const CANDLES_DEFAULT_LIMIT = 300;
export const CANDLES_MAX_LIMIT = 1_000;

/** CDN policies for keyless GeckoTerminal answers (its data is cached ~60 s upstream). */
export const KEYLESS_CANDLES_CACHE = {
  latest: { sMaxAge: 30, swr: 60 },
  /** Pages with `before`: history before a fixed time barely changes. */
  history: { sMaxAge: 600, swr: 3_600 },
} as const satisfies Record<string, CachePolicy>;

/** Per-worker memory TTLs (ms) for keyless answers, matching the CDN policies. */
export const KEYLESS_CANDLES_TTL = { latest: 30_000, history: 600_000 } as const;

export interface CandlesDeps {
  birdeye: ChartDataProvider | null;
  solanaTracker: ChartDataProvider | null;
  /** CoinGecko keyed (Demo: 1m+; paid plans add 1s/15s). */
  coingecko: ChartDataProvider | null;
  /** Keyless GeckoTerminal from the server (1m–1d); the last step, always present in production. */
  geckoKeyless?: ChartDataProvider | null;
  /**
   * Pool to chart when the request names none (keyless GeckoTerminal needs one).
   * Backed by the cached pools service (shared with /api/v1/pools), so a token's pool is
   * looked up at most once a minute per worker. Resolves `undefined` only when no source
   * lists a pool; rejects when the lookup failed.
   */
  resolvePool?: (mint: string) => Promise<string | undefined>;
}

export interface CandlesQueryInput {
  mint: string;
  pool?: string;
  interval: Interval;
  before?: number;
  limit: number;
}

/** Configured keyed providers that natively serve `interval`, in failover order. */
export function candleProvidersFor(interval: Interval, deps: CandlesDeps): ChartDataProvider[] {
  return [deps.birdeye, deps.solanaTracker, deps.coingecko].filter(
    (p): p is ChartDataProvider => p !== null && p.intervals.includes(interval),
  );
}

/** The keyless GeckoTerminal step when it serves `interval`. */
export function keylessCandlesFor(interval: Interval, deps: CandlesDeps): ChartDataProvider | undefined {
  const gecko = deps.geckoKeyless;
  return gecko && gecko.intervals.includes(interval) ? gecko : undefined;
}

/** True when only the keyless source can answer `interval` (drives cache lifetimes). */
export function candlesAreKeylessOnly(interval: Interval, deps: CandlesDeps): boolean {
  return candleProvidersFor(interval, deps).length === 0 && keylessCandlesFor(interval, deps) !== undefined;
}

/** CDN policy for a candles answer: keyless GeckoTerminal answers are cached longer than keyed ones. */
export function candlesCachePolicy(source: ProviderId, historic: boolean, keyed: { latest: CachePolicy; history: CachePolicy }): CachePolicy {
  if (source === 'geckoterminal') return historic ? KEYLESS_CANDLES_CACHE.history : KEYLESS_CANDLES_CACHE.latest;
  return historic ? keyed.history : keyed.latest;
}

/**
 * A failed pool lookup is an outage of the step, not a capability gap: keep
 * it retryable (rate_limited / timeout / http) so the route answers 503/502
 * (or its last good candles) instead of 501 "not configured", which clients
 * skip silently.
 */
export function poolLookupError(id: ProviderId, error: unknown): unknown {
  if (isAbortError(error)) return error;
  const codes: Array<string | undefined> =
    error instanceof ChainError ? error.attempts.map((a) => a.code) : isProviderError(error) ? [error.code] : [];
  const code: ProviderErrorCode = codes.includes('rate_limited') ? 'rate_limited' : codes.includes('timeout') ? 'timeout' : 'http';
  return new ProviderError(id, code, `${id}: pool lookup failed`, { cause: error });
}

export async function loadCandles(query: CandlesQueryInput, deps: CandlesDeps): Promise<ChainResult<CandleSeries>> {
  const keyed = candleProvidersFor(query.interval, deps);
  const keyless = keylessCandlesFor(query.interval, deps);
  if (!keyed.length && !keyless) {
    const anyKeyed = [deps.birdeye, deps.solanaTracker, deps.coingecko].some((p) => p !== null);
    throw new NotConfiguredError(
      anyKeyed || deps.geckoKeyless
        ? `No configured candle source serves ${query.interval} candles natively.`
        : 'Server candles need BIRDEYE_API_KEY, SOLANATRACKER_API_KEY or COINGECKO_API_KEY. The browser uses public sources instead.',
    );
  }
  const { mint, pool, interval, before, limit } = query;
  return runChain(
    'candles',
    [
      ...keyed.map((p) => ({ id: p.id, run: () => p.getCandles({ mint, pool, interval, before, limit }) })),
      keyless && {
        id: keyless.id,
        run: async () => {
          let target = pool;
          if (!target && deps.resolvePool) {
            try {
              target = await deps.resolvePool(mint);
            } catch (error) {
              throw poolLookupError(keyless.id, error);
            }
          }
          if (!target) throw new ProviderError(keyless.id, 'unsupported', `${keyless.id}: no indexed pool to chart this token`);
          return keyless.getCandles({ mint, pool: target, interval, before, limit });
        },
      },
    ],
    // An indexer that does not know the token answers with no candles: try the next one.
    { accept: (r) => r.data.candles.length > 0 },
  );
}
