/**
 * Connected wallet's position in the current token (pure; tested in
 * position.test.ts). The average cost is the FIFO cost of the tokens still
 * held, replayed from the wallet's recent activity by the wallet page's PnL
 * engine. It is shown only when that replay explains the whole balance with
 * a complete SOL cost basis: otherwise the value is unknown, never guessed.
 */

import type { PnlReport } from '@/lib/core/types';

/** Relative difference allowed between the replayed holding and the live balance (fees on transfer, float dust). */
export const POSITION_MATCH_TOLERANCE = 0.005;

export type PositionCostGap =
  /** No buy of this token in the recent activity analysed. */
  | 'not_in_activity'
  /** Tokens arrived without a SOL cost (transfer, non-SOL swap) or sells exceed known buys. */
  | 'basis_incomplete'
  /** The recent buys explain only part of the balance (older buys were not analysed). */
  | 'older_history';

export interface PositionCost {
  /** SOL paid per token still held (FIFO). */
  avgCostSol?: number;
  /** SOL paid for the tokens still held. */
  costSol?: number;
  gap?: PositionCostGap;
  /** Transactions the replay covered. */
  transactionsAnalyzed: number;
}

export function positionCost(report: Pick<PnlReport, 'tokens' | 'window'>, mint: string, balance: number): PositionCost {
  const transactionsAnalyzed = report.window.transactionsAnalyzed;
  const t = report.tokens.find((x) => x.mint === mint);
  if (!t || !(t.remainingAmount > 0) || !(t.buys > 0)) return { gap: 'not_in_activity', transactionsAnalyzed };
  if (!t.costBasisComplete || t.remainingCostSol === undefined || !(t.remainingCostSol >= 0)) return { gap: 'basis_incomplete', transactionsAnalyzed };
  if (!(balance > 0) || Math.abs(t.remainingAmount - balance) > balance * POSITION_MATCH_TOLERANCE) return { gap: 'older_history', transactionsAnalyzed };
  return { avgCostSol: t.remainingCostSol / t.remainingAmount, costSol: t.remainingCostSol, transactionsAnalyzed };
}

export interface PositionValue {
  /** balance × price (USD). */
  valueUsd?: number;
  /** balance × price in SOL − SOL cost of the holding. */
  pnlSol?: number;
  /** pnlSol relative to the cost, percent. */
  pnlPct?: number;
}

export function positionValue(input: { balance: number | undefined; priceUsd: number | undefined; solUsd: number | undefined; costSol: number | undefined }): PositionValue {
  const { balance, priceUsd, solUsd, costSol } = input;
  const out: PositionValue = {};
  if (balance === undefined || !Number.isFinite(balance) || balance < 0) return out;
  if (priceUsd !== undefined && Number.isFinite(priceUsd) && priceUsd > 0) out.valueUsd = balance * priceUsd;
  if (out.valueUsd !== undefined && solUsd !== undefined && solUsd > 0 && costSol !== undefined && costSol > 0) {
    const valueSol = out.valueUsd / solUsd;
    out.pnlSol = valueSol - costSol;
    out.pnlPct = (out.pnlSol / costSol) * 100;
  }
  return out;
}

export const COST_GAP_TEXT: Readonly<Record<PositionCostGap, string>> = {
  not_in_activity: 'No buy of this token in the recent activity analysed',
  basis_incomplete: 'Some of these tokens arrived without a SOL cost (transfer or non-SOL swap)',
  older_history: 'Part of this balance was bought before the recent activity analysed',
};
