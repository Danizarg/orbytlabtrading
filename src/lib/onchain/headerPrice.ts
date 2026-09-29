import type { Trade } from '@/lib/core/types';

/**
 * Header price / market cap for a token no market provider prices yet (a
 * pump.fun token seconds old): the on-chain bonding-curve read or the latest
 * on-chain trade, whichever observation is newer, labelled with its source.
 */

export type OnchainPriceSource = 'curve' | 'trade';

export interface OnchainPrice {
  priceUsd: number;
  marketCapUsd?: number;
  source: OnchainPriceSource;
  /** Observation time (ms): the curve read, or the trade's block time. */
  at: number;
  /** Short label for the header ("pump.fun curve", "last on-chain trade"). */
  label: string;
}

const ONCHAIN_SOURCES = new Set(['solana-rpc', 'solana-ws', 'helius']);
const isPos = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

export function onchainHeaderPrice(input: {
  /** Live curve price (USD) and its read time (ms). */
  curve?: { priceUsd?: number; marketCapUsd?: number; at?: number };
  /** Trade feed, newest first. */
  trades: readonly Trade[];
  /** On-chain supply (UI units) for a trade-based market cap. */
  supply?: number;
}): OnchainPrice | undefined {
  const { curve, trades, supply } = input;
  const trade = trades.find((t) => ONCHAIN_SOURCES.has(t.source) && isPos(t.priceUsd) && Number.isFinite(t.timestamp));
  const fromCurve: OnchainPrice | undefined =
    curve && isPos(curve.priceUsd) && isPos(curve.at)
      ? { priceUsd: curve.priceUsd, ...(isPos(curve.marketCapUsd) ? { marketCapUsd: curve.marketCapUsd } : {}), source: 'curve', at: curve.at, label: 'pump.fun curve' }
      : undefined;
  let fromTrade: OnchainPrice | undefined;
  if (trade && isPos(trade.priceUsd)) {
    const mc = isPos(trade.marketCapUsd) ? trade.marketCapUsd : isPos(supply) ? trade.priceUsd * supply : undefined;
    fromTrade = { priceUsd: trade.priceUsd, ...(mc !== undefined ? { marketCapUsd: mc } : {}), source: 'trade', at: trade.timestamp, label: 'last on-chain trade' };
  }
  if (fromCurve && fromTrade) return fromTrade.at > fromCurve.at ? fromTrade : fromCurve;
  return fromCurve ?? fromTrade;
}
