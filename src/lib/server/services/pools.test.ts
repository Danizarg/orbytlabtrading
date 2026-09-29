import { describe, expect, it } from 'vitest';
import { ChainError } from '@/lib/core/chain';
import type { LiquidityProvider, ProviderId } from '@/lib/core/providers';
import type { Freshness, PoolInfo, Sourced } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import { fillPool, loadPools, mergePools, POOLS_CACHE } from './pools';

const MINT = '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv';
const AMM = 'DdMA1cHcHEqYfttc1z1sJEY978CcU1pyjNuTWTNmdvzU';
const CURVE = '8HbgiXuiNbHRcxiNG8UBD8GLewoy6QVDnPFPgjFGmszf';
const OTHER = '4ov9rwwS4iBHeTWGCrVaQYW1HzWK51MSfs8csGAApump';

function pool(address: string, source: ProviderId, extra: Partial<PoolInfo> = {}): PoolInfo {
  return { address, dex: 'raydium', dexLabel: 'Raydium', baseMint: MINT, source, ...extra };
}

function provider(id: ProviderId, impl: () => Promise<PoolInfo[]>, opts: { freshness?: Freshness; fetchedAt?: number; notes?: string[] } = {}) {
  const calls: string[] = [];
  const p: LiquidityProvider = {
    id,
    getPools: async (mint): Promise<Sourced<PoolInfo[]>> => {
      calls.push(mint);
      const data = await impl();
      return { data, source: id, fetchedAt: opts.fetchedAt ?? 1_000, freshness: opts.freshness ?? 'indexed', ...(opts.notes ? { notes: opts.notes } : {}) };
    },
  };
  return { provider: p, calls };
}

describe('fillPool', () => {
  it('fills only missing fields and never overwrites or changes the source', () => {
    const { pool: out, changed } = fillPool(
      pool(AMM, 'dexscreener', { liquidityUsd: 100 }),
      pool(AMM, 'geckoterminal', { liquidityUsd: 999, volume24hUsd: 50, quoteSymbol: 'SOL' }),
    );
    expect(changed).toBe(true);
    expect(out).toMatchObject({ liquidityUsd: 100, volume24hUsd: 50, quoteSymbol: 'SOL', source: 'dexscreener' });
  });

  it('never gives a graduated (frozen) DEX Screener curve its price back', () => {
    const frozen = pool(CURVE, 'dexscreener', { dex: 'pumpfun', isBondingCurve: true, liquidityUsd: 10 });
    const { pool: out } = fillPool(frozen, pool(CURVE, 'geckoterminal', { dex: 'pumpfun', priceUsd: 0.5, priceNative: 0.1, marketCapUsd: 5e5, fdvUsd: 5e5, volume24hUsd: 3 }));
    expect(out.priceUsd).toBeUndefined();
    expect(out.priceNative).toBeUndefined();
    expect(out.marketCapUsd).toBeUndefined();
    expect(out.fdvUsd).toBeUndefined();
    expect(out.volume24hUsd).toBe(3);
  });
});

describe('fillPool orientation', () => {
  const SOL = 'So11111111111111111111111111111111111111112';

  it('never takes base-side fields from a source that reports the other token as the base', () => {
    // DEX Screener lists the pool with our token as the base but no price; GeckoTerminal reports SOL as the base.
    const ds = pool(AMM, 'dexscreener', { liquidityUsd: 100 });
    const gt = pool(AMM, 'geckoterminal', {
      baseMint: SOL,
      quoteMint: MINT,
      quoteSymbol: 'PENGU',
      priceUsd: 150,
      priceNative: 1,
      fdvUsd: 9e10,
      txns24h: { buys: 1, sells: 2 },
      volume24hUsd: 42,
      createdAt: 5,
    });
    const { pool: out } = fillPool(ds, gt);
    expect(out.baseMint).toBe(MINT);
    // SOL's price is not our token's price.
    expect(out.priceUsd).toBeUndefined();
    expect(out.priceNative).toBeUndefined();
    expect(out.fdvUsd).toBeUndefined();
    expect(out.quoteMint).toBeUndefined();
    expect(out.quoteSymbol).toBeUndefined();
    expect(out.txns24h).toBeUndefined();
    // Pool-level facts are orientation-free.
    expect(out.volume24hUsd).toBe(42);
    expect(out.createdAt).toBe(5);
  });

  it('keeps only PoolInfo fields (no embedded GeckoTerminal token identities)', () => {
    const gt = { ...pool(OTHER, 'geckoterminal'), baseToken: { mint: MINT, symbol: 'X' }, launchpad: { stage: 'amm' } } as PoolInfo;
    const filled = fillPool(pool(OTHER, 'dexscreener'), gt).pool;
    expect(filled).not.toHaveProperty('baseToken');
    expect(filled).not.toHaveProperty('launchpad');
    const merged = mergePools([], [gt]).pools[0];
    expect(merged).not.toHaveProperty('baseToken');
    expect(merged).not.toHaveProperty('launchpad');
    expect(merged).toMatchObject({ address: OTHER, source: 'geckoterminal' });
  });
});

describe('mergePools', () => {
  it('keeps the primary pools, adds unknown ones and ranks by liquidity with curves last', () => {
    const { pools, secondaryUsed } = mergePools(
      [pool(AMM, 'dexscreener', { liquidityUsd: 100 }), pool(CURVE, 'dexscreener', { isBondingCurve: true, liquidityUsd: 1_000 })],
      [pool(OTHER, 'geckoterminal', { liquidityUsd: 500 }), pool(AMM, 'geckoterminal', { liquidityUsd: 1 })],
    );
    expect(secondaryUsed).toBe(true);
    expect(pools.map((p) => p.address)).toEqual([OTHER, AMM, CURVE]);
    expect(pools.find((p) => p.address === AMM)?.liquidityUsd).toBe(100);
  });

  it('reports no secondary contribution when it adds nothing', () => {
    const { secondaryUsed } = mergePools([pool(AMM, 'dexscreener', { liquidityUsd: 1 })], [pool(AMM, 'geckoterminal', { liquidityUsd: 2 })]);
    expect(secondaryUsed).toBe(false);
  });
});

describe('loadPools', () => {
  it('asks both sources in parallel and merges them (DEX Screener leads, GeckoTerminal contributes)', async () => {
    const ds = provider('dexscreener', async () => [pool(AMM, 'dexscreener', { liquidityUsd: 100 })], { fetchedAt: 2_000, notes: ['ds note'] });
    const gt = provider('geckoterminal', async () => [pool(OTHER, 'geckoterminal', { liquidityUsd: 50 })], { fetchedAt: 1_500 });
    const result = await loadPools(MINT, { dex: ds.provider, gecko: gt.provider });
    expect(ds.calls).toEqual([MINT]);
    expect(gt.calls).toEqual([MINT]);
    expect(result.data.map((p) => p.address)).toEqual([AMM, OTHER]);
    expect(result.source).toBe('dexscreener');
    expect(result.contributors).toEqual(['geckoterminal']);
    expect(result.fetchedAt).toBe(1_500);
    expect(result.freshness).toBe('indexed');
    expect(result.notes).toEqual(['ds note']);
    expect(result.attempts).toEqual([
      { provider: 'dexscreener', ok: true },
      { provider: 'geckoterminal', ok: true },
    ]);
  });

  it('one failing source never blanks the list (and its failure stays visible)', async () => {
    const ds = provider('dexscreener', async () => {
      throw new ProviderError('dexscreener', 'rate_limited', 'dexscreener: HTTP 429');
    });
    const gt = provider('geckoterminal', async () => [pool(AMM, 'geckoterminal')]);
    const result = await loadPools(MINT, { dex: ds.provider, gecko: gt.provider });
    expect(result.data.map((p) => p.address)).toEqual([AMM]);
    expect(result.source).toBe('geckoterminal');
    expect(result.contributors).toBeUndefined();
    expect(result.attempts[0]).toMatchObject({ provider: 'dexscreener', ok: false, code: 'rate_limited' });
  });

  it('an empty answer does not hide the other source’s pools', async () => {
    const ds = provider('dexscreener', async () => []);
    const gt = provider('coingecko', async () => [pool(AMM, 'coingecko')], { freshness: 'fast' });
    const result = await loadPools(MINT, { dex: ds.provider, gecko: gt.provider });
    expect(result.source).toBe('coingecko');
    expect(result.data).toHaveLength(1);
    expect(result.freshness).toBe('fast');
  });

  it('returns an honest empty list when both answer without pools', async () => {
    const result = await loadPools(MINT, { dex: provider('dexscreener', async () => []).provider, gecko: provider('geckoterminal', async () => []).provider });
    expect(result.data).toEqual([]);
    expect(result.source).toBe('dexscreener');
  });

  it('a 404 is an answer: empty plus not-found stays an honest empty list', async () => {
    const gt = provider('geckoterminal', async () => {
      throw new ProviderError('geckoterminal', 'not_found', 'geckoterminal: not found');
    });
    const result = await loadPools(MINT, { dex: provider('dexscreener', async () => []).provider, gecko: gt.provider });
    expect(result.data).toEqual([]);
  });

  it('"no pools" while the other source failed is unknown: throws so the route serves its last good list', async () => {
    const gt = provider('geckoterminal', async () => {
      throw new ProviderError('geckoterminal', 'rate_limited', 'geckoterminal: HTTP 429');
    });
    const error = await loadPools(MINT, { dex: provider('dexscreener', async () => []).provider, gecko: gt.provider }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).attempts.map((a) => [a.provider, a.ok, a.code])).toEqual([
      ['dexscreener', true, undefined],
      ['geckoterminal', false, 'rate_limited'],
    ]);
  });

  it('throws a ChainError with both attempts when every source fails', async () => {
    const fail = (id: ProviderId) =>
      provider(id, async () => {
        throw new ProviderError(id, 'timeout', `${id}: timeout`);
      }).provider;
    const error = await loadPools(MINT, { dex: fail('dexscreener'), gecko: fail('geckoterminal') }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).attempts.map((a) => [a.provider, a.code])).toEqual([
      ['dexscreener', 'timeout'],
      ['geckoterminal', 'timeout'],
    ]);
  });

  it('is CDN-cached for 60 s', () => {
    expect(POOLS_CACHE.sMaxAge).toBe(60);
  });
});
