import 'server-only';
import { runChain, type ChainResult } from '@/lib/core/chain';
import type { ChartDataProvider } from '@/lib/core/providers';
import type { CandleSeries, Interval } from '@/lib/core/types';
import { NotConfiguredError } from './errors';

/**
 * /api/v1/candles: native candles from the configured keyed chart providers
 * that serve the requested interval. Unsupported intervals are never
 * fabricated: without a native source the route answers 501 and the client
 * derives short intervals from real trades instead.
 */

export const CANDLES_DEFAULT_LIMIT = 300;
export const CANDLES_MAX_LIMIT = 1_000;

export interface CandlesDeps {
  birdeye: ChartDataProvider | null;
  solanaTracker: ChartDataProvider | null;
  /** CoinGecko keyed (Demo: 1m+; paid plans add 1s/15s). */
  coingecko: ChartDataProvider | null;
}

export interface CandlesQueryInput {
  mint: string;
  pool?: string;
  interval: Interval;
  before?: number;
  limit: number;
}

/** Configured providers that natively serve `interval`, in failover order. */
export function candleProvidersFor(interval: Interval, deps: CandlesDeps): ChartDataProvider[] {
  return [deps.birdeye, deps.solanaTracker, deps.coingecko].filter(
    (p): p is ChartDataProvider => p !== null && p.intervals.includes(interval),
  );
}

export async function loadCandles(query: CandlesQueryInput, deps: CandlesDeps): Promise<ChainResult<CandleSeries>> {
  const configured = [deps.birdeye, deps.solanaTracker, deps.coingecko].some((p) => p !== null);
  if (!configured) {
    throw new NotConfiguredError('Server candles need BIRDEYE_API_KEY, SOLANATRACKER_API_KEY or COINGECKO_API_KEY. The browser uses public sources instead.');
  }
  const providers = candleProvidersFor(query.interval, deps);
  if (!providers.length) {
    throw new NotConfiguredError(`No configured candle source serves ${query.interval} candles natively.`);
  }
  return runChain(
    'candles',
    providers.map((p) => ({
      id: p.id,
      run: () => p.getCandles({ mint: query.mint, pool: query.pool, interval: query.interval, before: query.before, limit: query.limit }),
    })),
    // An indexer that does not know the token answers with no candles: try the next one.
    { accept: (r) => r.data.candles.length > 0 },
  );
}
