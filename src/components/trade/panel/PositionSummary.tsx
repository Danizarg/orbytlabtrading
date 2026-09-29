'use client';

import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { formatAmount, formatPct, formatPrice, formatUsd } from '@/lib/core/format';
import { providerLabel } from '@/lib/services/token';
import type { TokenBalanceReading } from '@/data/hooks/useWalletBalances';
import { Dash } from '../parts';
import { COST_GAP_TEXT, positionValue, type PositionCost } from './position';

function Cell({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="flex h-5 min-w-0 items-center justify-between gap-2" title={title}>
      <span className="shrink-0 text-faint">{label}</span>
      <span className="min-w-0 truncate text-right tabular text-fg-dim">{children}</span>
    </div>
  );
}

/**
 * The connected wallet's position in this token: holding, value at the
 * current price, FIFO average cost of the tokens still held and the
 * resulting PnL in SOL (only when the recent activity explains the whole
 * balance).
 */
export function PositionSummary({
  symbol,
  token,
  tokenPending,
  tokenError,
  priceUsd,
  solUsd,
  cost,
  costPending,
}: {
  symbol: string;
  token: TokenBalanceReading | undefined;
  tokenPending: boolean;
  tokenError: unknown;
  priceUsd: number | undefined;
  solUsd: number | undefined;
  cost: PositionCost | undefined;
  costPending: boolean;
}) {
  const balance = token?.amount;
  const source = token ? `Balance: ${providerLabel(token.source)}` : undefined;

  if (token && token.amount === 0) {
    return (
      <div className="mt-2 flex h-6 items-center justify-between border-t border-line pt-2 text-2xs" title={source}>
        <span className="text-faint">Position</span>
        <span className="text-muted">No {symbol} in this wallet</span>
      </div>
    );
  }

  const value = positionValue({ balance, priceUsd, solUsd, costSol: cost?.costSol });
  const costTitle = cost?.gap
    ? `${COST_GAP_TEXT[cost.gap]} (last ${cost.transactionsAnalyzed} transactions)`
    : cost?.avgCostSol !== undefined
      ? `FIFO cost of the tokens held, from the last ${cost.transactionsAnalyzed} transactions`
      : undefined;
  const pnlTone = value.pnlSol === undefined ? '' : value.pnlSol > 0 ? 'text-up' : value.pnlSol < 0 ? 'text-down' : '';

  return (
    <div className="mt-2 grid grid-cols-2 gap-x-4 border-t border-line pt-1.5 text-2xs" role="group" aria-label="Your position">
      <Cell label="Holding" title={token === undefined && tokenError ? 'Balance unavailable' : source}>
        {balance !== undefined ? `${formatAmount(balance)} ${symbol}` : tokenPending ? <span className="text-faint">…</span> : <Dash />}
      </Cell>
      <Cell label="Value" title={priceUsd === undefined ? 'Waiting for a price' : undefined}>
        {value.valueUsd !== undefined ? formatUsd(value.valueUsd) : <Dash />}
      </Cell>
      <Cell label="Avg cost" title={costTitle}>
        {cost?.avgCostSol !== undefined ? `${formatPrice(cost.avgCostSol, { currency: false })} SOL` : costPending ? <span className="text-faint">…</span> : <Dash />}
      </Cell>
      <Cell label="PnL" title={value.pnlSol !== undefined ? `${formatAmount(value.pnlSol, { maxDecimals: 6 })} SOL: current value in SOL minus the SOL paid for the tokens held` : costTitle}>
        {value.pnlSol !== undefined ? (
          <span className={cn(pnlTone)}>
            {value.pnlSol > 0 ? '+' : ''}
            {formatAmount(value.pnlSol, { maxDecimals: Math.abs(value.pnlSol) >= 1 ? 2 : 3 })} SOL
            <span className="ml-1 opacity-80">({formatPct(value.pnlPct)})</span>
          </span>
        ) : (
          <Dash />
        )}
      </Cell>
    </div>
  );
}
