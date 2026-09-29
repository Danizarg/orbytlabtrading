import { describe, expect, it } from 'vitest';
import type { OnchainFeedSnapshot, OnchainFeedStatus } from '@/lib/onchain/tradeFeed';
import { tradeFeedFromOnchain, type OnchainFeedInfo } from './useTrades';

/** The on-chain feed snapshot → the TradeFeed panels render (notes, attempts, completeness). */

const status = (over: Partial<OnchainFeedStatus> = {}): OnchainFeedStatus => ({
  backfill: 'done',
  history: 'idle',
  listed: 60,
  exhausted: false,
  complete: false,
  queued: 0,
  ws: 'open',
  polls: 3,
  failed: false,
  paused: false,
  skipped: 0,
  missed: 0,
  dropped: 0,
  unlisted: false,
  ...over,
});

const snapshot = (over: Partial<OnchainFeedStatus> = {}): OnchainFeedSnapshot => ({
  trades: [],
  fresh: new Set(),
  solPrices: new Map(),
  status: status(over),
  freshness: 'realtime',
  updatedAt: 1_000,
  version: 1,
});

const info: OnchainFeedInfo = {
  pool: 'CnJYShWKkDCHeees6Jgi2nx6rekrsu62VqJkDLxpZeNs',
  pumpCurve: false,
  exhausted: false,
  complete: false,
  historyLoading: false,
  historyDone: false,
  listed: 60,
  missed: 0,
  loadHistory: () => {},
  ws: 'open',
};

describe('tradeFeedFromOnchain', () => {
  it('says when a busy pool outran the RPC budget: the trades shown are a subset', () => {
    expect(tradeFeedFromOnchain(snapshot({ dropped: 40, missed: 40 }), info).notes).toEqual([
      'Busy pool: 40 listed transactions were not loaded within the RPC budget; trades shown are a subset.',
    ]);
    expect(tradeFeedFromOnchain(snapshot({ unlisted: true }), info).notes).toEqual([
      'Busy pool: some transactions were never listed between two polls; trades shown are a subset.',
    ]);
    expect(tradeFeedFromOnchain(snapshot(), info).notes).toBeUndefined();
  });

  it('keeps skipped transactions and a hidden-tab pause visible', () => {
    expect(tradeFeedFromOnchain(snapshot({ skipped: 1, missed: 1, paused: true }), info).notes).toEqual([
      '1 transaction could not be loaded and was skipped.',
      'Paused while the tab is hidden.',
    ]);
  });
});
