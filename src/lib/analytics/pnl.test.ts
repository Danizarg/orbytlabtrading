import { describe, expect, it } from 'vitest';
import type { ActivityKind, PnlReport, PnlTokenResult, WalletActivity } from '@/lib/core/types';
import { MINTS } from '@/lib/core/solana';
import { computePnl, type PnlInput } from './pnl';

const WALLET = 'Hfy1ettvX6dv2xEhxtM7RithXYam3QCV6fHWfsLzdKA5';
const OTHER = 'EKkMH7fw8rqyYHn6drFVduiQczRKLTrLGo9SW2YacigW';
const A = '5RJGBaFrTcTrmu5HuukxHxKeqpmRWf346YxQ1kXGetRs';
const B = 'dB98iqo6YQ2p1X1KtvmLRDFmtQauEiA2CtxL8cvpump';
const C = 'GJNVxxuSGZ4FQYVBrYYEQe4DFDithm9LopFno2XKpump';
const T0 = Date.parse('2026-09-28T12:00:00Z');

function act(
  kind: ActivityKind,
  signature: string,
  seconds: number,
  mint: string | undefined,
  tokenAmount: number | undefined,
  solAmount: number | undefined,
  extra: Partial<WalletActivity> = {},
): WalletActivity {
  const legs: WalletActivity['legs'] = [];
  const outgoing = kind === 'sell' || kind === 'transfer_out';
  if (mint && tokenAmount !== undefined) legs.push({ mint, delta: outgoing ? -tokenAmount : tokenAmount });
  if (solAmount !== undefined) legs.push({ mint: MINTS.SOL, delta: kind === 'buy' ? -solAmount : solAmount });
  const a: WalletActivity = { signature, timestamp: T0 + seconds * 1000, wallet: WALLET, kind, legs, success: true, source: 'solana-rpc', ...extra };
  if (mint !== undefined && a.tokenMint === undefined) a.tokenMint = mint;
  if (tokenAmount !== undefined && a.tokenAmount === undefined) a.tokenAmount = tokenAmount;
  if (solAmount !== undefined && a.solAmount === undefined) a.solAmount = solAmount;
  return a;
}

const buy = (sig: string, s: number, mint: string, tokens: number, sol: number | undefined, extra?: Partial<WalletActivity>) =>
  act('buy', sig, s, mint, tokens, sol, extra);
const sell = (sig: string, s: number, mint: string, tokens: number, sol: number | undefined, extra?: Partial<WalletActivity>) =>
  act('sell', sig, s, mint, tokens, sol, extra);

function run(activities: WalletActivity[], opts: Partial<PnlInput> = {}): PnlReport {
  return computePnl({ wallet: WALLET, activities, historyComplete: true, transactionsAnalyzed: activities.length, ...opts });
}

function token(report: PnlReport, mint: string): PnlTokenResult {
  const t = report.tokens.find((x) => x.mint === mint);
  if (!t) throw new Error(`no result for ${mint}`);
  return t;
}

const hasCaveat = (report: PnlReport, pattern: RegExp) => report.caveats.some((c) => pattern.test(c));

describe('computePnl — FIFO matching', () => {
  it('computes a simple round trip', () => {
    const r = run([buy('b1', 0, A, 1_000, 1), sell('s1', 60, A, 1_000, 1.5)], { currentPricesSol: { [A]: 0.002 } });
    const t = token(r, A);
    expect(t).toMatchObject({
      buys: 1,
      sells: 1,
      boughtAmount: 1_000,
      soldAmount: 1_000,
      costSol: 1,
      proceedsSol: 1.5,
      remainingAmount: 0,
      remainingCostSol: 0,
      unrealizedSol: 0,
      currentPriceSol: 0.002,
      firstTradeAt: T0,
      lastTradeAt: T0 + 60_000,
      avgHoldSeconds: 60,
      costBasisComplete: true,
      signatures: ['b1', 's1'],
    });
    expect(t.realizedSol).toBeCloseTo(0.5, 12);
    expect(r.totals).toMatchObject({ volumeSol: 2.5, trades: 2, winners: 1, losers: 0, winRatePct: 100, avgHoldSeconds: 60, unrealizedSol: 0 });
    expect(r.totals.realizedSol).toBeCloseTo(0.5, 12);
    expect(r).toMatchObject({ wallet: WALLET, method: 'FIFO', quote: 'SOL' });
  });

  it('consumes lots first-in-first-out and pro-rates partially used lots', () => {
    const r = run(
      [buy('b1', 0, A, 100, 1), buy('b2', 100, A, 100, 3), sell('s1', 200, A, 150, 3)],
      { currentPricesSol: { [A]: 0.02 } },
    );
    const t = token(r, A);
    // Sold 100 from b1 (cost 1) + 50 from b2 (cost 1.5) = 2.5 → realized 0.5.
    expect(t.realizedSol).toBeCloseTo(0.5, 12);
    expect(t.remainingAmount).toBeCloseTo(50, 12);
    expect(t.remainingCostSol).toBeCloseTo(1.5, 12);
    expect(t.unrealizedSol).toBeCloseTo(50 * 0.02 - 1.5, 12);
    // Hold: 100 units × 200 s + 50 units × 100 s over 150 units.
    expect(t.avgHoldSeconds).toBeCloseTo((100 * 200 + 50 * 100) / 150, 9);
    expect(t.costBasisComplete).toBe(true);
    expect(r.totals.unrealizedSol).toBeCloseTo(-0.5, 12);
  });

  it('handles float dust when amounts sum exactly in decimal but not in binary', () => {
    const r = run([buy('b1', 0, A, 100.1, 0.1), buy('b2', 1, A, 200.2, 0.2), sell('s1', 2, A, 300.3, 0.6)]);
    const t = token(r, A);
    expect(t.costBasisComplete).toBe(true);
    expect(t.remainingAmount).toBe(0);
    expect(t.unrealizedSol).toBe(0);
    expect(t.realizedSol).toBeCloseTo(0.3, 12);
  });

  it('counts a total loss (zero proceeds) as a loser', () => {
    const r = run([buy('b1', 0, A, 1_000, 2), sell('s1', 10, A, 1_000, 0)]);
    expect(token(r, A).realizedSol).toBe(-2);
    expect(r.totals).toMatchObject({ winners: 0, losers: 1, winRatePct: 0 });
  });
});

describe('computePnl — incomplete cost basis', () => {
  it('excludes units sold beyond known inventory from realized PnL', () => {
    const r = run([buy('b1', 0, A, 100, 1), sell('s1', 10, A, 150, 3)]);
    const t = token(r, A);
    // Only 100 of 150 units have a known cost: proceeds 3 × 100/150 = 2 − cost 1.
    expect(t.realizedSol).toBeCloseTo(1, 12);
    expect(t.proceedsSol).toBe(3);
    expect(t.costBasisComplete).toBe(false);
    expect(t.remainingAmount).toBe(0);
    expect(r.totals).toMatchObject({ winners: 0, losers: 0 });
    expect(r.totals.winRatePct).toBeUndefined();
    expect(hasCaveat(r, /1 token has incomplete cost basis/)).toBe(true);
  });

  it('computes nothing for a sell of tokens bought before the window', () => {
    const r = run([sell('s1', 0, A, 500, 2)], { historyComplete: false, transactionsAnalyzed: 1000 });
    const t = token(r, A);
    expect(t).toMatchObject({ realizedSol: 0, proceedsSol: 2, costBasisComplete: false, remainingAmount: 0, sells: 1, buys: 0 });
    expect(t.avgHoldSeconds).toBeUndefined();
    expect(hasCaveat(r, /only the most recent 1000 transactions were analysed/)).toBe(true);
  });

  it('treats transfer-in lots as unknown cost (hold time still measured)', () => {
    const r = run([act('transfer_in', 't1', 0, A, 100, undefined), sell('s1', 30, A, 100, 1)]);
    const t = token(r, A);
    expect(t.realizedSol).toBe(0);
    expect(t.costBasisComplete).toBe(false);
    expect(t.avgHoldSeconds).toBe(30);
    expect(t.signatures).toEqual(['t1', 's1']);
    expect(t.buys).toBe(0);
    expect(t.boughtAmount).toBe(0);
  });

  it('matches known lots before a later transfer-in (FIFO) and flags the unknown-cost holding', () => {
    const r = run([buy('b1', 0, A, 100, 1), act('transfer_in', 't1', 5, A, 50, undefined), sell('s1', 10, A, 100, 2)], {
      currentPricesSol: { [A]: 0.05 },
    });
    const t = token(r, A);
    expect(t.realizedSol).toBeCloseTo(1, 12);
    expect(t.remainingAmount).toBe(50);
    expect(t.remainingCostSol).toBeUndefined();
    expect(t.unrealizedSol).toBeUndefined();
    expect(t.costBasisComplete).toBe(false);
    expect(hasCaveat(r, /Unrealized PnL excludes 1 open position/)).toBe(true);
  });

  it('removes transferred-out units FIFO without treating them as a sale', () => {
    const r = run([buy('b1', 0, A, 100, 2), act('transfer_out', 't1', 5, A, 40, undefined), sell('s1', 10, A, 60, 3)]);
    const t = token(r, A);
    // Remaining 60 units carry 60% of the cost (1.2 SOL).
    expect(t.realizedSol).toBeCloseTo(1.8, 12);
    expect(t).toMatchObject({ soldAmount: 60, sells: 1, proceedsSol: 3, costSol: 2, remainingAmount: 0, costBasisComplete: true });
    expect(t.avgHoldSeconds).toBe(10);
    expect(t.signatures).toEqual(['b1', 't1', 's1']);
    expect(hasCaveat(r, /1 token transfer affected inventory/)).toBe(true);
  });

  it('flags buys / sells without a SOL amount', () => {
    const r = run([buy('b1', 0, A, 100, undefined), sell('s1', 10, A, 100, 1)]);
    const t = token(r, A);
    expect(t.costBasisComplete).toBe(false);
    expect(t.realizedSol).toBe(0);
    expect(t.costSol).toBe(0);
    expect(r.totals.volumeSol).toBe(1);
    expect(hasCaveat(r, /1 buy\/sell has no SOL amount/)).toBe(true);
  });

  it('flags a sell without a SOL amount and still consumes inventory', () => {
    const r = run([buy('b1', 0, A, 100, 1), sell('s1', 10, A, 60, undefined), sell('s2', 20, A, 40, 1)]);
    const t = token(r, A);
    expect(t.realizedSol).toBeCloseTo(1 - 0.4, 12);
    expect(t.costBasisComplete).toBe(false);
    expect(t.remainingAmount).toBe(0);
  });
});

describe('computePnl — token↔token swaps', () => {
  it('excludes swaps from PnL but moves inventory on both legs', () => {
    const swap = act('swap', 'x1', 50, undefined, undefined, undefined, {
      legs: [
        { mint: A, delta: -50 },
        { mint: B, delta: 1_000, symbol: 'CURVE' },
        { mint: MINTS.SOL, delta: -0.00001 },
      ],
    });
    const r = run([buy('b1', 0, A, 100, 2), swap, sell('s1', 100, A, 50, 1.5), sell('s2', 110, B, 1_000, 4)], {
      currentPricesSol: { [A]: 0.03 },
    });
    const a = token(r, A);
    // A: 50 units left after the swap, sold with the remaining cost 1 SOL.
    expect(a.realizedSol).toBeCloseTo(0.5, 12);
    expect(a.costBasisComplete).toBe(true);
    expect(a.remainingAmount).toBe(0);
    expect(a.signatures).toEqual(['b1', 'x1', 's1']);
    const b = token(r, B);
    expect(b).toMatchObject({ symbol: 'CURVE', realizedSol: 0, costBasisComplete: false, proceedsSol: 4, remainingAmount: 0 });
    expect(r.window.swapsCounted).toBe(3);
    expect(r.totals.trades).toBe(3);
    expect(r.totals.volumeSol).toBeCloseTo(7.5, 12);
    expect(hasCaveat(r, /1 token↔token swap without a SOL leg was excluded/)).toBe(true);
  });

  it('does not report tokens that were only moved by swaps / transfers', () => {
    const r = run([
      act('swap', 'x1', 0, undefined, undefined, undefined, { legs: [{ mint: C, delta: 10 }, { mint: B, delta: -5 }] }),
      act('transfer_in', 't1', 1, A, 5, undefined),
    ]);
    expect(r.tokens).toEqual([]);
    expect(r.totals.trades).toBe(0);
  });
});

describe('computePnl — input hygiene and determinism', () => {
  const activities = [
    buy('b1', 0, A, 100, 1),
    buy('b2', 0, B, 1_000, 0.5, { tokenSymbol: 'BBB' }),
    sell('s1', 60, A, 100, 2),
    sell('s2', 60, B, 1_000, 0.25),
    buy('b3', 120, C, 10, 1),
    sell('s3', 180, C, 10, 1.5),
  ];

  it('is independent of input order (ties by signature)', () => {
    const a = run(activities);
    const b = run([...activities].reverse());
    expect(b).toEqual(a);
  });

  it('never mutates its input', () => {
    const snapshot = JSON.stringify(activities);
    run(activities, { currentPricesSol: { [A]: 1 } });
    expect(JSON.stringify(activities)).toBe(snapshot);
  });

  it('sorts tokens by last trade (newest first) and aggregates winners / losers', () => {
    const r = run(activities, { symbols: { [A]: 'AAA', [B]: 'B-OVERRIDE' } });
    expect(r.tokens.map((t) => t.mint)).toEqual([C, A, B]);
    expect(token(r, A).symbol).toBe('AAA');
    expect(token(r, B).symbol).toBe('B-OVERRIDE'); // explicit symbols win over activity symbols
    expect(token(r, C).symbol).toBeUndefined();
    expect(r.totals).toMatchObject({ winners: 2, losers: 1, trades: 6 });
    expect(r.totals.winRatePct).toBeCloseTo((2 / 3) * 100, 12);
    expect(r.totals.realizedSol).toBeCloseTo(1 - 0.25 + 0.5, 12);
    expect(r.totals.volumeSol).toBeCloseTo(1 + 0.5 + 2 + 0.25 + 1 + 1.5, 12);
    // Unweighted mean of per-token hold times (60, 60, 60 s).
    expect(r.totals.avgHoldSeconds).toBe(60);
    expect(r.window).toEqual({ from: T0, to: T0 + 180_000, transactionsAnalyzed: 6, swapsCounted: 6, historyComplete: true });
  });

  it('uses each signature once', () => {
    const r = run([buy('b1', 0, A, 100, 1), buy('b1', 0, A, 100, 1), sell('s1', 5, A, 100, 2)]);
    expect(token(r, A)).toMatchObject({ buys: 1, boughtAmount: 100, costBasisComplete: true, signatures: ['b1', 's1'] });
  });

  it('ignores failed transactions with a caveat', () => {
    const r = run([buy('b1', 0, A, 100, 1), sell('bad', 5, A, 100, 9, { success: false }), sell('s1', 10, A, 100, 2)]);
    expect(token(r, A).realizedSol).toBeCloseTo(1, 12);
    expect(token(r, A).signatures).not.toContain('bad');
    expect(hasCaveat(r, /1 failed transaction ignored/)).toBe(true);
    expect(r.window.to).toBe(T0 + 10_000);
  });

  it('ignores activities of other wallets, SOL-as-token and unusable rows', () => {
    const r = run([
      buy('b1', 0, A, 100, 1),
      buy('o1', 1, A, 1_000_000, 1, { wallet: OTHER }),
      buy('w1', 2, MINTS.SOL, 5, 5),
      act('buy', 'm1', 3, A, undefined, 1, { legs: [] }),
      { ...buy('n1', 4, A, 1, 1), timestamp: Number.NaN },
      sell('s1', 10, A, 100, 2),
    ]);
    expect(r.tokens.map((t) => t.mint)).toEqual([A]);
    expect(token(r, A)).toMatchObject({ buys: 1, costBasisComplete: true });
    expect(hasCaveat(r, /1 activity belonging to other wallets ignored/)).toBe(true);
    expect(hasCaveat(r, /3 activities without a usable token, amount or timestamp skipped/)).toBe(true);
  });

  it('falls back to the balance leg when tokenAmount is missing and accepts signed amounts', () => {
    const r = run([
      buy('b1', 0, A, 100, 1, { tokenAmount: undefined }),
      sell('s1', 10, A, 100, 2, { tokenAmount: -100, solAmount: -2 }),
    ]);
    expect(token(r, A)).toMatchObject({ boughtAmount: 100, soldAmount: 100, costSol: 1, proceedsSol: 2, costBasisComplete: true });
  });
});

describe('computePnl — prices, totals and caveats', () => {
  it('reports unrealized PnL only where a price and full cost basis are known', () => {
    const r = run([buy('b1', 0, A, 100, 1), buy('b2', 1, B, 100, 1), buy('b3', 2, C, 100, 1)], {
      currentPricesSol: { [A]: 0.02, [B]: 0, [C]: Number.NaN },
    });
    expect(token(r, A).unrealizedSol).toBeCloseTo(1, 12);
    expect(token(r, B).unrealizedSol).toBeUndefined();
    expect(token(r, B).currentPriceSol).toBeUndefined();
    expect(token(r, C).unrealizedSol).toBeUndefined();
    expect(r.totals.unrealizedSol).toBeCloseTo(1, 12);
    expect(hasCaveat(r, /Unrealized PnL excludes 2 open positions/)).toBe(true);
    // Nothing sold → no winners, losers, win rate or hold time.
    expect(r.totals).toMatchObject({ winners: 0, losers: 0, realizedSol: 0 });
    expect(r.totals.winRatePct).toBeUndefined();
    expect(r.totals.avgHoldSeconds).toBeUndefined();
  });

  it('returns an empty but honest report for no activity', () => {
    const r = computePnl({ wallet: WALLET, activities: [], historyComplete: true, transactionsAnalyzed: 0 });
    expect(r.tokens).toEqual([]);
    expect(r.totals).toEqual({ realizedSol: 0, volumeSol: 0, trades: 0, winners: 0, losers: 0 });
    expect(r.window).toEqual({ transactionsAnalyzed: 0, swapsCounted: 0, historyComplete: true });
    expect(r.solPriceUsd).toBeUndefined();
    expect(r.caveats).toHaveLength(2);
  });

  it('always explains the method and fee treatment, with the network fee total', () => {
    const r = run([buy('b1', 0, A, 100, 1, { feeSol: 0.000005 }), sell('s1', 1, A, 100, 2, { feeSol: 0.0001 })], { solPriceUsd: 118.74 });
    expect(r.caveats[0]).toMatch(/FIFO per token and denominated in SOL/);
    expect(r.caveats[1]).toMatch(/router\/bot fees and tips .* are included/);
    expect(r.caveats[1]).toMatch(/network fees \(0\.000105 SOL on counted trades\) are not/);
    expect(r.solPriceUsd).toBe(118.74);
  });

  it('omits a non-finite SOL price', () => {
    expect(run([], { solPriceUsd: Number.NaN }).solPriceUsd).toBeUndefined();
  });
});
