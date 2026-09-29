import { describe, expect, it, vi } from 'vitest';
import { ChainError } from '@/lib/core/chain';
import type { DiscoverQuery, ProviderId, TokenDiscoveryProvider, TokenRowsProvider } from '@/lib/core/providers';
import type { Freshness, Sourced, TokenRow } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import type { JupiterUltraInfo } from '@/lib/providers/jupiter';
import { NotConfiguredError } from './errors';
import { applyUltraInfo, loadDiscover, loadTokenRows, ULTRA_UNAVAILABLE_NOTE, type DiscoverDeps } from './discover';

const A = '4ov9rwwS4iBHeTWGCrVaQYW1HzWK51MSfs8csGAApump';
const B = 'GJJ6TADXU6TdvBR8siNxLqYzbcwc6ixgxFCg7Ystpump';
const C = '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump';

function row(mint: string, source: ProviderId, extra: Partial<TokenRow> = {}): TokenRow {
  return { token: { mint, symbol: mint.slice(0, 3) }, market: { mint, stats: {}, updatedAt: 1, source }, ...extra };
}

function sourced<T>(data: T, source: ProviderId, freshness: Freshness = 'fast', fetchedAt = 1_000): Sourced<T> {
  return { data, source, fetchedAt, freshness };
}

const QUERY: DiscoverQuery = { list: 'trending', window: '1h', limit: 50 };

describe('applyUltraInfo', () => {
  it('fills missing holder-risk fields without overwriting row values', () => {
    const rows = [row(A, 'jupiter', { risk: { top10Pct: 30 } }), row(B, 'jupiter')];
    const info: Record<string, JupiterUltraInfo> = {
      [A]: { risk: { top10Pct: 99, snipersPct: 4 } },
      [B]: { risk: { bundlersPct: 7 } },
    };
    const { rows: out, changed } = applyUltraInfo(rows, info);
    expect(changed).toBe(true);
    expect(out[0]?.risk).toEqual({ top10Pct: 30, snipersPct: 4 });
    expect(out[1]?.risk).toEqual({ bundlersPct: 7 });
    expect(rows[0]?.risk).toEqual({ top10Pct: 30 });
  });

  it('adds bonding progress only to rows known to be on a curve', () => {
    const bonding = row(A, 'jupiter', { token: { mint: A, launchpad: { stage: 'bonding', launchpad: 'pump.fun' } } });
    const amm = row(B, 'jupiter', { token: { mint: B, launchpad: { stage: 'amm' } } });
    const known = row(C, 'jupiter', { token: { mint: C, launchpad: { stage: 'bonding', progressPct: 12, progressSource: 'solana-rpc' } } });
    const { rows: out } = applyUltraInfo([bonding, amm, known], {
      [A]: { progressPct: 140, risk: {} },
      [B]: { progressPct: 50, risk: {} },
      [C]: { progressPct: 90, risk: {} },
    });
    expect(out[0]?.token.launchpad).toEqual({ stage: 'bonding', launchpad: 'pump.fun', progressPct: 100, progressSource: 'jupiter' });
    expect(out[1]).toBe(amm);
    expect(out[2]).toBe(known);
  });

  it('reports no change when Ultra adds nothing', () => {
    const rows = [row(A, 'jupiter', { risk: { snipersPct: 1 } })];
    const result = applyUltraInfo(rows, { [A]: { risk: { snipersPct: 5 } } });
    expect(result.changed).toBe(false);
    expect(result.rows[0]).toBe(rows[0]);
  });
});

function discoverProvider(id: ProviderId, impl: (q: DiscoverQuery) => Promise<Sourced<TokenRow[]>>): TokenDiscoveryProvider {
  return { id, discover: impl };
}

function jupiter(rows: TokenRow[], ultra: () => Promise<Sourced<Record<string, JupiterUltraInfo>>>): NonNullable<DiscoverDeps['jupiter']> {
  return { id: 'jupiter', discover: async () => sourced(rows, 'jupiter'), getUltraInfo: vi.fn(ultra) };
}

describe('loadDiscover', () => {
  it('is not configured without a Jupiter or CoinGecko key', async () => {
    await expect(loadDiscover(QUERY, { jupiter: null, coingecko: null })).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it('enriches Jupiter rows with Ultra extras', async () => {
    const jup = jupiter([row(A, 'jupiter')], async () => sourced({ [A]: { risk: { insidersPct: 8 } } }, 'jupiter'));
    const result = await loadDiscover(QUERY, { jupiter: jup, coingecko: null });
    expect(result.data[0]?.risk).toEqual({ insidersPct: 8 });
    expect(result.contributors).toBeUndefined();
    expect(jup.getUltraInfo).toHaveBeenCalledWith([A]);
  });

  it('falls back to CoinGecko and credits Jupiter only when Ultra contributed', async () => {
    const jup: NonNullable<DiscoverDeps['jupiter']> = {
      id: 'jupiter',
      discover: async () => {
        throw new ProviderError('jupiter', 'rate_limited', 'jupiter: HTTP 429');
      },
      getUltraInfo: async () => sourced({ [B]: { risk: { snipersPct: 2 } } }, 'jupiter'),
    };
    const gecko = discoverProvider('coingecko', async () => sourced([row(B, 'coingecko')], 'coingecko', 'indexed'));
    const result = await loadDiscover(QUERY, { jupiter: jup, coingecko: gecko });
    expect(result.source).toBe('coingecko');
    expect(result.contributors).toEqual(['jupiter']);
    expect(result.data[0]?.risk).toEqual({ snipersPct: 2 });
    expect(result.attempts.map((a) => a.ok)).toEqual([false, true]);
  });

  it('keeps rows and adds a note when Ultra fails', async () => {
    const jup = jupiter([row(A, 'jupiter')], async () => {
      throw new ProviderError('jupiter', 'http', 'jupiter: HTTP 500', { status: 500 });
    });
    const result = await loadDiscover(QUERY, { jupiter: jup, coingecko: null });
    expect(result.data).toHaveLength(1);
    expect(result.notes).toEqual([ULTRA_UNAVAILABLE_NOTE]);
  });

  it('skips Ultra when the list is empty', async () => {
    const jup = jupiter([], async () => sourced({}, 'jupiter'));
    const result = await loadDiscover(QUERY, { jupiter: jup, coingecko: null });
    expect(result.data).toEqual([]);
    expect(jup.getUltraInfo).not.toHaveBeenCalled();
  });

  it('never asks CoinGecko for the organic list it cannot rank', async () => {
    const gecko = { id: 'coingecko' as const, discover: vi.fn(async () => sourced([row(B, 'coingecko')], 'coingecko', 'indexed')) };
    const organic: DiscoverQuery = { ...QUERY, list: 'organic' };
    // CoinGecko alone: a capability gap (501), not a failed upstream call.
    await expect(loadDiscover(organic, { jupiter: null, coingecko: gecko })).rejects.toBeInstanceOf(NotConfiguredError);
    expect(gecko.discover).not.toHaveBeenCalled();

    // With Jupiter failing, the chain ends at Jupiter instead of recording a pointless CoinGecko attempt.
    const failing: NonNullable<DiscoverDeps['jupiter']> = {
      id: 'jupiter',
      discover: async () => {
        throw new ProviderError('jupiter', 'http', 'jupiter: HTTP 500', { status: 500 });
      },
      getUltraInfo: async () => sourced({}, 'jupiter'),
    };
    const error = await loadDiscover(organic, { jupiter: failing, coingecko: gecko }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).attempts.map((a) => a.provider)).toEqual(['jupiter']);
    expect(gecko.discover).not.toHaveBeenCalled();

    // Lists CoinGecko does rank still fall back to it.
    const top = await loadDiscover({ ...QUERY, list: 'top' }, { jupiter: failing, coingecko: gecko });
    expect(top.source).toBe('coingecko');
  });
});

function rowsProvider(id: ProviderId, known: string[], freshness: Freshness, calls: string[][]): TokenRowsProvider {
  return {
    id,
    getRows: async (mints) => {
      calls.push([...mints]);
      return sourced(
        mints.filter((m) => known.includes(m)).map((m) => row(m, id)),
        id,
        freshness,
        id === 'jupiter' ? 2_000 : 1_500,
      );
    },
  };
}

describe('loadTokenRows', () => {
  it('is not configured without keyed row providers', async () => {
    await expect(loadTokenRows([A], { jupiter: null, coingecko: null })).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it('asks the next provider only for missing mints and keeps request order', async () => {
    const calls: string[][] = [];
    const result = await loadTokenRows([A, B, C], {
      jupiter: rowsProvider('jupiter', [A, C], 'fast', calls),
      coingecko: rowsProvider('coingecko', [B], 'indexed', calls),
    });
    expect(calls).toEqual([[A, B, C], [B]]);
    expect(result.data.map((r) => r.token.mint)).toEqual([A, B, C]);
    expect(result.source).toBe('jupiter');
    expect(result.contributors).toEqual(['coingecko']);
    expect(result.freshness).toBe('indexed');
    expect(result.fetchedAt).toBe(1_500);
  });

  it('stops once every mint is covered', async () => {
    const calls: string[][] = [];
    await loadTokenRows([A], { jupiter: rowsProvider('jupiter', [A], 'fast', calls), coingecko: rowsProvider('coingecko', [A], 'indexed', calls) });
    expect(calls).toEqual([[A]]);
  });

  it('credits the provider that actually supplied rows', async () => {
    const calls: string[][] = [];
    const result = await loadTokenRows([B], {
      jupiter: rowsProvider('jupiter', [], 'fast', calls),
      coingecko: rowsProvider('coingecko', [B], 'indexed', calls),
    });
    expect(result.source).toBe('coingecko');
    expect(result.contributors).toBeUndefined();
    expect(result.attempts.map((a) => [a.provider, a.ok])).toEqual([
      ['jupiter', true],
      ['coingecko', true],
    ]);
  });

  it('returns an honest empty list when providers answer but know none of the mints', async () => {
    const calls: string[][] = [];
    const result = await loadTokenRows([A], { jupiter: rowsProvider('jupiter', [], 'fast', calls), coingecko: null });
    expect(result.data).toEqual([]);
    expect(result.source).toBe('jupiter');
  });

  it('throws a ChainError when every provider fails', async () => {
    const failing: TokenRowsProvider = {
      id: 'jupiter',
      getRows: async () => {
        throw new ProviderError('jupiter', 'timeout', 'jupiter: timeout');
      },
    };
    await expect(loadTokenRows([A], { jupiter: failing, coingecko: null })).rejects.toBeInstanceOf(ChainError);
  });
});

describe('loadTokenRows keyless fallback', () => {
  function failing(id: ProviderId, calls: string[][]): TokenRowsProvider {
    return {
      id,
      getRows: async (mints) => {
        calls.push([...mints]);
        throw new ProviderError(id, 'rate_limited', `${id}: HTTP 429`);
      },
    };
  }

  it('answers without any key: keyless Jupiter, then DEX Screener for the mints still missing', async () => {
    const calls: string[][] = [];
    const result = await loadTokenRows([A, B], {
      jupiter: null,
      coingecko: null,
      jupiterKeyless: rowsProvider('jupiter', [A], 'fast', calls),
      dex: rowsProvider('dexscreener', [B], 'indexed', calls),
    });
    expect(calls).toEqual([[A, B], [B]]);
    expect(result.data.map((r) => r.token.mint)).toEqual([A, B]);
    expect(result.source).toBe('jupiter');
    expect(result.contributors).toEqual(['dexscreener']);
    expect(result.freshness).toBe('indexed');
    expect(result.keyless).toBe(true);
  });

  it('falls through a rate-limited keyless Jupiter to DEX Screener', async () => {
    const calls: string[][] = [];
    const result = await loadTokenRows([A], { jupiter: null, coingecko: null, jupiterKeyless: failing('jupiter', calls), dex: rowsProvider('dexscreener', [A], 'indexed', calls) });
    expect(result.source).toBe('dexscreener');
    expect(result.attempts.map((a) => [a.provider, a.ok])).toEqual([
      ['jupiter', false],
      ['dexscreener', true],
    ]);
  });

  it('keyed sources cover everything: no keyless call, keyed cache lifetime', async () => {
    const calls: string[][] = [];
    const keyless: string[][] = [];
    const result = await loadTokenRows([A], {
      jupiter: rowsProvider('jupiter', [A], 'fast', calls),
      coingecko: null,
      jupiterKeyless: rowsProvider('jupiter', [A], 'fast', keyless),
      dex: rowsProvider('dexscreener', [A], 'indexed', keyless),
    });
    expect(keyless).toEqual([]);
    expect(result.keyless).toBe(false);
  });

  it('skips keyless Jupiter when the keyed Jupiter answered (same index), but still asks DEX Screener', async () => {
    const keyedCalls: string[][] = [];
    const keylessJup: string[][] = [];
    const dexCalls: string[][] = [];
    const result = await loadTokenRows([A, B], {
      jupiter: rowsProvider('jupiter', [A], 'fast', keyedCalls),
      coingecko: null,
      jupiterKeyless: rowsProvider('jupiter', [B], 'fast', keylessJup),
      dex: rowsProvider('dexscreener', [B], 'indexed', dexCalls),
    });
    expect(keylessJup).toEqual([]);
    expect(dexCalls).toEqual([[B]]);
    expect(result.data.map((r) => r.token.mint)).toEqual([A, B]);
    expect(result.keyless).toBe(true);
  });

  it('uses keyless Jupiter when the keyed Jupiter failed', async () => {
    const calls: string[][] = [];
    const result = await loadTokenRows([A], {
      jupiter: failing('jupiter', calls),
      coingecko: null,
      jupiterKeyless: rowsProvider('jupiter', [A], 'fast', calls),
      dex: null,
    });
    expect(calls).toEqual([[A], [A]]);
    expect(result.data).toHaveLength(1);
    expect(result.attempts.map((a) => a.ok)).toEqual([false, true]);
  });

  it('no rows while an index failed is unknown, not unlisted: throws so the route serves its last good rows', async () => {
    const calls: string[][] = [];
    const error = await loadTokenRows([A], {
      jupiter: null,
      coingecko: null,
      jupiterKeyless: failing('jupiter', calls),
      dex: rowsProvider('dexscreener', [], 'indexed', calls),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).attempts.map((a) => [a.provider, a.ok])).toEqual([
      ['jupiter', false],
      ['dexscreener', true],
    ]);
  });

  it('keeps an honest empty list when a failed keyed Jupiter is covered by keyless Jupiter answering', async () => {
    const calls: string[][] = [];
    const result = await loadTokenRows([A], {
      jupiter: failing('jupiter', calls),
      coingecko: null,
      jupiterKeyless: rowsProvider('jupiter', [], 'fast', calls),
      dex: rowsProvider('dexscreener', [], 'indexed', calls),
    });
    expect(result.data).toEqual([]);
  });

  it('throws a ChainError (never an empty success) when every keyless source fails', async () => {
    const calls: string[][] = [];
    await expect(
      loadTokenRows([A], { jupiter: null, coingecko: null, jupiterKeyless: failing('jupiter', calls), dex: failing('dexscreener', calls) }),
    ).rejects.toBeInstanceOf(ChainError);
  });
});
