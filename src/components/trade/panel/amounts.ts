/**
 * Trade-panel amount math (pure, unit tested in amounts.test.ts).
 *
 * Amounts that reach Jupiter are raw integer base units, so conversions run
 * in bigint wherever the input allows it. Balances from the portfolio
 * sources arrive as UI numbers (float); `uiBalanceToRaw` recovers the raw
 * balance exactly while it fits comfortably in a double and otherwise rounds
 * DOWN by a margin larger than the float error, so a "100 %" sell never asks
 * for more than the wallet holds.
 */

import { SOL_DECIMALS, SOL_PRESETS, toRawAmount, type QuoteSide } from '@/lib/services/token';

/** SOL kept back by "Max" on buys for network fees, token-account rent and priority fees (0.01 SOL). */
export const FEE_RESERVE_LAMPORTS = 10_000_000n;

/** Default buy presets (SOL). */
export const DEFAULT_BUY_PRESETS: readonly number[] = SOL_PRESETS;
export const BUY_PRESET_COUNT = 4;
/** Largest SOL amount a preset may hold. */
export const MAX_BUY_PRESET = 100_000;

/** Below this raw value a double holds the balance exactly enough to round-trip (several summed accounts included). */
const EXACT_RAW_LIMIT = 2n ** 50n;

/** Exact decimal string for a raw integer amount, e.g. (1234500n, 6) → '1.2345'. */
export function rawToDecimal(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Decimal text → raw base units (fraction digits beyond `decimals` truncated); undefined for invalid or zero input. */
export function decimalToRaw(text: string, decimals: number): bigint | undefined {
  const raw = toRawAmount(text, decimals);
  return raw === undefined ? undefined : BigInt(raw);
}

/**
 * Raw balance behind a UI balance (float). Exact below 2^50 raw units
 * (e.g. every pump.fun balance, and 9-decimal balances under ~1.1M tokens);
 * above that it is rounded down by more than the float error.
 */
export function uiBalanceToRaw(amount: number | undefined, decimals: number | undefined): bigint | undefined {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount >= 1e21) return undefined;
  if (decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 100) return undefined;
  // toFixed rounds the double's exact binary value to `decimals` places.
  const rounded = BigInt(amount.toFixed(decimals).replace('.', ''));
  if (rounded <= 0n) return undefined;
  if (rounded < EXACT_RAW_LIMIT) return rounded;
  const safe = rounded - (rounded >> 49n) - 1n;
  return safe > 0n ? safe : undefined;
}

/** `pct` percent of a raw amount, rounded down (0–100 %, 0.01 % steps). */
export function percentOfRaw(raw: bigint, pct: number): bigint {
  if (!Number.isFinite(pct) || raw <= 0n) return 0n;
  const bps = BigInt(Math.min(10_000, Math.max(0, Math.round(pct * 100))));
  return (raw * bps) / 10_000n;
}

/** Sell-field text for `pct` percent of a token balance; undefined when the balance is unknown or the result is zero. */
export function sellAmountForPercent(balanceRaw: bigint | undefined, decimals: number | undefined, pct: number): string | undefined {
  if (balanceRaw === undefined || decimals === undefined) return undefined;
  const raw = percentOfRaw(balanceRaw, pct);
  return raw > 0n ? rawToDecimal(raw, decimals) : undefined;
}

/** Largest buy that leaves the fee reserve in the wallet (lamports); 0 when the balance is below the reserve. */
export function maxBuyLamports(balanceLamports: bigint, reserve: bigint = FEE_RESERVE_LAMPORTS): bigint {
  const max = balanceLamports - reserve;
  return max > 0n ? max : 0n;
}

/** "Max" text for the buy field; undefined when nothing is left after the fee reserve. */
export function maxBuyAmount(balanceLamports: bigint | undefined, reserve: bigint = FEE_RESERVE_LAMPORTS): string | undefined {
  if (balanceLamports === undefined) return undefined;
  const max = maxBuyLamports(balanceLamports, reserve);
  return max > 0n ? rawToDecimal(max, SOL_DECIMALS) : undefined;
}

/** SOL (float, from a server portfolio) → lamports. */
export function solToLamports(sol: number | undefined): bigint | undefined {
  if (typeof sol !== 'number' || !Number.isFinite(sol) || sol < 0) return undefined;
  return BigInt(Math.round(sol * 1e9));
}

/**
 * Minimum output after slippage for an ExactIn quote, as Jupiter computes
 * `otherAmountThreshold`: out × (10000 − slippageBps) / 10000.
 */
export function minReceived(outAmount: number | undefined, slippageBps: number | undefined): number | undefined {
  if (typeof outAmount !== 'number' || !Number.isFinite(outAmount) || outAmount <= 0) return undefined;
  if (slippageBps === undefined || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) return undefined;
  return (outAmount * (10_000 - slippageBps)) / 10_000;
}


export type BalanceCheck =
  /** The amount fits the balance (and, for buys, leaves the fee reserve). */
  | 'ok'
  /** The amount exceeds the balance. */
  | 'insufficient'
  /** A buy that leaves less than the fee reserve for network fees. */
  | 'low_reserve'
  /** Balance or amount unknown. */
  | 'unknown';

/** Compare an entered amount (raw units of the input asset) with the wallet balance of that asset. */
export function checkBalance(input: {
  side: QuoteSide;
  amountRaw: bigint | undefined;
  /** Balance of the input asset in raw units: lamports for buys, token base units for sells. */
  balanceRaw: bigint | undefined;
  reserve?: bigint;
}): BalanceCheck {
  const { side, amountRaw, balanceRaw } = input;
  if (amountRaw === undefined || balanceRaw === undefined || amountRaw <= 0n) return 'unknown';
  if (amountRaw > balanceRaw) return 'insufficient';
  if (side === 'buy' && balanceRaw - amountRaw < (input.reserve ?? FEE_RESERVE_LAMPORTS)) return 'low_reserve';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Editable buy presets
// ---------------------------------------------------------------------------

/** A preset value typed by the user → SOL amount (positive, at most 9 decimals, ≤ 100 000); undefined when invalid. */
export function parsePresetInput(text: string): number | undefined {
  const raw = toRawAmount(text, SOL_DECIMALS);
  if (raw === undefined) return undefined;
  const value = Number(rawToDecimal(BigInt(raw), SOL_DECIMALS));
  return Number.isFinite(value) && value > 0 && value <= MAX_BUY_PRESET ? value : undefined;
}

/** Index of the first preset draft that is not a valid SOL amount; undefined when every draft is valid. */
export function invalidPresetDraft(drafts: readonly string[]): number | undefined {
  const i = drafts.findIndex((d) => parsePresetInput(d) === undefined);
  return i === -1 ? undefined : i;
}

/** Presets read back from storage: exactly four valid SOL amounts; an invalid slot falls back to its default. */
export function normalizeBuyPresets(value: unknown): number[] {
  const list = Array.isArray(value) ? value : [];
  return DEFAULT_BUY_PRESETS.slice(0, BUY_PRESET_COUNT).map((fallback, i) => {
    const v: unknown = list[i];
    return typeof v === 'number' && parsePresetInput(formatPreset(v)) === v ? v : fallback;
  });
}

/** Plain decimal text for a preset (never exponent notation). */
export function formatPreset(value: number): string {
  if (!Number.isFinite(value)) return '';
  return value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: SOL_DECIMALS });
}
