import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolInfo, Sourced } from '@/lib/core/types';
import type { GeckoPoolInfo } from '@/lib/providers/geckoterminal';
import { ProviderError } from '@/lib/net/errors';
import { dex, gecko, server } from '../sources';
import { loadPools } from './usePools';

const MINT = '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv';
const POOL = 'DdMA1cHcHEqYfttc1z1sJEY978CcU1pyjNuTWTNmdvzU';

function pools(source: PoolInfo['source'], list: PoolInfo[]): Sourced<GeckoPoolInfo[]> {
  return { data: list, source, fetchedAt: 1, freshness: 'indexed' };
}

const one = (source: PoolInfo['source']): PoolInfo => ({ address: POOL, dex: 'raydium', dexLabel: 'Raydium', baseMint: MINT, source });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadPools', () => {
  it('uses DEX Screener directly and never asks the server when it answers', async () => {
    vi.spyOn(dex, 'getPools').mockResolvedValue(pools('dexscreener', [one('dexscreener')]));
    const gt = vi.spyOn(gecko, 'getPools');
    const srv = vi.spyOn(server.pools, 'getPools');
    const result = await loadPools(MINT);
    expect(result.source).toBe('dexscreener');
    expect(gt).not.toHaveBeenCalled();
    expect(srv).not.toHaveBeenCalled();
  });

  it('falls back to ORBYT /api/v1/pools after the direct sources fail (visitor rate limited)', async () => {
    vi.spyOn(dex, 'getPools').mockRejectedValue(new ProviderError('dexscreener', 'network', 'dexscreener: network error'));
    vi.spyOn(gecko, 'getPools').mockRejectedValue(new ProviderError('geckoterminal', 'rate_limited', 'geckoterminal: rate limited'));
    const srv = vi.spyOn(server.pools, 'getPools').mockResolvedValue(pools('dexscreener', [one('dexscreener')]));
    const result = await loadPools(MINT);
    expect(srv).toHaveBeenCalledWith(MINT, undefined);
    expect(result.data).toHaveLength(1);
    expect(result.attempts.map((a) => [a.provider, a.ok])).toEqual([
      ['dexscreener', false],
      ['geckoterminal', false],
      ['orbyt', true],
    ]);
  });

  it('never blanks the list on a failed refresh: DEX Screener empty + GeckoTerminal and ORBYT failing throws', async () => {
    vi.spyOn(dex, 'getPools').mockResolvedValue(pools('dexscreener', []));
    vi.spyOn(gecko, 'getPools').mockRejectedValue(new ProviderError('geckoterminal', 'network', 'geckoterminal: network error'));
    vi.spyOn(server.pools, 'getPools').mockRejectedValue(new ProviderError('orbyt', 'rate_limited', 'orbyt: 503'));
    // A rejection makes React Query keep the previous list (isRefetchError → "Delayed"); an empty success would replace it.
    await expect(loadPools(MINT)).rejects.toMatchObject({ name: 'ChainError' });
  });

  it('does not ask the server when both sources answered that no pool exists', async () => {
    vi.spyOn(dex, 'getPools').mockResolvedValue(pools('dexscreener', []));
    vi.spyOn(gecko, 'getPools').mockRejectedValue(new ProviderError('geckoterminal', 'not_found', 'geckoterminal: not found'));
    const srv = vi.spyOn(server.pools, 'getPools');
    const result = await loadPools(MINT);
    expect(result.data).toEqual([]);
    expect(srv).not.toHaveBeenCalled();
  });
});
