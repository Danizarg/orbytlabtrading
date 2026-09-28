/**
 * pump.fun bonding-curve constants and math, shared by the PumpPortal stream
 * (virtual reserves in UI units) and the on-chain BondingCurve decoder (raw
 * reserves, decimal-adjusted before calling these helpers).
 *
 * All token quantities are UI units (pump.fun tokens have 6 decimals; divide
 * raw u64 reserves by 1e6 first). Quote quantities are UI units of the curve's
 * quote mint (SOL for most curves, but USDC / PUMP-paired curves exist).
 *
 * Live-verified facts (2026-09-28, SOL, PUMP-paired and mayhem curves):
 * - initial real token reserves = 793,100,000; the curve completes when real
 *   token reserves reach 0.
 * - virtual − real token reserves = 279,900,000 on every curve, so progress can
 *   be derived from either reserve.
 * - Initial virtual quote reserves are NOT constant (30 SOL on classic curves,
 *   1.6–7 SOL on mayhem curves after agent adjustment), so SOL-based progress
 *   formulas are invalid; always use the token side.
 * - Mayhem curves can report real token reserves above 793.1M (negative
 *   progress), which is clamped to 0.
 * - After migration every reserve reads 0; use the account's `complete` flag.
 *
 * Every helper is NaN-safe and returns `undefined` instead of an invented value.
 */

/** pump.fun mint decimals. */
export const PUMP_TOKEN_DECIMALS = 6;

/** Standard pump.fun mint supply (UI). Mayhem coins mint 2,000,000,000; pass the actual supply when known. */
export const PUMP_STANDARD_SUPPLY = 1_000_000_000;

/** Tokens sellable on a pump.fun curve (initial real token reserves, UI). */
export const PUMP_INITIAL_REAL_TOKEN_RESERVES = 793_100_000;

/** Virtual − real token reserves (UI); constant for every pump.fun curve. */
export const PUMP_TOKEN_OFFSET = 279_900_000;

/** Initial virtual token reserves (UI) = real + offset. */
export const PUMP_INITIAL_VIRTUAL_TOKEN_RESERVES = PUMP_INITIAL_REAL_TOKEN_RESERVES + PUMP_TOKEN_OFFSET;

const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

const clampPct = (pct: number): number => Math.min(100, Math.max(0, pct));

/**
 * Bonding progress 0–100 from real token reserves (UI):
 * (793.1M − real) / 793.1M × 100, clamped. 0 reserves → 100 (complete).
 * Undefined for negative / non-finite input.
 */
export function progressFromRealTokens(realTokensUi: number): number | undefined {
  if (!isFiniteNumber(realTokensUi) || realTokensUi < 0) return undefined;
  return clampPct(((PUMP_INITIAL_REAL_TOKEN_RESERVES - realTokensUi) / PUMP_INITIAL_REAL_TOKEN_RESERVES) * 100);
}

/**
 * Bonding progress 0–100 from virtual token reserves (UI), e.g. PumpPortal's
 * `vTokensInBondingCurve`: (1 − (vTokens − 279.9M) / 793.1M) × 100, clamped.
 * Undefined for 0 / negative / non-finite input: a zeroed account (post
 * migration) or a missing field is ambiguous, so rely on `complete` instead.
 */
export function progressFromVirtualTokens(vTokensUi: number): number | undefined {
  if (!isFiniteNumber(vTokensUi) || vTokensUi <= 0) return undefined;
  return progressFromRealTokens(Math.max(0, vTokensUi - PUMP_TOKEN_OFFSET));
}

/**
 * Spot price per token in quote units from virtual reserves (UI units of both
 * sides): vQuote / vToken. Undefined when either reserve is 0 (migrated curve),
 * negative or non-finite — a price is never reported as 0.
 */
export function priceFromReserves(vQuoteUi: number, vTokenUi: number): number | undefined {
  if (!isFiniteNumber(vQuoteUi) || !isFiniteNumber(vTokenUi) || vQuoteUi <= 0 || vTokenUi <= 0) return undefined;
  const price = vQuoteUi / vTokenUi;
  return Number.isFinite(price) && price > 0 ? price : undefined;
}

/**
 * Market cap = price × supply (same quote unit as `price`). Pass the mint's
 * actual supply: PumpPortal's `marketCapSol` assumes 1B, which is 2× wrong for
 * mayhem coins. Undefined unless both inputs are finite and positive.
 */
export function marketCapFromPrice(price: number, supply: number): number | undefined {
  if (!isFiniteNumber(price) || !isFiniteNumber(supply) || price <= 0 || supply <= 0) return undefined;
  const mc = price * supply;
  return Number.isFinite(mc) ? mc : undefined;
}
