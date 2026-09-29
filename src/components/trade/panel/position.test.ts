import { describe, expect, it } from 'vitest';
import { computePnl } from '@/lib/analytics/pnl';
import type { WalletActivity } from '@/lib/core/types';
import { positionCost, positionValue } from './position';

const WALLET = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const MINT = 'DKxXdaMC1so182urvrrnhs6V6fGTrttPS8br6JuEpump';

function swap(signature: string, timestamp: number, side: 'buy' | 'sell', tokens: number, sol: number): WalletActivity {
  return { signature, timestamp, wallet: WALLET, kind: side, tokenMint: MINT, tokenAmount: tokens, solAmount: sol, legs: [], success: true, source: 'solana-rpc' };
}

function report(activities: WalletActivity[]) {
  return computePnl({ wallet: WALLET, activities, historyComplete: false, transactionsAnalyzed: 15 });
}

describe('positionCost', () => {
  it('FIFO average cost of the tokens still held', () => {
    const r = report([swap('a', 1, 'buy', 1_000, 1), swap('b', 2, 'buy', 1_000, 3), swap('c', 3, 'sell', 1_000, 2)]);
    // The first lot (1 SOL / 1000) was sold; 1000 tokens bought for 3 SOL remain.
    expect(positionCost(r, MINT, 1_000)).toEqual({ avgCostSol: 0.003, costSol: 3, transactionsAnalyzed: 15 });
  });

  it('is unknown when the recent activity does not explain the whole balance', () => {
    const r = report([swap('a', 1, 'buy', 1_000, 1)]);
    expect(positionCost(r, MINT, 5_000)).toMatchObject({ gap: 'older_history' });
    expect(positionCost(r, MINT, 5_000).avgCostSol).toBeUndefined();
    // Within 0.5 % (fees, dust) it still counts.
    expect(positionCost(r, MINT, 1_004).avgCostSol).toBe(0.001);
  });

  it('is unknown without a buy in the window or with an incomplete basis', () => {
    expect(positionCost(report([]), MINT, 10)).toMatchObject({ gap: 'not_in_activity' });
    const oversold = report([swap('a', 1, 'buy', 100, 1), swap('b', 2, 'sell', 150, 2), swap('c', 3, 'buy', 100, 1)]);
    expect(positionCost(oversold, MINT, 100)).toMatchObject({ gap: 'basis_incomplete' });
  });
});

describe('positionValue', () => {
  it('values the holding and its PnL in SOL', () => {
    // 1000 tokens at $0.30 with SOL at $150 = 2 SOL; paid 1 SOL.
    const v = positionValue({ balance: 1_000, priceUsd: 0.3, solUsd: 150, costSol: 1 });
    expect(v.valueUsd).toBeCloseTo(300);
    expect(v.pnlSol).toBeCloseTo(1);
    expect(v.pnlPct).toBeCloseTo(100);
  });

  it('never invents missing inputs', () => {
    expect(positionValue({ balance: 1_000, priceUsd: undefined, solUsd: 150, costSol: 1 })).toEqual({});
    expect(positionValue({ balance: 1_000, priceUsd: 0.3, solUsd: undefined, costSol: 1 })).toEqual({ valueUsd: 300 });
    expect(positionValue({ balance: 1_000, priceUsd: 0.3, solUsd: 150, costSol: undefined }).pnlSol).toBeUndefined();
    expect(positionValue({ balance: undefined, priceUsd: 0.3, solUsd: 150, costSol: 1 })).toEqual({});
  });
});
