import { describe, expect, it } from 'vitest';
import { computePnl } from '@/lib/analytics/pnl';
import { MINTS } from '@/lib/core/solana';
import type { Portfolio, WalletActivity, WalletActivityPage } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import {
  accountHintGapMs,
  accumulateHead,
  activityCoverage,
  activityMints,
  assemblePnlInput,
  displayUnrealized,
  openPositionStats,
  pricesAsOf,
  tradeSplit,
  feedMints,
  filterTrackerEntries,
  holdingPrices,
  identityMints,
  mergeActivityItems,
  mergeTrackerEntries,
  missingPriceMints,
  nextPnlTarget,
  openPositionMints,
  pickPrices,
  priceHoldings,
  pricesInSol,
  countStreamMisses,
  patchTrackerStatus,
  pruneTrackerEntries,
  reconcileIntervalMs,
  retryDelayMs,
  selectMintsToPrice,
  streamReliable,
  TRACKER_FAST_POLL_MS,
  TRACKER_MEDIUM_POLL_MS,
  TRACKER_POLL_MS,
  signedSol,
  solToUsd,
  staggerMs,
  toTrackerEntries,
  trackerKey,
  usdEstimate,
  walletLive,
  PNL_MAX_PAGES,
} from './wallet';

// ---------------------------------------------------------------------------
// Synthetic fixtures (tests only)
// ---------------------------------------------------------------------------

const WALLET = 'A1'.padEnd(44, 'x');
const OTHER = 'B2'.padEnd(44, 'y');
const MINT_A = 'MintA'.padEnd(44, '1');
const MINT_B = 'MintB'.padEnd(44, '2');
const MINT_C = 'MintC'.padEnd(44, '3');
const NOW = 1_790_000_000_000;

function portfolio(tokens: Portfolio['tokens'], sol = 2, extra: Partial<Portfolio> = {}): Portfolio {
  return { address: WALLET, sol, tokens, pricedCount: 0, unpricedCount: tokens.length, updatedAt: NOW, ...extra };
}

function activity(sig: string, kind: WalletActivity['kind'], init: Partial<WalletActivity> = {}): WalletActivity {
  return {
    signature: sig,
    timestamp: NOW,
    wallet: WALLET,
    kind,
    legs: [],
    success: true,
    source: 'solana-rpc',
    ...init,
  };
}

function buy(sig: string, mint: string, tokenAmount: number, solAmount: number, timestamp: number): WalletActivity {
  return activity(sig, 'buy', {
    tokenMint: mint,
    tokenAmount,
    solAmount,
    timestamp,
    legs: [
      { mint, delta: tokenAmount },
      { mint: MINTS.SOL, delta: -solAmount },
    ],
  });
}

function sell(sig: string, mint: string, tokenAmount: number, solAmount: number, timestamp: number): WalletActivity {
  return activity(sig, 'sell', {
    tokenMint: mint,
    tokenAmount,
    solAmount,
    timestamp,
    legs: [
      { mint, delta: -tokenAmount },
      { mint: MINTS.SOL, delta: solAmount },
    ],
  });
}

// ---------------------------------------------------------------------------
// Portfolio pricing
// ---------------------------------------------------------------------------

describe('priceHoldings', () => {
  it('values only priced holdings and counts the rest as unpriced', () => {
    const p = priceHoldings(
      portfolio([
        { mint: MINT_A, amount: 10, decimals: 6 },
        { mint: MINT_B, amount: 5, decimals: 6 },
        { mint: MINT_C, amount: 1_000, decimals: 9 },
      ]),
      { [MINT_A]: 2, [MINT_B]: 0 },
      100,
    );
    expect(p.pricedCount).toBe(1);
    expect(p.unpricedCount).toBe(2);
    expect(p.tokenValueUsd).toBe(20);
    expect(p.solValueUsd).toBe(200);
    expect(p.totalUsd).toBe(220);
    // Priced first (by value), then unpriced by balance.
    expect(p.tokens.map((t) => t.mint)).toEqual([MINT_A, MINT_C, MINT_B]);
    expect(p.tokens[0]?.sharePct).toBeCloseTo((20 / 220) * 100, 6);
    expect(p.tokens[1]?.priceUsd).toBeUndefined();
    expect(p.tokens[1]?.valueUsd).toBeUndefined();
    expect(p.tokens[1]?.sharePct).toBeUndefined();
  });

  it('omits the total when SOL cannot be valued', () => {
    const p = priceHoldings(portfolio([{ mint: MINT_A, amount: 10, decimals: 6 }]), { [MINT_A]: 2 }, undefined);
    expect(p.tokenValueUsd).toBe(20);
    expect(p.solValueUsd).toBeUndefined();
    expect(p.totalUsd).toBeUndefined();
    expect(p.tokens[0]?.sharePct).toBeUndefined();
  });

  it('never reports a $0 total for a wallet whose tokens all failed to price', () => {
    const p = priceHoldings(portfolio([{ mint: MINT_A, amount: 10, decimals: 6 }], 0), {}, 100);
    expect(p.totalUsd).toBeUndefined();
    expect(p.unpricedCount).toBe(1);
  });

  it('totals an empty wallet honestly', () => {
    const p = priceHoldings(portfolio([], 0), {}, undefined);
    expect(p.totalUsd).toBe(0);
    expect(p.pricedCount).toBe(0);
  });

  it('prefers browser prices over server prices and keeps server prices otherwise', () => {
    const p = priceHoldings(
      portfolio([
        { mint: MINT_A, amount: 1, decimals: 6, priceUsd: 5, valueUsd: 5 },
        { mint: MINT_B, amount: 1, decimals: 6, priceUsd: 3, valueUsd: 3 },
      ]),
      { [MINT_A]: 7 },
      undefined,
      {},
    );
    expect(p.tokens.find((t) => t.mint === MINT_A)?.priceUsd).toBe(7);
    expect(p.tokens.find((t) => t.mint === MINT_B)?.priceUsd).toBe(3);
    expect(p.pricedCount).toBe(2);
  });

  it('uses the server SOL price when the browser has none and fills identity gaps only', () => {
    const p = priceHoldings(
      portfolio([{ mint: MINT_A, amount: 1, decimals: 6, symbol: 'KEEP' }], 1, { solPriceUsd: 50 }),
      {},
      undefined,
      { [MINT_A]: { mint: MINT_A, symbol: 'NEW', name: 'Token A', image: 'https://x/a.png' } },
    );
    expect(p.solPriceUsd).toBe(50);
    expect(p.solValueUsd).toBe(50);
    const a = p.tokens[0];
    expect(a?.symbol).toBe('KEEP');
    expect(a?.name).toBe('Token A');
    expect(a?.image).toBe('https://x/a.png');
  });
});

describe('identityMints / selectMintsToPrice', () => {
  const tokens = (n: number) => Array.from({ length: n }, (_, i) => ({ mint: `M${i}`.padEnd(44, 'z'), amount: 1, decimals: 6 }));

  it('orders server-priced holdings by value first and caps the batch', () => {
    const list = [
      { mint: MINT_A, amount: 1, decimals: 6 },
      { mint: MINT_B, amount: 1, decimals: 6, valueUsd: 10 },
      { mint: MINT_C, amount: 1, decimals: 6, valueUsd: 50 },
      { mint: MINTS.SOL, amount: 1, decimals: 9 },
    ];
    expect(identityMints(list)).toEqual([MINT_C, MINT_B, MINT_A]);
    expect(identityMints(list, 2)).toEqual([MINT_C, MINT_B]);
  });

  it('prices everything immediately when within budget', () => {
    const sel = selectMintsToPrice(tokens(3), undefined, 150);
    expect(sel.mints).toHaveLength(3);
    expect(sel.skipped).toBe(0);
    expect(sel.needsMetadata).toBe(false);
  });

  it('skips holdings the server already priced', () => {
    const sel = selectMintsToPrice([{ mint: MINT_A, amount: 1, decimals: 6, priceUsd: 2 }, { mint: MINT_B, amount: 1, decimals: 6 }], undefined);
    expect(sel.mints).toEqual([MINT_B]);
  });

  it('waits for metadata beyond the budget, then prefers known tokens', () => {
    const list = tokens(5);
    const waiting = selectMintsToPrice(list, undefined, 3);
    expect(waiting.needsMetadata).toBe(true);
    expect(waiting.skipped).toBe(2);
    const known = new Set([list[4]!.mint, list[3]!.mint]);
    const sel = selectMintsToPrice(list, known, 3);
    expect(sel.needsMetadata).toBe(false);
    // Known tokens first (in holding order), then the rest in holding order.
    expect(sel.mints).toEqual([list[3]!.mint, list[4]!.mint, list[0]!.mint]);
    expect(sel.skipped).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Activity pages and PnL assembly
// ---------------------------------------------------------------------------

describe('mergeActivityItems / activityCoverage', () => {
  it('de-duplicates by signature (first page wins) and orders newest first', () => {
    const head: WalletActivityPage = { items: [activity('s3', 'buy', { timestamp: NOW + 3 }), activity('s2', 'sell', { timestamp: NOW + 2 })], scanned: 2 };
    const p1: WalletActivityPage = { items: [activity('s2', 'other', { timestamp: NOW + 2 }), activity('s1', 'buy', { timestamp: NOW + 1 })], scanned: 3, nextCursor: 's1' };
    const merged = mergeActivityItems([head, p1]);
    expect(merged.map((a) => a.signature)).toEqual(['s3', 's2', 's1']);
    expect(merged[1]?.kind).toBe('sell');
    const coverage = activityCoverage([p1], merged.length);
    expect(coverage).toEqual({ pages: 1, scanned: 3, activities: 3, historyComplete: false });
    expect(activityCoverage([p1, { items: [], scanned: 1 }], 3).historyComplete).toBe(true);
    expect(activityCoverage([], 0).historyComplete).toBe(false);
  });
});

describe('accumulateHead', () => {
  const at = (sig: string, offset: number) => activity(sig, 'buy', { timestamp: NOW + offset });

  it('keeps items from earlier refreshes instead of replacing them', () => {
    const page1 = [at('p2', 2), at('p1', 1)];
    // First refresh: two new transactions on top of page 1.
    const r1 = accumulateHead({ items: page1 }, { items: [at('n2', 20), at('n1', 10), at('p2', 2)], scanned: 3 }, page1, 3);
    expect(r1.items.map((a) => a.signature)).toEqual(['n2', 'n1', 'p2', 'p1']);
    expect(r1.gap).toBeUndefined();
    // Second refresh only returns the newest 3; n1 and n2 must stay on screen.
    const r2 = accumulateHead(r1, { items: [at('n4', 40), at('n3', 30), at('n2', 20)], scanned: 3, nextCursor: 'n2' }, page1, 3);
    expect(r2.items.map((a) => a.signature)).toEqual(['n4', 'n3', 'n2', 'n1', 'p2', 'p1']);
    expect(r2.gap).toBeUndefined();
    expect(r2.scanned).toBe(3);
    expect(r2.nextCursor).toBe('n2');
  });

  it('flags a possible gap when a full page is entirely newer than everything known, and keeps the flag', () => {
    const page1 = [at('p1', 1)];
    const r1 = accumulateHead({ items: page1 }, { items: [at('n9', 90), at('n8', 80), at('n7', 70)], scanned: 3, nextCursor: 'n7' }, page1, 3);
    expect(r1.gap).toBe(true);
    const r2 = accumulateHead(r1, { items: [at('n9', 90)], scanned: 1 }, page1, 3);
    expect(r2.gap).toBe(true);
    // A short page cannot hide anything in between.
    expect(accumulateHead({ items: page1 }, { items: [at('n1', 10)], scanned: 1 }, page1, 3).gap).toBeUndefined();
  });

  it('caps the accumulated list at the newest items', () => {
    const r = accumulateHead({ items: [at('a', 1), at('b', 2)] }, { items: [at('c', 3)], scanned: 1 }, [], 15, 2);
    expect(r.items.map((a) => a.signature)).toEqual(['c', 'b']);
  });
});

describe('assemblePnlInput', () => {
  it('converts USD prices to SOL, sums scanned signatures and flags incomplete history', () => {
    const pages: WalletActivityPage[] = [
      { items: [sell('s2', MINT_A, 50, 1.5, NOW + 1000)], scanned: 15, nextCursor: 's2' },
      { items: [buy('s1', MINT_A, 100, 2, NOW)], scanned: 12, nextCursor: 's1' },
    ];
    const input = assemblePnlInput({ wallet: WALLET, pages, pricesUsd: { [MINT_A]: 0.5, [MINT_B]: 0 }, solPriceUsd: 200, symbols: { [MINT_A]: 'AAA' } });
    expect(input.transactionsAnalyzed).toBe(27);
    expect(input.historyComplete).toBe(false);
    expect(input.activities.map((a) => a.signature)).toEqual(['s2', 's1']);
    expect(input.currentPricesSol).toEqual({ [MINT_A]: 0.0025 });
    expect(input.solPriceUsd).toBe(200);
    expect(input.symbols).toEqual({ [MINT_A]: 'AAA' });

    const report = computePnl(input);
    expect(report.window.historyComplete).toBe(false);
    expect(report.window.transactionsAnalyzed).toBe(27);
    const a = report.tokens[0];
    expect(a?.symbol).toBe('AAA');
    expect(a?.realizedSol).toBeCloseTo(0.5, 9);
    expect(a?.remainingAmount).toBe(50);
    expect(a?.unrealizedSol).toBeCloseTo(50 * 0.0025 - 1, 9);
    expect(openPositionMints(report)).toEqual([MINT_A]);
  });

  it('omits prices and symbols it cannot vouch for', () => {
    const input = assemblePnlInput({ wallet: WALLET, pages: [{ items: [], scanned: 0 }], pricesUsd: { [MINT_A]: 1 }, solPriceUsd: undefined });
    expect(input.currentPricesSol).toBeUndefined();
    expect(input.solPriceUsd).toBeUndefined();
    expect(input.symbols).toBeUndefined();
    expect(input.historyComplete).toBe(true);
    expect(pricesInSol({ [MINT_A]: 1 }, 0)).toEqual({});
  });

  it('caps the analysis window', () => {
    expect(nextPnlTarget(3)).toBe(6);
    expect(nextPnlTarget(PNL_MAX_PAGES - 1)).toBe(PNL_MAX_PAGES);
    expect(nextPnlTarget(PNL_MAX_PAGES)).toBe(PNL_MAX_PAGES);
  });
});

describe('activity helpers', () => {
  it('lists distinct mints without SOL, in first-seen order', () => {
    const items = [buy('s1', MINT_A, 1, 1, NOW), sell('s2', MINT_B, 1, 1, NOW), activity('s3', 'swap', { tokenMint: MINT_A, legs: [{ mint: MINT_C, delta: 1 }] })];
    expect(activityMints(items)).toEqual([MINT_A, MINT_B, MINT_C]);
    expect(activityMints(items, 2)).toEqual([MINT_A, MINT_B]);
  });

  it('derives the signed SOL change and USD estimates honestly', () => {
    const b = buy('s1', MINT_A, 10, 0.5, NOW);
    expect(signedSol(b)).toBe(-0.5);
    expect(signedSol(activity('s2', 'sell', { solAmount: 0.25 }))).toBe(0.25);
    expect(signedSol(activity('s3', 'other'))).toBeUndefined();
    expect(usdEstimate(b, 200)).toEqual({ value: 100, exact: false });
    expect(usdEstimate(b, undefined)).toBeUndefined();
    expect(usdEstimate(activity('s4', 'buy', { usdValue: 12, solAmount: 1 }), 200)).toEqual({ value: 12, exact: true });
    expect(solToUsd(2, 150)).toBe(300);
    expect(solToUsd(undefined, 150)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tracker feed
// ---------------------------------------------------------------------------

describe('mergeTrackerEntries', () => {
  const t = (sig: string, ts: number, wallet = WALLET) => activity(sig, 'buy', { timestamp: ts, wallet });

  it('dedupes by wallet + signature, keeps existing entries, orders newest first', () => {
    const existing = toTrackerEntries([t('s1', NOW), t('s2', NOW + 2_000)], WALLET, 'backfill', NOW);
    const incoming = [
      ...toTrackerEntries([t('s2', NOW + 2_000), t('s3', NOW + 1_000)], WALLET, 'stream', NOW + 5_000),
      ...toTrackerEntries([t('s1', NOW, OTHER)], OTHER, 'poll', NOW + 5_000),
    ];
    const { entries, added } = mergeTrackerEntries(existing, incoming);
    expect(added).toBe(2);
    expect(entries.map((e) => e.key)).toEqual([trackerKey(WALLET, 's2'), trackerKey(WALLET, 's3'), trackerKey(WALLET, 's1'), trackerKey(OTHER, 's1')]);
    // The existing s2 entry kept its provenance.
    expect(entries[0]?.via).toBe('backfill');
    expect(entries[0]?.seenAt).toBe(NOW);
  });

  it('returns the same array when nothing is new', () => {
    const existing = toTrackerEntries([t('s1', NOW)], WALLET, 'backfill', NOW);
    const { entries, added } = mergeTrackerEntries(existing, toTrackerEntries([t('s1', NOW)], WALLET, 'poll', NOW + 1));
    expect(added).toBe(0);
    expect(entries).toBe(existing);
  });

  it('caps the feed at the newest entries', () => {
    const existing = toTrackerEntries([t('s1', NOW), t('s2', NOW + 1)], WALLET, 'backfill', NOW);
    const { entries } = mergeTrackerEntries(existing, toTrackerEntries([t('s3', NOW + 2)], WALLET, 'stream', NOW), 2);
    expect(entries.map((e) => e.activity.signature)).toEqual(['s3', 's2']);
  });

  it('prunes untracked wallets and filters by wallet and kind', () => {
    const entries = [
      ...toTrackerEntries([t('s1', NOW + 3), activity('s2', 'transfer_in', { timestamp: NOW + 2 })], WALLET, 'backfill', NOW),
      ...toTrackerEntries([activity('s3', 'sell', { timestamp: NOW + 1, wallet: OTHER }), activity('s4', 'other', { timestamp: NOW, wallet: OTHER })], OTHER, 'backfill', NOW),
    ];
    expect(pruneTrackerEntries(entries, [WALLET, OTHER])).toBe(entries);
    expect(pruneTrackerEntries(entries, [WALLET]).map((e) => e.wallet)).toEqual([WALLET, WALLET]);
    expect(filterTrackerEntries(entries, null, 'all')).toBe(entries);
    expect(filterTrackerEntries(entries, OTHER, 'all').map((e) => e.activity.signature)).toEqual(['s3', 's4']);
    expect(filterTrackerEntries(entries, null, 'transfer').map((e) => e.activity.signature)).toEqual(['s2']);
    expect(filterTrackerEntries(entries, null, 'other').map((e) => e.activity.signature)).toEqual(['s4']);
    expect(filterTrackerEntries(entries, WALLET, 'sell')).toEqual([]);
    expect(feedMints(toTrackerEntries([buy('s9', MINT_B, 1, 1, NOW)], WALLET, 'poll', NOW))).toEqual([MINT_B]);
  });

  it('staggers requests and derives the live state', () => {
    expect(staggerMs(0)).toBe(0);
    expect(staggerMs(3)).toBe(900);
    expect(staggerMs(2, 100)).toBe(200);
    expect(walletLive(undefined, { open: true, confirmed: true })).toBe('subscribed');
    expect(walletLive({ streamEvents: 0 }, { open: false, confirmed: false })).toBe('polling');
    expect(walletLive({ streamEvents: 0, backfillError: 'HTTP 500' }, { open: true, confirmed: true })).toBe('error');
    // A backfill that succeeded before a later poll failed is still live while the WS is.
    expect(walletLive({ streamEvents: 0, backfilledAt: NOW, lastPollAt: NOW, pollError: 'rate limited' }, { open: true, confirmed: true })).toBe('subscribed');
    // ...but with the WS down and the poll failing nothing is feeding the wallet.
    expect(walletLive({ streamEvents: 0, backfilledAt: NOW, pollError: 'rate limited' }, { open: false, confirmed: false })).toBe('error');
    // A successful poll clears the backfill error (the hook reports backfillError: undefined).
    expect(walletLive({ streamEvents: 0, lastPollAt: NOW }, { open: false, confirmed: false })).toBe('polling');
    // An open socket whose subscriptions are not confirmed yet is not "subscribed".
    expect(walletLive({ streamEvents: 0, backfilledAt: NOW }, { open: true, confirmed: false })).toBe('polling');
    // A confirmed subscription that is missing this wallet's transactions is not trusted either.
    expect(walletLive({ streamEvents: 0, backfilledAt: NOW, lastMissAt: NOW + 1 }, { open: true, confirmed: true })).toBe('polling');
    expect(walletLive({ streamEvents: 1, backfilledAt: NOW, lastMissAt: NOW + 1, lastStreamAt: NOW + 2 }, { open: true, confirmed: true })).toBe('subscribed');
  });
});

describe('stream reliability and reconciliation cadence', () => {
  it('trusts the stream only while it is live and has delivered since the last miss', () => {
    expect(streamReliable(undefined, true)).toBe(true);
    expect(streamReliable(undefined, false)).toBe(false);
    expect(streamReliable({ streamEvents: 0, lastMissAt: 10 }, true)).toBe(false);
    expect(streamReliable({ streamEvents: 1, lastMissAt: 10, lastStreamAt: 5 }, true)).toBe(false);
    expect(streamReliable({ streamEvents: 2, lastMissAt: 10, lastStreamAt: 11 }, true)).toBe(true);
    // A balance-change notification after the miss is live evidence too (log notifications may never come).
    expect(streamReliable({ streamEvents: 0, lastMissAt: 10, lastAccountAt: 12 }, true)).toBe(true);
    expect(streamReliable({ streamEvents: 0, lastMissAt: 10, lastAccountAt: 9 }, true)).toBe(false);
    expect(streamReliable({ streamEvents: 0, lastMissAt: 10, lastAccountAt: 12 }, false)).toBe(false);
  });

  it('coalesces balance-change reads more widely for longer lists', () => {
    expect(accountHintGapMs(1)).toBe(10_000);
    expect(accountHintGapMs(5)).toBe(10_000);
    expect(accountHintGapMs(6)).toBe(15_000);
    expect(accountHintGapMs(25)).toBe(30_000);
  });

  it('polls faster only for small lists while the stream is unreliable', () => {
    expect(reconcileIntervalMs(1, true)).toBe(TRACKER_POLL_MS);
    expect(reconcileIntervalMs(3, false)).toBe(TRACKER_FAST_POLL_MS);
    expect(reconcileIntervalMs(5, false)).toBe(TRACKER_FAST_POLL_MS);
    expect(reconcileIntervalMs(6, false)).toBe(TRACKER_MEDIUM_POLL_MS);
    expect(reconcileIntervalMs(25, false)).toBe(TRACKER_POLL_MS);
  });

  it('counts only new, successful, post-subscription transactions as stream misses', () => {
    const entries = toTrackerEntries(
      [
        activity('new', 'buy', { timestamp: NOW + 20_000 }),
        activity('streamed', 'sell', { timestamp: NOW + 21_000 }),
        activity('early', 'buy', { timestamp: NOW + 1_000 }),
        activity('failed', 'buy', { timestamp: NOW + 22_000, success: false }),
      ],
      WALLET,
      'poll',
      NOW + 30_000,
    );
    const known = new Set([trackerKey(WALLET, 'streamed')]);
    expect(countStreamMisses(entries, NOW + 10_000, (e) => known.has(e.key))).toBe(1);
    expect(countStreamMisses([], NOW, () => false)).toBe(0);
  });

  it('patches status fields and clears the ones set to undefined', () => {
    const base = { streamEvents: 3, backfillError: 'HTTP 503', lastPollAt: 1 };
    const next = patchTrackerStatus(base, { backfillError: undefined, lastPollAt: 2, missedByStream: 4 });
    expect(next).toEqual({ streamEvents: 3, lastPollAt: 2, missedByStream: 4 });
    expect('backfillError' in next).toBe(false);
    expect(base.backfillError).toBe('HTTP 503');
    // streamEvents is a counter and never cleared by a patch.
    expect(patchTrackerStatus(base, { streamEvents: undefined }).streamEvents).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Shared prices and retries
// ---------------------------------------------------------------------------

describe('price sharing between holdings and PnL', () => {
  it('exposes only real holding prices and requests only what is missing', () => {
    const priced = priceHoldings(
      portfolio([
        { mint: MINT_A, amount: 10, decimals: 6 },
        { mint: MINT_B, amount: 5, decimals: 6 },
      ]),
      { [MINT_A]: 2 },
      100,
    );
    const known = holdingPrices(priced);
    expect(known).toEqual({ [MINT_A]: 2 });
    expect(holdingPrices(undefined)).toEqual({});
    expect(missingPriceMints([MINT_A, MINT_B, MINT_C], known)).toEqual([MINT_B, MINT_C]);
    expect(missingPriceMints([MINT_A], { [MINT_A]: 0 })).toEqual([MINT_A]);
    // MINT_B was already asked for by the holdings and came back unpriced: not requested again.
    expect(missingPriceMints([MINT_A, MINT_B, MINT_C], known, new Set([MINT_A, MINT_B]))).toEqual([MINT_C]);
  });

  it('dates a picked price set by its oldest contributing source', () => {
    const sources = [
      { prices: { [MINT_A]: 2 }, at: NOW },
      { prices: { [MINT_A]: 3, [MINT_B]: 4 }, at: NOW - 60_000 },
    ];
    expect(pricesAsOf([MINT_A], sources)).toBe(NOW);
    expect(pricesAsOf([MINT_A, MINT_B], sources)).toBe(NOW - 60_000);
    expect(pricesAsOf([MINT_C], sources)).toBeUndefined();
    expect(pricesAsOf([MINT_A], [{ prices: undefined, at: NOW }])).toBeUndefined();
  });

  it('picks the first positive price per mint and omits unpriced mints', () => {
    const picked = pickPrices([MINT_A, MINT_B, MINT_C], [{ [MINT_A]: 2, [MINT_B]: 0 }, { [MINT_A]: 3, [MINT_B]: 4 }, undefined]);
    expect(picked).toEqual({ [MINT_A]: 2, [MINT_B]: 4 });
    expect(pickPrices([], [{ [MINT_A]: 1 }])).toEqual({});
  });

  it('feeds shared prices into unrealized PnL without inventing the rest', () => {
    const pages: WalletActivityPage[] = [{ items: [buy('s2', MINT_B, 10, 1, NOW + 1), buy('s1', MINT_A, 100, 2, NOW)], scanned: 2 }];
    const open = openPositionMints(computePnl(assemblePnlInput({ wallet: WALLET, pages })));
    expect(open.sort()).toEqual([MINT_A, MINT_B].sort());
    const pricesUsd = pickPrices(open, [{ [MINT_A]: 0.05 }]);
    const report = computePnl(assemblePnlInput({ wallet: WALLET, pages, pricesUsd, solPriceUsd: 100 }));
    const a = report.tokens.find((t) => t.mint === MINT_A);
    const b = report.tokens.find((t) => t.mint === MINT_B);
    expect(a?.unrealizedSol).toBeCloseTo(100 * 0.0005 - 2, 9);
    expect(b?.unrealizedSol).toBeUndefined();
    expect(b?.currentPriceSol).toBeUndefined();
    expect(openPositionStats(report)).toEqual({ open: 2, priced: 1, valued: 1 });
    expect(displayUnrealized(report)).toBeCloseTo(100 * 0.0005 - 2, 9);
  });

  it('never shows 0 unrealized when open positions exist but none can be valued', () => {
    // MINT_A: bought then fully sold (closed, exact 0). MINT_B: part received without a SOL cost, then bought:
    // priced, but its remaining cost is unknown, so it cannot be valued.
    const pages: WalletActivityPage[] = [
      {
        items: [
          sell('s2', MINT_A, 10, 2, NOW + 3),
          buy('s1', MINT_A, 10, 1, NOW + 2),
          buy('b1', MINT_B, 5, 0.5, NOW + 1),
          activity('t1', 'transfer_in', { tokenMint: MINT_B, tokenAmount: 5, timestamp: NOW, legs: [{ mint: MINT_B, delta: 5 }] }),
        ],
        scanned: 4,
      },
    ];
    const report = computePnl(assemblePnlInput({ wallet: WALLET, pages, pricesUsd: { [MINT_B]: 1 }, solPriceUsd: 100 }));
    expect(report.totals.unrealizedSol).toBe(0);
    expect(openPositionStats(report)).toEqual({ open: 1, priced: 1, valued: 0 });
    expect(displayUnrealized(report)).toBeUndefined();
    expect(displayUnrealized(undefined)).toBeUndefined();
    expect(tradeSplit(report)).toEqual({ buys: 2, sells: 1 });
    // No open positions: the exact 0 of closed positions is shown.
    const closed = computePnl(assemblePnlInput({ wallet: WALLET, pages: [{ items: [sell('s2', MINT_A, 10, 2, NOW + 2), buy('s1', MINT_A, 10, 1, NOW + 1)], scanned: 2 }] }));
    expect(displayUnrealized(closed)).toBe(0);
  });
});

describe('retryDelayMs', () => {
  it('waits for the browser budget window on rate limits and backs off otherwise', () => {
    const limited = new ProviderError('jupiter', 'rate_limited', 'jupiter: request budget exhausted');
    expect(retryDelayMs(0, limited)).toBe(6_000);
    expect(retryDelayMs(1, limited)).toBe(8_000);
    expect(retryDelayMs(1, new ProviderError('jupiter', 'rate_limited', 'x', { retryAfterMs: 15_000 }))).toBe(15_000);
    expect(retryDelayMs(9, limited)).toBe(20_000);
    expect(retryDelayMs(0, new Error('boom'))).toBe(1_000);
    expect(retryDelayMs(2, new ProviderError('orbyt', 'http', 'x', { status: 500 }))).toBe(4_000);
    expect(retryDelayMs(10, new Error('boom'))).toBe(8_000);
  });
});
