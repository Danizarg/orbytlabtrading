import 'server-only';
import { isSignature, isSolanaAddress } from '@/lib/core/solana';
import { BadRequestError } from './errors';

/**
 * Query / path parameter parsing for the /api/v1 routes. Every helper either
 * returns a validated value or throws BadRequestError (→ HTTP 400). Absent
 * optional parameters fall back to defaults; present-but-invalid ones are
 * rejected rather than silently ignored.
 */

type Raw = string | null | undefined;

/** Trimmed value, or undefined when absent/blank. */
function present(value: Raw): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

export function requireAddress(value: Raw, name: string): string {
  const v = present(value);
  if (!v) throw new BadRequestError(`${name} is required`);
  if (!isSolanaAddress(v)) throw new BadRequestError(`${name} must be a Solana address`);
  return v;
}

export function optionalAddress(value: Raw, name: string): string | undefined {
  const v = present(value);
  if (v === undefined) return undefined;
  if (!isSolanaAddress(v)) throw new BadRequestError(`${name} must be a Solana address`);
  return v;
}

/**
 * Comma-separated addresses: trimmed, de-duplicated (first occurrence order),
 * at least one and at most `max` unique entries, every entry valid.
 */
export function parseAddressList(value: Raw, name: string, max: number): string[] {
  const v = present(value);
  if (!v) throw new BadRequestError(`${name} is required`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of v.split(',')) {
    const item = part.trim();
    if (!item) continue;
    if (!isSolanaAddress(item)) throw new BadRequestError(`${name} contains an invalid Solana address`);
    if (seen.has(item)) continue;
    // Stop at the first extra entry instead of base58-decoding an arbitrarily long list.
    if (out.length === max) throw new BadRequestError(`${name} accepts at most ${max} addresses`);
    seen.add(item);
    out.push(item);
  }
  if (!out.length) throw new BadRequestError(`${name} is required`);
  return out;
}

export function requireSignature(value: Raw, name: string): string {
  const v = present(value);
  if (!v) throw new BadRequestError(`${name} is required`);
  if (!isSignature(v)) throw new BadRequestError(`${name} must be a transaction signature`);
  return v;
}

/** Non-negative integer string (no sign, no decimals, no exponent). */
function parseUint(value: string, name: string): number {
  if (!/^\d{1,15}$/.test(value)) throw new BadRequestError(`${name} must be a non-negative integer`);
  return Number(value);
}

/** Integer limit: absent → fallback; out of range → clamped; malformed → 400. */
export function parseLimit(value: Raw, opts: { fallback: number; max: number; min?: number }, name = 'limit'): number {
  const v = present(value);
  if (v === undefined) return opts.fallback;
  const n = parseUint(v, name);
  return Math.min(opts.max, Math.max(opts.min ?? 1, n));
}

/** One of `allowed`; absent → fallback (or 400 when no fallback is given). */
export function parseEnum<T extends string>(value: Raw, allowed: readonly T[], name: string, fallback?: T): T {
  const v = present(value);
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new BadRequestError(`${name} is required (${allowed.join(', ')})`);
  }
  const match = allowed.find((a) => a === v);
  if (match === undefined) throw new BadRequestError(`${name} must be one of ${allowed.join(', ')}`);
  return match;
}

/** Latest accepted timestamp: a day into the future absorbs client clock skew. */
const MAX_FUTURE_S = 86_400;

/** Optional UNIX-seconds timestamp (e.g. a candle `before` cursor). Millisecond values are rejected. */
export function parseUnixSeconds(value: Raw, name: string, now: number = Date.now()): number | undefined {
  const v = present(value);
  if (v === undefined) return undefined;
  const n = parseUint(v, name);
  if (n <= 0 || n > Math.floor(now / 1000) + MAX_FUTURE_S) throw new BadRequestError(`${name} must be a UNIX timestamp in seconds`);
  return n;
}

const U64_MAX = 18_446_744_073_709_551_615n;

/** Raw token amount in base units: a positive integer that fits in a u64, returned canonical (no leading zeros). */
export function parseAmountRaw(value: Raw, name = 'amountRaw'): string {
  const v = present(value);
  if (!v) throw new BadRequestError(`${name} is required`);
  if (!/^\d{1,20}$/.test(v)) throw new BadRequestError(`${name} must be a positive integer string`);
  const n = BigInt(v);
  if (n <= 0n || n > U64_MAX) throw new BadRequestError(`${name} must be a positive integer string`);
  return n.toString();
}

/** SPL token decimals (u8). */
export function parseDecimals(value: Raw, name: string): number {
  const v = present(value);
  if (v === undefined) throw new BadRequestError(`${name} is required`);
  const n = parseUint(v, name);
  if (n > 255) throw new BadRequestError(`${name} must be between 0 and 255`);
  return n;
}

/** Optional slippage in basis points, 0–10,000. */
export function parseSlippageBps(value: Raw, name = 'slippageBps'): number | undefined {
  const v = present(value);
  if (v === undefined) return undefined;
  const n = parseUint(v, name);
  if (n > 10_000) throw new BadRequestError(`${name} must be between 0 and 10000`);
  return n;
}

/** Helius pagination tokens are opaque but short and URL-safe. */
const OPAQUE_CURSOR = /^[A-Za-z0-9:._\-+/=]{1,200}$/;

/**
 * Wallet-activity cursor: a transaction signature, or (only when the Helius
 * indexed history is active) an opaque Helius pagination token.
 */
export function parseActivityCursor(value: Raw, opts: { allowOpaque: boolean }, name = 'before'): string | undefined {
  const v = present(value);
  if (v === undefined) return undefined;
  if (isSignature(v)) return v;
  if (opts.allowOpaque && OPAQUE_CURSOR.test(v)) return v;
  throw new BadRequestError(`${name} must be a cursor returned by a previous page`);
}
