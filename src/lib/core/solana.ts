/**
 * Solana constants and pure helpers shared by server and client code.
 * No network access here.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000;

export const MINTS = {
  /** Wrapped SOL (also used by providers to mean native SOL). */
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
} as const;

export const PROGRAMS = {
  TOKEN: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN_2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  /** pump.fun bonding-curve program. */
  PUMP: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  /** PumpSwap AMM (pump.fun migration destination). */
  PUMP_AMM: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
} as const;

/** Quote assets whose value we can express in USD without a pool lookup. */
export const STABLE_MINTS: ReadonlySet<string> = new Set([MINTS.USDC, MINTS.USDT]);

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((c, i) => [c, i]));
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Decoded byte length of a base58 string, or -1 if invalid. */
export function base58ByteLength(s: string): number {
  if (!s || !BASE58_RE.test(s)) return -1;
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(BASE58_MAP.get(c) ?? 0);
  let len = 0;
  while (n > 0n) {
    len++;
    n >>= 8n;
  }
  let leadingZeros = 0;
  while (leadingZeros < s.length && s[leadingZeros] === '1') leadingZeros++;
  return len + leadingZeros;
}

/** True for a base58 string that decodes to exactly 32 bytes (a public key / mint). */
export function isSolanaAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 32 && value.length <= 44 && base58ByteLength(value) === 32;
}

/** True for a base58 transaction signature (64 bytes). */
export function isSignature(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 64 && value.length <= 90 && base58ByteLength(value) === 64;
}

export function shortAddress(address: string | undefined | null, head = 4, tail = 4): string {
  if (!address) return '—';
  return address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`;
}

export const explorer = {
  tx: (signature: string) => `https://solscan.io/tx/${signature}`,
  account: (address: string) => `https://solscan.io/account/${address}`,
  token: (mint: string) => `https://solscan.io/token/${mint}`,
};
