import type { Trade } from '@/lib/core/types';

/**
 * Pure helpers for live trade feeds: merging polled / streamed pages, spotting
 * new rows for flash animations and window statistics. Nothing here invents a
 * value: USD figures come from the trade itself.
 */

const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * USD value of a trade: the provider's `usdValue`, else execution
 * `priceUsd × tokenAmount` (both real per-trade figures). Undefined when
 * neither is available.
 */
export function tradeUsdValue(trade: Trade): number | undefined {
  if (isFiniteNumber(trade.usdValue) && trade.usdValue >= 0) return trade.usdValue;
  if (isFiniteNumber(trade.priceUsd) && isFiniteNumber(trade.tokenAmount) && trade.priceUsd > 0 && trade.tokenAmount >= 0) {
    return trade.priceUsd * trade.tokenAmount;
  }
  return undefined;
}

/**
 * Newest-first order: timestamp descending, then signature descending, i.e.
 * the exact reverse of chronological (timestamp, signature) order used by the
 * candle aggregator. Trades in the same block share a timestamp and their true
 * intra-block order is unknown, so the signature only makes it deterministic.
 */
export function compareTradesNewestFirst(a: Trade, b: Trade): number {
  if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
  return a.signature < b.signature ? 1 : a.signature > b.signature ? -1 : 0;
}

const usable = (t: Trade): boolean => typeof t.signature === 'string' && t.signature.length > 0 && isFiniteNumber(t.timestamp);

/**
 * Merge a new page / stream batch into an existing feed.
 * - Deduplicated by signature; when a signature is in both, the incoming row
 *   wins (a later fetch may carry corrected amounts or extra fields). Within
 *   one array, the later occurrence wins.
 * - Sorted newest first (see `compareTradesNewestFirst`), capped at `max`.
 * - Rows without a signature or a finite timestamp are dropped (they cannot be
 *   deduplicated or ordered).
 *
 * Note: a transaction that swaps through the same pool twice collapses into one
 * row, because `Trade` carries no per-instruction index.
 */
export function mergeTrades(existing: readonly Trade[], incoming: readonly Trade[], max = 200): Trade[] {
  const limit = Number.isFinite(max) ? Math.floor(max) : 0;
  if (limit <= 0) return [];
  const bySignature = new Map<string, Trade>();
  for (const t of existing) if (usable(t)) bySignature.set(t.signature, t);
  for (const t of incoming) if (usable(t)) bySignature.set(t.signature, t);
  return [...bySignature.values()].sort(compareTradesNewestFirst).slice(0, limit);
}

/**
 * Trades in `next` whose signature is not in `prev`, in `next` order. Used to
 * flash freshly arrived rows. On the very first load every row is "new"; callers
 * that do not want to flash the initial snapshot should skip that call.
 */
export function newTradesSince(prev: readonly Trade[], next: readonly Trade[]): Trade[] {
  const seen = new Set(prev.map((t) => t.signature));
  return next.filter((t) => !seen.has(t.signature));
}

export interface TradeWindowStats {
  /** Trades counted in the window. */
  trades: number;
  buys: number;
  sells: number;
  /**
   * Sum of known USD values (`tradeUsdValue`) of buys / sells. 0 when the
   * window has no buys / sells; undefined when there are some but none has a
   * USD value.
   */
  buyVolumeUsd?: number;
  sellVolumeUsd?: number;
  /** True when every counted trade had a USD value (volumes are complete, not a lower bound). */
  volumeComplete: boolean;
  /**
   * Distinct wallets among counted trades. 0 for an empty window; undefined when
   * there are trades but the provider supplied no wallet for any of them.
   */
  uniqueWallets?: number;
}

/**
 * Buy / sell counts, USD volume and unique traders for trades with
 * `timestamp >= nowMs − windowMs`. There is deliberately no upper bound: rows
 * stamped slightly after `nowMs` (client clock behind block time) still count.
 */
export function tradeStats(trades: readonly Trade[], windowMs: number, nowMs: number): TradeWindowStats {
  const from = nowMs - windowMs;
  let buys = 0;
  let sells = 0;
  let buyVolume = 0;
  let sellVolume = 0;
  let buyPriced = 0;
  let sellPriced = 0;
  let walletsKnown = 0;
  const wallets = new Set<string>();
  for (const t of trades) {
    if (!isFiniteNumber(t.timestamp) || !(t.timestamp >= from)) continue;
    if (t.side !== 'buy' && t.side !== 'sell') continue;
    const usd = tradeUsdValue(t);
    if (t.side === 'buy') {
      buys++;
      if (usd !== undefined) {
        buyVolume += usd;
        buyPriced++;
      }
    } else {
      sells++;
      if (usd !== undefined) {
        sellVolume += usd;
        sellPriced++;
      }
    }
    if (t.wallet) {
      walletsKnown++;
      wallets.add(t.wallet);
    }
  }
  const count = buys + sells;
  const stats: TradeWindowStats = {
    trades: count,
    buys,
    sells,
    volumeComplete: buyPriced === buys && sellPriced === sells,
  };
  if (buys === 0 || buyPriced > 0) stats.buyVolumeUsd = buyVolume;
  if (sells === 0 || sellPriced > 0) stats.sellVolumeUsd = sellVolume;
  if (count === 0 || walletsKnown > 0) stats.uniqueWallets = wallets.size;
  return stats;
}
