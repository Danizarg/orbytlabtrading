import { describe, expect, it, vi } from 'vitest';
import { ChainError } from '@/lib/core/chain';
import type { HolderProvider, ProviderId } from '@/lib/core/providers';
import type { HolderEntry, HolderSnapshot, Sourced } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import { NotConfiguredError } from './errors';
import {
  BONDING_CURVE_LABEL,
  derivePumpSwapPool,
  HELIUS_DEPTH_NOTE,
  holderProvidersFor,
  labelHolders,
  launchpadHolderLabels,
  loadHolders,
  mergeHolderSummary,
  needsHolderSummary,
  PUMPSWAP_POOL_LABEL,
  type HoldersDeps,
} from './holders';

// Live-verified vectors: tests/fixtures/pump/pumpswap_canonical_pool_decoded_rpc_2026-09-28.json
const GRADUATED = [
  { mint: '4ov9rwwS4iBHeTWGCrVaQYW1HzWK51MSfs8csGAApump', pool: '8HbgiXuiNbHRcxiNG8UBD8GLewoy6QVDnPFPgjFGmszf' },
  { mint: 'GJJ6TADXU6TdvBR8siNxLqYzbcwc6ixgxFCg7Ystpump', pool: '4N5bUkvsWX5pQYz1WNNzszmVEua77ZwBMaJnKrPpddTX' },
];
// tests/fixtures/solana-rpc/rpc_getSignaturesForAddress_bondingcurve.json
const CURVE_VECTOR = { mint: '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump', curve: '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A' };

const MINT = CURVE_VECTOR.mint;
const WALLET_A = 'So11111111111111111111111111111111111111112';
const WALLET_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function entry(owner: string, amount: number, extra: Partial<HolderEntry> = {}): HolderEntry {
  return { owner, amount, ...extra };
}

function snapshot(partial: Partial<HolderSnapshot> = {}): HolderSnapshot {
  return { mint: MINT, top: [entry(WALLET_A, 10)], updatedAt: 1_000, ...partial };
}

function holderProvider(id: ProviderId, impl: () => Promise<Sourced<HolderSnapshot>>): HolderProvider & { calls: number } {
  const p = {
    id,
    calls: 0,
    getHolders: () => {
      p.calls++;
      return impl();
    },
  };
  return p;
}

function ok(data: HolderSnapshot, source: ProviderId): Sourced<HolderSnapshot> {
  return { data, source, fetchedAt: 5_000, freshness: source === 'helius' ? 'realtime' : 'indexed' };
}

function deps(overrides: Partial<HoldersDeps> = {}): HoldersDeps {
  return { helius: null, birdeye: null, solanaTracker: null, coingecko: null, labels: async () => ({}), ...overrides };
}

describe('launchpad PDA derivations', () => {
  it.each(GRADUATED)('derives the canonical PumpSwap pool of $mint', async ({ mint, pool }) => {
    expect(await derivePumpSwapPool(mint)).toBe(pool);
  });

  it('returns undefined for an invalid mint', async () => {
    expect(await derivePumpSwapPool('not-a-mint')).toBeUndefined();
  });

  it('labels the bonding-curve PDA and the PumpSwap pool', async () => {
    const labels = await launchpadHolderLabels(CURVE_VECTOR.mint);
    expect(labels[CURVE_VECTOR.curve]).toBe(BONDING_CURVE_LABEL);
    expect(Object.values(labels).filter((l) => l === PUMPSWAP_POOL_LABEL)).toHaveLength(1);
    const graduated = await launchpadHolderLabels(GRADUATED[0]!.mint);
    expect(graduated[GRADUATED[0]!.pool]).toBe(PUMPSWAP_POOL_LABEL);
  });
});

describe('labelHolders', () => {
  it('labels matching owners or token accounts and marks them as program accounts', () => {
    const snap = snapshot({
      top: [entry(CURVE_VECTOR.curve, 500), entry(WALLET_A, 10, { tokenAccount: WALLET_B }), entry(WALLET_B, 5)],
    });
    const out = labelHolders(snap, { [CURVE_VECTOR.curve]: BONDING_CURVE_LABEL, [WALLET_B]: 'Pool vault' });
    expect(out.top[0]).toMatchObject({ label: BONDING_CURVE_LABEL, isProgramAccount: true });
    expect(out.top[1]).toMatchObject({ owner: WALLET_A, label: 'Pool vault' });
    // A token-account match says nothing about the owner being a program.
    expect(out.top[1]?.isProgramAccount).toBeUndefined();
    expect(out.top[2]).toMatchObject({ owner: WALLET_B, label: 'Pool vault', isProgramAccount: true });
    // Input untouched.
    expect(snap.top[0]?.label).toBeUndefined();
  });

  it('keeps provider labels and returns the same object when nothing matches', () => {
    const snap = snapshot({ top: [entry(CURVE_VECTOR.curve, 1, { label: 'Pump.fun AMM' })] });
    expect(labelHolders(snap, { [CURVE_VECTOR.curve]: BONDING_CURVE_LABEL })).toBe(snap);
    expect(labelHolders(snapshot(), {})).toStrictEqual(snapshot());
  });
});

describe('mergeHolderSummary', () => {
  const summary = snapshot({ top: [], totalHolders: 1_234, distribution: { top10Pct: 30, restPct: 70 } });

  it('fills a missing count and distribution', () => {
    const { snapshot: out, used } = mergeHolderSummary(snapshot(), summary);
    expect(used).toEqual(['totalHolders', 'distribution']);
    expect(out.totalHolders).toBe(1_234);
    expect(out.distribution).toEqual({ top10Pct: 30, restPct: 70 });
    expect(out.top).toHaveLength(1);
  });

  it('never overwrites or mixes distributions from two providers', () => {
    const own = snapshot({ totalHolders: 99, distribution: { top10Pct: 55 } });
    const { snapshot: out, used } = mergeHolderSummary(own, summary);
    expect(used).toEqual([]);
    expect(out).toBe(own);
    expect(out.distribution).toEqual({ top10Pct: 55 });
  });

  it('ignores a summary for another mint', () => {
    expect(mergeHolderSummary(snapshot(), { ...summary, mint: WALLET_B }).used).toEqual([]);
  });

  it('knows when a summary is worth fetching', () => {
    expect(needsHolderSummary(snapshot())).toBe(true);
    expect(needsHolderSummary(snapshot({ totalHolders: 1, distribution: {} }))).toBe(false);
  });
});

describe('loadHolders', () => {
  it('is not configured without a holder-list provider (a summary alone is not a list)', async () => {
    const gecko = holderProvider('coingecko', async () => ok(snapshot({ top: [] }), 'coingecko'));
    await expect(loadHolders(MINT, 20, deps({ coingecko: gecko }))).rejects.toBeInstanceOf(NotConfiguredError);
    expect(gecko.calls).toBe(0);
  });

  it('labels launchpad accounts and merges the CoinGecko summary into a Helius list', async () => {
    const helius = holderProvider('helius', async () =>
      ok(snapshot({ top: [entry(CURVE_VECTOR.curve, 800), entry(WALLET_A, 10)], distribution: { top10Pct: 81 } }), 'helius'),
    );
    const gecko = holderProvider('coingecko', async () => ok(snapshot({ top: [], totalHolders: 4_321, distribution: { top10Pct: 20 } }), 'coingecko'));
    const result = await loadHolders(MINT, 20, deps({ helius, coingecko: gecko, labels: launchpadHolderLabels }));
    expect(result.source).toBe('helius');
    expect(result.data.top[0]).toMatchObject({ owner: CURVE_VECTOR.curve, label: BONDING_CURVE_LABEL, isProgramAccount: true });
    expect(result.data.totalHolders).toBe(4_321);
    // Helius' own distribution is kept.
    expect(result.data.distribution).toEqual({ top10Pct: 81 });
    expect(result.contributors).toEqual(['coingecko']);
    expect(result.notes).toEqual(['Holder count from CoinGecko.']);
  });

  it('skips the summary call when the list already has count and distribution', async () => {
    const st = holderProvider('solanatracker', async () => ok(snapshot({ totalHolders: 10, distribution: { top10Pct: 40 } }), 'solanatracker'));
    const gecko = holderProvider('coingecko', async () => ok(snapshot({ top: [] }), 'coingecko'));
    const result = await loadHolders(MINT, 20, deps({ solanaTracker: st, coingecko: gecko }));
    expect(gecko.calls).toBe(0);
    expect(result.contributors).toBeUndefined();
  });

  it('tolerates a failing summary and failing label derivation', async () => {
    const bird = holderProvider('birdeye', async () => ok(snapshot(), 'birdeye'));
    const gecko = holderProvider('coingecko', async () => {
      throw new ProviderError('coingecko', 'rate_limited', 'coingecko: HTTP 429');
    });
    const labels = vi.fn(async () => {
      throw new Error('derivation failed');
    });
    const result = await loadHolders(MINT, 20, deps({ birdeye: bird, coingecko: gecko, labels }));
    expect(result.source).toBe('birdeye');
    expect(result.data.totalHolders).toBeUndefined();
    expect(result.notes).toBeUndefined();
  });

  it('fails over past an empty list and an error, in Helius → Birdeye → Solana Tracker order', async () => {
    const order: string[] = [];
    const helius = holderProvider('helius', async () => {
      order.push('helius');
      throw new ProviderError('helius', 'timeout', 'helius: timeout');
    });
    const bird = holderProvider('birdeye', async () => {
      order.push('birdeye');
      return ok(snapshot({ top: [] }), 'birdeye');
    });
    const st = holderProvider('solanatracker', async () => {
      order.push('solanatracker');
      return ok(snapshot({ totalHolders: 5, distribution: {} }), 'solanatracker');
    });
    const result = await loadHolders(MINT, 20, deps({ helius, birdeye: bird, solanaTracker: st }));
    expect(order).toEqual(['helius', 'birdeye', 'solanatracker']);
    expect(result.source).toBe('solanatracker');
    expect(result.attempts.map((a) => a.ok)).toEqual([false, false, true]);
  });

  it('asks the indexers first for lists deeper than Helius serves, keeping Helius as the fallback', async () => {
    const helius = holderProvider('helius', async () => ok(snapshot(), 'helius'));
    const bird = holderProvider('birdeye', async () => ok(snapshot(), 'birdeye'));
    const st = holderProvider('solanatracker', async () => ok(snapshot(), 'solanatracker'));
    const all = deps({ helius, birdeye: bird, solanaTracker: st });
    expect(holderProvidersFor(20, all).map((p) => p.id)).toEqual(['helius', 'birdeye', 'solanatracker']);
    expect(holderProvidersFor(100, all).map((p) => p.id)).toEqual(['birdeye', 'solanatracker', 'helius']);

    const deep = await loadHolders(MINT, 100, all);
    expect(deep.source).toBe('birdeye');
    expect(helius.calls).toBe(0);
  });

  it('says so when only the on-chain top 20 could serve a deeper request', async () => {
    const helius = holderProvider('helius', async () => ok(snapshot({ totalHolders: 3, distribution: {} }), 'helius'));
    const bird = holderProvider('birdeye', async () => {
      throw new ProviderError('birdeye', 'timeout', 'birdeye: timeout');
    });
    const result = await loadHolders(MINT, 50, deps({ helius, birdeye: bird }));
    expect(result.source).toBe('helius');
    expect(result.notes).toEqual([HELIUS_DEPTH_NOTE]);
    const shallow = await loadHolders(MINT, 20, deps({ helius }));
    expect(shallow.notes).toBeUndefined();
  });

  it('propagates a ChainError when every list provider fails', async () => {
    const helius = holderProvider('helius', async () => {
      throw new ProviderError('helius', 'not_found', 'helius: not found');
    });
    await expect(loadHolders(MINT, 20, deps({ helius }))).rejects.toBeInstanceOf(ChainError);
  });
});
