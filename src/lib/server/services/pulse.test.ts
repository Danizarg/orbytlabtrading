import { describe, expect, it } from 'vitest';
import type { LaunchpadProvider, ProviderId } from '@/lib/core/providers';
import type { PulseColumn, PulseToken, Sourced } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import { NotConfiguredError } from './errors';
import { loadPulse } from './pulse';

const MINT = '4ov9rwwS4iBHeTWGCrVaQYW1HzWK51MSfs8csGAApump';

function token(source: ProviderId): PulseToken {
  return { mint: MINT, detectedAt: 1, launchpad: { stage: 'bonding', launchpad: 'pump.fun' }, sources: [source], updatedAt: 1 };
}

function launchpad(id: ProviderId, impl: (column: PulseColumn) => Promise<Sourced<PulseToken[]>>): LaunchpadProvider & { columns: PulseColumn[] } {
  const columns: PulseColumn[] = [];
  return {
    id,
    columns,
    getPulse: (column) => {
      columns.push(column);
      return impl(column);
    },
  };
}

describe('loadPulse', () => {
  it('is not configured without Solana Tracker or Birdeye', async () => {
    await expect(loadPulse('new', { solanaTracker: null, birdeye: null })).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it('prefers Solana Tracker and asks for the requested column', async () => {
    const st = launchpad('solanatracker', async () => ({ data: [token('solanatracker')], source: 'solanatracker', fetchedAt: 1, freshness: 'fast' }));
    const be = launchpad('birdeye', async () => ({ data: [token('birdeye')], source: 'birdeye', fetchedAt: 1, freshness: 'fast' }));
    const result = await loadPulse('final', { solanaTracker: st, birdeye: be });
    expect(result.source).toBe('solanatracker');
    expect(st.columns).toEqual(['final']);
    expect(be.columns).toEqual([]);
  });

  it('falls back to Birdeye on failure or an empty column', async () => {
    const failing = launchpad('solanatracker', async () => {
      throw new ProviderError('solanatracker', 'http', 'solanatracker: HTTP 500', { status: 500 });
    });
    const empty = launchpad('solanatracker', async () => ({ data: [], source: 'solanatracker', fetchedAt: 1, freshness: 'fast' }));
    const be = launchpad('birdeye', async () => ({ data: [token('birdeye')], source: 'birdeye', fetchedAt: 1, freshness: 'fast' }));
    expect((await loadPulse('migrated', { solanaTracker: failing, birdeye: be })).source).toBe('birdeye');
    expect((await loadPulse('migrated', { solanaTracker: empty, birdeye: be })).source).toBe('birdeye');
  });
});
