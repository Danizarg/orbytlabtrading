import { describe, expect, it } from 'vitest';
import { ChainError } from '@/lib/core/chain';
import { MINTS } from '@/lib/core/solana';
import type { BondingCurveState, TokenRow } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import type { GeckoPoolInfo } from '@/lib/providers/geckoterminal';
import type { MigrationEvent, NewTokenEvent } from '@/lib/streams/pumpportal';
import {
  activeFilterCount,
  applyPatches,
  applyPause,
  classifyGeckoPool,
  columnFreshness,
  COLUMN_CAPS,
  createItem,
  DEFAULT_PULSE_FILTER,
  feedErrorText,
  geckoMigrationAction,
  inColumn,
  isCurveTarget,
  isExpired,
  launchpadGroup,
  launchpadShort,
  marketCapUsdOf,
  matchesFilter,
  mergeItem,
  MIGRATED_WINDOW_MS,
  NEW_PAIRS_WINDOW_MS,
  observedAt,
  patchFromCurve,
  patchFromGeckoPool,
  patchFromMigration,
  patchFromNewToken,
  patchFromServerToken,
  patchFromTokenRow,
  patchFromUltra,
  pickBatch,
  pruneItems,
  READING_HOLD_MS,
  sameCardData,
  sanitizeFilter,
  selectColumn,
  sourceHealth,
  verifyCandidate,
  type PendingCandidate,
  type PulseItem,
  type PulsePatch,
} from './pulse';

// Syntactically valid 32–44 char base58 test mints (fixtures only).
const MINT_A = '8xzeMhd2Uy2AWQeTGaMonjvsmfWGnkiuYkzcuuzSpump';
const MINT_B = 'ATsnpDf6tahuXJCz5MxZWV1CbTJ7qigRVbFoi379FHVD';
const MINT_C = 'HYHtQudUCPzNEf3eb3bceErbPzpE5fCjhRvULPgmPwe1';
const POOL = 'HWGadsqBpzSr323ix615PNNZLkfBFvv6LXDBChDsDcNv';
const POOL_2 = 'BtLVeo9sgcvcFdFYge9C89thNRbuH7tCnzCofUPocsUm';
const SIG = '5'.repeat(88);

const T0 = 1_790_000_000_000;

function patch(overrides: Partial<PulsePatch> = {}): PulsePatch {
  return { mint: MINT_A, source: 'jupiter', freshness: 'fast', at: T0, receivedAt: T0, ...overrides };
}

function item(overrides: Partial<PulsePatch> = {}): PulseItem {
  return createItem(patch(overrides));
}

function mintN(i: number): string {
  // Unique 44-char strings; the reducer only checks length, selectors never decode.
  return `${String(i).padStart(4, '1')}${MINT_A.slice(4)}`;
}

describe('createItem / mergeItem', () => {
  it('creates an item from its first reading with detection and provenance', () => {
    const it0 = item({ source: 'pumpportal', freshness: 'stream', symbol: 'DIAM', stage: 'bonding', launchpad: 'pump.fun', createdAt: T0, createdAtApprox: true });
    expect(it0).toMatchObject({
      mint: MINT_A,
      symbol: 'DIAM',
      detectedAt: T0,
      createdAt: T0,
      createdAtApprox: true,
      launchpad: { stage: 'bonding', launchpad: 'pump.fun' },
      sources: ['pumpportal'],
      updatedAt: T0,
    });
  });

  it('fills identity gaps but never overwrites a first real value', () => {
    const a = item({ symbol: 'ONE' });
    const b = mergeItem(a, patch({ source: 'geckoterminal', symbol: 'TWO', name: 'Named', at: T0 + 1_000, receivedAt: T0 + 1_000 }));
    expect(b.symbol).toBe('ONE');
    expect(b.name).toBe('Named');
    expect(b.sources).toEqual(['jupiter', 'geckoterminal']);
  });

  it('replaces an approximate creation time with a chain/provider time only', () => {
    const a = item({ createdAt: T0 + 900, createdAtApprox: true });
    const approx = mergeItem(a, patch({ createdAt: T0 + 5_000, createdAtApprox: true }));
    expect(approx).toBe(a);
    const real = mergeItem(a, patch({ createdAt: T0 }));
    expect(real.createdAt).toBe(T0);
    expect(real.createdAtApprox).toBeUndefined();
    // A real time is not replaced by another reading.
    expect(mergeItem(real, patch({ createdAt: T0 + 60_000 })).createdAt).toBe(T0);
  });

  it('takes the newest reading for live groups and ignores older ones', () => {
    const a = item({ marketCapUsd: 10_000, holders: 5 });
    const newer = mergeItem(a, patch({ at: T0 + 10_000, receivedAt: T0 + 10_000, marketCapUsd: 12_000, holders: 9 }));
    expect(newer.marketCapUsd).toBe(12_000);
    expect(newer.holders).toBe(9);
    expect(newer.updatedAt).toBe(T0 + 10_000);
    const older = mergeItem(newer, patch({ at: T0 + 5_000, receivedAt: T0 + 20_000, marketCapUsd: 11_000 }));
    expect(older).toBe(newer);
  });

  it('protects higher-tier readings from lower tiers until they are READING_HOLD_MS old', () => {
    const onChain = item({ source: 'solana-rpc', freshness: 'realtime', marketCapUsd: 20_000 });
    const indexedSoon = mergeItem(onChain, patch({ source: 'geckoterminal', freshness: 'indexed', at: T0 + 5_000, marketCapUsd: 15_000 }));
    expect(indexedSoon.marketCapUsd).toBe(20_000);
    const indexedLater = mergeItem(onChain, patch({ source: 'geckoterminal', freshness: 'indexed', at: T0 + READING_HOLD_MS, marketCapUsd: 15_000 }));
    expect(indexedLater.marketCapUsd).toBe(15_000);
    expect(indexedLater.readings.mcap).toEqual({ at: T0 + READING_HOLD_MS, source: 'geckoterminal', tier: 1 });
  });

  it('prefers on-chain progress over provider-reported progress while it is fresh', () => {
    const a = item({ source: 'solana-rpc', freshness: 'realtime', stage: 'bonding', progressPct: 71.2, progressSource: 'solana-rpc' });
    const jupiter = mergeItem(a, patch({ source: 'jupiter', freshness: 'fast', at: T0 + 10_000, progressPct: 65 }));
    expect(jupiter.launchpad.progressPct).toBe(71.2);
    expect(jupiter.launchpad.progressSource).toBe('solana-rpc');
    const onChainAgain = mergeItem(a, patch({ source: 'solana-rpc', freshness: 'realtime', at: T0 + 4_000, progressPct: 73 }));
    expect(onChainAgain.launchpad).toMatchObject({ progressPct: 73, progressSource: 'solana-rpc' });
    const staleOnChain = mergeItem(a, patch({ source: 'jupiter', freshness: 'fast', at: T0 + 31_000, progressPct: 66 }));
    expect(staleOnChain.launchpad).toMatchObject({ progressPct: 66, progressSource: 'jupiter' });
  });

  it('clamps progress to 0–100', () => {
    expect(item({ progressPct: 140 }).launchpad.progressPct).toBe(100);
    expect(item({ progressPct: -3 }).launchpad.progressPct).toBe(0);
  });

  it('refreshes reading time on confirmation without counting it as a change', () => {
    const a = item({ source: 'solana-rpc', freshness: 'realtime', progressPct: 50 });
    const same = mergeItem(a, patch({ source: 'solana-rpc', freshness: 'realtime', at: T0 + 4_000, receivedAt: T0 + 4_000, progressPct: 50 }));
    expect(same).not.toBe(a);
    expect(same.readings.progress?.at).toBe(T0 + 4_000);
    expect(same.updatedAt).toBe(a.updatedAt);
    expect(sameCardData(a, same)).toBe(true);
    // Identical reading → identical item.
    expect(mergeItem(same, patch({ source: 'solana-rpc', freshness: 'realtime', at: T0 + 4_000, progressPct: 50 }))).toBe(same);
  });

  it('replaces a group as a unit (no stale half-readings)', () => {
    const a = item({ source: 'solana-rpc', freshness: 'realtime', priceUsd: 0.00004, priceSol: 3e-7 });
    const b = mergeItem(a, patch({ source: 'solana-rpc', freshness: 'realtime', at: T0 + 1_000, priceUsd: 0.00005 }));
    expect(b.priceUsd).toBe(0.00005);
    expect('priceSol' in b).toBe(false);
  });

  it('moves the launch stage forward only', () => {
    const bonding = item({ stage: 'bonding', launchpad: 'pump.fun' });
    const graduated = mergeItem(bonding, patch({ stage: 'graduated', graduatedAt: T0 + 60_000, at: T0 + 60_000 }));
    expect(graduated.launchpad.stage).toBe('graduated');
    expect(graduated.launchpad.graduatedAt).toBe(T0 + 60_000);
    expect(mergeItem(graduated, patch({ stage: 'bonding', at: T0 + 90_000 })).launchpad.stage).toBe('graduated');
    const amm = item({ stage: 'amm' });
    expect(mergeItem(amm, patch({ stage: 'bonding' })).launchpad.stage).toBe('bonding');
  });

  it('approximates a timeless graduation only for curves this session watched, then takes the real time', () => {
    const open = item({ source: 'solana-rpc', freshness: 'realtime', stage: 'bonding', launchpad: 'pump.fun', progressPct: 97, curveComplete: false });
    const detected = mergeItem(open, patch({ stage: 'graduated', at: T0 + 20_000, receivedAt: T0 + 25_000 }));
    expect(detected.launchpad.graduatedAt).toBe(T0 + 25_000);
    expect(detected.graduatedAtApprox).toBe(true);
    const exact = mergeItem(detected, patch({ stage: 'graduated', graduatedAt: T0 + 12_000, migratedPool: POOL, migratedDex: 'PumpSwap' }));
    expect(exact.launchpad.graduatedAt).toBe(T0 + 12_000);
    expect(exact.launchpad.migratedPool).toBe(POOL);
    expect(exact.migratedDex).toBe('PumpSwap');
    expect(exact.graduatedAtApprox).toBeUndefined();

    // Seen completing on-chain: the completion time is the better estimate.
    const completing = mergeItem(open, patch({ source: 'solana-rpc', freshness: 'realtime', at: T0 + 4_000, receivedAt: T0 + 4_000, curveComplete: true, progressPct: 100 }));
    const migrated = mergeItem(completing, patch({ stage: 'graduated', at: T0 + 30_000, receivedAt: T0 + 30_000 }));
    expect(migrated.launchpad.graduatedAt).toBe(T0 + 4_000);
    expect(migrated.graduatedAtApprox).toBe(true);

    // A curve found already complete (e.g. hours-old GeckoTerminal candidate) is never placed by detection time.
    const foundComplete = mergeItem(item({ stage: 'bonding', launchpad: 'pump.fun' }), patch({ source: 'solana-rpc', freshness: 'realtime', curveComplete: true }));
    expect(mergeItem(foundComplete, patch({ stage: 'graduated', at: T0 + 30_000, receivedAt: T0 + 30_000 })).launchpad.graduatedAt).toBeUndefined();
    // Stale open reading: no approximation either.
    expect(mergeItem(open, patch({ stage: 'graduated', receivedAt: T0 + 5 * 60_000, at: T0 + 5 * 60_000 })).launchpad.graduatedAt).toBeUndefined();
    // Bonding without on-chain evidence, or unknown → graduated: stays unplaced.
    expect(mergeItem(item({ stage: 'bonding' }), patch({ stage: 'graduated', at: T0 + 1_000 })).launchpad.graduatedAt).toBeUndefined();
    expect(item({ stage: 'graduated' }).launchpad.graduatedAt).toBeUndefined();
  });

  it('refines a generic LaunchLab launchpad name but keeps specific ones', () => {
    const a = item({ stage: 'bonding', launchpad: 'LaunchLab' });
    expect(mergeItem(a, patch({ launchpad: 'letsbonk' })).launchpad.launchpad).toBe('letsbonk');
    const b = item({ stage: 'bonding', launchpad: 'pump.fun' });
    expect(mergeItem(b, patch({ launchpad: 'letsbonk' })).launchpad.launchpad).toBe('pump.fun');
  });

  it('timestamps a curve completion only when it was seen open first', () => {
    const open = mergeItem(item({ stage: 'bonding' }), patch({ source: 'solana-rpc', freshness: 'realtime', curveComplete: false }));
    expect(open.curveComplete).toBe(false);
    const done = mergeItem(open, patch({ source: 'solana-rpc', freshness: 'realtime', at: T0 + 4_000, curveComplete: true }));
    expect(done.curveComplete).toBe(true);
    expect(done.completedAt).toBe(T0 + 4_000);
    expect(mergeItem(done, patch({ curveComplete: false, at: T0 + 8_000 })).curveComplete).toBe(true);
    const unseen = mergeItem(item({ stage: 'bonding' }), patch({ curveComplete: true }));
    expect(unseen.curveComplete).toBe(true);
    expect(unseen.completedAt).toBeUndefined();
  });

  it('merges risk per key: newest wins, older readings only fill gaps', () => {
    const a = item({ risk: { top10Pct: 30, devHoldingPct: 5 } });
    const b = mergeItem(a, patch({ at: T0 + 10_000, risk: { top10Pct: 25, snipersPct: 3 } }));
    expect(b.risk).toEqual({ top10Pct: 25, devHoldingPct: 5, snipersPct: 3 });
    const c = mergeItem(b, patch({ at: T0 + 1_000, risk: { top10Pct: 99, insidersPct: 2 } }));
    expect(c.risk).toEqual({ top10Pct: 25, devHoldingPct: 5, snipersPct: 3, insidersPct: 2 });
  });

  it('fills socials per key', () => {
    const a = item({ socials: { twitter: 'https://x.com/a' } });
    const b = mergeItem(a, patch({ socials: { twitter: 'https://x.com/b', website: 'https://a.io' } }));
    expect(b.socials).toEqual({ twitter: 'https://x.com/a', website: 'https://a.io' });
  });
});

describe('applyPatches', () => {
  it('inserts, merges and keeps the same map when nothing changes', () => {
    const empty = new Map<string, PulseItem>();
    const r1 = applyPatches(empty, [patch({ symbol: 'A' }), patch({ mint: MINT_B, symbol: 'B' })]);
    expect(r1.changed).toBe(true);
    expect(r1.items.size).toBe(2);
    expect(empty.size).toBe(0);
    const r2 = applyPatches(r1.items, [patch({ symbol: 'A' })]);
    expect(r2.changed).toBe(false);
    expect(r2.items).toBe(r1.items);
  });

  it('never inserts from update-only readings and skips malformed mints', () => {
    const r = applyPatches(new Map(), [patch({ updateOnly: true, symbol: 'X' }), patch({ mint: 'short' })]);
    expect(r.changed).toBe(false);
    expect(r.items.size).toBe(0);
  });

  it('applies readings in order within one batch', () => {
    const r = applyPatches(new Map(), [
      patch({ source: 'pumpportal', freshness: 'stream', stage: 'bonding', launchpad: 'pump.fun' }),
      patch({ source: 'solana-rpc', freshness: 'realtime', updateOnly: true, progressPct: 12.5, curveComplete: false }),
    ]);
    expect(r.items.get(MINT_A)?.launchpad).toMatchObject({ stage: 'bonding', progressPct: 12.5, progressSource: 'solana-rpc' });
  });
});

describe('column selectors', () => {
  const now = T0 + 60 * 60_000;

  function bonding(i: number, extra: Partial<PulsePatch> = {}): PulseItem {
    return item({ mint: mintN(i), stage: 'bonding', launchpad: 'pump.fun', createdAt: now - i * 1_000, ...extra });
  }

  it('New Pairs: bonding within 3 h, newest first, capped at 60', () => {
    const items = Array.from({ length: 70 }, (_, i) => bonding(i));
    items.push(bonding(100, { createdAt: now - NEW_PAIRS_WINDOW_MS - 1 }));
    items.push(item({ mint: MINT_B, stage: 'graduated', graduatedAt: now }));
    const list = selectColumn('new', items, now);
    expect(list).toHaveLength(COLUMN_CAPS.new);
    expect(list[0]?.mint).toBe(mintN(0));
    expect(list[59]?.mint).toBe(mintN(59));
    expect(list.every((x) => x.launchpad.stage === 'bonding')).toBe(true);
  });

  it('New Pairs falls back to detection time and excludes completed curves', () => {
    const detected = item({ mint: MINT_B, stage: 'bonding', receivedAt: now - 1_000 });
    const complete = mergeItem(bonding(1), patch({ mint: mintN(1), curveComplete: true }));
    expect(inColumn('new', detected, now)).toBe(true);
    expect(inColumn('new', complete, now)).toBe(false);
  });

  it('Final Stretch: progress ≥ 60, highest first, capped at 40, completed curves only during the grace window', () => {
    const items = Array.from({ length: 50 }, (_, i) => bonding(i, { progressPct: 50 + i }));
    const list = selectColumn('final', items, now);
    expect(list).toHaveLength(COLUMN_CAPS.final);
    expect(list[0]?.launchpad.progressPct).toBe(99);
    expect(list.at(-1)?.launchpad.progressPct).toBe(60);

    const open = mergeItem(bonding(1, { progressPct: 90 }), patch({ mint: mintN(1), source: 'solana-rpc', freshness: 'realtime', curveComplete: false, at: now - 60_000 }));
    const seenComplete = mergeItem(open, patch({ mint: mintN(1), source: 'solana-rpc', freshness: 'realtime', curveComplete: true, progressPct: 100, at: now - 30_000 }));
    expect(inColumn('final', seenComplete, now)).toBe(true);
    expect(inColumn('final', seenComplete, now + 10 * 60_000)).toBe(false);
    const unseenComplete = mergeItem(bonding(2, { progressPct: 100 }), patch({ mint: mintN(2), curveComplete: true }));
    expect(inColumn('final', unseenComplete, now)).toBe(false);
  });

  it('Migrated: graduated within 24 h, newest first, capped at 60', () => {
    const items = Array.from({ length: 65 }, (_, i) => item({ mint: mintN(i), stage: 'graduated', graduatedAt: now - i * 60_000 }));
    items.push(item({ mint: MINT_B, stage: 'graduated', graduatedAt: now - MIGRATED_WINDOW_MS - 1 }));
    items.push(item({ mint: MINT_C, stage: 'graduated' }));
    const list = selectColumn('migrated', items, now);
    expect(list).toHaveLength(COLUMN_CAPS.migrated);
    expect(list[0]?.mint).toBe(mintN(0));
    expect(list.some((x) => x.mint === MINT_B || x.mint === MINT_C)).toBe(false);
  });

  it('applies filters before the cap', () => {
    const items = [
      bonding(1, { launchpad: 'pump.fun', marketCapUsd: 5_000 }),
      bonding(2, { launchpad: 'letsbonk', marketCapUsd: 50_000, socials: { twitter: 'https://x.com/t' } }),
      bonding(3, { launchpad: 'Meteora DBC' }),
    ];
    expect(selectColumn('new', items, now, { filter: { ...DEFAULT_PULSE_FILTER, launchpad: 'bonk' } }).map((x) => x.mint)).toEqual([mintN(2)]);
    expect(selectColumn('new', items, now, { filter: { ...DEFAULT_PULSE_FILTER, launchpad: 'other' } }).map((x) => x.mint)).toEqual([mintN(3)]);
    expect(selectColumn('new', items, now, { filter: { ...DEFAULT_PULSE_FILTER, requireSocials: true } })).toHaveLength(1);
    // Unknown MC never passes a min-MC filter.
    expect(selectColumn('new', items, now, { filter: { ...DEFAULT_PULSE_FILTER, minMcUsd: 1_000 } }).map((x) => x.mint)).toEqual([mintN(1), mintN(2)]);
  });
});

describe('filters and display values', () => {
  it('converts a SOL market cap with the current SOL price only when needed', () => {
    const sol = item({ marketCapSol: 30 });
    expect(marketCapUsdOf(sol)).toBeUndefined();
    expect(marketCapUsdOf(sol, 150)).toBe(4_500);
    expect(marketCapUsdOf(item({ marketCapUsd: 9_000, marketCapSol: 30 }), 150)).toBe(9_000);
    expect(matchesFilter(sol, { ...DEFAULT_PULSE_FILTER, minMcUsd: 4_000 }, 150)).toBe(true);
    expect(matchesFilter(sol, { ...DEFAULT_PULSE_FILTER, minMcUsd: 4_000 })).toBe(false);
  });

  it('groups and abbreviates launchpads', () => {
    expect(launchpadGroup('pump.fun')).toBe('pump');
    expect(launchpadGroup('letsbonk')).toBe('bonk');
    expect(launchpadGroup('Meteora DBC')).toBe('other');
    expect(launchpadGroup(undefined)).toBe('other');
    expect(launchpadShort('pump.fun')).toBe('Pump');
    expect(launchpadShort('Meteora DBC')).toBe('DBC');
    expect(launchpadShort('bags')).toBe('Bags');
    expect(launchpadShort(undefined)).toBeUndefined();
  });

  it('sanitizes stored filters and counts active ones', () => {
    expect(sanitizeFilter(null)).toEqual(DEFAULT_PULSE_FILTER);
    expect(sanitizeFilter({ minMcUsd: -5, launchpad: 'evil', requireSocials: 'yes' })).toEqual(DEFAULT_PULSE_FILTER);
    const f = sanitizeFilter({ minMcUsd: 10_000, launchpad: 'pump', requireSocials: true });
    expect(f).toEqual({ minMcUsd: 10_000, launchpad: 'pump', requireSocials: true });
    expect(activeFilterCount(f)).toBe(3);
    expect(activeFilterCount(DEFAULT_PULSE_FILTER)).toBe(0);
  });

  it('identifies pump.fun curves to poll on-chain', () => {
    expect(isCurveTarget(item({ stage: 'bonding', launchpad: 'pump.fun' }))).toBe(true);
    expect(isCurveTarget(item({ stage: 'bonding', launchpad: 'letsbonk' }))).toBe(false);
    expect(isCurveTarget(item({ stage: 'graduated', launchpad: 'pump.fun' }))).toBe(false);
    expect(isCurveTarget(item({ stage: 'bonding', launchpad: 'pump.fun', curveComplete: true }))).toBe(false);
  });
});

describe('applyPause', () => {
  it('keeps the frozen order with current data and counts queued tokens', () => {
    const a = item({ mint: MINT_A, symbol: 'A' });
    const b = item({ mint: MINT_B, symbol: 'B' });
    const c = item({ mint: MINT_C, symbol: 'C' });
    const updatedA = mergeItem(a, patch({ holders: 99 }));
    const items = new Map([
      [MINT_A, updatedA],
      [MINT_B, b],
      [MINT_C, c],
    ]);
    const { shown, queued } = applyPause([MINT_B, MINT_A, 'gone'], [c, updatedA, b], items);
    expect(shown.map((x) => x.mint)).toEqual([MINT_B, MINT_A]);
    expect(shown[1]?.holders).toBe(99);
    expect(queued).toBe(1);
  });
});

describe('pruning', () => {
  const now = T0 + 5 * 60 * 60_000;

  it('expires tokens that can no longer be shown', () => {
    expect(isExpired(item({ stage: 'graduated', graduatedAt: now - MIGRATED_WINDOW_MS - 1, receivedAt: now }), now)).toBe(true);
    expect(isExpired(item({ stage: 'graduated', graduatedAt: now - 1_000, receivedAt: now }), now)).toBe(false);
    // Old bonding token with low progress, quiet for > 10 min.
    expect(isExpired(item({ stage: 'bonding', createdAt: now - 4 * 3_600_000, progressPct: 10, receivedAt: now - 11 * 60_000 }), now)).toBe(true);
    // Old but close to Final Stretch.
    expect(isExpired(item({ stage: 'bonding', createdAt: now - 4 * 3_600_000, progressPct: 55, receivedAt: now - 11 * 60_000 }), now)).toBe(false);
    // Inside the New Pairs window.
    expect(isExpired(item({ stage: 'bonding', createdAt: now - 60_000, receivedAt: now - 11 * 60_000 }), now)).toBe(false);
    expect(isExpired(item({ stage: 'amm', receivedAt: now - 11 * 60_000 }), now)).toBe(true);
  });

  it('drops expired and then the least recently changed non-visible tokens', () => {
    const items = new Map<string, PulseItem>();
    for (let i = 0; i < 10; i++) {
      items.set(mintN(i), item({ mint: mintN(i), stage: 'bonding', createdAt: now - 1_000, receivedAt: now - (10 - i) * 1_000 }));
    }
    const expired = item({ mint: MINT_B, stage: 'amm', receivedAt: now - 20 * 60_000 });
    items.set(MINT_B, expired);
    const visible = new Set([mintN(0)]);
    const pruned = pruneItems(items, visible, now, 5);
    expect(pruned.size).toBe(5);
    expect(pruned.has(MINT_B)).toBe(false);
    expect(pruned.has(mintN(0))).toBe(true); // visible, although the oldest
    expect([...pruned.keys()].sort()).toEqual([mintN(0), mintN(6), mintN(7), mintN(8), mintN(9)].sort());
  });

  it('returns the same map when nothing needs pruning', () => {
    const items = new Map([[MINT_A, item({ stage: 'bonding', createdAt: now, receivedAt: now })]]);
    expect(pruneItems(items, new Set(), now)).toBe(items);
  });
});

describe('pickBatch', () => {
  it('takes priority tiers first, then rotates the pool by least recently picked', () => {
    const last = new Map([
      ['p1', 50],
      ['p2', 10],
      ['v2', 5],
    ]);
    const batch = pickBatch([['v1', 'v2'], ['v2', 'c1']], ['p1', 'p2', 'p3', 'v1'], last, 5);
    expect(batch).toEqual(['v1', 'v2', 'c1', 'p3', 'p2']);
  });

  it('rotates within a tier so every visible token gets a turn', () => {
    const last = new Map([
      ['a', 100],
      ['b', 0],
    ]);
    expect(pickBatch([['a', 'b', 'c']], [], last, 2)).toEqual(['b', 'c']);
  });
});

describe('readings from sources', () => {
  const create: NewTokenEvent = {
    mint: MINT_A,
    name: 'Diamond',
    symbol: 'DIAM',
    creator: MINT_B,
    devBuySol: 1.5,
    initialBuyTokens: 50_000_000,
    marketCapSol: 32,
    progressPct: 4.2,
    isMayhemMode: false,
    launchpad: 'pump.fun',
    pool: 'pump',
    signature: SIG,
    receivedAt: T0,
    source: 'pumpportal',
  };

  it('PumpPortal create: receipt time as approximate creation, USD MC only with a SOL price', () => {
    const p = patchFromNewToken(create, 150);
    expect(p).toMatchObject({
      source: 'pumpportal',
      freshness: 'stream',
      stage: 'bonding',
      launchpad: 'pump.fun',
      createdAt: T0,
      createdAtApprox: true,
      devBuySol: 1.5,
      progressPct: 4.2,
      marketCapSol: 32,
      marketCapUsd: 4_800,
      mayhem: false,
    });
    const noPrice = patchFromNewToken({ ...create, marketCapSol: undefined });
    expect(noPrice.marketCapUsd).toBeUndefined();
    expect(noPrice.marketCapSol).toBeUndefined();
    expect(patchFromNewToken(create).marketCapUsd).toBeUndefined();
  });

  it('PumpPortal migration: graduated at receipt, pump-amm is PumpSwap', () => {
    const e: MigrationEvent = { mint: MINT_A, signature: SIG, pool: 'pump-amm', receivedAt: T0, source: 'pumpportal' };
    expect(patchFromMigration(e)).toMatchObject({ stage: 'graduated', graduatedAt: T0, migratedDex: 'PumpSwap', launchpad: 'pump.fun' });
    const other = patchFromMigration({ ...e, pool: 'raydium' });
    expect(other.migratedDex).toBe('Raydium');
    expect(other.launchpad).toBeUndefined();
  });

  const curve: BondingCurveState = {
    mint: MINT_A,
    curve: POOL,
    complete: false,
    progressPct: 72.5,
    virtualTokenReserves: 500_000_000,
    virtualQuoteReserves: 60,
    realTokenReserves: 220_000_000,
    realQuoteReserves: 30,
    quoteMint: MINTS.SOL,
    quoteDecimals: 9,
    priceQuote: 1.2e-7,
    marketCapQuote: 120,
    fetchedAt: T0,
  };

  it('on-chain curve: exact progress, SOL-quoted USD values only', () => {
    const p = patchFromCurve(curve, 150);
    expect(p).toMatchObject({
      source: 'solana-rpc',
      freshness: 'realtime',
      updateOnly: true,
      progressPct: 72.5,
      progressSource: 'solana-rpc',
      curveComplete: false,
      priceSol: 1.2e-7,
      marketCapSol: 120,
      marketCapUsd: 18_000,
    });
    expect(p.priceUsd).toBeCloseTo(1.8e-5);
    const usdc = patchFromCurve({ ...curve, quoteMint: MINTS.USDC }, 150);
    expect(usdc.priceUsd).toBeUndefined();
    expect(usdc.marketCapUsd).toBeUndefined();
    const done = patchFromCurve({ ...curve, complete: true, progressPct: 100, priceQuote: undefined, marketCapQuote: undefined }, 150);
    expect(done.curveComplete).toBe(true);
    expect(done.marketCapUsd).toBeUndefined();
  });

  it('Jupiter Ultra: risk and progress, ignoring the 100 % it reports for graduated tokens', () => {
    const meta = { source: 'jupiter' as const, freshness: 'fast' as const, fetchedAt: T0 };
    const p = patchFromUltra(MINT_A, { progressPct: 64, risk: { snipersPct: 3, bundlersPct: 1 } }, meta);
    expect(p).toMatchObject({ updateOnly: true, progressPct: 64, progressSource: 'jupiter', risk: { snipersPct: 3, bundlersPct: 1 }, at: observedAt(T0, 'fast') });
    expect(patchFromUltra(MINT_A, { progressPct: 100, risk: {} }, meta)).toBeNull();
  });

  function pool(overrides: Partial<GeckoPoolInfo>): GeckoPoolInfo {
    return {
      address: POOL,
      dex: 'pumpfun',
      dexLabel: 'Pump.fun',
      baseMint: MINT_A,
      quoteMint: MINTS.SOL,
      priceUsd: 0.00004,
      priceNative: 3e-7,
      fdvUsd: 40_000,
      liquidityUsd: 9_000,
      volume24hUsd: 70_000,
      createdAt: T0 - 60_000,
      txns24h: { buys: 400, sells: 300 },
      isBondingCurve: true,
      source: 'geckoterminal',
      baseToken: { mint: MINT_A, symbol: 'DIAM', name: 'Diamond' },
      launchpad: { stage: 'bonding', launchpad: 'pump.fun' },
      ...overrides,
    };
  }
  const geckoMeta = { source: 'geckoterminal' as const, freshness: 'indexed' as const, fetchedAt: T0 };

  it('GeckoTerminal pools: bonding curves become launches, migration venues carry graduation facts', () => {
    expect(classifyGeckoPool(pool({}))).toBe('bonding');
    expect(classifyGeckoPool(pool({ isBondingCurve: false, dex: 'pumpswap', dexLabel: 'PumpSwap' }))).toBe('migration');
    expect(classifyGeckoPool(pool({ isBondingCurve: false, dex: 'orca' }))).toBe('other');
    expect(classifyGeckoPool(pool({ baseMint: MINTS.SOL }))).toBe('other');

    const launch = patchFromGeckoPool(pool({}), geckoMeta);
    expect(launch).toMatchObject({
      stage: 'bonding',
      launchpad: 'pump.fun',
      createdAt: T0 - 60_000,
      marketCapUsd: 40_000,
      priceSol: 3e-7,
      volumeUsd: 70_000,
      txns: { buys: 400, sells: 300 },
      at: T0 - 45_000,
    });
    const migration = patchFromGeckoPool(pool({ isBondingCurve: false, dex: 'pumpswap', dexLabel: 'PumpSwap', launchpad: undefined }), geckoMeta);
    expect(migration).toMatchObject({ stage: 'graduated', graduatedAt: T0 - 60_000, migratedPool: POOL, migratedDex: 'PumpSwap' });
    expect(migration?.createdAt).toBeUndefined();
    expect(patchFromGeckoPool(pool({ isBondingCurve: false, dex: 'orca' }), geckoMeta)).toBeNull();
  });

  it('decides how to treat a migration-venue pool', () => {
    const p = pool({ isBondingCurve: false, dex: 'pumpswap', dexLabel: 'PumpSwap' });
    expect(geckoMigrationAction(undefined, p)).toBe('verify');
    expect(geckoMigrationAction(item({ stage: 'bonding' }), p)).toBe('verify');
    expect(geckoMigrationAction(item({ stage: 'graduated', migratedDex: 'PumpSwap' }), p)).toBe('apply');
    expect(geckoMigrationAction(item({ stage: 'graduated', migratedPool: POOL_2 }), p)).toBe('ignore');
    expect(geckoMigrationAction(item({ stage: 'graduated', migratedDex: 'Raydium' }), p)).toBe('ignore');
  });

  function row(overrides: Partial<TokenRow['token']> = {}, market: Partial<TokenRow['market']> = {}): TokenRow {
    return {
      token: { mint: MINT_A, symbol: 'DIAM', name: 'Diamond', createdAt: T0 - 30_000, launchpad: { stage: 'bonding', launchpad: 'pump.fun' }, ...overrides },
      market: { mint: MINT_A, fdvUsd: 12_000, holders: 40, stats: { h24: { buys: 17, volumeUsd: 3_000 } }, updatedAt: T0, source: 'jupiter', ...market },
      risk: { top10Pct: 22, devHoldingPct: 3 },
    };
  }
  const jupMeta = { source: 'jupiter' as const, freshness: 'fast' as const, fetchedAt: T0 };

  it('token rows: launchpad FDV as MC, 24 h activity, audit risk', () => {
    const p = patchFromTokenRow(row(), jupMeta);
    expect(p).toMatchObject({
      stage: 'bonding',
      launchpad: 'pump.fun',
      createdAt: T0 - 30_000,
      marketCapUsd: 12_000,
      holders: 40,
      volumeUsd: 3_000,
      txns: { buys: 17 },
      risk: { top10Pct: 22, devHoldingPct: 3 },
      at: T0 - 5_000,
    });
    // Without a launchpad FDV is not used as market cap.
    expect(patchFromTokenRow(row({ launchpad: { stage: 'amm' } }), jupMeta).marketCapUsd).toBeUndefined();
  });

  it('server tokens keep provider provenance', () => {
    const p = patchFromServerToken(
      {
        mint: MINT_A,
        symbol: 'DIAM',
        detectedAt: T0,
        launchpad: { stage: 'bonding', launchpad: 'pump.fun', progressPct: 81, progressSource: 'solanatracker' },
        marketCapUsd: 50_000,
        holders: 120,
        risk: { snipersPct: 4 },
        sources: ['solanatracker'],
        updatedAt: T0,
      },
      { source: 'solanatracker', freshness: 'fast', fetchedAt: T0 },
    );
    expect(p).toMatchObject({ source: 'solanatracker', progressPct: 81, progressSource: 'solanatracker', marketCapUsd: 50_000, holders: 120, risk: { snipersPct: 4 } });
  });

  describe('verifyCandidate', () => {
    const now = T0;
    const launch: PendingCandidate = {
      kind: 'launch',
      patch: patch({ source: 'pumpportal', freshness: 'stream', stage: 'bonding', launchpad: 'letsbonk', createdAt: T0 - 5_000, createdAtApprox: true }),
      addedAt: T0 - 5_000,
      attempts: 0,
    };

    it('confirms a launch only for a recent launchpad token', () => {
      expect(verifyCandidate(launch, undefined, jupMeta, now)).toEqual({ status: 'unknown' });
      const ok = verifyCandidate(launch, row({ launchpad: { stage: 'bonding', launchpad: 'letsbonk' } }), jupMeta, now);
      expect(ok.status).toBe('confirmed');
      expect(verifyCandidate(launch, row({ launchpad: { stage: 'amm' } }), jupMeta, now)).toEqual({ status: 'rejected' });
      expect(verifyCandidate(launch, row({ createdAt: T0 - 2 * NEW_PAIRS_WINDOW_MS }), jupMeta, now)).toEqual({ status: 'rejected' });
    });

    const migration: PendingCandidate = {
      kind: 'migration',
      patch: patch({ source: 'geckoterminal', freshness: 'indexed', stage: 'graduated', graduatedAt: T0 - 60_000, migratedPool: POOL, migratedDex: 'PumpSwap' }),
      addedAt: T0,
      attempts: 0,
    };

    it('confirms a migration with the provider graduation time and pool', () => {
      const ok = verifyCandidate(migration, row({ launchpad: { stage: 'graduated', launchpad: 'pump.fun', migratedPool: POOL, graduatedAt: T0 - 58_000 } }), jupMeta, now);
      expect(ok.status).toBe('confirmed');
      if (ok.status !== 'confirmed') return;
      const applied = applyPatches(new Map(), ok.patches).items.get(MINT_A);
      expect(applied?.launchpad).toMatchObject({ stage: 'graduated', launchpad: 'pump.fun', graduatedAt: T0 - 58_000, migratedPool: POOL });
      expect(applied?.migratedDex).toBe('PumpSwap');
    });

    it('ignores the candidate pool when the provider names a different migration pool', () => {
      const ok = verifyCandidate(migration, row({ launchpad: { stage: 'graduated', launchpad: 'pump.fun', migratedPool: POOL_2 } }), jupMeta, now);
      expect(ok.status).toBe('confirmed');
      if (ok.status !== 'confirmed') return;
      const applied = applyPatches(new Map(), ok.patches).items.get(MINT_A);
      expect(applied?.launchpad.migratedPool).toBe(POOL_2);
      expect(applied?.launchpad.graduatedAt).toBeUndefined();
      expect(applied?.migratedDex).toBeUndefined();
    });

    it('retries while the provider still reports bonding and rejects non-launchpad tokens', () => {
      expect(verifyCandidate(migration, row(), jupMeta, now)).toEqual({ status: 'unknown' });
      expect(verifyCandidate(migration, row({ launchpad: { stage: 'amm' } }), jupMeta, now)).toEqual({ status: 'rejected' });
    });
  });
});

describe('column freshness', () => {
  const now = T0;

  it('is LIVE while the stream delivers, otherwise shows the newest backfill age', () => {
    expect(columnFreshness('new', { streamOpen: true, streamLastAt: now - 2_000, feeds: {}, now })).toEqual({ updatedAt: now - 2_000, live: true });
    const quiet = columnFreshness('new', { streamOpen: true, streamLastAt: now - 20_000, feeds: { jupRecent: { lastOkAt: now - 4_000 } }, now });
    expect(quiet).toEqual({ updatedAt: now - 4_000, live: false });
    const closed = columnFreshness('migrated', { streamOpen: false, streamLastAt: now - 1_000, feeds: { geckoNew: { lastOkAt: now - 30_000 } }, now });
    expect(closed).toEqual({ updatedAt: now - 30_000, live: false });
  });

  it('uses on-chain curve reads for Final Stretch', () => {
    expect(columnFreshness('final', { streamOpen: true, streamLastAt: now, feeds: { curves: { lastOkAt: now - 3_000 } }, now }).live).toBe(true);
    expect(columnFreshness('final', { streamOpen: true, streamLastAt: now, feeds: { geckoPump: { lastOkAt: now - 50_000 } }, now })).toEqual({
      updatedAt: now - 50_000,
      live: false,
    });
  });

  it('reports an error only when every source of the column is failing', () => {
    const failing = { lastOkAt: now - 90_000, lastErrorAt: now - 1_000, error: 'Jupiter is rate limiting this browser; retrying' };
    const some = columnFreshness('new', { streamOpen: false, feeds: { jupRecent: failing, geckoNew: { lastOkAt: now - 5_000 } }, now });
    expect(some.error).toBeUndefined();
    const all = columnFreshness('new', { streamOpen: false, feeds: { jupRecent: failing }, now });
    expect(all.error).toBe(failing.error);
    expect(columnFreshness('new', { streamOpen: true, streamLastAt: now - 60_000, feeds: { jupRecent: failing }, now }).error).toBeUndefined();
  });
});

describe('sourceHealth', () => {
  it('summarizes the feeds behind a source tag', () => {
    expect(sourceHealth([undefined, { disabled: true, lastErrorAt: T0 }])).toEqual({ state: 'idle' });
    expect(sourceHealth([{ lastOkAt: T0, via: 'publicnode' }])).toEqual({ state: 'ok', lastOkAt: T0, via: 'publicnode' });
    const failing = { lastOkAt: T0, lastErrorAt: T0 + 1, error: 'Jupiter timed out' };
    expect(sourceHealth([failing, { lastOkAt: T0 + 5 }])).toMatchObject({ state: 'ok', lastOkAt: T0 + 5, error: 'Jupiter timed out' });
    expect(sourceHealth([failing])).toMatchObject({ state: 'error', error: 'Jupiter timed out', lastOkAt: T0 });
  });
});

describe('feedErrorText', () => {
  it('describes provider and chain failures without URLs', () => {
    expect(feedErrorText(new ProviderError('geckoterminal', 'rate_limited', 'x', { retryAfterMs: 19_500 }))).toBe(
      'GeckoTerminal is rate limiting this browser; retrying in 20 s',
    );
    expect(feedErrorText(new ProviderError('jupiter', 'http', 'x', { status: 503 }))).toBe('Jupiter error (HTTP 503)');
    expect(
      feedErrorText(
        new ChainError('curves', [
          { provider: 'solana-rpc', ok: false, code: 'rate_limited' },
          { provider: 'orbyt', ok: false, code: 'http' },
        ]),
      ),
    ).toBe('Solana RPC rate limited · ORBYT unavailable');
    expect(feedErrorText(new Error('boom'))).toBe('Source unavailable');
  });
});
