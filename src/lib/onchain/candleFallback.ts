import { ChainError } from '@/lib/core/chain';
import type { Candle, Trade } from '@/lib/core/types';
import { isProviderError } from '@/lib/net/errors';
import { INTERVAL_LABELS, MINUTE_INTERVALS, solPricedTrades, type IntervalOption } from '@/lib/services/token';

/**
 * When the chart uses candles aggregated from on-chain trades instead of the
 * native OHLCV source (GeckoTerminal / ORBYT's route). Pure, unit tested.
 *
 * GeckoTerminal needs 40 s to minutes to index a new pool, and then covers it
 * only from its indexing time, while the on-chain feed can hold every trade
 * of a young pool. Trade-built bars are real (one bar per bucket that had a
 * trade, never a synthesized empty bar) and labelled with their provenance.
 */

export type CandleFallbackReason =
  /** No native source can be asked for this pool (not indexed anywhere yet). */
  | 'no-native'
  /** The native source answered "not found" (typically: not indexed yet). */
  | 'not-found'
  /** The native source answered with no candles. */
  | 'empty'
  /** The native source failed (rate limit, network…) and real trades are in hand. */
  | 'failed'
  /** The on-chain trades reach back further than the native series. */
  | 'coverage'
  /** The feed holds every trade since the pool's first transaction. */
  | 'complete-history'
  /** The native source has not answered yet, and this young pool's trades are already charting. */
  | 'pending';

export interface NativeCandleState {
  /** A native source may be asked for this pool and interval (pool indexed, or the server route). */
  enabled: boolean;
  /** No answer yet. */
  pending: boolean;
  /** Native candles on screen (history pages included), ascending. */
  candles: readonly Candle[];
  error?: unknown;
}

export interface TradeCandleState {
  /** A trade feed from the chain runs for the charted pool. */
  available: boolean;
  /** Trades with a usable price (in the chart's currency). */
  count: number;
  /** First usable trade (ms). */
  fromMs?: number;
  /** Every trade since the pool's first transaction is held. */
  complete?: boolean;
  /** Trades are the likely final answer (a pump.fun curve, or a pool whose whole history was listed). */
  young?: boolean;
}

export interface CandleSourceDecision {
  source: 'native' | 'trades';
  reason?: CandleFallbackReason;
}

/** Every source said "not found" (a timeout or rate limit is not an absence). */
export function isNotFound(error: unknown): boolean {
  if (error instanceof ChainError) return error.allNotFound;
  return isProviderError(error) && error.code === 'not_found';
}

export function selectCandleSource(native: NativeCandleState, trades: TradeCandleState): CandleSourceDecision {
  if (!trades.available) return { source: 'native' };
  if (!native.enabled) return { source: 'trades', reason: 'no-native' };
  const first = native.candles[0];
  if (first) {
    if (trades.count >= 2 && trades.complete) return { source: 'trades', reason: 'complete-history' };
    if (trades.count >= 2 && trades.fromMs !== undefined && Math.floor(trades.fromMs / 1000) < first.time) return { source: 'trades', reason: 'coverage' };
    return { source: 'native' };
  }
  if (native.error !== undefined && native.error !== null) {
    if (isNotFound(native.error)) return { source: 'trades', reason: 'not-found' };
    // Keep the error on screen unless real trades can draw something.
    return trades.count >= 2 ? { source: 'trades', reason: 'failed' } : { source: 'native' };
  }
  if (native.pending) {
    // A young pool already charting from its trades keeps them while the indexer is asked (no skeleton flash).
    return trades.young && trades.count >= 2 ? { source: 'trades', reason: 'pending' } : { source: 'native' };
  }
  return { source: 'trades', reason: 'empty' };
}

/**
 * A pool whose whole life fits the first listing page is fetched within
 * seconds: its on-chain history counts as complete right away, so the chart
 * does not flash the indexer's series first.
 */
export const SMALL_POOL_SIGNATURES = 60;

/**
 * The on-chain feed holds every trade of the pool since its first
 * transaction. Never while listed transactions are missing (a busy pool
 * outran the RPC budget): bars drawn from a subset are not "complete".
 */
export function onchainHistoryComplete(onchain: { complete: boolean; exhausted: boolean; listed: number; missed?: number } | undefined): boolean {
  if (!onchain || (onchain.missed ?? 0) > 0) return false;
  return onchain.complete || (onchain.exhausted && onchain.listed <= SMALL_POOL_SIGNATURES);
}

/**
 * Trades priced in SOL for SOL charts (volume in SOL, see `solPricedTrades`).
 * Trades of the on-chain feed carry their exact SOL price on the basis of
 * their USD price (a pump.fun trade: the post-trade curve reserves, like the
 * SOL curve tick); using the trade's own SOL / token ratio instead would draw
 * SOL bars of another shape than the USD bars (off by the trade's price
 * impact, several % on a young curve).
 */
export function solChartTrades(trades: readonly Trade[], solPrices?: ReadonlyMap<string, number>): Trade[] {
  const base = solPricedTrades(trades);
  if (!solPrices?.size) return base;
  return base.map((t) => {
    const price = solPrices.get(t.signature);
    return price !== undefined && Number.isFinite(price) && price > 0 ? { ...t, priceUsd: price } : t;
  });
}

/**
 * Minute intervals with no native source (no indexed pool yet) become
 * trade-built when an on-chain trade feed runs for the pool.
 */
export function withOnchainIntervals(options: readonly IntervalOption[], onchain: boolean): IntervalOption[] {
  if (!onchain) return [...options];
  return options.map((o) =>
    !o.available && MINUTE_INTERVALS.includes(o.interval)
      ? { interval: o.interval, kind: 'trades', available: true, reason: `No indexed ${INTERVAL_LABELS[o.interval]} source for this pool yet; built by ORBYT from on-chain trades` }
      : o,
  );
}

/** Short provenance for a fallback, shown next to "Built from N on-chain trades". */
export function fallbackNote(reason: CandleFallbackReason | undefined): string | undefined {
  switch (reason) {
    case 'no-native':
      return 'pool not indexed yet';
    case 'not-found':
      return 'candle indexer has not listed this pool yet';
    case 'empty':
      return 'no indexed candles yet';
    case 'failed':
      return 'indexed candles unavailable';
    case 'coverage':
      return 'on-chain history reaches back further than the indexer';
    case 'complete-history':
      return 'complete on-chain history';
    case 'pending':
      return 'indexer not answered yet';
    default:
      return undefined;
  }
}
