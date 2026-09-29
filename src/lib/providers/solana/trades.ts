import type { Sourced, Trade } from '@/lib/core/types';
import type { ProviderId, TradesQuery, TransactionProvider } from '@/lib/core/providers';
import { normalizeDex } from '@/lib/core/dex';
import { isSolanaAddress, MINTS, STABLE_MINTS } from '@/lib/core/solana';
import { ProviderError } from '@/lib/net/errors';
import { deriveTradeForMint, type DerivedTrade } from '@/lib/analytics/swaps';
import { LruCache } from './lru';
import { PUMP_TOKEN_MINT } from './pump';
import type { RpcClient } from './rpc';
import { collectParsed, pipelineNotes } from './tx-pipeline';
import { clampInt } from './units';

/**
 * Trade feed for one pool from raw RPC: recent signatures of the pool
 * (bonding-curve PDA or AMM pool address), successful ones only, then
 * jsonParsed transactions and the swap derivation from balance deltas.
 *
 * Prices stay in the quote asset: `usdValue` / `priceUsd` are left undefined
 * for SOL-quoted trades (the service layer multiplies by SOL/USD); only
 * USDC/USDT-quoted trades carry USD values directly.
 */

/** getSignaturesForAddress page size cap (the public RPC allows 10 getTransaction per 10 s). */
export const MAX_RPC_TRADES = 40;

/** Parsed trades by `signature|mint|pool` (transactions are immutable). `null` = no trade of the mint in that tx. */
const tradeCache = new LruCache<string, DerivedTrade | null>(2_000);

/** Drop cached parsed trades (tests / memory pressure). */
export function resetTradeCache(): void {
  tradeCache.clear();
}

const QUOTE_SYMBOLS: Readonly<Record<string, string>> = {
  [MINTS.SOL]: 'SOL',
  [MINTS.USDC]: 'USDC',
  [MINTS.USDT]: 'USDT',
  [PUMP_TOKEN_MINT]: 'PUMP',
};

const DEX_ALIASES: Readonly<Record<string, string>> = {
  pumpfun: 'pumpfun',
  pump: 'pumpfun',
  pumpfunbondingcurve: 'pumpfun',
  pumpswap: 'pumpswap',
  pumpamm: 'pumpswap',
  raydium: 'raydium',
  raydiumamm: 'raydium',
  raydiumammv4: 'raydium',
  raydiumv4: 'raydium',
  raydiumcpmm: 'raydium-cpmm',
  raydiumclmm: 'raydium-clmm',
  raydiumlaunchlab: 'launchlab',
  launchlab: 'launchlab',
  letsbonk: 'letsbonk',
  meteora: 'meteora',
  meteoradlmm: 'meteora-dlmm',
  meteoradamm: 'meteora-damm',
  meteoradammv2: 'meteora-damm-v2',
  meteoradbc: 'meteora-dbc',
  orca: 'orca',
  orcawhirlpool: 'orca',
  whirlpool: 'orca',
  jupiter: 'jupiter',
};

/** Venue label from the swap derivation ('pump.fun', 'PumpSwap', 'Raydium CPMM', …) → normalized dex id. */
export function dexIdFromProgramLabel(label: string | undefined): string | undefined {
  if (!label || !label.trim()) return undefined;
  const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const alias = DEX_ALIASES[key];
  if (alias) return normalizeDex('orbyt', alias).dex;
  const slug = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? normalizeDex('orbyt', slug).dex : undefined;
}

/** DerivedTrade → normalized Trade (undefined when it lacks a usable timestamp or amount). */
export function toTrade(d: DerivedTrade, pool: string, source: ProviderId): Trade | undefined {
  if (!Number.isFinite(d.timestamp) || d.timestamp <= 0) return undefined;
  if (!Number.isFinite(d.tokenAmount) || d.tokenAmount <= 0) return undefined;
  const trade: Trade = {
    signature: d.signature,
    timestamp: d.timestamp,
    side: d.side,
    tokenAmount: d.tokenAmount,
    pool,
    source,
  };
  if (d.wallet) trade.wallet = d.wallet;
  // Router-paid pump.fun trades carry the curve's SOL amount from the TradeEvent (venue price, before router fees).
  const solAmount = typeof d.solAmount === 'number' && Number.isFinite(d.solAmount) ? d.solAmount : d.venueSolAmount;
  if (typeof solAmount === 'number' && Number.isFinite(solAmount) && solAmount > 0) {
    trade.solAmount = solAmount;
    trade.quoteAmount = solAmount;
    trade.quoteSymbol = 'SOL';
  } else if (d.quoteMint && typeof d.quoteAmount === 'number' && Number.isFinite(d.quoteAmount)) {
    trade.quoteAmount = d.quoteAmount;
    const symbol = QUOTE_SYMBOLS[d.quoteMint];
    if (symbol) trade.quoteSymbol = symbol;
    if (STABLE_MINTS.has(d.quoteMint)) {
      trade.usdValue = d.quoteAmount;
      trade.priceUsd = d.quoteAmount / d.tokenAmount;
    }
  }
  const dex = dexIdFromProgramLabel(d.program);
  if (dex) trade.dex = dex;
  return trade;
}

export function createRpcTradesProvider(opts: { rpc: RpcClient; provider?: ProviderId }): TransactionProvider {
  const { rpc } = opts;
  const id: ProviderId = opts.provider ?? rpc.provider;

  async function getTrades(query: TradesQuery, signal?: AbortSignal): Promise<Sourced<Trade[]>> {
    const { mint, pool } = query;
    if (!pool) throw new ProviderError(id, 'unsupported', `${rpc.label}: on-chain trades need a pool or bonding-curve address`);
    if (!isSolanaAddress(mint) || !isSolanaAddress(pool)) throw new ProviderError(id, 'not_found', `${rpc.label}: invalid mint or pool address`);
    const limit = clampInt(query.limit, 1, MAX_RPC_TRADES, MAX_RPC_TRADES);
    const since = typeof query.since === 'number' && Number.isFinite(query.since) ? query.since : undefined;

    const signatures = await rpc.getSignaturesForAddress(pool, { limit }, signal);
    const entries = signatures
      // Signatures with a known block time at or before `since` cannot yield newer trades.
      .filter((s) => since === undefined || s.blockTime === null || s.blockTime * 1000 > since)
      .map((s) => ({ signature: s.signature, failed: s.err !== null && s.err !== undefined }));

    const result = await collectParsed<DerivedTrade>({
      rpc,
      entries,
      cache: tradeCache,
      cacheKey: (signature) => `${signature}|${mint}|${pool}`,
      parse: (tx) => deriveTradeForMint(tx, mint, { pool }),
      signal,
    });
    const fetchedAt = Date.now();

    if (result.fetchError && result.processed === 0) throw result.fetchError;
    if (result.parseFailures > 0 && result.parsed === 0 && result.items.length === 0) {
      throw new ProviderError(id, 'malformed', `${rpc.label}: pool transactions could not be parsed`);
    }

    const order = new Map(entries.map((e, i) => [e.signature, i]));
    const trades = result.items
      .map((d) => toTrade(d, pool, id))
      .filter((t): t is Trade => t !== undefined && (since === undefined || t.timestamp > since))
      .sort((a, b) => b.timestamp - a.timestamp || (order.get(a.signature) ?? 0) - (order.get(b.signature) ?? 0));

    const out: Sourced<Trade[]> = { data: trades, source: id, fetchedAt, freshness: 'realtime' };
    const notes = pipelineNotes(result, entries.length);
    if (notes.length > 0) out.notes = notes;
    return out;
  }

  return { id, getTrades };
}
