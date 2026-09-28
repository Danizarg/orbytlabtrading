import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getBase58Decoder, isAddress } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  base58ByteLength,
  explorer,
  isSignature,
  isSolanaAddress,
  LAMPORTS_PER_SOL,
  MINTS,
  PROGRAMS,
  shortAddress,
  STABLE_MINTS,
} from './solana';

/** Bytes → base58 string (via @solana/kit's codec, the reference implementation). */
const toBase58 = (bytes: Uint8Array): string => getBase58Decoder().decode(bytes);

/** Deterministic pseudo-random bytes (LCG) so failures are reproducible. */
function pseudoRandomBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

const readJson = (rel: string): unknown => JSON.parse(readFileSync(path.join(process.cwd(), rel), 'utf8'));

describe('base58ByteLength', () => {
  it('decodes byte lengths including leading zero bytes', () => {
    expect(base58ByteLength('1')).toBe(1);
    expect(base58ByteLength('z')).toBe(1);
    expect(base58ByteLength('5Q')).toBe(1); // 4 × 58 + 23 = 255
    expect(base58ByteLength('5R')).toBe(2); // 256
    expect(base58ByteLength('15Q')).toBe(2); // [0x00, 0xff]
    expect(base58ByteLength('11111111111111111111111111111111')).toBe(32);
    expect(base58ByteLength(MINTS.SOL)).toBe(32);
  });

  it('matches the reference encoder for 31, 32, 33 and 64 byte payloads', () => {
    for (const len of [1, 31, 32, 33, 64]) {
      for (let seed = 1; seed <= 20; seed++) {
        const bytes = pseudoRandomBytes(len, seed * 7919 + len);
        expect(base58ByteLength(toBase58(bytes)), `${len}/${seed}`).toBe(len);
      }
    }
  });

  it('returns -1 for non-base58 input', () => {
    for (const bad of ['', '0', 'O', 'I', 'l', 'abc+', ' So11', '0x5481']) expect(base58ByteLength(bad), bad).toBe(-1);
  });
});

describe('isSolanaAddress', () => {
  it('accepts real mints, programs and wallets', () => {
    for (const a of [...Object.values(MINTS), ...Object.values(PROGRAMS)]) expect(isSolanaAddress(a), a).toBe(true);
    expect(isSolanaAddress('11111111111111111111111111111111')).toBe(true); // System program (all-zero key)
    expect(isSolanaAddress('Hfy1ettvX6dv2xEhxtM7RithXYam3QCV6fHWfsLzdKA5')).toBe(true);
    expect(isSolanaAddress('dB98iqo6YQ2p1X1KtvmLRDFmtQauEiA2CtxL8cvpump')).toBe(true);
  });

  it('accepts every mint, curve and wallet in the PumpPortal create fixture', () => {
    const doc = readJson('tests/fixtures/pump/pumpportal_ws_subscribeNewToken_pump_create_events.json') as {
      events: Array<{ mint: string; traderPublicKey: string; bondingCurveKey?: string }>;
    };
    for (const e of doc.events) {
      expect(isSolanaAddress(e.mint), e.mint).toBe(true);
      expect(isSolanaAddress(e.traderPublicKey), e.traderPublicKey).toBe(true);
      if (e.bondingCurveKey) expect(isSolanaAddress(e.bondingCurveKey), e.bondingCurveKey).toBe(true);
    }
  });

  it('rejects base58 strings of the right length that do not decode to 32 bytes', () => {
    const b31 = toBase58(pseudoRandomBytes(31, 42).map((b, i) => (i === 0 ? b | 0x80 : b)));
    expect(b31.length).toBeGreaterThanOrEqual(32);
    expect(isSolanaAddress(b31)).toBe(false);

    const b33 = new Uint8Array(33);
    b33[0] = 1;
    b33[32] = 9;
    const s33 = toBase58(b33);
    expect(s33.length).toBe(44); // looks like an address by length alone
    expect(isSolanaAddress(s33)).toBe(false);

    expect(isSolanaAddress('1'.repeat(31))).toBe(false); // 31 zero bytes
    expect(isSolanaAddress('1'.repeat(33))).toBe(false); // 33 zero bytes
  });

  it('rejects malformed values and non-strings', () => {
    for (const bad of [
      '',
      'So1111111111111111111111111111111111111111O', // O is not base58
      `${MINTS.SOL} `,
      MINTS.SOL.slice(0, 31),
      `${MINTS.SOL}1`,
      '0x5481a8c9b8a9e5bdf2d7f5b0c8c1d0b5a1b2c3d4',
      null,
      undefined,
      12345,
      { address: MINTS.SOL },
    ]) {
      expect(isSolanaAddress(bad), String(bad)).toBe(false);
    }
  });

  it('agrees with @solana/kit isAddress on random 32-byte keys and random base58 strings', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const key = toBase58(pseudoRandomBytes(32, seed));
      expect(isSolanaAddress(key), key).toBe(true);
      expect(isAddress(key)).toBe(true);
      // Mutate one character: may or may not stay a 32-byte key, but both implementations must agree.
      const mutated = `${key.slice(0, -1)}${key.endsWith('z') ? '2' : 'z'}`;
      expect(isSolanaAddress(mutated), mutated).toBe(isAddress(mutated));
    }
  });
});

describe('isSignature', () => {
  it('accepts real transaction signatures', () => {
    const trades = readJson('tests/fixtures/geckoterminal/trades_pool.json') as { data: Array<{ attributes: { tx_hash: string } }> };
    const pump = readJson('tests/fixtures/pump/pumpportal_ws_subscribeNewToken_pump_create_events.json') as { events: Array<{ signature: string }> };
    const sigs = [...trades.data.map((t) => t.attributes.tx_hash), ...pump.events.map((e) => e.signature)];
    expect(sigs.length).toBeGreaterThan(3);
    for (const s of sigs) expect(isSignature(s), s).toBe(true);
  });

  it('accepts any 64-byte base58 payload, including leading zero bytes', () => {
    const zeroLead = new Uint8Array(64);
    zeroLead[63] = 1;
    expect(isSignature(toBase58(zeroLead))).toBe(true);
    for (let seed = 1; seed <= 50; seed++) expect(isSignature(toBase58(pseudoRandomBytes(64, seed)))).toBe(true);
  });

  it('rejects addresses, wrong byte lengths and non-strings', () => {
    expect(isSignature(MINTS.SOL)).toBe(false);
    expect(isSignature(toBase58(pseudoRandomBytes(63, 5).map((b, i) => (i === 0 ? b | 0x80 : b))))).toBe(false);
    expect(isSignature(toBase58(pseudoRandomBytes(65, 5).map((b, i) => (i === 0 ? b | 0x80 : b))))).toBe(false);
    expect(isSignature('')).toBe(false);
    expect(isSignature(undefined)).toBe(false);
    expect(isSignature(42)).toBe(false);
  });

  it('is disjoint from isSolanaAddress', () => {
    const sig = toBase58(pseudoRandomBytes(64, 9));
    expect(isSolanaAddress(sig)).toBe(false);
    expect(isSignature(MINTS.USDC)).toBe(false);
  });
});

describe('shortAddress', () => {
  it('keeps head and tail', () => {
    expect(shortAddress(MINTS.SOL)).toBe('So11…1112');
    expect(shortAddress(MINTS.USDC, 6, 3)).toBe('EPjFWd…t1v');
  });

  it('returns short strings unchanged', () => {
    expect(shortAddress('abcdefghi')).toBe('abcdefghi'); // 9 chars = head + tail + 1
    expect(shortAddress('abcdefghij')).toBe('abcd…ghij');
  });

  it('renders missing values as an em dash', () => {
    expect(shortAddress(undefined)).toBe('—');
    expect(shortAddress(null)).toBe('—');
    expect(shortAddress('')).toBe('—');
  });
});

describe('constants', () => {
  it('exposes consistent units and mints', () => {
    expect(LAMPORTS_PER_SOL).toBe(1_000_000_000);
    expect(STABLE_MINTS.has(MINTS.USDC)).toBe(true);
    expect(STABLE_MINTS.has(MINTS.USDT)).toBe(true);
    expect(STABLE_MINTS.has(MINTS.SOL)).toBe(false);
  });

  it('builds Solscan links', () => {
    expect(explorer.tx('sig')).toBe('https://solscan.io/tx/sig');
    expect(explorer.account(MINTS.SOL)).toBe(`https://solscan.io/account/${MINTS.SOL}`);
    expect(explorer.token(MINTS.USDC)).toBe(`https://solscan.io/token/${MINTS.USDC}`);
  });
});
