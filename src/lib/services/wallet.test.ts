import { describe, expect, it } from 'vitest';
import { computePnl } from '@/lib/analytics/pnl';
import { MINTS } from '@/lib/core/solana';
import type { Portfolio, WalletActivity, WalletActivityPage } from '@/lib/core/types';
import {
  activityCoverage,
  activityMints,
  assemblePnlInput,
  feedMints,
  filterTrackerEntries,
  identityMints,
  mergeActivityItems,
  mergeTrackerEntries,
  nextPnlTarget,
  openPositionMints,
  priceHoldings,
  pricesInSol,
  pruneTrackerEntries,
  selectMintsToPrice,
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
    // A backfill that succeeded before a later poll failed is still live.
    expect(walletLive({ streamEvents: 0, backfilledAt: NOW, lastPollAt: NOW, pollError: 'rate limited' }, { open: true, confirmed: true })).toBe('subscribed');
  });
});
