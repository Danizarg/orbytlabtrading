import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChainResult } from '@/lib/core/chain';
import type { Sourced, TokenRow } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import { POLL } from '../query';
import { dex, gecko, jup, server } from '../sources';
import { loadTokenRow, tokenRowPollInterval } from './useTokenOverview';

const MINT = '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv';

function rows(source: TokenRow['market']['source'], list: string[], freshness: Sourced<unknown>['freshness'] = 'fast'): Sourced<TokenRow[]> {
  return {
    data: list.map((mint) => ({ token: { mint, symbol: 'PENGU' }, market: { mint, stats: {}, updatedAt: 1, source } })),
    source,
    fetchedAt: 1,
    freshness,
  };
}

const limited = (id: 'jupiter' | 'dexscreener' | 'geckoterminal') => new ProviderError(id, 'rate_limited', `${id}: rate limited`);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadTokenRow', () => {
  it('asks DEX Screener before GeckoTerminal when Jupiter fails (keeps the GeckoTerminal budget for charts)', async () => {
    vi.spyOn(jup, 'getRows').mockRejectedValue(limited('jupiter'));
    vi.spyOn(dex, 'getRows').mockResolvedValue(rows('dexscreener', [MINT], 'indexed'));
    const gt = vi.spyOn(gecko, 'getRows');
    const srv = vi.spyOn(server.tokens, 'getRows');
    const result = await loadTokenRow(MINT, false);
    expect(result.data?.token.mint).toBe(MINT);
    expect(result.source).toBe('dexscreener');
    expect(gt).not.toHaveBeenCalled();
    expect(srv).not.toHaveBeenCalled();
  });

  it('reaches the keyless ORBYT tokens route when every browser source is rate limited', async () => {
    vi.spyOn(jup, 'getRows').mockRejectedValue(limited('jupiter'));
    vi.spyOn(dex, 'getRows').mockRejectedValue(limited('dexscreener'));
    vi.spyOn(gecko, 'getRows').mockRejectedValue(limited('geckoterminal'));
    const srv = vi.spyOn(server.tokens, 'getRows').mockResolvedValue(rows('jupiter', [MINT]));
    const result = await loadTokenRow(MINT, false);
    expect(srv).toHaveBeenCalledWith([MINT], undefined);
    expect(result.data?.token.mint).toBe(MINT);
    expect(result.attempts.at(-1)).toEqual({ provider: 'orbyt', ok: true });
  });

  it('with a keyed route, asks it first and not again at the end', async () => {
    const srv = vi.spyOn(server.tokens, 'getRows').mockRejectedValue(new ProviderError('orbyt', 'rate_limited', 'orbyt: 503'));
    vi.spyOn(jup, 'getRows').mockRejectedValue(limited('jupiter'));
    vi.spyOn(dex, 'getRows').mockRejectedValue(limited('dexscreener'));
    vi.spyOn(gecko, 'getRows').mockRejectedValue(limited('geckoterminal'));
    await expect(loadTokenRow(MINT, true)).rejects.toThrow();
    expect(srv).toHaveBeenCalledOnce();
  });

  it('keeps "not listed" definitive when every source answered without the mint', async () => {
    vi.spyOn(jup, 'getRows').mockResolvedValue(rows('jupiter', []));
    vi.spyOn(dex, 'getRows').mockResolvedValue(rows('dexscreener', [], 'indexed'));
    vi.spyOn(gecko, 'getRows').mockResolvedValue(rows('geckoterminal', [], 'indexed'));
    const srv = vi.spyOn(server.tokens, 'getRows');
    const result = await loadTokenRow(MINT, false);
    expect(result.data).toBeUndefined();
    expect(srv).not.toHaveBeenCalled();
  });
});

describe('tokenRowPollInterval', () => {
  const result = (winner: 'jupiter' | 'orbyt' | 'dexscreener', freshness: 'fast' | 'indexed'): ChainResult<unknown> => ({
    data: undefined,
    source: 'jupiter',
    fetchedAt: 1,
    freshness,
    attempts: [{ provider: winner, ok: true }],
  });

  it('polls fast only for fast sources, including ORBYT relaying Jupiter', () => {
    expect(tokenRowPollInterval(result('jupiter', 'fast'))).toBe(POLL.fast);
    expect(tokenRowPollInterval(result('orbyt', 'fast'))).toBe(POLL.fast);
  });

  it('polls at the indexed cadence for indexed data, whoever relays it', () => {
    expect(tokenRowPollInterval(result('orbyt', 'indexed'))).toBe(POLL.indexed);
    expect(tokenRowPollInterval(result('dexscreener', 'indexed'))).toBe(POLL.indexed);
    expect(tokenRowPollInterval(undefined)).toBe(POLL.indexed);
  });
});
