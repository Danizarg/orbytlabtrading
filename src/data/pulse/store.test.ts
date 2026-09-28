import { beforeEach, describe, expect, it } from 'vitest';
import type { PulsePatch } from '@/lib/services/pulse';
import { createPatchBuffer, enqueuePatches, flushPatches, getVisibleMints, setVisibleMints, usePulseStore, visibleMintSet } from './store';

const MINT_A = '8xzeMhd2Uy2AWQeTGaMonjvsmfWGnkiuYkzcuuzSpump';
const MINT_B = 'ATsnpDf6tahuXJCz5MxZWV1CbTJ7qigRVbFoi379FHVD';
const T0 = 1_790_000_000_000;

function patch(overrides: Partial<PulsePatch> = {}): PulsePatch {
  return { mint: MINT_A, source: 'pumpportal', freshness: 'stream', at: T0, receivedAt: T0, stage: 'bonding', ...overrides };
}

beforeEach(() => {
  usePulseStore.setState({ items: new Map(), feeds: {} });
  flushPatches();
  setVisibleMints('new', []);
  setVisibleMints('final', []);
  setVisibleMints('migrated', []);
});

describe('patch buffer', () => {
  it('drains in order and keeps only the newest readings beyond its cap', () => {
    const buffer = createPatchBuffer(3);
    buffer.push([patch({ symbol: '1' }), patch({ symbol: '2' })]);
    buffer.push([patch({ symbol: '3' }), patch({ symbol: '4' })]);
    expect(buffer.size()).toBe(3);
    expect(buffer.drain().map((p) => p.symbol)).toEqual(['2', '3', '4']);
    expect(buffer.size()).toBe(0);
    expect(buffer.drain()).toEqual([]);
  });
});

describe('usePulseStore', () => {
  it('applies queued readings in one update on flush', () => {
    let updates = 0;
    const unsubscribe = usePulseStore.subscribe(() => updates++);
    enqueuePatches([patch({ symbol: 'A' }), patch({ mint: MINT_B, symbol: 'B' }), patch({ holders: 3, at: T0 + 1 })]);
    expect(usePulseStore.getState().items.size).toBe(0);
    flushPatches();
    unsubscribe();
    expect(updates).toBe(1);
    const items = usePulseStore.getState().items;
    expect(items.size).toBe(2);
    expect(items.get(MINT_A)).toMatchObject({ symbol: 'A', holders: 3 });
  });

  it('does not notify when a flush changes nothing', () => {
    usePulseStore.getState().apply([patch({ symbol: 'A' })]);
    const before = usePulseStore.getState().items;
    usePulseStore.getState().apply([patch({ symbol: 'A' })]);
    expect(usePulseStore.getState().items).toBe(before);
  });

  it('prunes but keeps visible tokens', () => {
    const old = T0 - 60 * 60_000;
    usePulseStore.getState().apply([patch({ stage: 'amm', receivedAt: old, at: old }), patch({ mint: MINT_B, stage: 'amm', receivedAt: old, at: old })]);
    setVisibleMints('new', [MINT_B]);
    expect(visibleMintSet()).toEqual(new Set([MINT_B]));
    usePulseStore.getState().prune(visibleMintSet(), T0);
    expect([...usePulseStore.getState().items.keys()]).toEqual([MINT_B]);
    expect(getVisibleMints().new).toEqual([MINT_B]);
  });

  it('tracks feed health', () => {
    const s = usePulseStore.getState();
    s.reportOk('curves', T0, 'publicnode');
    s.reportError('curves', 'Solana RPC timed out', T0 + 4_000);
    expect(usePulseStore.getState().feeds.curves).toEqual({ lastOkAt: T0, via: 'publicnode', error: 'Solana RPC timed out', lastErrorAt: T0 + 4_000 });
    s.disableFeed('serverNew');
    expect(usePulseStore.getState().feeds.serverNew?.disabled).toBe(true);
  });
});
