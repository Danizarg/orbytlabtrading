/**
 * Raw on-chain integer amounts → decimal-adjusted UI numbers.
 *
 * Token amounts and supplies arrive as u64 strings that can exceed 2^53
 * (BONK supply is 8.8e18 raw), so the split into whole/fraction happens in
 * bigint and only the final decimal string is converted to a JS number.
 */

const INTEGER_RE = /^-?\d+$/;

/** Parse a raw integer (bigint, safe integer number, or digit string) to bigint; undefined when invalid. */
export function toBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : undefined;
  if (typeof value === 'string' && INTEGER_RE.test(value.trim())) return BigInt(value.trim());
  return undefined;
}

/** Exact decimal string for a raw integer amount, e.g. (1234567n, 6) → '1.234567'. */
export function formatUnits(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Raw integer amount → UI number (undefined when the input is not a valid integer or decimals are invalid). */
export function rawToUi(raw: unknown, decimals: number): number | undefined {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return undefined;
  const value = toBigInt(raw);
  if (value === undefined) return undefined;
  const n = Number(formatUnits(value, decimals));
  return Number.isFinite(n) ? n : undefined;
}

/** Clamp an optional integer option into [min, max], falling back to `fallback` when absent/invalid. */
export function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}
