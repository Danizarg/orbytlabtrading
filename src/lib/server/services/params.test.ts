import { describe, expect, it } from 'vitest';
import { MINTS } from '@/lib/core/solana';
import { BadRequestError } from './errors';
import {
  optionalAddress,
  parseActivityCursor,
  parseAddressList,
  parseAmountRaw,
  parseDecimals,
  parseEnum,
  parseLimit,
  parseSlippageBps,
  parseUnixSeconds,
  requireAddress,
  requireSignature,
} from './params';

const MINT_A = '4ov9rwwS4iBHeTWGCrVaQYW1HzWK51MSfs8csGAApump';
const MINT_B = 'GJJ6TADXU6TdvBR8siNxLqYzbcwc6ixgxFCg7Ystpump';
// Real mainnet signature (tests/fixtures/solana-rpc/rpc_getSignaturesForAddress_bondingcurve.json).
const SIGNATURE = '5vkeqCReatk7bXc41f2WXfJGLacAo8ZkcJNqQfCNr1jQAovwJ6P8cuqg4TW6Hi3My4nszgpcBC4TkdmP8CAsSchk';

function expectBadRequest(fn: () => unknown, message?: RegExp) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestError);
    if (message) expect((error as Error).message).toMatch(message);
    return;
  }
  throw new Error('expected BadRequestError');
}

describe('requireAddress / optionalAddress', () => {
  it('accepts a valid address and trims it', () => {
    expect(requireAddress(` ${MINTS.SOL} `, 'mint')).toBe(MINTS.SOL);
    expect(optionalAddress(MINTS.USDC, 'pool')).toBe(MINTS.USDC);
  });

  it('rejects missing and invalid values without echoing input', () => {
    expectBadRequest(() => requireAddress(null, 'mint'), /mint is required/);
    expectBadRequest(() => requireAddress('   ', 'mint'), /mint is required/);
    expectBadRequest(() => requireAddress('<script>alert(1)</script>', 'mint'), /^mint must be a Solana address$/);
    expectBadRequest(() => requireAddress(SIGNATURE, 'mint'), /Solana address/);
    expectBadRequest(() => optionalAddress('0OIl', 'pool'), /pool must be a Solana address/);
  });

  it('treats a blank optional address as absent', () => {
    expect(optionalAddress(undefined, 'pool')).toBeUndefined();
    expect(optionalAddress('', 'pool')).toBeUndefined();
  });
});

describe('parseAddressList', () => {
  it('trims, drops empty parts and de-duplicates in first-seen order', () => {
    expect(parseAddressList(` ${MINT_B},${MINT_A},,${MINT_B} `, 'mints', 100)).toEqual([MINT_B, MINT_A]);
  });

  it('rejects any invalid entry, an empty list and too many unique entries', () => {
    expectBadRequest(() => parseAddressList(`${MINT_A},nope`, 'mints', 100), /invalid Solana address/);
    expectBadRequest(() => parseAddressList(',,', 'mints', 100), /mints is required/);
    expectBadRequest(() => parseAddressList(null, 'mints', 100), /mints is required/);
    expectBadRequest(() => parseAddressList(`${MINT_A},${MINT_B}`, 'mints', 1), /at most 1/);
  });

  it('counts duplicates once against the limit', () => {
    expect(parseAddressList(`${MINT_A},${MINT_A}`, 'mints', 1)).toEqual([MINT_A]);
  });
});

describe('requireSignature', () => {
  it('accepts a base58 signature and rejects addresses', () => {
    expect(requireSignature(SIGNATURE, 'signature')).toBe(SIGNATURE);
    expectBadRequest(() => requireSignature(MINT_A, 'signature'), /transaction signature/);
    expectBadRequest(() => requireSignature(undefined, 'signature'), /required/);
  });
});

describe('parseLimit', () => {
  const bounds = { fallback: 50, max: 100 };

  it('falls back when absent and clamps out-of-range integers', () => {
    expect(parseLimit(null, bounds)).toBe(50);
    expect(parseLimit('', bounds)).toBe(50);
    expect(parseLimit('20', bounds)).toBe(20);
    expect(parseLimit('1000', bounds)).toBe(100);
    expect(parseLimit('0', bounds)).toBe(1);
    expect(parseLimit('3', { fallback: 10, max: 100, min: 5 })).toBe(5);
  });

  it('rejects non-integers', () => {
    for (const bad of ['-1', '1.5', '1e3', 'abc', '10abc', '9999999999999999']) {
      expectBadRequest(() => parseLimit(bad, bounds), /limit must be a non-negative integer/);
    }
  });
});

describe('parseEnum', () => {
  const lists = ['trending', 'top'] as const;

  it('returns the matching value or the fallback', () => {
    expect(parseEnum('top', lists, 'list')).toBe('top');
    expect(parseEnum(null, lists, 'list', 'trending')).toBe('trending');
  });

  it('is case-sensitive and requires a value without fallback', () => {
    expectBadRequest(() => parseEnum('TOP', lists, 'list'), /list must be one of trending, top/);
    expectBadRequest(() => parseEnum(undefined, lists, 'list'), /list is required/);
  });
});

describe('parseUnixSeconds', () => {
  const now = Date.UTC(2026, 8, 29);

  it('accepts UNIX seconds up to a day ahead', () => {
    expect(parseUnixSeconds(null, 'before', now)).toBeUndefined();
    expect(parseUnixSeconds('1759000000', 'before', now)).toBe(1_759_000_000);
    expect(parseUnixSeconds(String(Math.floor(now / 1000) + 3_600), 'before', now)).toBe(Math.floor(now / 1000) + 3_600);
  });

  it('rejects milliseconds, zero and malformed values', () => {
    expectBadRequest(() => parseUnixSeconds(String(now), 'before', now), /UNIX timestamp in seconds/);
    expectBadRequest(() => parseUnixSeconds('0', 'before', now), /UNIX timestamp in seconds/);
    expectBadRequest(() => parseUnixSeconds('17.5', 'before', now), /non-negative integer/);
  });
});

describe('parseAmountRaw', () => {
  it('returns a canonical positive u64 string', () => {
    expect(parseAmountRaw('1000000000')).toBe('1000000000');
    expect(parseAmountRaw('0001')).toBe('1');
    expect(parseAmountRaw('18446744073709551615')).toBe('18446744073709551615');
  });

  it('rejects zero, signs, decimals and values beyond u64', () => {
    for (const bad of ['0', '000', '-5', '1.5', '1e9', 'abc', '18446744073709551616', '123456789012345678901']) {
      expectBadRequest(() => parseAmountRaw(bad), /positive integer string/);
    }
    expectBadRequest(() => parseAmountRaw(null), /amountRaw is required/);
  });
});

describe('parseDecimals / parseSlippageBps', () => {
  it('accepts u8 decimals and requires them', () => {
    expect(parseDecimals('0', 'inputDecimals')).toBe(0);
    expect(parseDecimals('9', 'inputDecimals')).toBe(9);
    expectBadRequest(() => parseDecimals('256', 'inputDecimals'), /between 0 and 255/);
    expectBadRequest(() => parseDecimals(null, 'inputDecimals'), /inputDecimals is required/);
  });

  it('accepts optional slippage within 0..10000 bps', () => {
    expect(parseSlippageBps(null)).toBeUndefined();
    expect(parseSlippageBps('50')).toBe(50);
    expect(parseSlippageBps('10000')).toBe(10_000);
    expectBadRequest(() => parseSlippageBps('10001'), /between 0 and 10000/);
    expectBadRequest(() => parseSlippageBps('-1'), /non-negative integer/);
  });
});

describe('parseActivityCursor', () => {
  it('accepts a signature cursor on every path', () => {
    expect(parseActivityCursor(SIGNATURE, { allowOpaque: false })).toBe(SIGNATURE);
    expect(parseActivityCursor(null, { allowOpaque: false })).toBeUndefined();
  });

  it('accepts opaque Helius tokens only when Helius history is active', () => {
    expect(parseActivityCursor('348572918:15', { allowOpaque: true })).toBe('348572918:15');
    expectBadRequest(() => parseActivityCursor('348572918:15', { allowOpaque: false }), /cursor returned by a previous page/);
    expectBadRequest(() => parseActivityCursor('a b', { allowOpaque: true }), /cursor/);
    expectBadRequest(() => parseActivityCursor('x'.repeat(201), { allowOpaque: true }), /cursor/);
  });
});
