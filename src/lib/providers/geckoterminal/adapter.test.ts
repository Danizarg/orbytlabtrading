import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProviderId } from '@/lib/core/providers';
import { MINTS } from '@/lib/core/solana';
import { ProviderError } from '@/lib/net/errors';
import type { JsonFetcher, JsonRequest } from '@/lib/net/types';
import { createGeckoTerminal, GECKOTERMINAL_ACCEPT, type GeckoTerminalOptions } from './adapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Payload = Record<string, unknown>;

function fixture(name: string): Payload {
  const file = path.join(process.cwd(), 'tests/fixtures/geckoterminal', name);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Payload;
  delete raw._fixture_meta;
  return raw;
}

function dataOf(payload: Payload): Payload[] {
  const data = payload.data;
  if (!Array.isArray(data)) throw new Error('fixture has no data array');
  return data as Payload[];
}

interface Route {
  match: string;
  body?: unknown;
  error?: unknown;
}

interface Call {
  provider: ProviderId;
  url: string;
  init: JsonRequest;
}

/** Fake transport: the first route whose `match` is a substring of the URL answers. */
function fakeFetcher(routes: Route[]) {
  const calls: Call[] = [];
  const fetcher: JsonFetcher = async <T,>(provider: ProviderId, url: string, init: JsonRequest = {}): Promise<T> => {
    calls.push({ provider, url, init });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`unexpected request: ${url}`);
    if (route.error) throw route.error;
    return structuredClone(route.body) as T;
  };
  return { fetcher, calls };
}

function setup(routes: Route[], opts: Omit<GeckoTerminalOptions, 'fetcher'> = {}) {
  const { fetcher, calls } = fakeFetcher(routes);
  return { gt: createGeckoTerminal({ fetcher, ...opts }), calls };
}

function firstCall(calls: Call[]): Call {
  const call = calls[0];
  if (!call) throw new Error('no request was made');
  return call;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Deterministic valid 32-byte base58 address for batching tests. */
function fakeAddress(i: number): string {
  const bytes = new Uint8Array(32).fill(9);
  bytes[0] = 1 + (i % 200);
  bytes[1] = 1 + Math.floor(i / 200);
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58.charAt(Number(n % 58n)) + out;
    n /= 58n;
  }
  return out;
}

function pathMints(url: string, marker: string): string[] {
  const after = url.split(marker)[1] ?? '';
  return (after.split('?')[0] ?? '').split(',').filter(Boolean);
}

const CLONES = '5RJGBaFrTcTrmu5HuukxHxKeqpmRWf346YxQ1kXGetRs';
const CLONES_POOL = 'CnJYShWKkDCHeees6Jgi2nx6rekrsu62VqJkDLxpZeNs';
const CARDS = 'CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp';
const COLLECT = 'nDZknLvfFRp5rgUHdzTrQsmSY5NKzoavqdLjSHVpump';
const XMRPAD = '62zeow8T5HL7nsUCqJPmc9c6vViwnPqhxa5Dd2pgpump';
const DEMO_KEY = 'demo-key-placeholder';
const PRO_KEY = 'pro-key-placeholder';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('createGeckoTerminal: plans, hosts and headers', () => {
  it('keyless uses api.geckoterminal.com with the exact versioned Accept header and no key', async () => {
    const { gt, calls } = setup([{ match: '/trending_pools', body: fixture('trending_pools_solana_5m.json') }]);
    expect(gt.id).toBe('geckoterminal');
    expect(gt.plan).toBe('keyless');
    expect(gt.intervals).toEqual(['1m', '5m', '15m', '1h', '4h', '1d']);
    await gt.discover({ list: 'trending', window: '5m' });
    const call = firstCall(calls);
    expect(call.provider).toBe('geckoterminal');
    expect(call.url.startsWith('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?')).toBe(true);
    expect(call.init.headers).toEqual({ accept: GECKOTERMINAL_ACCEPT });
    expect(GECKOTERMINAL_ACCEPT).toBe('application/json;version=20230203');
    expect(call.init.label).toBeTruthy();
  });

  it('demo uses api.coingecko.com/api/v3/onchain + x-cg-demo-api-key, reported as coingecko', async () => {
    const { gt, calls } = setup([{ match: '/new_pools', body: fixture('new_pools_solana.json') }], { plan: 'demo', apiKey: DEMO_KEY });
    expect(gt.id).toBe('coingecko');
    const result = await gt.getNewPools();
    const call = firstCall(calls);
    expect(call.provider).toBe('coingecko');
    expect(call.url.startsWith('https://api.coingecko.com/api/v3/onchain/networks/solana/new_pools?')).toBe(true);
    expect(call.init.headers).toEqual({ accept: GECKOTERMINAL_ACCEPT, 'x-cg-demo-api-key': DEMO_KEY });
    // The key travels only in a header: never in the URL or the error label.
    expect(call.url).not.toContain(DEMO_KEY);
    expect(call.init.label ?? '').not.toContain(DEMO_KEY);
    expect(result.source).toBe('coingecko');
    expect(result.data[0]?.source).toBe('coingecko');
  });

  it('pro uses pro-api.coingecko.com + x-cg-pro-api-key and exposes second intervals', async () => {
    const { gt, calls } = setup([{ match: '/new_pools', body: fixture('new_pools_solana.json') }], { plan: 'pro', apiKey: PRO_KEY });
    expect(gt.intervals).toEqual(['1s', '15s', '1m', '5m', '15m', '1h', '4h', '1d']);
    await gt.getNewPools(2);
    const call = firstCall(calls);
    expect(call.url).toBe('https://pro-api.coingecko.com/api/v3/onchain/networks/solana/new_pools?include=base_token,quote_token,dex&page=2');
    expect(call.init.headers).toEqual({ accept: GECKOTERMINAL_ACCEPT, 'x-cg-pro-api-key': PRO_KEY });
  });

  it('keyed plans without a key throw not_configured (without echoing anything secret)', () => {
    const { fetcher } = fakeFetcher([]);
    for (const plan of ['demo', 'pro'] as const) {
      expect(() => createGeckoTerminal({ fetcher, plan })).toThrow(
        expect.objectContaining({ name: 'ProviderError', code: 'not_configured', provider: 'coingecko' }),
      );
      expect(() => createGeckoTerminal({ fetcher, plan, apiKey: '   ' })).toThrow(expect.objectContaining({ code: 'not_configured' }));
    }
  });

  it('honours a base URL override', async () => {
    const { gt, calls } = setup([{ match: '/new_pools', body: fixture('new_pools_solana.json') }], { baseUrl: 'https://proxy.example/gt/' });
    await gt.getNewPools();
    expect(firstCall(calls).url.startsWith('https://proxy.example/gt/networks/solana/new_pools?')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

describe('discover', () => {
  it('trending: one TokenRow per base token with pool-level market data', async () => {
    const { gt, calls } = setup([{ match: '/trending_pools', body: fixture('trending_pools_solana_5m.json') }]);
    const result = await gt.discover({ list: 'trending', window: '5m' });
    const url = firstCall(calls).url;
    expect(url).toContain('duration=5m');
    expect(url).toContain('include=base_token,quote_token,dex');
    expect(firstCall(calls).init.cacheMs).toBe(15_000);
    expect(result.source).toBe('geckoterminal');
    expect(result.freshness).toBe('indexed');
    expect(result.fetchedAt).toBeGreaterThan(0);
    expect(result.data.map((r) => r.rank)).toEqual([1, 2, 3]);

    const [collect, eacc, jeanphil] = result.data;
    expect(collect?.token).toEqual({
      mint: COLLECT,
      symbol: 'COLLECT',
      name: 'GoCollect',
      decimals: 6,
      image: 'https://coin-images.coingecko.com/coins/images/102178821/large/zrz9eqw282sfgiwv70q9jl97fb0c.?1790407278',
      createdAt: Date.parse('2026-09-25T00:58:47Z'),
    });
    expect(collect?.pool).toEqual({ address: '99C6TUp7WgTvnwQVVhAbD8HbxPdo5LJCXr7VFCvTmJf1', dex: 'pumpswap', dexLabel: 'PumpSwap', quoteSymbol: 'CARDS' });
    expect(collect?.market).toMatchObject({
      mint: COLLECT,
      priceUsd: Number('0.0053090691083532508661819494526067416975239138942324231354098246'),
      fdvUsd: 5257197.83771481,
      marketCapUsd: 5257197.84963614,
      liquidityUsd: 313829.0922,
      source: 'geckoterminal',
      updatedAt: result.fetchedAt,
    });
    // Quoted in CARDS, not WSOL: no SOL price.
    expect(collect?.market).not.toHaveProperty('priceSol');
    expect(Object.keys(collect?.market.stats ?? {})).toEqual(['m5', 'h1', 'h6', 'h24']);
    expect(collect?.market.stats.m5).toEqual({ buys: 104, sells: 86, buyers: 77, sellers: 69, volumeUsd: 69719.0774990289, priceChangePct: -6.366 });
    expect(collect?.market.stats.h24?.volumeUsd).toBe(810838.853347632);

    // "0.0" market cap next to an $8.4M FDV is not a real value.
    expect(eacc?.market).not.toHaveProperty('marketCapUsd');
    expect(eacc?.market.priceSol).toBe(0.0000713469278879846);
    expect(eacc?.pool?.quoteSymbol).toBe('SOL');
    expect(jeanphil?.market).not.toHaveProperty('marketCapUsd');
    expect(jeanphil?.token.image).toBe('https://assets.geckoterminal.com/pkwz4cwv7pwdsdmvepbecsh2ybit');
    expect(jeanphil?.token).not.toHaveProperty('launchpad');
  });

  it('dedupes base tokens (first pool wins) and honours limit', async () => {
    const payload = fixture('trending_pools_solana_5m.json');
    const [first, ...rest] = dataOf(payload);
    const duplicate = { ...structuredClone(first), id: 'solana_4R8CiMnJWDNoes3fQi1ccPFJygPXazaHaWpHrN3rZeNj' };
    payload.data = [first, duplicate, ...rest];
    const { gt } = setup([{ match: '/trending_pools', body: payload }]);
    const all = await gt.discover({ list: 'trending', window: '1h' });
    expect(all.data.map((r) => r.token.mint)).toEqual([COLLECT, 'CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU', 'GTBxUiw6wJdmmkCGZgRHLyYxqu1vG4KtRpeox6yDpump']);
    expect(all.data[0]?.pool?.address).toBe('99C6TUp7WgTvnwQVVhAbD8HbxPdo5LJCXr7VFCvTmJf1');
    expect(all.data.map((r) => r.rank)).toEqual([1, 2, 3]);
    const limited = await gt.discover({ list: 'trending', window: '1h', limit: 2 });
    expect(limited.data).toHaveLength(2);
  });

  it('top: 24h volume ranking, WSOL fdv/market cap omitted, note when window differs', async () => {
    const { gt, calls } = setup([{ match: '/networks/solana/pools?', body: fixture('top_pools_solana_h24_volume.json') }]);
    const result = await gt.discover({ list: 'top', window: '1h' });
    expect(firstCall(calls).url).toContain('sort=h24_volume_usd_desc');
    const sol = result.data[0];
    expect(sol?.token.mint).toBe(MINTS.SOL);
    expect(sol?.market).not.toHaveProperty('fdvUsd');
    expect(sol?.market).not.toHaveProperty('marketCapUsd');
    expect(sol?.market.priceUsd).toBe(118.65637852211911);
    expect(sol?.pool).toMatchObject({ dex: 'orca', quoteSymbol: 'USDC' });
    expect(result.notes).toEqual(['GeckoTerminal ranks top pools by 24h volume']);
    const day = await gt.discover({ list: 'top', window: '24h' });
    expect(day).not.toHaveProperty('notes');
  });

  it('new: bonding-curve venues mark the token as bonding (no progress in lists)', async () => {
    const { gt, calls } = setup([{ match: '/new_pools', body: fixture('new_pools_solana.json') }]);
    const result = await gt.discover({ list: 'new', window: '5m' });
    expect(firstCall(calls).url).toContain('/networks/solana/new_pools?include=base_token,quote_token,dex&page=1');
    const [meowney, mem, collectinu] = result.data;
    expect(meowney?.token.launchpad).toEqual({ stage: 'bonding', launchpad: 'pump.fun' });
    expect(meowney?.pool).toMatchObject({ dex: 'pumpfun', dexLabel: 'Pump.fun' });
    expect(meowney?.market).not.toHaveProperty('marketCapUsd');
    expect(meowney?.market.liquidityUsd).toBe(3180.12880498401);
    expect(mem?.token.launchpad).toEqual({ stage: 'bonding', launchpad: 'Meteora DBC' });
    expect(collectinu?.token).not.toHaveProperty('launchpad');
  });

  it("'organic' is unsupported and makes no request", async () => {
    const { gt, calls } = setup([]);
    await expect(gt.discover({ list: 'organic', window: '24h' })).rejects.toMatchObject({ name: 'ProviderError', code: 'unsupported', provider: 'geckoterminal' });
    expect(calls).toHaveLength(0);
  });

  it('propagates transport errors and rejects error bodies as malformed', async () => {
    const limited = new ProviderError('geckoterminal', 'rate_limited', 'geckoterminal trending pools: HTTP 429', { status: 429 });
    const { gt } = setup([{ match: '/trending_pools', error: limited }]);
    await expect(gt.discover({ list: 'trending', window: '5m' })).rejects.toBe(limited);

    const { gt: gt2 } = setup([{ match: '/trending_pools', body: fixture('error_429_rate_limited.json') }]);
    await expect(gt2.discover({ list: 'trending', window: '5m' })).rejects.toMatchObject({ code: 'malformed' });
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe('search', () => {
  it('returns one hit per base token from /search/pools', async () => {
    const payload = fixture('search_pools.json');
    const [first, ...rest] = dataOf(payload);
    payload.data = [first, ...rest, structuredClone(first)];
    const { gt, calls } = setup([{ match: '/search/pools', body: payload }]);
    const result = await gt.search('  CLONES & co ');
    expect(firstCall(calls).url).toContain('/search/pools?query=CLONES%20%26%20co&network=solana&include=base_token,quote_token,dex');
    expect(result.data.map((h) => h.mint)).toEqual([CLONES, '4akevTN2EaqUKDT2jhcRH4oRk5cppwRdaE5MGoT8pump', 'GKokAG4oSBvTjPpKYyktPm5SgdhQ5Y4zJ3AnUEFpump']);
    expect(result.data[0]).toEqual({
      mint: CLONES,
      symbol: 'CLONES',
      name: 'CLONES',
      image: 'https://assets.geckoterminal.com/m5v6ax92hlhxjon5fog7ak1zwx78',
      priceUsd: Number('0.000966164171756035297348513131780882811138630714719635554986319872'),
      liquidityUsd: 90737.0343,
      volume24hUsd: 4366349.15575799,
      source: 'geckoterminal',
    });
  });

  it('empty query makes no request', async () => {
    const { gt, calls } = setup([]);
    expect((await gt.search('   ')).data).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// tokens/multi: markets, rows, metadata
// ---------------------------------------------------------------------------

describe('getMarkets / getRows (tokens/multi)', () => {
  const requested = [CLONES, MINTS.SOL, CARDS, COLLECT];

  it('maps token-level market data; unknown mints are absent, never zero-filled', async () => {
    const { gt, calls } = setup([{ match: '/tokens/multi/', body: fixture('tokens_multi.json') }]);
    const result = await gt.getMarkets(requested);
    expect(calls).toHaveLength(1);
    expect(firstCall(calls).url).toBe(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/multi/${requested.join(',')}?include=top_pools`);
    expect(result.freshness).toBe('indexed');
    expect(Object.keys(result.data).sort()).toEqual([CLONES, CARDS, MINTS.SOL].sort());
    expect(result.data[COLLECT]).toBeUndefined();

    const clones = result.data[CLONES];
    expect(clones).toMatchObject({
      mint: CLONES,
      priceUsd: 0.0009161161691,
      fdvUsd: 916116.169130282,
      liquidityUsd: 41403.81329439491,
      // Top pool CnJY… is CLONES/WSOL, so its native price is the SOL price.
      priceSol: 0.0000075808535417059,
      source: 'geckoterminal',
    });
    expect(clones).not.toHaveProperty('marketCapUsd');
    expect(clones?.stats.h24).toEqual({ priceChangePct: 2518.12, volumeUsd: 3960777.64528347 });
    expect(clones?.stats.m5).toEqual({ priceChangePct: 0.74 });

    const cards = result.data[CARDS];
    expect(cards?.marketCapUsd).toBe(217469815.300522);
    expect(cards).not.toHaveProperty('priceSol'); // quoted in USDC

    const sol = result.data[MINTS.SOL];
    expect(sol?.priceUsd).toBe(118.7693417377);
    expect(sol).not.toHaveProperty('marketCapUsd'); // wrapped supply, not SOL's market cap
    expect(sol).not.toHaveProperty('fdvUsd');
    expect(sol?.liquidityUsd).toBeCloseTo(16107434475.37293, 2);
  });

  it('builds watchlist rows in requested order with the top pool and launchpad state', async () => {
    const { gt } = setup([{ match: '/tokens/multi/', body: fixture('tokens_multi.json') }]);
    const result = await gt.getRows([CARDS, CLONES, COLLECT]);
    expect(result.data.map((r) => r.token.mint)).toEqual([CARDS, CLONES]);
    const clones = result.data[1];
    expect(clones?.token).toEqual({
      mint: CLONES,
      symbol: 'CLONES',
      name: 'CLONES',
      decimals: 6,
      image: 'https://assets.geckoterminal.com/m5v6ax92hlhxjon5fog7ak1zwx78',
      createdAt: Date.parse('2026-09-28T19:58:37Z'),
      launchpad: {
        stage: 'graduated',
        progressPct: 100,
        progressSource: 'geckoterminal',
        graduatedAt: Date.parse('2026-09-28T19:58:10.000Z'),
        migratedPool: 'GG6MBPb94r8dPfba9Fkrn5tyFPWeVZGd1VyBPxQKFSmg',
      },
    });
    expect(clones?.pool).toEqual({ address: CLONES_POOL, dex: 'pumpswap', dexLabel: 'PumpSwap', quoteSymbol: 'SOL' });
    expect(result.data[0]?.pool).toEqual({ address: 'HnhpJPJgBG2KwniMTNW8cVBHvk1hFog3RC3kjnyc23tD', dex: 'raydium-clmm', dexLabel: 'Raydium CLMM', quoteSymbol: 'USDC' });
  });

  it('chunks into ≤30 addresses per call and dedupes/validates input', async () => {
    const mints = Array.from({ length: 65 }, (_, i) => fakeAddress(i));
    const { gt, calls } = setup([{ match: '/tokens/multi/', body: { data: [], included: [] } }]);
    const result = await gt.getMarkets([...mints, mints[0] ?? '', 'not-an-address', '']);
    expect(result.data).toEqual({});
    expect(calls).toHaveLength(3);
    const sent = calls.map((c) => pathMints(c.url, '/tokens/multi/'));
    expect(sent.map((s) => s.length)).toEqual([30, 30, 5]);
    expect(sent.flat()).toEqual(mints);
  });

  it('keeps successful chunks when one fails and says so; rethrows when all fail', async () => {
    const mints = [CLONES, ...Array.from({ length: 40 }, (_, i) => fakeAddress(i))];
    const limited = new ProviderError('geckoterminal', 'rate_limited', 'geckoterminal tokens/multi: HTTP 429', { status: 429 });
    const { gt } = setup([
      { match: `/tokens/multi/${CLONES}`, body: fixture('tokens_multi.json') },
      { match: '/tokens/multi/', error: limited },
    ]);
    const result = await gt.getMarkets(mints);
    expect(Object.keys(result.data)).toEqual([CLONES]);
    expect(result.notes).toEqual(['11 of 41 addresses could not be loaded (geckoterminal: rate limited)']);

    const { gt: failing } = setup([{ match: '/tokens/multi/', error: limited }]);
    await expect(failing.getRows([CLONES, CARDS])).rejects.toBe(limited);
  });

  it('empty input resolves without a request', async () => {
    const { gt, calls } = setup([]);
    expect((await gt.getMarkets([])).data).toEqual({});
    expect((await gt.getRows(['nope'])).data).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('pro plan labels token snapshots fast', async () => {
    const { gt } = setup([{ match: '/tokens/multi/', body: fixture('tokens_multi.json') }], { plan: 'pro', apiKey: PRO_KEY });
    const result = await gt.getMarkets([CLONES]);
    expect(result.freshness).toBe('fast');
    expect(result.data[CLONES]?.source).toBe('coingecko');
  });
});

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

describe('getPools', () => {
  it('maps token pools with relationship mints, txns and bonding-curve detection', async () => {
    const { gt, calls } = setup([{ match: `/tokens/${CLONES}/pools`, body: fixture('token_top_pools.json') }]);
    const result = await gt.getPools(CLONES);
    const url = firstCall(calls).url;
    expect(url).toContain('sort=h24_volume_usd_liquidity_desc');
    expect(url).toContain('include=base_token,quote_token,dex');
    expect(result.data.map((p) => [p.address, p.dex, p.isBondingCurve])).toEqual([
      [CLONES_POOL, 'pumpswap', false],
      ['GG6MBPb94r8dPfba9Fkrn5tyFPWeVZGd1VyBPxQKFSmg', 'meteora-damm-v2', false],
      ['FFJaBU3q7C1e6Pwc1dsrX76aoS5Y8RPgGSzb9rSzRo3Q', 'meteora-dbc', true],
    ]);
    expect(result.data[0]).toMatchObject({
      dexLabel: 'PumpSwap',
      baseMint: CLONES,
      quoteMint: MINTS.SOL,
      quoteSymbol: 'SOL',
      priceUsd: 0.0008390792309,
      priceNative: 0.000007270817153,
      liquidityUsd: 84898.3708,
      volume24hUsd: 4280180.88547282,
      fdvUsd: 839079.2309,
      createdAt: Date.parse('2026-09-28T19:58:37Z'),
      txns24h: { buys: 10156, sells: 6689 },
      url: `https://www.geckoterminal.com/solana/pools/${CLONES_POOL}`,
      source: 'geckoterminal',
      baseToken: { mint: CLONES, symbol: 'CLONES' },
    });
    expect(result.data[0]).not.toHaveProperty('marketCapUsd');
    // A migrated-away DBC pool genuinely holds nothing: 0 is kept, not omitted.
    expect(result.data[2]?.liquidityUsd).toBe(0);
  });

  it('rejects an invalid mint without calling upstream', async () => {
    const { gt, calls } = setup([]);
    await expect(gt.getPools('bad')).rejects.toMatchObject({ code: 'not_found' });
    expect(calls).toHaveLength(0);
  });
});

describe('getDexPools / getNewPools', () => {
  it('pump-fun dex pools are bonding curves with base-token identity', async () => {
    const { gt, calls } = setup([{ match: '/dexes/pump-fun/pools', body: fixture('top_pools_by_dex_pump_fun.json') }]);
    const result = await gt.getDexPools('pump-fun');
    expect(firstCall(calls).url).toBe(
      'https://api.geckoterminal.com/api/v2/networks/solana/dexes/pump-fun/pools?include=base_token,quote_token,dex&sort=h24_tx_count_desc&page=1',
    );
    expect(result.freshness).toBe('indexed');
    expect(result.data).toHaveLength(3);
    for (const pool of result.data) {
      expect(pool).toMatchObject({ dex: 'pumpfun', dexLabel: 'Pump.fun', isBondingCurve: true, launchpad: { stage: 'bonding', launchpad: 'pump.fun' } });
    }
    expect(result.data[0]?.baseToken).toMatchObject({ mint: '8xzeMhd2Uy2AWQeTGaMonjvsmfWGnkiuYkzcuuzSpump', symbol: 'DIAMOND', name: 'Diamond Hands' });
    expect(result.data[1]?.liquidityUsd).toBe(0);
  });

  it('passes sort/page and rejects unsafe dex ids', async () => {
    const { gt, calls } = setup([{ match: '/dexes/', body: fixture('top_pools_by_dex_pump_fun.json') }]);
    await gt.getDexPools('pumpswap', { sort: 'h24_volume_usd_desc', page: 42 });
    expect(firstCall(calls).url).toContain('/dexes/pumpswap/pools?include=base_token,quote_token,dex&sort=h24_volume_usd_desc&page=10');
    await expect(gt.getDexPools('../tokens')).rejects.toMatchObject({ code: 'unsupported' });
    expect(calls).toHaveLength(1);
  });

  it('new pools include bonding curves and AMM pools', async () => {
    const { gt } = setup([{ match: '/new_pools', body: fixture('new_pools_solana_page2.json') }]);
    const result = await gt.getNewPools(2);
    expect(result.data.map((p) => p.dex)).toEqual(['meteora-dbc', 'pumpfun', 'pumpfun']);
    expect(result.data.every((p) => p.isBondingCurve)).toBe(true);
    expect(result.data[0]?.baseToken?.symbol).toBe('REPOING');
  });
});

describe('getLaunchpadStates (pools/multi)', () => {
  const MEOWNEY_POOL = '9Tn6b3sGJPkSCrRxeVjhEWsfSUbVfyTnaYt9szy6cpxs';
  const DBC_POOL = '4YRuES6c4zMkcgiZRUzdMbDbJ9MdJ1dKoQjgx2Q3kXMw';
  const AMM_POOL = '99C6TUp7WgTvnwQVVhAbD8HbxPdo5LJCXr7VFCvTmJf1';

  it('maps launchpad_details by pool id (not index) and drops non-launchpad / unknown pools', async () => {
    const { gt, calls } = setup([{ match: '/pools/multi/', body: fixture('pools_multi_launchpad_details.json') }]);
    const unknown = fakeAddress(7);
    const result = await gt.getLaunchpadStates([unknown, DBC_POOL, AMM_POOL, MEOWNEY_POOL]);
    const url = firstCall(calls).url;
    expect(url).toBe(`https://api.geckoterminal.com/api/v2/networks/solana/pools/multi/${[unknown, DBC_POOL, AMM_POOL, MEOWNEY_POOL].join(',')}`);
    expect(Object.keys(result.data).sort()).toEqual([DBC_POOL, MEOWNEY_POOL].sort());
    expect(result.data[MEOWNEY_POOL]).toEqual({
      mint: 'sFNG3qgQCBEZnXw3shLKmhxif37gsJujooh38skpump',
      launchpad: { stage: 'bonding', launchpad: 'pump.fun', progressPct: 0, progressSource: 'geckoterminal' },
    });
    expect(result.data[DBC_POOL]).toEqual({
      mint: 'H8TL2wzxT98FhPvU7jrjK75LoEhmKrALJgBkU6m9izLS',
      launchpad: {
        stage: 'graduated',
        launchpad: 'Meteora DBC',
        progressPct: 100,
        progressSource: 'geckoterminal',
        graduatedAt: Date.parse('2026-09-28T20:44:56.000Z'),
        migratedPool: '37yEq8oxU659vFVpCVKKpE1y9iVAsLeQHCwoEfRecJbK',
      },
    });
    expect(result.freshness).toBe('indexed');
  });

  it('chunks more than 30 pools', async () => {
    const pools = Array.from({ length: 45 }, (_, i) => fakeAddress(i));
    const { gt, calls } = setup([{ match: '/pools/multi/', body: { data: [] } }]);
    await gt.getLaunchpadStates(pools);
    expect(calls.map((c) => pathMints(c.url, '/pools/multi/').length)).toEqual([30, 15]);
  });
});

// ---------------------------------------------------------------------------
// Candles
// ---------------------------------------------------------------------------

describe('getCandles', () => {
  it('requests USD candles for our token and returns ascending UNIX-second candles', async () => {
    const { gt, calls } = setup([{ match: '/ohlcv/', body: fixture('ohlcv_minute_1_limit1000.json') }]);
    const result = await gt.getCandles({ mint: CLONES, pool: CLONES_POOL, interval: '1m' });
    expect(firstCall(calls).url).toBe(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${CLONES_POOL}/ohlcv/minute?aggregate=1&limit=300&currency=usd&token=${CLONES}`,
    );
    expect(firstCall(calls).init.cacheMs).toBe(15_000);
    expect(result.freshness).toBe('indexed');
    expect(result.data.interval).toBe('1m');
    expect(result.data.pool).toBe(CLONES_POOL);
    expect(result.data.hasMore).toBe(false);
    const times = result.data.candles.map((c) => c.time);
    expect(times).toEqual([1790628180, 1790628240, 1790628300]);
    // UNIX seconds, not ms.
    expect(times.every((t) => t < 1e11)).toBe(true);
    expect(result.data.candles[2]).toEqual({
      time: 1790628300,
      open: 0.0009049786059522766,
      high: 0.0009464581412148887,
      low: 0.0008801633798638143,
      close: 0.0009385780967054462,
      volume: 10722.599971221984,
    });
  });

  it('hasMore when a full page is returned; limit is clamped to 1000', async () => {
    const { gt, calls } = setup([{ match: '/ohlcv/', body: fixture('ohlcv_minute_1_limit1000.json') }]);
    expect((await gt.getCandles({ mint: CLONES, pool: CLONES_POOL, interval: '5m', limit: 3 })).data.hasMore).toBe(true);
    expect(calls[0]?.url).toContain('/ohlcv/minute?aggregate=5&limit=3&');
    await gt.getCandles({ mint: CLONES, pool: CLONES_POOL, interval: '15m', limit: 5000 });
    expect(calls[1]?.url).toContain('/ohlcv/minute?aggregate=15&limit=1000&');
  });

  it('pages back with before_timestamp and caches historic pages longer', async () => {
    const { gt, calls } = setup([{ match: '/ohlcv/', body: fixture('ohlcv_hour_4_before_timestamp.json') }]);
    const result = await gt.getCandles({ mint: CARDS, pool: 'HnhpJPJgBG2KwniMTNW8cVBHvk1hFog3RC3kjnyc23tD', interval: '4h', before: 1788000000 });
    const call = firstCall(calls);
    expect(call.url).toContain('/ohlcv/hour?aggregate=4&limit=300&currency=usd&token=CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp&before_timestamp=1788000000');
    expect(call.init.cacheMs).toBe(600_000);
    expect(result.data.candles.map((c) => c.time)).toEqual([1787961600, 1787976000, 1787990400]);
    expect(result.data.candles.every((c) => c.time < 1788000000)).toBe(true);
  });

  it('maps 1h and 1d to hour/day aggregates', async () => {
    const { gt, calls } = setup([{ match: '/ohlcv/', body: fixture('ohlcv_day_1_include_empty.json') }]);
    await gt.getCandles({ mint: MINTS.SOL, pool: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', interval: '1h' });
    await gt.getCandles({ mint: MINTS.SOL, pool: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', interval: '1d' });
    expect(calls[0]?.url).toContain('/ohlcv/hour?aggregate=1&');
    expect(calls[1]?.url).toContain('/ohlcv/day?aggregate=1&');
  });

  it('resolves the top pool with one extra call when no pool is given', async () => {
    const { gt, calls } = setup([
      { match: `/tokens/${CLONES}/pools`, body: fixture('token_top_pools.json') },
      { match: '/ohlcv/', body: fixture('ohlcv_minute_1_limit1000.json') },
    ]);
    const result = await gt.getCandles({ mint: CLONES, interval: '1m' });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain(`/pools/${CLONES_POOL}/ohlcv/minute`);
    expect(result.data.pool).toBe(CLONES_POOL);
  });

  it('is unsupported when no pool exists or the interval is not served', async () => {
    const { gt, calls } = setup([{ match: '/pools?', body: { data: [], included: [] } }]);
    await expect(gt.getCandles({ mint: CLONES, interval: '1m' })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(gt.getCandles({ mint: CLONES, pool: CLONES_POOL, interval: '1s' })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(gt.getCandles({ mint: CLONES, pool: CLONES_POOL, interval: '5s' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(calls).toHaveLength(1);
  });

  it('pro: second candles via timeframe=second, fast freshness; 401 maps to unsupported', async () => {
    const { gt, calls } = setup([{ match: '/ohlcv/second', body: fixture('ohlcv_minute_1_limit1000.json') }], { plan: 'pro', apiKey: PRO_KEY });
    const one = await gt.getCandles({ mint: CLONES, pool: CLONES_POOL, interval: '1s' });
    await gt.getCandles({ mint: CLONES, pool: CLONES_POOL, interval: '15s' });
    expect(calls[0]?.url).toContain('https://pro-api.coingecko.com/api/v3/onchain/networks/solana/pools/');
    expect(calls[0]?.url).toContain('/ohlcv/second?aggregate=1&');
    expect(calls[1]?.url).toContain('/ohlcv/second?aggregate=15&');
    expect(one.freshness).toBe('fast');
    expect(one.source).toBe('coingecko');
    await expect(gt.getCandles({ mint: CLONES, pool: CLONES_POOL, interval: '5s' })).rejects.toMatchObject({ code: 'unsupported' });

    const denied = new ProviderError('coingecko', 'http', 'coingecko ohlcv 1s: HTTP 401', { status: 401 });
    const { gt: basic } = setup([{ match: '/ohlcv/second', error: denied }], { plan: 'pro', apiKey: PRO_KEY });
    await expect(basic.getCandles({ mint: CLONES, pool: CLONES_POOL, interval: '1s' })).rejects.toMatchObject({
      code: 'unsupported',
      provider: 'coingecko',
      status: 401,
    });
  });

  it('rejects an error body as malformed', async () => {
    const { gt } = setup([{ match: '/ohlcv/', body: fixture('ohlcv_invalid_aggregate_error_400.json') }]);
    await expect(gt.getCandles({ mint: CLONES, pool: CLONES_POOL, interval: '1m' })).rejects.toMatchObject({ code: 'malformed' });
  });
});

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

describe('getTrades', () => {
  it('maps pool trades relative to our token, newest first, with a cache note', async () => {
    const { gt, calls } = setup([{ match: '/trades', body: fixture('trades_pool.json') }]);
    const result = await gt.getTrades({ mint: CLONES, pool: CLONES_POOL });
    expect(firstCall(calls).url).toBe(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${CLONES_POOL}/trades?token=${CLONES}`);
    expect(result.freshness).toBe('indexed');
    expect(result.notes).toEqual(['GeckoTerminal trade feed is cached ~30 s']);
    expect(result.data.map((t) => t.side)).toEqual(['buy', 'buy', 'sell']);
    expect(result.data[0]).toMatchObject({
      signature: 'gqcaBQM3GETHZiNYL8XF3YkHNiiWHV2UB4T4fJig6qUskpV4T58kwFoacfGHNAcz4vSNmDJTHwYFcKMTFi9Z5yZ',
      timestamp: Date.parse('2026-09-28T20:45:04Z'),
      wallet: 'Hfy1ettvX6dv2xEhxtM7RithXYam3QCV6fHWfsLzdKA5',
      tokenAmount: 635981.867943,
      solAmount: 4.911028452,
      quoteSymbol: 'SOL',
      pool: CLONES_POOL,
    });
    expect(result.data[2]).toMatchObject({
      side: 'sell',
      tokenAmount: 349698.196244,
      solAmount: 2.66886047,
      priceUsd: Number('0.00090619798496263941716783396352061400584072058186185508847425701'),
      usdValue: Number('316.89580078138243991296698405964001375386326824229686762716071042507267044'),
    });
    expect(result.data.every((t) => t.timestamp > 1e12)).toBe(true); // ms
  });

  it('sorts newest first, dedupes by signature, applies since and limit', async () => {
    const payload = fixture('trades_pool_volume_gt_1000.json');
    const [a, b, c] = dataOf(payload);
    payload.data = [c, a, b, structuredClone(a)];
    const { gt } = setup([{ match: '/trades', body: payload }]);
    const all = await gt.getTrades({ mint: CLONES, pool: CLONES_POOL });
    expect(all.data.map((t) => t.timestamp)).toEqual([
      Date.parse('2026-09-28T20:50:48Z'),
      Date.parse('2026-09-28T20:49:46Z'),
      Date.parse('2026-09-28T20:34:01Z'),
    ]);
    expect(new Set(all.data.map((t) => t.signature)).size).toBe(3);
    const since = await gt.getTrades({ mint: CLONES, pool: CLONES_POOL, since: Date.parse('2026-09-28T20:40:00Z') });
    expect(since.data).toHaveLength(2);
    const limited = await gt.getTrades({ mint: CLONES, pool: CLONES_POOL, limit: 1 });
    expect(limited.data.map((t) => t.timestamp)).toEqual([Date.parse('2026-09-28T20:50:48Z')]);
  });

  it('requires a pool', async () => {
    const { gt, calls } = setup([]);
    await expect(gt.getTrades({ mint: CLONES })).rejects.toMatchObject({ code: 'unsupported', provider: 'geckoterminal' });
    expect(calls).toHaveLength(0);
  });

  it('pro trades are realtime (uncached upstream) and carry no cache note', async () => {
    const { gt, calls } = setup([{ match: '/trades', body: fixture('trades_pool.json') }], { plan: 'pro', apiKey: PRO_KEY });
    const result = await gt.getTrades({ mint: CLONES, pool: CLONES_POOL });
    expect(result.freshness).toBe('realtime');
    expect(result).not.toHaveProperty('notes');
    expect(firstCall(calls).init.cacheMs).toBeUndefined();
    expect(result.data[0]?.source).toBe('coingecko');
  });
});

// ---------------------------------------------------------------------------
// Token info: risk, metadata, holders
// ---------------------------------------------------------------------------

describe('token info: getRisk / getMetadata / getHolders', () => {
  it('risk from a graduated token: authorities, distribution, dev holding, GT score', async () => {
    const { gt, calls } = setup([{ match: `/tokens/${CLONES}/info`, body: fixture('token_info_graduated.json') }]);
    const result = await gt.getRisk(CLONES);
    expect(firstCall(calls).url).toBe(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${CLONES}/info`);
    expect(firstCall(calls).init.cacheMs).toBe(300_000);
    expect(result.freshness).toBe('indexed');
    expect(result.data).toEqual({
      mint: CLONES,
      top10Pct: 89.0668,
      devHoldingPct: 20.66,
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      providerScore: { value: 54.649350649350644, max: 100, label: 'GT Score' },
      flags: [
        { level: 'warn', label: 'Top 10 holders own 89.1%', source: 'geckoterminal' },
        { level: 'warn', label: 'Developer holds 20.7%', source: 'geckoterminal' },
      ],
      sources: ['geckoterminal'],
      updatedAt: result.fetchedAt,
    });
  });

  it('flags active mint/freeze authorities as danger', async () => {
    const payload = fixture('token_info_bonding_curve.json');
    const data = payload.data as { attributes: Record<string, unknown> };
    data.attributes.mint_authority = 'yes';
    data.attributes.freeze_authority = 'yes';
    const { gt } = setup([{ match: '/info', body: payload }]);
    const risk = (await gt.getRisk(XMRPAD)).data;
    expect(risk.mintAuthorityDisabled).toBe(false);
    expect(risk.freezeAuthorityDisabled).toBe(false);
    expect(risk.flags.map((f) => [f.level, f.label])).toEqual([
      ['danger', 'Mint authority enabled'],
      ['danger', 'Freeze authority enabled'],
    ]);
    expect(risk).not.toHaveProperty('top10Pct');
  });

  it('single-mint metadata: images, sanitized socials, launchpad progress', async () => {
    const { gt, calls } = setup([{ match: `/tokens/${XMRPAD}/info`, body: fixture('token_info_bonding_curve.json') }]);
    const result = await gt.getMetadata([XMRPAD]);
    expect(calls).toHaveLength(1);
    expect(result.data[XMRPAD]).toEqual({
      mint: XMRPAD,
      symbol: 'xmrpad',
      name: 'xmrpad',
      decimals: 6,
      image: 'https://assets.geckoterminal.com/xn7xh2wv7r2tjrnw3mvh18jkubfl',
      socials: { website: 'https://xmrpad.com', twitter: 'https://x.com/thexmrpad' },
      description: 'launch a coin. keep the keys.',
      creator: '6hPJt2QQXjog1Wxj3JTKuNs3fFoSrYcaKCQqjKR4P85e',
      verified: false,
      tags: ['Pump Fun'],
      launchpad: { stage: 'bonding', launchpad: 'pump.fun', progressPct: 1.61, progressSource: 'geckoterminal' },
    });
  });

  it('drops a malformed twitter handle and keeps graduation details', async () => {
    const { gt } = setup([{ match: '/info', body: fixture('token_info_graduated.json') }]);
    const meta = (await gt.getMetadata([CLONES])).data[CLONES];
    expect(meta?.socials).toEqual({ website: 'https://yourclone.fun' });
    expect(meta).not.toHaveProperty('description');
    expect(meta).not.toHaveProperty('tags');
    expect(meta?.launchpad).toEqual({
      stage: 'graduated',
      progressPct: 100,
      progressSource: 'geckoterminal',
      graduatedAt: Date.parse('2026-09-28T19:58:10.000Z'),
      migratedPool: 'GG6MBPb94r8dPfba9Fkrn5tyFPWeVZGd1VyBPxQKFSmg',
    });
  });

  it('a token GeckoTerminal does not know is absent from metadata, but getRisk rejects', async () => {
    const notFound = new ProviderError('geckoterminal', 'not_found', 'geckoterminal token info: not found', { status: 404 });
    const { gt } = setup([{ match: '/info', error: notFound }]);
    expect((await gt.getMetadata([CLONES])).data).toEqual({});
    await expect(gt.getRisk(CLONES)).rejects.toBe(notFound);
  });

  it('multi-mint metadata comes from tokens/multi (identity, supply, launchpad; no socials)', async () => {
    const { gt, calls } = setup([{ match: '/tokens/multi/', body: fixture('tokens_multi.json') }]);
    const result = await gt.getMetadata([CLONES, CARDS]);
    expect(calls).toHaveLength(1);
    expect(firstCall(calls).url).toContain('?include=top_pools');
    expect(result.data[CLONES]).toMatchObject({ mint: CLONES, symbol: 'CLONES', decimals: 6, socials: {}, totalSupply: 1_000_000_000, launchpad: { stage: 'graduated' } });
    expect(result.data[CARDS]).toMatchObject({ symbol: 'CARDS', totalSupply: 1977215935.91682 });
    expect(result.data[CARDS]).not.toHaveProperty('launchpad');
    expect(Object.keys(result.data).sort()).toEqual([CLONES, CARDS].sort());
  });

  it('holder summary: count + distribution, no holder list', async () => {
    const { gt } = setup([{ match: '/info', body: fixture('token_info_graduated.json') }]);
    const result = await gt.getHolders(CLONES, 50);
    expect(result.notes).toEqual(['GeckoTerminal provides holder counts and distribution, not a holder list']);
    expect(result.data).toEqual({
      mint: CLONES,
      totalHolders: 2113,
      top: [],
      distribution: { top10Pct: 89.0668, top11to20Pct: 4.0654, top21to40Pct: 4.8878, restPct: 1.98 },
      updatedAt: Date.parse('2026-09-28T20:42:49Z'),
    });
  });

  it('getTokenInfo returns meta, risk and holders from one request', async () => {
    const { gt, calls } = setup([{ match: '/info', body: fixture('token_info_graduated.json') }], { plan: 'demo', apiKey: DEMO_KEY });
    const info = await gt.getTokenInfo(CLONES);
    expect(calls).toHaveLength(1);
    expect(info.source).toBe('coingecko');
    expect(info.data.meta.creator).toBe('9etxSKvGXhPKL1kGDnhrzXZE5yR6hQBpBvk5r36B6CmC');
    expect(info.data.risk.sources).toEqual(['coingecko']);
    expect(info.data.holders.totalHolders).toBe(2113);
  });
});
