import 'server-only';
import { runChain, type ChainResult, type ChainStep } from '@/lib/core/chain';
import type { TransactionProvider } from '@/lib/core/providers';
import type { MintInfo, Trade } from '@/lib/core/types';
import { BadRequestError, NotConfiguredError } from './errors';

/**
 * /api/v1/trades: keyed trade feeds in failover order, then USD enrichment of
 * SOL-quoted trades with the current SOL/USD price (the RPC-derived feed
 * reports amounts in SOL only).
 */

export const TRADES_DEFAULT_LIMIT = 50;
export const TRADES_MAX_LIMIT = 100;

export const TRADES_SOL_USD_NOTE = 'USD values use the current SOL/USD price';
export const TRADES_MC_NOTE = 'Market cap at trade uses the current token supply';

export interface TradesDeps {
  /** RPC-derived feed; null on the public RPC (10 getTransaction / 10 s is too few for a feed). */
  rpcTrades: TransactionProvider | null;
  birdeye: TransactionProvider | null;
  solanaTracker: TransactionProvider | null;
  /** CoinGecko on a paid plan only (uncached pool trades); needs a pool address. */
  coingeckoPro: TransactionProvider | null;
  solPriceUsd: () => Promise<number | undefined>;
  mintInfo: (mint: string) => Promise<MintInfo | undefined>;
}

export interface TradesQueryInput {
  mint: string;
  pool?: string;
  limit: number;
}

function positive(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

const SOL_SYMBOLS: ReadonlySet<string> = new Set(['SOL', 'WSOL']);

/**
 * SOL exchanged in a trade: the dedicated field, or the quote amount of a
 * trade whose quote asset is (wrapped) SOL. Undefined for every other quote.
 */
function solAmountOf(trade: Trade): number | undefined {
  if (positive(trade.solAmount)) {
    return trade.quoteSymbol === undefined || SOL_SYMBOLS.has(trade.quoteSymbol) ? trade.solAmount : undefined;
  }
  if (trade.quoteSymbol !== undefined && SOL_SYMBOLS.has(trade.quoteSymbol) && positive(trade.quoteAmount)) return trade.quoteAmount;
  return undefined;
}

/** True when a trade was quoted in SOL (so its price can be expressed via SOL/USD). */
function isSolQuoted(trade: Trade): boolean {
  return solAmountOf(trade) !== undefined;
}

type UsdPatch = Pick<Trade, 'usdValue' | 'priceUsd' | 'marketCapUsd'>;

/**
 * Complete a trade's USD pair from its own execution figures (no SOL price):
 * priceUsd = usdValue / tokenAmount, or usdValue = priceUsd × tokenAmount.
 * Both sides then describe the same moment, instead of mixing the provider's
 * historical valuation with today's SOL/USD.
 */
function selfCompleted(trade: Trade): UsdPatch {
  const patch: UsdPatch = {};
  if (!positive(trade.tokenAmount)) return patch;
  if (trade.priceUsd === undefined && positive(trade.usdValue)) patch.priceUsd = trade.usdValue / trade.tokenAmount;
  if (trade.usdValue === undefined && positive(trade.priceUsd)) patch.usdValue = trade.priceUsd * trade.tokenAmount;
  return patch;
}

/** Whether the SOL/USD price could fill anything (decides if it is worth fetching). */
export function tradesNeedUsd(trades: readonly Trade[]): boolean {
  return trades.some((t) => {
    if (!isSolQuoted(t)) return false;
    const own = selfCompleted(t);
    const missingValue = t.usdValue === undefined && own.usdValue === undefined;
    const missingPrice = t.priceUsd === undefined && own.priceUsd === undefined && positive(t.tokenAmount);
    return missingValue || missingPrice;
  });
}

/** Whether the mint supply could fill a market cap (decides if mint info is worth fetching). */
export function tradesNeedSupply(trades: readonly Trade[]): boolean {
  return trades.some((t) => t.marketCapUsd === undefined && (positive(t.priceUsd) || selfCompleted(t).priceUsd !== undefined || isSolQuoted(t)));
}

/**
 * Fill USD fields from real inputs only, never overwriting provider values:
 * 1. the trade's own USD figures complete each other (see selfCompleted)
 * 2. SOL-quoted trades still lacking them: usdValue = solAmount × solUsd,
 *    priceUsd = (solAmount / tokenAmount) × solUsd (current SOL/USD, noted)
 * 3. marketCapUsd = priceUsd × supply when the mint supply is known (noted)
 * Returns new objects; the input is never mutated (values are shared through caches).
 */
export function enrichTradesUsd(
  trades: readonly Trade[],
  opts: { solUsd?: number; supply?: number },
): { trades: Trade[]; usedSolPrice: boolean; usedSupply: boolean } {
  const solUsd = positive(opts.solUsd) ? opts.solUsd : undefined;
  const supply = positive(opts.supply) ? opts.supply : undefined;
  let usedSolPrice = false;
  let usedSupply = false;
  const out = trades.map((trade) => {
    const patch = selfCompleted(trade);
    const sol = solUsd !== undefined ? solAmountOf(trade) : undefined;
    if (solUsd !== undefined && sol !== undefined) {
      if (trade.usdValue === undefined && patch.usdValue === undefined) {
        patch.usdValue = sol * solUsd;
        usedSolPrice = true;
      }
      if (trade.priceUsd === undefined && patch.priceUsd === undefined && positive(trade.tokenAmount)) {
        patch.priceUsd = (sol / trade.tokenAmount) * solUsd;
        usedSolPrice = true;
      }
    }
    const price = patch.priceUsd ?? trade.priceUsd;
    if (supply !== undefined && trade.marketCapUsd === undefined && positive(price)) {
      patch.marketCapUsd = price * supply;
      usedSupply = true;
    }
    return Object.keys(patch).length ? { ...trade, ...patch } : trade;
  });
  return { trades: out, usedSolPrice, usedSupply };
}

interface Candidate {
  provider: TransactionProvider;
  requiresPool: boolean;
}

export async function loadTrades(query: TradesQueryInput, deps: TradesDeps): Promise<ChainResult<Trade[]>> {
  const candidates: Candidate[] = [];
  if (deps.rpcTrades) candidates.push({ provider: deps.rpcTrades, requiresPool: true });
  if (deps.birdeye) candidates.push({ provider: deps.birdeye, requiresPool: false });
  if (deps.solanaTracker) candidates.push({ provider: deps.solanaTracker, requiresPool: false });
  if (deps.coingeckoPro) candidates.push({ provider: deps.coingeckoPro, requiresPool: true });
  if (!candidates.length) {
    throw new NotConfiguredError(
      'A live trade feed needs HELIUS_API_KEY, a private SOLANA_RPC_URL, BIRDEYE_API_KEY, SOLANATRACKER_API_KEY or a paid CoinGecko plan. The browser uses public sources instead.',
    );
  }
  const runnable = candidates.filter((c) => !c.requiresPool || query.pool);
  if (!runnable.length) throw new BadRequestError('pool is required by the configured trade sources');

  const steps: ChainStep<Trade[]>[] = runnable.map(({ provider }) => ({
    id: provider.id,
    run: () => provider.getTrades({ mint: query.mint, pool: query.pool, limit: query.limit }),
  }));
  const result = await runChain('trades', steps);
  // Newest first before capping, whatever order the provider used (a stable copy: cached values are shared).
  const trades = [...result.data].sort((a, b) => b.timestamp - a.timestamp).slice(0, query.limit);

  const needUsd = tradesNeedUsd(trades);
  const [solUsd, mint] = await Promise.all([
    needUsd ? deps.solPriceUsd() : Promise.resolve(undefined),
    tradesNeedSupply(trades) ? deps.mintInfo(query.mint) : Promise.resolve(undefined),
  ]);
  const enriched = enrichTradesUsd(trades, { solUsd, supply: mint?.supply });
  const notes = [...(result.notes ?? [])];
  if (enriched.usedSolPrice) notes.push(TRADES_SOL_USD_NOTE);
  if (enriched.usedSupply) notes.push(TRADES_MC_NOTE);
  return { ...result, data: enriched.trades, ...(notes.length ? { notes } : {}) };
}
