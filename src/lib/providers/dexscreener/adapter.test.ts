import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProviderId } from '@/lib/core/providers';
import { isSolanaAddress, MINTS } from '@/lib/core/solana';
import { isProviderError, ProviderError } from '@/lib/net/errors';
import type { JsonFetcher, JsonRequest } from '@/lib/net/types';
import { createDexScreener, DEXSCREENER_BATCH_LIMIT } from './index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/dexscreener', name), 'utf8'));
}

function fixtureArray(name: string): Array<Record<string, unknown>> {
  const body = fixture(name);
  if (!Array.isArray(body)) throw new Error(`${name} is not an array`);
  return body as Array<Record<string, unknown>>;
}

interface Call {
  provider: ProviderId;
  url: string;
  init?: JsonRequest;
}

type Responder = (url: string, init?: JsonRequest) => unknown;

/** Fake transport: first route whose substring matches the URL answers (Error → reject). */
function fakeFetcher(routes: Array<[match: string, respond: Responder | unknown]>) {
  const calls: Call[] = [];
  const fetcher: JsonFetcher = async <T>(provider: ProviderId, url: string, init?: JsonRequest): Promise<T> => {
    calls.push({ provider, url, init });
    for (const [match, respond] of routes) {
      if (!url.includes(match)) continue;
      const value: unknown = typeof respond === 'function' ? (respond as Responder)(url, init) : respond;
      if (value instanceof Error) throw value;
      return structuredClone(value) as T;
    }
    throw new Error(`unexpected URL in test: ${url}`);
  };
  return { fetcher, calls };
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Deterministic valid 32-byte base58 address. */
function fakeAddress(i: number): string {
  const bytes = new Uint8Array(32).fill(7);
  bytes[0] = (i % 250) + 1;
  bytes[31] = i % 256;
  bytes[30] = Math.floor(i / 256);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58.charAt(Number(n % 58n)) + s;
    n /= 58n;
  }
  return s;
}

/** Addresses in the path segment after `/solana/`. */
function pathAddresses(url: string): string[] {
  const segment = url.split('/solana/')[1] ?? '';
  return segment ? segment.split(',') : [];
}

async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (e) {
    if (isProviderError(e)) return e;
    throw e;
  }
  throw new Error('expected rejection');
}

const KOLPACKS = 'FtvDpvtyVepN9YFhwymwQRC3oEuig57kiDxBSMgkpump';
const PXMR = 'B5R7Xt9pXBHDAs2jkJ67nM2Wwch1napBsdzMxk56qpJk';
const ONE_PCT = 'Dvx47FCHEa77thmxtgzfyx35vq3cPvy2D7mZfpCzVwUP';
const TWM = 'CS2T1HQRPCXaYR5V3SNDb5ceERwZg1Nb5uuw6Dg5hpsn';
const MIXED = [KOLPACKS, PXMR, ONE_PCT, TWM];
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** Real USDT mint as reported by DEX Screener. */
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const CATEMAS = '8LmvqLQhC53pqTyChaGLUCYJgMrcAGiKN8FGEm8Gpump';
const FOMO = '8T193DFGTGcimGaotbnYdHTsTRGgLAaiy3sMGgL6pump';
const BONK_USD1 = '5H1jkA7erRxwD8uqH8KimMD74ctjUYBd32rbp2jubonk';
const SIXTY_SEVEN = '9AvytnUKsLxPxFHFqS6VLxaxt5p6BhYNr53SD2Chpump';

// ---------------------------------------------------------------------------

describe('createDexScreener', () => {
  it('has provider id dexscreener and honours a custom base URL', async () => {
    const { fetcher, calls } = fakeFetcher([['/token-pairs/v1/', fixture('token-pairs-v1.solana.jup.json')]]);
    const ds = createDexScreener({ fetcher, baseUrl: 'https://proxy.test/ds/' });
    expect(ds.id).toBe('dexscreener');
    await ds.getPools(JUP);
    expect(calls[0]?.url).toBe(`https://proxy.test/ds/token-pairs/v1/solana/${JUP}`);
  });
});

describe('getMarkets (/tokens/v1)', () => {
  it('normalizes the mixed-dexids payload: string prices, USD, percent, per-window stats', async () => {
    const { fetcher, calls } = fakeFetcher([['/tokens/v1/solana/', fixture('tokens-v1.solana.mixed-dexids.json')]]);
    const ds = createDexScreener({ fetcher });
    const before = Date.now();
    const res = await ds.getMarkets(MIXED);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toBe('dexscreener');
    expect(calls[0]?.url).toBe(`https://api.dexscreener.com/tokens/v1/solana/${MIXED.join(',')}`);
    expect(calls[0]?.init?.cacheMs).toBe(15_000);
    expect(calls[0]?.init?.label).toMatch(/^dexscreener /);

    expect(res.source).toBe('dexscreener');
    expect(res.freshness).toBe('indexed');
    expect(res.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(res.notes).toBeUndefined();
    expect(Object.keys(res.data).sort()).toEqual([...MIXED].sort());

    const kol = res.data[KOLPACKS];
    expect(kol).toEqual({
      mint: KOLPACKS,
      priceUsd: 0.000003509,
      priceSol: 0.00000002954,
      marketCapUsd: 3509.12,
      fdvUsd: 3509.12,
      stats: {
        m5: { buys: 85, sells: 174, volumeUsd: 10320.25, priceChangePct: -78.19 },
        h1: { buys: 735, sells: 628, volumeUsd: 62302.97, priceChangePct: -22.3 },
        h6: { buys: 735, sells: 628, volumeUsd: 62302.97, priceChangePct: -22.3 },
        h24: { buys: 735, sells: 628, volumeUsd: 62302.97, priceChangePct: -22.3 },
      },
      updatedAt: res.fetchedAt,
      source: 'dexscreener',
    });
    // Bonding curves have no liquidity object: omitted, never 0.
    expect(kol).not.toHaveProperty('liquidityUsd');
    expect(kol).not.toHaveProperty('holders');

    const twm = res.data[TWM];
    expect(twm?.liquidityUsd).toBe(45939.64);
    expect(twm?.priceSol).toBe(0.0000007836);
    expect(twm?.stats.h6).toEqual({ buys: 94, sells: 123, volumeUsd: 5357.11, priceChangePct: 0.63 });
  });

  it('skips a token that is only the QUOTE of the returned pair and drops unknown mints silently', async () => {
    const unknown = fakeAddress(1);
    const { fetcher } = fakeFetcher([['/tokens/v1/solana/', fixture('tokens-v1.solana.jup-usdc.json')]]);
    const res = await createDexScreener({ fetcher }).getMarkets([JUP, USDT, unknown]);
    expect(Object.keys(res.data)).toEqual([JUP]);
    expect(res.data[JUP]?.liquidityUsd).toBe(805020.63);
  });

  it('only sets priceSol when the quote is WSOL', async () => {
    const { fetcher } = fakeFetcher([['/tokens/v1/solana/', fixture('tokens-v1.solana.jup-usdc.json')]]);
    const res = await createDexScreener({ fetcher }).getMarkets([JUP, USDC]);
    expect(res.data[JUP]?.priceSol).toBe(0.002772);
    expect(res.data[USDC]?.priceUsd).toBe(1.00037);
    expect(res.data[USDC]).not.toHaveProperty('priceSol');
    // priceChange only carried h6/h24 for this pair: other windows keep counts/volume only.
    expect(res.data[USDC]?.stats.m5).not.toHaveProperty('priceChangePct');
  });

  it('makes no request for empty / invalid input and de-duplicates mints', async () => {
    const { fetcher, calls } = fakeFetcher([['/tokens/v1/solana/', []]]);
    const ds = createDexScreener({ fetcher });
    const empty = await ds.getMarkets([]);
    expect(empty.data).toEqual({});
    expect(calls).toHaveLength(0);

    await ds.getMarkets(['not-a-mint', 'a/b?c', ` ${JUP} `, JUP]);
    expect(calls).toHaveLength(1);
    expect(pathAddresses(calls[0]?.url ?? '')).toEqual([JUP]);
  });

  it('never fabricates values for sparse pairs (missing priceUsd, liquidity, info, priceChange)', async () => {
    const mint = fakeAddress(2);
    const sparse = {
      chainId: 'solana',
      dexId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
      pairAddress: fakeAddress(3),
      baseToken: { address: mint, symbol: 'SPRS' },
      quoteToken: { address: fakeAddress(4), symbol: 'ODD' },
      priceNative: '0.5',
      txns: {},
      volume: {},
      priceChange: {},
    };
    const { fetcher } = fakeFetcher([['/tokens/v1/solana/', [sparse]]]);
    const ds = createDexScreener({ fetcher });
    const markets = await ds.getMarkets([mint]);
    expect(markets.data[mint]).toEqual({ mint, stats: {}, updatedAt: markets.fetchedAt, source: 'dexscreener' });

    const rows = await ds.getRows([mint]);
    const row = rows.data[0];
    expect(row?.token).toEqual({ mint, symbol: 'SPRS' });
    // Unknown DEX emitted as a raw program address passes through with a short label.
    expect(row?.pool).toEqual({ address: sparse.pairAddress, dex: sparse.dexId, dexLabel: 'pAMM…fXEA', quoteSymbol: 'ODD' });
  });
});

describe('batching at 30', () => {
  it('chunks /tokens/v1 requests to at most 30 addresses (31 → 30 + 1, 61 → 30 + 30 + 1)', async () => {
    const mints = Array.from({ length: 61 }, (_, i) => fakeAddress(i + 10));
    expect(mints.every((m) => isSolanaAddress(m))).toBe(true);
    expect(new Set(mints).size).toBe(61);

    const { fetcher, calls } = fakeFetcher([['/tokens/v1/solana/', []]]);
    const ds = createDexScreener({ fetcher });

    await ds.getMarkets(mints.slice(0, 31));
    expect(calls.map((c) => pathAddresses(c.url).length)).toEqual([30, 1]);

    calls.length = 0;
    await ds.getRows(mints);
    expect(calls.map((c) => pathAddresses(c.url).length)).toEqual([30, 30, 1]);
    expect(calls.flatMap((c) => pathAddresses(c.url))).toEqual(mints);
    expect(DEXSCREENER_BATCH_LIMIT).toBe(30);
  });

  it('chunks /latest/dex/pairs requests (31 pair addresses would be an HTTP 400 upstream)', async () => {
    const pairs = Array.from({ length: 31 }, (_, i) => fakeAddress(i + 100));
    const { fetcher, calls } = fakeFetcher([
      [
        '/latest/dex/pairs/solana/',
        (url: string) =>
          pathAddresses(url).length > 30
            ? new ProviderError('dexscreener', 'http', 'dexscreener pairs: HTTP 400', { status: 400 })
            : fixture('latest-dex-pairs.solana.not-found.json'),
      ],
    ]);
    const res = await createDexScreener({ fetcher }).getPairs(pairs);
    expect(calls.map((c) => pathAddresses(c.url).length)).toEqual([30, 1]);
    expect(res.data).toEqual([]);
    expect(res.notes).toBeUndefined();
  });

  it('keeps successful chunks and notes the failed ones', async () => {
    const mints = [KOLPACKS, ...Array.from({ length: 30 }, (_, i) => fakeAddress(i + 200))];
    const { fetcher } = fakeFetcher([
      [
        '/tokens/v1/solana/',
        (url: string) =>
          pathAddresses(url).includes(KOLPACKS)
            ? fixture('tokens-v1.solana.mixed-dexids.json')
            : new ProviderError('dexscreener', 'rate_limited', 'dexscreener tokens: HTTP 429', { status: 429 }),
      ],
    ]);
    const res = await createDexScreener({ fetcher }).getMarkets(mints);
    expect(Object.keys(res.data)).toEqual([KOLPACKS]);
    expect(res.notes).toHaveLength(1);
    expect(res.notes?.[0]).toContain('1 of 2 batches failed');
    expect(res.notes?.[0]).toContain('rate limited');
  });

  it('rejects when every chunk fails, and propagates aborts', async () => {
    const rateLimited = fakeFetcher([
      ['/tokens/v1/', new ProviderError('dexscreener', 'rate_limited', 'dexscreener tokens: HTTP 429', { status: 429 })],
    ]);
    const err = await rejection(createDexScreener({ fetcher: rateLimited.fetcher }).getMarkets([JUP]));
    expect(err.code).toBe('rate_limited');

    const mints = [JUP, ...Array.from({ length: 30 }, (_, i) => fakeAddress(i + 300))];
    const aborting = fakeFetcher([
      [
        '/tokens/v1/',
        (url: string) =>
          pathAddresses(url).includes(JUP)
            ? fixture('tokens-v1.solana.jup-usdc.json')
            : new ProviderError('dexscreener', 'aborted', 'dexscreener tokens: aborted'),
      ],
    ]);
    const aborted = await rejection(createDexScreener({ fetcher: aborting.fetcher }).getMarkets(mints));
    expect(aborted.code).toBe('aborted');
  });

  it('forwards the AbortSignal to the transport', async () => {
    const { fetcher, calls } = fakeFetcher([['/tokens/v1/', []]]);
    const controller = new AbortController();
    await createDexScreener({ fetcher }).getMetadata([JUP], controller.signal);
    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });
});

describe('getRows', () => {
  it('normalizes dex ids (pumpfun, pumpswap, meteora DBC, raydium CLMM) and keeps request order', async () => {
    const { fetcher } = fakeFetcher([['/tokens/v1/solana/', fixture('tokens-v1.solana.mixed-dexids.json')]]);
    const res = await createDexScreener({ fetcher }).getRows([...MIXED].reverse());
    expect(res.data.map((r) => r.token.mint)).toEqual([TWM, ONE_PCT, PXMR, KOLPACKS]);
    expect(res.data.map((r) => r.pool)).toEqual([
      { address: '5hc8GruCvLQQd8mw85Ai1nV6v1tyuA9a8HMt1quTNA6', dex: 'raydium-clmm', dexLabel: 'Raydium CLMM', quoteSymbol: 'SOL' },
      { address: '42v7DBnWH16M8ARkDcg815hmsuwKQxWR8waEUtct7ZjK', dex: 'meteora-dbc', dexLabel: 'Meteora DBC', quoteSymbol: 'SOL' },
      { address: 'G5sqxttkSJv5wcj47Y4CPRDuqsPCZy7jCLuBQ7MyXhJ9', dex: 'pumpswap', dexLabel: 'PumpSwap', quoteSymbol: 'SOL' },
      { address: 'FFk6jzJsqNBgRprDTUChNeULXyK4mGtN6SidFPWc8YSB', dex: 'pumpfun', dexLabel: 'Pump.fun', quoteSymbol: 'SOL' },
    ]);
  });

  it('builds token identity, image, socials, createdAt and bonding stage', async () => {
    const { fetcher } = fakeFetcher([['/tokens/v1/solana/', fixture('tokens-v1.solana.mixed-dexids.json')]]);
    const res = await createDexScreener({ fetcher }).getRows(MIXED);
    const byMint = new Map(res.data.map((r) => [r.token.mint, r] as const));

    const kol = byMint.get(KOLPACKS);
    expect(kol?.token).toEqual({
      mint: KOLPACKS,
      symbol: 'KolPacks',
      name: 'KolPacks',
      image: 'https://cdn.dexscreener.com/cms/images/6SFwyNnBHnkT080I?width=800&height=800&quality=95&format=auto',
      createdAt: 1790627602000,
      socials: { website: 'https://kolpacks.fun' },
      launchpad: { stage: 'bonding', launchpad: 'pump.fun' },
    });
    expect(kol?.market.marketCapUsd).toBe(3509.12);

    expect(byMint.get(ONE_PCT)?.token.launchpad).toEqual({ stage: 'bonding', launchpad: 'Meteora DBC' });
    expect(byMint.get(ONE_PCT)?.token.socials).toEqual({ twitter: 'https://x.com/drilladev/status/2104670951585821040' });
    // An AMM main pair alone cannot tell graduated from plain AMM: stage omitted.
    expect(byMint.get(PXMR)?.token).not.toHaveProperty('launchpad');
    expect(byMint.get(TWM)?.token.socials).toEqual({
      website: 'http://www.thewhalemonkey.com',
      twitter: 'https://x.com/TWM20724',
      telegram: 'https://t.me/thewhalemonkey',
    });
    expect(byMint.get(TWM)?.token.createdAt).toBe(1783519177000);
  });
});

describe('getMetadata', () => {
  it('maps info.imageUrl, websites and socials; empty profile → empty socials', async () => {
    const { fetcher } = fakeFetcher([['/tokens/v1/solana/', fixture('tokens-v1.solana.jup-usdc.json')]]);
    const res = await createDexScreener({ fetcher }).getMetadata([JUP, USDC]);
    expect(res.data[JUP]).toEqual({
      mint: JUP,
      symbol: 'JUP',
      name: 'Jupiter',
      image: expect.stringMatching(/^https:\/\/cdn\.dexscreener\.com\//),
      socials: {
        website: 'https://jup.ag',
        twitter: 'https://twitter.com/JupiterExchange',
        discord: 'https://discord.gg/jup',
      },
    });
    expect(res.data[USDC]?.socials).toEqual({});
    // AMM main pair: its creation time does not date the token.
    expect(res.data[JUP]).not.toHaveProperty('createdAt');
  });

  it('dates the token from a bonding-curve main pair', async () => {
    const { fetcher } = fakeFetcher([['/tokens/v1/solana/', fixture('tokens-v1.solana.mixed-dexids.json')]]);
    const res = await createDexScreener({ fetcher }).getMetadata([KOLPACKS]);
    expect(res.data[KOLPACKS]?.createdAt).toBe(1790627602000);
    expect(res.data[KOLPACKS]?.launchpad).toEqual({ stage: 'bonding', launchpad: 'pump.fun' });
  });
});

describe('getPools (/token-pairs/v1)', () => {
  it('sorts a migrated pump token: PumpSwap, then DLMM, frozen pump.fun curve last without price', async () => {
    const { fetcher, calls } = fakeFetcher([
      ['/token-pairs/v1/', fixture('token-pairs-v1.solana.migrated-pump-token.dlmm+pumpswap+pumpfun.json')],
    ]);
    const res = await createDexScreener({ fetcher }).getPools(FOMO);
    expect(calls[0]?.url).toBe(`https://api.dexscreener.com/token-pairs/v1/solana/${FOMO}`);
    expect(calls[0]?.init?.cacheMs).toBe(15_000);
    expect(res.freshness).toBe('indexed');
    expect(res.notes).toHaveLength(1);

    expect(res.data.map((p) => [p.address, p.dex, p.dexLabel])).toEqual([
      ['BuaA3jui2qmGDkdTF7Eut8pKbgsyhH4okQopUVXWg7G2', 'pumpswap', 'PumpSwap'],
      ['DzZNXsvPVDGQftjvErc9MD6hx4ANE425wB74BXrK4vLj', 'meteora-dlmm', 'Meteora DLMM'],
      ['GVgC42Ds7sB9KEYCTrFzr9HZFd9nxEmWLN3pZuAZvcQ2', 'pumpfun', 'Pump.fun'],
    ]);
    expect(res.data[0]).toEqual({
      address: 'BuaA3jui2qmGDkdTF7Eut8pKbgsyhH4okQopUVXWg7G2',
      dex: 'pumpswap',
      dexLabel: 'PumpSwap',
      baseMint: FOMO,
      quoteMint: MINTS.SOL,
      quoteSymbol: 'SOL',
      priceUsd: 0.000002824,
      priceNative: 0.00000002375,
      liquidityUsd: 3208.24,
      volume24hUsd: 1664702.44,
      marketCapUsd: 2824,
      fdvUsd: 2824,
      createdAt: 1790626194000,
      txns24h: { buys: 5248, sells: 5143 },
      isBondingCurve: false,
      url: 'https://dexscreener.com/solana/buaa3jui2qmgdkdtf7eut8pkbgsyhh4okqopuvxwg7g2',
      source: 'dexscreener',
    });
    const curve = res.data[2];
    expect(curve?.isBondingCurve).toBe(true);
    expect(curve).not.toHaveProperty('liquidityUsd');
    expect(curve).not.toHaveProperty('priceUsd');
    expect(curve).not.toHaveProperty('marketCapUsd');
    expect(curve?.volume24hUsd).toBe(12659);
  });

  it('normalizes raydium CPMM and meteora DYN2 and sorts by liquidity', async () => {
    const { fetcher } = fakeFetcher([['/token-pairs/v1/', fixture('token-pairs-v1.solana.bonk-mint-raydium-cpmm.json')]]);
    const res = await createDexScreener({ fetcher }).getPools(BONK_USD1);
    expect(res.data.map((p) => [p.dex, p.dexLabel, p.liquidityUsd])).toEqual([
      ['raydium-cpmm', 'Raydium CPMM', 13232.02],
      ['meteora-damm-v2', 'Meteora DAMM v2', 96.77],
      ['meteora-damm-v2', 'Meteora DAMM v2', 75.19],
    ]);
    expect(res.data[1]?.quoteSymbol).toBe('OUROBOROS');
    expect(res.data[0]?.priceNative).toBe(0.0000168);
    expect(res.notes).toBeUndefined();
  });

  it('keeps a live bonding curve price (not frozen) when the token is still bonding', async () => {
    const { fetcher } = fakeFetcher([['/token-pairs/v1/', fixture('token-pairs-v1.solana.bonding-curve-only-pumpfun.json')]]);
    const res = await createDexScreener({ fetcher }).getPools(KOLPACKS);
    expect(res.data).toHaveLength(1);
    expect(res.data[0]).toMatchObject({ dex: 'pumpfun', isBondingCurve: true, priceUsd: 0.000003434, marketCapUsd: 3434.65 });
    expect(res.data[0]).not.toHaveProperty('liquidityUsd');
  });

  it('excludes pools that only quote the mint (other tokens paired against it)', async () => {
    const { fetcher } = fakeFetcher([
      ['/token-pairs/v1/', fixture('token-pairs-v1.solana.token-as-quote-pumpfun-nonsol-quote.json')],
    ]);
    const res = await createDexScreener({ fetcher }).getPools(SIXTY_SEVEN);
    expect(res.data).toEqual([]);
  });

  it('returns an empty list only when upstream genuinely has no pairs', async () => {
    const { fetcher } = fakeFetcher([['/token-pairs/v1/', []]]);
    const res = await createDexScreener({ fetcher }).getPools(fakeAddress(5));
    expect(res.data).toEqual([]);
  });

  it('rejects invalid mints without a request', async () => {
    const { fetcher, calls } = fakeFetcher([]);
    const err = await rejection(createDexScreener({ fetcher }).getPools('../../etc'));
    expect(err.code).toBe('not_found');
    expect(calls).toHaveLength(0);
  });

  it('maps malformed payloads and transport errors to ProviderError', async () => {
    const htmlBody = fixture('latest-dex-pairs.solana.31-pairs.400-error.json');
    expect(typeof htmlBody).toBe('string');
    const asString = fakeFetcher([['/token-pairs/v1/', htmlBody]]);
    const malformed = await rejection(createDexScreener({ fetcher: asString.fetcher }).getPools(JUP));
    expect(malformed.code).toBe('malformed');
    expect(malformed.provider).toBe('dexscreener');

    const asObject = fakeFetcher([['/token-pairs/v1/', { pairs: [] }]]);
    expect((await rejection(createDexScreener({ fetcher: asObject.fetcher }).getPools(JUP))).code).toBe('malformed');

    const http = fakeFetcher([
      ['/token-pairs/v1/', new ProviderError('dexscreener', 'http', 'dexscreener token-pairs: HTTP 500', { status: 500 })],
    ]);
    const httpErr = await rejection(createDexScreener({ fetcher: http.fetcher }).getPools(JUP));
    expect(httpErr.code).toBe('http');
    expect(httpErr.status).toBe(500);
  });
});

describe('getLaunchpadState', () => {
  const run = async (name: string, mint: string) => {
    const { fetcher } = fakeFetcher([['/token-pairs/v1/', fixture(name)]]);
    return createDexScreener({ fetcher }).getLaunchpadState(mint);
  };

  it('pumpfun + pumpswap → graduated into the PumpSwap pool (approximate time)', async () => {
    const res = await run('token-pairs-v1.solana.migrated-pump-token.pumpswap+pumpfun.json', CATEMAS);
    expect(res.data).toEqual({
      stage: 'graduated',
      launchpad: 'pump.fun',
      migratedPool: '5c7zAA6SASDNEZKqZWQpBXqxDjvFSLndig9yWaSv5R8L',
      graduatedAt: 1790626080000,
    });
    expect(res.notes?.[0]).toMatch(/approximated/);
  });

  it('prefers the launchpad migration venue over other AMM pools', async () => {
    const res = await run('token-pairs-v1.solana.migrated-pump-token.dlmm+pumpswap+pumpfun.json', FOMO);
    expect(res.data.stage).toBe('graduated');
    expect(res.data.migratedPool).toBe('BuaA3jui2qmGDkdTF7Eut8pKbgsyhH4okQopUVXWg7G2');
    expect(res.data.graduatedAt).toBe(1790626194000);
  });

  it('bonding curve only → bonding, with no invented progress', async () => {
    const res = await run('token-pairs-v1.solana.bonding-curve-only-pumpfun.json', KOLPACKS);
    expect(res.data).toEqual({ stage: 'bonding', launchpad: 'pump.fun' });
    expect(res.data).not.toHaveProperty('progressPct');
  });

  it('AMM pairs only → amm; mint only seen as quote → unknown', async () => {
    expect((await run('token-pairs-v1.solana.jup.json', JUP)).data).toEqual({ stage: 'amm' });
    expect((await run('token-pairs-v1.solana.bonk-mint-raydium-cpmm.json', BONK_USD1)).data).toEqual({ stage: 'amm' });
    expect((await run('token-pairs-v1.solana.token-as-quote-pumpfun-nonsol-quote.json', SIXTY_SEVEN)).data).toEqual({
      stage: 'unknown',
    });
  });

  it('a pump.fun curve with only a foreign (DLMM) side pool stays bonding, trading or not', async () => {
    const curve = fixtureArray('token-pairs-v1.solana.bonding-curve-only-pumpfun.json')[0];
    const dlmm = fixtureArray('token-pairs-v1.solana.migrated-pump-token.dlmm+pumpswap+pumpfun.json')[0];
    expect(curve?.dexId).toBe('pumpfun');
    expect(dlmm?.dexId).toBe('meteora');
    const sidePool = { ...dlmm, baseToken: { address: KOLPACKS, name: 'KolPacks', symbol: 'KolPacks' } };

    const active = fakeFetcher([['/token-pairs/v1/', [curve, sidePool]]]);
    expect((await createDexScreener({ fetcher: active.fetcher }).getLaunchpadState(KOLPACKS)).data).toEqual({
      stage: 'bonding',
      launchpad: 'pump.fun',
    });

    // A dead curve (no trades in m5) is not a graduation: pump.fun never migrates to DLMM,
    // so the DLMM pool must not be reported as migratedPool and the curve's last real price stays.
    const silentCurve = { ...curve, txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 1, sells: 1 } } };
    const silent = fakeFetcher([['/token-pairs/v1/', [silentCurve, sidePool]]]);
    const ds = createDexScreener({ fetcher: silent.fetcher });
    expect((await ds.getLaunchpadState(KOLPACKS)).data).toEqual({ stage: 'bonding', launchpad: 'pump.fun' });
    const pools = await ds.getPools(KOLPACKS);
    expect(pools.notes).toBeUndefined();
    expect(pools.data[1]).toMatchObject({ dex: 'pumpfun', priceUsd: 0.000003434, marketCapUsd: 3434.65 });
  });

  it('launchpads without a known venue fall back to curve activity', async () => {
    const curve = fixtureArray('token-pairs-v1.solana.bonding-curve-only-pumpfun.json')[0];
    const raydium = fixtureArray('token-pairs-v1.solana.jup.json')[2];
    expect(raydium?.labels).toEqual(['CLMM']);
    const moonshot = { ...curve, dexId: 'moonshot' };
    const pool = { ...raydium, baseToken: { address: KOLPACKS, symbol: 'KolPacks' } };

    const active = fakeFetcher([['/token-pairs/v1/', [moonshot, pool]]]);
    expect((await createDexScreener({ fetcher: active.fetcher }).getLaunchpadState(KOLPACKS)).data).toEqual({
      stage: 'bonding',
      launchpad: 'moonshot',
    });

    const quiet = { ...moonshot, txns: { m5: { buys: 0, sells: 0 } } };
    const silent = fakeFetcher([['/token-pairs/v1/', [quiet, pool]]]);
    expect((await createDexScreener({ fetcher: silent.fetcher }).getLaunchpadState(KOLPACKS)).data).toEqual({
      stage: 'graduated',
      launchpad: 'moonshot',
      migratedPool: 'EZVkeboWeXygtq8LMyENHyXdF5wpYrtExRNH9UwB1qYw',
      graduatedAt: 1723699335000,
    });
  });

  it('LaunchLab curves may migrate to Raydium AMM v4 as well as CPMM', async () => {
    const curve = fixtureArray('token-pairs-v1.solana.bonding-curve-only-pumpfun.json')[0];
    const search = fixture('search.q=JUP.one-per-dexId-label.json') as { pairs: Array<Record<string, unknown>> };
    const ammV4 = search.pairs.find((p) => p.dexId === 'raydium' && !('labels' in p));
    expect(ammV4?.pairAddress).toBe('EYErUp5muPYEEkeaUCY22JibeZX7E9UuMcJFZkmNAN7c');
    const launchlab = { ...curve, dexId: 'launchlab' };
    const pool = { ...ammV4, baseToken: { address: KOLPACKS, symbol: 'KolPacks' } };
    const { fetcher } = fakeFetcher([['/token-pairs/v1/', [launchlab, pool]]]);
    expect((await createDexScreener({ fetcher }).getLaunchpadState(KOLPACKS)).data).toEqual({
      stage: 'graduated',
      launchpad: 'LaunchLab',
      migratedPool: 'EYErUp5muPYEEkeaUCY22JibeZX7E9UuMcJFZkmNAN7c',
      graduatedAt: 1706715778000,
    });
  });

  it("picks the migration pool quoted in the curve's own quote mint over an older same-venue pool", async () => {
    const curve = fixtureArray('token-pairs-v1.solana.bonding-curve-only-pumpfun.json')[0];
    const solPool = fixtureArray('token-pairs-v1.solana.migrated-pump-token.pumpswap+pumpfun.json')[0];
    const search = fixture('search.q=SOL-USDC.json') as { pairs: Array<Record<string, unknown>> };
    const usdcPool = search.pairs[0];
    expect(usdcPool?.dexId).toBe('pumpswap');
    const asKol = (p: Record<string, unknown> | undefined) => ({ ...p, baseToken: { address: KOLPACKS, symbol: 'KolPacks' } });
    // The USDC PumpSwap pool (created 1779397336000) is older than the SOL one (1790626080000).
    const { fetcher } = fakeFetcher([['/token-pairs/v1/', [curve, asKol(usdcPool), asKol(solPool)]]]);
    expect((await createDexScreener({ fetcher }).getLaunchpadState(KOLPACKS)).data).toEqual({
      stage: 'graduated',
      launchpad: 'pump.fun',
      migratedPool: '5c7zAA6SASDNEZKqZWQpBXqxDjvFSLndig9yWaSv5R8L',
      graduatedAt: 1790626080000,
    });
  });
});

describe('schema drift', () => {
  /** Real payload with `pairAddress` renamed: every item loses its identity. */
  const renamed = () =>
    fixtureArray('tokens-v1.solana.mixed-dexids.json').map(({ pairAddress, ...rest }) => ({ ...rest, pairId: pairAddress }));

  it('a non-empty payload in which no pair parses is malformed on every endpoint, never an empty result', async () => {
    const envelope = { schemaVersion: '1.0.0', pairs: renamed() };
    const { fetcher } = fakeFetcher([
      ['/tokens/v1/', renamed()],
      ['/token-pairs/v1/', renamed()],
      ['/latest/dex/pairs/', envelope],
      ['/latest/dex/search', envelope],
    ]);
    const ds = createDexScreener({ fetcher });
    const errors = [
      await rejection(ds.getMarkets(MIXED)),
      await rejection(ds.getRows(MIXED)),
      await rejection(ds.getMetadata(MIXED)),
      await rejection(ds.getPools(KOLPACKS)),
      await rejection(ds.getLaunchpadState(KOLPACKS)),
      await rejection(ds.getPairs(['FFk6jzJsqNBgRprDTUChNeULXyK4mGtN6SidFPWc8YSB'])),
      await rejection(ds.search('KolPacks')),
    ];
    for (const e of errors) {
      expect(e.code).toBe('malformed');
      expect(e.provider).toBe('dexscreener');
      // Errors carry labels, never URLs.
      expect(e.message).not.toMatch(/https?:|api\.dexscreener\.com/);
    }
  });

  it('drops individual unusable items but keeps the rest', async () => {
    const items: unknown[] = [...fixtureArray('tokens-v1.solana.mixed-dexids.json'), null, { pairId: 'x' }];
    const { fetcher } = fakeFetcher([['/tokens/v1/', items]]);
    const res = await createDexScreener({ fetcher }).getMarkets(MIXED);
    expect(Object.keys(res.data).sort()).toEqual([...MIXED].sort());
  });
});

describe('getPairs (/latest/dex/pairs)', () => {
  it('returns pools in request order with normalized venues', async () => {
    const { fetcher, calls } = fakeFetcher([['/latest/dex/pairs/solana/', fixture('latest-dex-pairs.solana.30-pairs.trimmed.json')]]);
    const wanted = [
      '42v7DBnWH16M8ARkDcg815hmsuwKQxWR8waEUtct7ZjK',
      'G5sqxttkSJv5wcj47Y4CPRDuqsPCZy7jCLuBQ7MyXhJ9',
      'FFk6jzJsqNBgRprDTUChNeULXyK4mGtN6SidFPWc8YSB',
    ];
    const res = await createDexScreener({ fetcher }).getPairs(wanted);
    expect(calls[0]?.url).toBe(`https://api.dexscreener.com/latest/dex/pairs/solana/${wanted.join(',')}`);
    expect(res.data.map((p) => p.address)).toEqual(wanted);
    expect(res.data.map((p) => p.dex)).toEqual(['meteora-dbc', 'pumpswap', 'pumpfun']);
    expect(res.data[0]).toMatchObject({ isBondingCurve: true, baseMint: ONE_PCT, priceUsd: 0.00003305 });
    expect(res.data[0]).not.toHaveProperty('liquidityUsd');
    expect(res.data[1]).toMatchObject({ liquidityUsd: 15324.37, priceNative: 0.0000002976, txns24h: expect.any(Object) });
  });

  it('parses the single-pair envelope', async () => {
    const { fetcher } = fakeFetcher([['/latest/dex/pairs/solana/', fixture('latest-dex-pairs.solana.single.json')]]);
    const res = await createDexScreener({ fetcher }).getPairs(['G5sqxttkSJv5wcj47Y4CPRDuqsPCZy7jCLuBQ7MyXhJ9']);
    expect(res.data).toHaveLength(1);
    expect(res.data[0]?.marketCapUsd).toBe(34883);
  });

  it('treats {pairs:null} as not found (empty), but a missing envelope as malformed', async () => {
    const notFound = fakeFetcher([['/latest/dex/pairs/', fixture('latest-dex-pairs.solana.not-found.json')]]);
    const res = await createDexScreener({ fetcher: notFound.fetcher }).getPairs([fakeAddress(6)]);
    expect(res.data).toEqual([]);

    const bad = fakeFetcher([['/latest/dex/pairs/', { schemaVersion: '1.0.0' }]]);
    expect((await rejection(createDexScreener({ fetcher: bad.fetcher }).getPairs([fakeAddress(6)]))).code).toBe('malformed');
  });
});

describe('search (/latest/dex/search)', () => {
  it('dedupes pairs per base token and keeps the most liquid one', async () => {
    const { fetcher, calls } = fakeFetcher([['/latest/dex/search', fixture('search.q=JUP.one-per-dexId-label.json')]]);
    const res = await createDexScreener({ fetcher }).search('  JUP ');
    expect(calls[0]?.url).toBe('https://api.dexscreener.com/latest/dex/search?q=JUP');
    expect(res.freshness).toBe('indexed');
    expect(res.data).toEqual([
      {
        mint: JUP,
        symbol: 'JUP',
        name: 'Jupiter',
        image: expect.stringMatching(/^https:\/\//),
        priceUsd: 0.3296,
        marketCapUsd: 1094164076,
        liquidityUsd: 805428.6,
        volume24hUsd: expect.any(Number),
        source: 'dexscreener',
      },
    ]);
  });

  it('filters to Solana and URL-encodes the query', async () => {
    const payload = fixture('search.q=SOL-USDC.json') as { pairs: Array<Record<string, unknown>> };
    const foreign = { ...payload.pairs[0], chainId: 'base', baseToken: { address: '0xabc', symbol: 'BASED' } };
    const { fetcher, calls } = fakeFetcher([['/latest/dex/search', { ...payload, pairs: [foreign, ...payload.pairs] }]]);
    const res = await createDexScreener({ fetcher }).search('SOL/USDC');
    expect(calls[0]?.url).toBe('https://api.dexscreener.com/latest/dex/search?q=SOL%2FUSDC');
    expect(res.data.map((h) => h.symbol)).toEqual(['SOLANGELES', 'SOLO', 'PLAY']);
  });

  it('reports launchpad bonding stage for bags curves (no liquidity → omitted)', async () => {
    const { fetcher } = fakeFetcher([['/latest/dex/search', fixture('search.q=bags.dexId-bags.json')]]);
    const res = await createDexScreener({ fetcher }).search('bags');
    expect(res.data).toHaveLength(3);
    for (const hit of res.data) {
      expect(hit.launchpad).toEqual({ stage: 'bonding', launchpad: 'bags' });
      expect(hit).not.toHaveProperty('liquidityUsd');
      expect(hit).not.toHaveProperty('image');
    }
    expect(res.data[0]).toMatchObject({ symbol: 'BAGSINU', priceUsd: 0.000003454, marketCapUsd: 3454.94 });
  });

  it('address queries resolve to that token, its pair, or an identity-only quote hit', async () => {
    const jup = fakeFetcher([['/latest/dex/search', fixture('search.q=JUP.one-per-dexId-label.json')]]);
    const byMint = await createDexScreener({ fetcher: jup.fetcher }).search(JUP);
    expect(byMint.data.map((h) => h.mint)).toEqual([JUP]);

    const byPair = await createDexScreener({ fetcher: jup.fetcher }).search('EZVkeboWeXygtq8LMyENHyXdF5wpYrtExRNH9UwB1qYw');
    expect(byPair.data.map((h) => [h.mint, h.liquidityUsd])).toEqual([[JUP, 60443.45]]);

    const quoteOnly = fakeFetcher([
      ['/latest/dex/search', { schemaVersion: '1.0.0', pairs: fixture('token-pairs-v1.solana.token-as-quote-pumpfun-nonsol-quote.json') }],
    ]);
    const quoted = await createDexScreener({ fetcher: quoteOnly.fetcher }).search(SIXTY_SEVEN);
    expect(quoted.data).toEqual([{ mint: SIXTY_SEVEN, symbol: '67', name: 'The Official 67 Coin', source: 'dexscreener' }]);

    const unrelated = await createDexScreener({ fetcher: jup.fetcher }).search(fakeAddress(7));
    expect(unrelated.data).toEqual([]);
  });

  it('empty query makes no request; {pairs:null} is an empty result; bad envelope is malformed', async () => {
    const empty = fakeFetcher([]);
    const res = await createDexScreener({ fetcher: empty.fetcher }).search('   ');
    expect(res.data).toEqual([]);
    expect(empty.calls).toHaveLength(0);

    const none = fakeFetcher([['/latest/dex/search', { schemaVersion: '1.0.0', pairs: null }]]);
    expect((await createDexScreener({ fetcher: none.fetcher }).search('zzzz')).data).toEqual([]);

    const bad = fakeFetcher([['/latest/dex/search', []]]);
    expect((await rejection(createDexScreener({ fetcher: bad.fetcher }).search('zzzz'))).code).toBe('malformed');
  });
});
