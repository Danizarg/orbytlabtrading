import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PoolInfo } from '@/lib/core/types';
import { comparePools, compact, deriveLaunch, parsePair, parsePairs, safeUrl, toPoolInfo, toTokenMarket } from './parse';

function fixture(name: string): unknown[] {
  const body: unknown = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/dexscreener', name), 'utf8'));
  if (!Array.isArray(body)) throw new Error(`${name} is not an array`);
  return body;
}

const PUMP_MINT = '8T193DFGTGcimGaotbnYdHTsTRGgLAaiy3sMGgL6pump';

describe('parsePair', () => {
  it('parses decimal strings and keeps percentages / USD / ms units', () => {
    const [first] = fixture('tokens-v1.solana.mixed-dexids.json');
    const p = parsePair(first);
    expect(p).toBeDefined();
    expect(p?.priceNative).toBe(0.00000002954);
    expect(p?.priceUsd).toBe(0.000003509);
    expect(p?.priceChange.m5).toBe(-78.19);
    expect(p?.volume.m5).toBe(10320.25);
    expect(p?.txns.h24).toEqual({ buys: 735, sells: 628 });
    expect(p?.createdAt).toBe(1790627602000);
    expect(p?.liquidityUsd).toBeUndefined();
    expect(p?.venue).toMatchObject({ dex: 'pumpfun', isBondingCurve: true, launchpad: 'pump.fun' });
  });

  it('returns undefined when identity fields are missing', () => {
    expect(parsePair(null)).toBeUndefined();
    expect(parsePair('<html>400</html>')).toBeUndefined();
    expect(parsePair({ pairAddress: 'x' })).toBeUndefined();
    expect(parsePair({ baseToken: { address: 'y' } })).toBeUndefined();
  });

  it('omits invalid, empty, zero and non-numeric values instead of inventing them', () => {
    const p = parsePair({
      pairAddress: 'P',
      baseToken: { address: 'B', symbol: '' },
      priceUsd: '0',
      priceNative: 'abc',
      marketCap: null,
      fdv: -5,
      liquidity: { usd: '1234.5' },
      txns: { m5: { buys: '3' }, h1: 'bad' },
      volume: { h24: 'NaN' },
      priceChange: {},
    });
    expect(p).toBeDefined();
    expect(p?.base.symbol).toBeUndefined();
    expect(p?.priceUsd).toBeUndefined();
    expect(p?.priceNative).toBeUndefined();
    expect(p?.marketCapUsd).toBeUndefined();
    expect(p?.fdvUsd).toBeUndefined();
    expect(p?.liquidityUsd).toBe(1234.5);
    expect(p?.txns).toEqual({ m5: { buys: 3, sells: undefined } });
    expect(p?.volume).toEqual({});
    expect(p?.priceChange).toEqual({});
    expect(p?.venue).toEqual({ dex: 'unknown', label: 'Unknown', isBondingCurve: false });
  });

  it('maps verified socials [{type,url}] / websites [{label,url}] and rejects unsafe URLs', () => {
    const p = parsePair({
      pairAddress: 'P',
      baseToken: { address: 'B' },
      info: {
        imageUrl: 'http://insecure.example/logo.png',
        websites: [
          { label: 'Docs', url: 'https://docs.example' },
          { label: 'Website', url: 'https://example.org' },
        ],
        socials: [
          { type: 'twitter', url: 'javascript:alert(1)' },
          { type: 'x', url: 'https://x.com/example' },
          { type: 'telegram', url: 'https://t.me/example' },
          { type: 'discord', url: 'https://discord.gg/example' },
          { type: 'tiktok', url: 'https://tiktok.com/@example' },
        ],
      },
    });
    expect(p?.imageUrl).toBeUndefined();
    expect(p?.socials).toEqual({
      website: 'https://example.org',
      twitter: 'https://x.com/example',
      telegram: 'https://t.me/example',
      discord: 'https://discord.gg/example',
    });
  });
});

describe('safeUrl', () => {
  it('accepts http(s) only', () => {
    expect(safeUrl('https://a.b/c')).toBe('https://a.b/c');
    expect(safeUrl('http://a.b')).toBe('http://a.b');
    expect(safeUrl('http://a.b', true)).toBeUndefined();
    expect(safeUrl('data:image/png;base64,xx')).toBeUndefined();
    expect(safeUrl('not a url')).toBeUndefined();
    expect(safeUrl(42)).toBeUndefined();
  });
});

describe('compact', () => {
  it('drops undefined keys only', () => {
    expect(compact({ a: 1, b: undefined, c: 0, d: null })).toEqual({ a: 1, c: 0, d: null });
    expect('b' in compact({ a: 1, b: undefined })).toBe(false);
  });
});

describe('deriveLaunch', () => {
  it('detects a pump.fun graduation and marks the curve pair frozen', () => {
    const pairs = parsePairs(fixture('token-pairs-v1.solana.migrated-pump-token.dlmm+pumpswap+pumpfun.json'));
    const { state, frozenPairs } = deriveLaunch(PUMP_MINT, pairs);
    expect(state).toEqual({
      stage: 'graduated',
      launchpad: 'pump.fun',
      migratedPool: 'BuaA3jui2qmGDkdTF7Eut8pKbgsyhH4okQopUVXWg7G2',
      graduatedAt: 1790626194000,
    });
    expect([...frozenPairs]).toEqual(['GVgC42Ds7sB9KEYCTrFzr9HZFd9nxEmWLN3pZuAZvcQ2']);
  });

  it('does not invent a migration into a foreign side pool (quiet pump.fun curve + DLMM only)', () => {
    const pairs = parsePairs(fixture('token-pairs-v1.solana.migrated-pump-token.dlmm+pumpswap+pumpfun.json'));
    const withoutPumpSwap = pairs.filter((p) => p.venue.dex !== 'pumpswap');
    expect(withoutPumpSwap.map((p) => p.venue.dex)).toEqual(['meteora-dlmm', 'pumpfun']);
    const { state, frozenPairs } = deriveLaunch(PUMP_MINT, withoutPumpSwap);
    expect(state).toEqual({ stage: 'bonding', launchpad: 'pump.fun' });
    expect(frozenPairs.size).toBe(0);
  });

  it('returns unknown when the mint is never the base token', () => {
    const pairs = parsePairs(fixture('token-pairs-v1.solana.token-as-quote-pumpfun-nonsol-quote.json'));
    expect(deriveLaunch('9AvytnUKsLxPxFHFqS6VLxaxt5p6BhYNr53SD2Chpump', pairs).state).toEqual({ stage: 'unknown' });
    expect(deriveLaunch('anything', []).state).toEqual({ stage: 'unknown' });
  });
});

describe('toTokenMarket / toPoolInfo', () => {
  it('omits priceSol when the quote is not WSOL and omits empty windows', () => {
    const [, usdc] = parsePairs(fixture('tokens-v1.solana.jup-usdc.json'));
    expect(usdc).toBeDefined();
    if (!usdc) return;
    const m = toTokenMarket(usdc, 123);
    expect(m.priceUsd).toBe(1.00037);
    expect('priceSol' in m).toBe(false);
    expect(m.updatedAt).toBe(123);
    expect(m.source).toBe('dexscreener');
  });

  it('drops price fields of a frozen curve but keeps its real history', () => {
    const pairs = parsePairs(fixture('token-pairs-v1.solana.migrated-pump-token.pumpswap+pumpfun.json'));
    const curve = pairs.find((p) => p.venue.dex === 'pumpfun');
    expect(curve).toBeDefined();
    if (!curve) return;
    const pool = toPoolInfo(curve, true);
    expect(pool).not.toHaveProperty('priceUsd');
    expect(pool).not.toHaveProperty('priceNative');
    expect(pool).not.toHaveProperty('marketCapUsd');
    expect(pool).not.toHaveProperty('fdvUsd');
    expect(pool.volume24hUsd).toBe(50658.42);
    expect(pool.txns24h).toEqual({ buys: 268, sells: 118 });
  });
});

describe('comparePools', () => {
  it('orders by liquidity desc, unknown liquidity after, bonding curves last', () => {
    const mk = (address: string, extra: Partial<PoolInfo>): PoolInfo => ({
      address,
      dex: 'x',
      dexLabel: 'X',
      baseMint: 'm',
      source: 'dexscreener',
      ...extra,
    });
    const pools = [
      mk('curve', { isBondingCurve: true, volume24hUsd: 1e9 }),
      mk('noLiq', { isBondingCurve: false }),
      mk('small', { isBondingCurve: false, liquidityUsd: 10 }),
      mk('big', { isBondingCurve: false, liquidityUsd: 1000 }),
    ];
    expect(pools.sort(comparePools).map((p) => p.address)).toEqual(['big', 'small', 'noLiq', 'curve']);
  });
});
