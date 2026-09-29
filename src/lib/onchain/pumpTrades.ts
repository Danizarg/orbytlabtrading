import type { PumpTradeEvent } from '@/lib/analytics/swaps';
import type { ProviderId } from '@/lib/core/providers';
import { MINTS } from '@/lib/core/solana';
import type { Trade } from '@/lib/core/types';

/**
 * pump.fun bonding-curve trades built from the program's own TradeEvent
 * (decoded from `Program data:` log lines or the event self-CPI).
 *
 * - Amounts are exact: `sol_amount` (the SOL moved against the curve; pump's
 *   protocol / creator fees and any router fee are not part of it) and
 *   `token_amount`, both integers scaled by their decimals.
 * - Price = the curve's POST-trade virtual reserves (vSOL / vTokens), the
 *   same constant-product price the on-chain curve read reports, so bars
 *   built from trades and the curve tick share one basis. Layouts without
 *   reserves fall back to the trade's own sol / token ratio.
 * - One trade per transaction: several events of the same user and direction
 *   (e.g. a split buy) are summed and priced by the last event's reserves.
 *   Events of different users or directions (a bundle), or a curve quoted in
 *   another asset, return undefined so the caller derives the trade from the
 *   full transaction instead of guessing.
 */

/** pump.fun mints always use 6 decimals. */
export const PUMP_DECIMALS = 6;
const LAMPORTS_DECIMALS = 9;
/** The all-zero pubkey: a curve event's default quote mint (SOL). */
const DEFAULT_PUBKEY = '11111111111111111111111111111111';

/** Raw integer → decimal number via the exact decimal string (no float drift from splitting). */
export function rawToNumber(raw: bigint, decimals: number): number {
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString();
  if (decimals === 0) return negative ? -Number(digits) : Number(digits);
  const padded = digits.padStart(decimals + 1, '0');
  const value = Number(`${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`);
  return negative ? -value : value;
}

function isSolQuoted(event: PumpTradeEvent): boolean {
  return event.quoteMint === undefined || event.quoteMint === DEFAULT_PUBKEY || event.quoteMint === MINTS.SOL;
}

/** SOL per token from post-trade virtual reserves (undefined when absent or zero). */
export function reservePriceSol(event: PumpTradeEvent, tokenDecimals = PUMP_DECIMALS): number | undefined {
  const vSol = event.virtualSolReserves;
  const vTok = event.virtualTokenReserves;
  if (vSol === undefined || vTok === undefined || vSol <= 0n || vTok <= 0n) return undefined;
  const price = rawToNumber(vSol, LAMPORTS_DECIMALS) / rawToNumber(vTok, tokenDecimals);
  return Number.isFinite(price) && price > 0 ? price : undefined;
}

/** A trade in SOL terms; USD fields are added by the feed (`priceWithSol`). */
export interface NativeTrade {
  trade: Trade;
  /** Price per token in SOL (undefined when the quote is not SOL or unknown). */
  priceSol?: number;
  /**
   * Pools quoted in an asset that is neither SOL nor a USD stablecoin (e.g. a
   * StonkFun pool quoted in GLDx): the venue price per token in that asset,
   * and the trade's amount of it when the trade was paid in it (not routed
   * from another asset). USD fields follow from the asset's USD price
   * (`QuoteUsd`), the way SOL-quoted trades follow from SOL/USD.
   */
  quote?: { mint: string; price: number; amount?: number };
}

/** USD price of a pool's non-SOL, non-stable quote asset. */
export interface QuoteUsd {
  mint: string;
  priceUsd: number;
}

export interface PumpTradeContext {
  signature: string;
  mint: string;
  /** Bonding-curve address (the trade's pool). */
  pool: string;
  source: ProviderId;
  /** Block time (ms) when known; otherwise the event's own clock is used. */
  timestampMs?: number;
  tokenDecimals?: number;
}

/**
 * The trade of `ctx.mint` described by these TradeEvents (already filtered to
 * the mint by the caller or not: foreign mints are ignored), or undefined when
 * the events cannot describe exactly one SOL-quoted trade.
 */
export function tradeFromPumpEvents(events: readonly PumpTradeEvent[], ctx: PumpTradeContext): NativeTrade | undefined {
  const own = events.filter((e) => e.mint === ctx.mint);
  const first = own[0];
  const last = own.at(-1);
  if (!first || !last) return undefined;
  let solRaw = 0n;
  let tokenRaw = 0n;
  for (const e of own) {
    if (e.user !== first.user || e.isBuy !== first.isBuy || !isSolQuoted(e)) return undefined;
    solRaw += e.solAmount;
    tokenRaw += e.tokenAmount;
  }
  if (tokenRaw <= 0n) return undefined;
  const decimals = ctx.tokenDecimals ?? PUMP_DECIMALS;
  const seconds = own.find((e) => e.timestamp !== undefined)?.timestamp;
  const timestamp = ctx.timestampMs ?? (seconds !== undefined ? seconds * 1000 : undefined);
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return undefined;

  const tokenAmount = rawToNumber(tokenRaw, decimals);
  const solAmount = rawToNumber(solRaw, LAMPORTS_DECIMALS);
  const trade: Trade = {
    signature: ctx.signature,
    timestamp,
    side: first.isBuy ? 'buy' : 'sell',
    wallet: first.user,
    tokenAmount,
    pool: ctx.pool,
    dex: 'pumpfun',
    source: ctx.source,
  };
  if (solAmount > 0) {
    trade.solAmount = solAmount;
    trade.quoteAmount = solAmount;
    trade.quoteSymbol = 'SOL';
  }
  const priceSol = reservePriceSol(last, decimals) ?? (solAmount > 0 ? solAmount / tokenAmount : undefined);
  return priceSol !== undefined && Number.isFinite(priceSol) && priceSol > 0 ? { trade, priceSol } : { trade };
}

/**
 * The trade a transaction's TradeEvents describe, bundles included: one user
 * and direction as `tradeFromPumpEvents`; several users or directions trading
 * the mint in one transaction (a launch bundle) → the (user, direction) group
 * that moved the most tokens, priced by its own events (a Trade is one per
 * signature). Undefined when no usable SOL-quoted event of the mint exists.
 */
export function pumpTradeFromEvents(events: readonly PumpTradeEvent[], ctx: PumpTradeContext): NativeTrade | undefined {
  const own = events.filter((e) => e.mint === ctx.mint);
  const whole = tradeFromPumpEvents(own, ctx);
  if (whole || own.length < 2) return whole;
  const groups = new Map<string, PumpTradeEvent[]>();
  for (const e of own) {
    const key = `${e.user}|${e.isBuy ? 'buy' : 'sell'}`;
    const group = groups.get(key);
    if (group) group.push(e);
    else groups.set(key, [e]);
  }
  if (groups.size < 2) return undefined;
  let best: PumpTradeEvent[] | undefined;
  let bestTokens = -1n;
  for (const group of groups.values()) {
    const tokens = group.reduce((sum, e) => sum + e.tokenAmount, 0n);
    if (tokens > bestTokens) {
      bestTokens = tokens;
      best = group;
    }
  }
  return best ? tradeFromPumpEvents(best, ctx) : undefined;
}

/**
 * USD fields from the SOL price: priceUsd = priceSol × SOL/USD, usdValue =
 * solAmount × SOL/USD, marketCapUsd = priceUsd × supply. A trade priced in
 * another quote asset takes priceUsd = quote price × the asset's USD price
 * (and its usdValue from the quote amount when the trader paid in it). Fields
 * a trade already carries (e.g. a USDC-quoted trade's own USD value) are kept.
 */
export function priceWithSol(native: NativeTrade, solUsd: number | undefined, supply: number | undefined, quoteUsd?: QuoteUsd): Trade {
  const trade: Trade = { ...native.trade };
  const sol = typeof solUsd === 'number' && Number.isFinite(solUsd) && solUsd > 0 ? solUsd : undefined;
  const { quote } = native;
  const quoteRate = quote && quoteUsd?.mint === quote.mint && Number.isFinite(quoteUsd.priceUsd) && quoteUsd.priceUsd > 0 ? quoteUsd.priceUsd : undefined;
  if (trade.priceUsd === undefined && native.priceSol !== undefined && sol !== undefined) trade.priceUsd = native.priceSol * sol;
  if (trade.priceUsd === undefined && quote && quoteRate !== undefined) trade.priceUsd = quote.price * quoteRate;
  if (trade.usdValue === undefined && trade.solAmount !== undefined && sol !== undefined) trade.usdValue = trade.solAmount * sol;
  if (trade.usdValue === undefined && quote?.amount !== undefined && quoteRate !== undefined) trade.usdValue = quote.amount * quoteRate;
  if (trade.marketCapUsd === undefined && trade.priceUsd !== undefined && typeof supply === 'number' && Number.isFinite(supply) && supply > 0) {
    trade.marketCapUsd = trade.priceUsd * supply;
  }
  return trade;
}
