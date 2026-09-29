'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import { memo, useCallback, useState, type ReactNode } from 'react';
import { TxLink } from '@/components/ui/AddressLink';
import { EmptyState } from '@/components/ui/EmptyState';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/components/ui/cn';
import type { MintIdentities } from '@/data/hooks/usePortfolio';
import type { WalletPnlView } from '@/data/hooks/useWalletPnl';
import { formatAmount, formatDateTime, formatDuration, formatSol, formatUsd } from '@/lib/core/format';
import type { PnlTokenResult } from '@/lib/core/types';
import { describeError } from '@/lib/net/errors';
import { solToUsd } from '@/lib/services/wallet';
import { Dash, TokenCell } from './cells';
import { FOOTER, TD, TD_STICKY, TH, TH_STICKY } from './styles';

const COLS: ReadonlyArray<{ id: string; label: string; width: string; align: 'left' | 'right'; title?: string }> = [
  { id: 'token', label: 'Token', width: 'w-48', align: 'left' },
  { id: 'trades', label: 'B / S', width: 'w-16', align: 'right', title: 'Buys / sells' },
  { id: 'bought', label: 'Bought', width: 'w-24', align: 'right' },
  { id: 'sold', label: 'Sold', width: 'w-24', align: 'right' },
  { id: 'cost', label: 'Cost', width: 'w-24', align: 'right', title: 'SOL spent on buys' },
  { id: 'proceeds', label: 'Proceeds', width: 'w-24', align: 'right', title: 'SOL received from sells' },
  { id: 'realized', label: 'Realized', width: 'w-28', align: 'right', title: 'Sells matched FIFO to lots with a known cost' },
  { id: 'remaining', label: 'Remaining', width: 'w-24', align: 'right', title: 'Units still held' },
  { id: 'unrealized', label: 'Unrealized', width: 'w-28', align: 'right', title: 'Remaining × current price − remaining cost' },
  { id: 'hold', label: 'Avg hold', width: 'w-20', align: 'right' },
  { id: 'basis', label: 'Basis', width: 'w-24', align: 'left', title: 'Cost basis complete for every sold and held unit' },
  { id: 'expand', label: '', width: 'w-8', align: 'right' },
];

const SHOWN_SIGNATURES = 40;

function PnlSol({ value, usdPrice }: { value?: number; usdPrice?: number }) {
  if (value === undefined) return <Dash />;
  const usd = solToUsd(value, usdPrice);
  const tone = value === 0 ? 'text-fg-dim' : value > 0 ? 'text-up' : 'text-down';
  return (
    <span className={cn('tabular', tone)} title={usd === undefined ? undefined : `≈ ${usd < 0 ? '−' : ''}${formatUsd(Math.abs(usd))} at the current SOL price`}>
      {value > 0 ? '+' : value < 0 ? '−' : ''}
      {formatSol(Math.abs(value))}
    </span>
  );
}

function BasisBadge({ complete }: { complete: boolean }) {
  return (
    <span
      className={cn('inline-flex h-5 items-center rounded px-1.5 text-2xs font-semibold', complete ? 'bg-up-soft text-up' : 'bg-warn-soft text-warn')}
      title={
        complete
          ? 'Every sold and held unit traces back to a buy with a known SOL cost'
          : 'Some units were sold beyond the analysed buys or received without a SOL cost; realized PnL covers only units with a known cost'
      }
    >
      {complete ? 'Complete' : 'Partial'}
    </span>
  );
}

const PnlRow = memo(function PnlRow({
  token,
  identities,
  solPriceUsd,
  expanded,
  onToggle,
}: {
  token: PnlTokenResult;
  identities: MintIdentities;
  solPriceUsd?: number;
  expanded: boolean;
  onToggle: (mint: string) => void;
}) {
  const t = token;
  const identity = identities.byMint[t.mint];
  const symbol = identity?.symbol ?? t.symbol;
  return (
    <>
      <tr className="group h-8">
        <td className={TD_STICKY}>
          <TokenCell mint={t.mint} identity={identity} symbol={t.symbol} />
        </td>
        <td className={cn(TD, 'text-right tabular')}>
          <span className="text-up">{t.buys}</span>
          <span className="text-faint"> / </span>
          <span className="text-down">{t.sells}</span>
        </td>
        <td className={cn(TD, 'text-right tabular text-fg-dim')} title={`${t.boughtAmount.toLocaleString('en-US', { maximumFractionDigits: 9 })} ${symbol ?? ''}`}>
          {formatAmount(t.boughtAmount)}
        </td>
        <td className={cn(TD, 'text-right tabular text-fg-dim')} title={`${t.soldAmount.toLocaleString('en-US', { maximumFractionDigits: 9 })} ${symbol ?? ''}`}>
          {formatAmount(t.soldAmount)}
        </td>
        <td className={cn(TD, 'text-right tabular text-fg-dim')}>{formatSol(t.costSol)}</td>
        <td className={cn(TD, 'text-right tabular text-fg-dim')}>{formatSol(t.proceedsSol)}</td>
        <td className={cn(TD, 'text-right')}>
          <PnlSol value={t.realizedSol} usdPrice={solPriceUsd} />
        </td>
        <td className={cn(TD, 'text-right tabular')} title={t.remainingCostSol !== undefined ? `Remaining cost ${formatSol(t.remainingCostSol)}` : 'Remaining cost unknown'}>
          {t.remainingAmount > 0 ? <span className="text-fg">{formatAmount(t.remainingAmount)}</span> : <span className="text-faint">0</span>}
        </td>
        <td className={cn(TD, 'text-right')}>
          {t.unrealizedSol === undefined ? (
            <span className="text-2xs text-faint" title={t.currentPriceSol === undefined ? 'No current price for this token' : 'Remaining cost basis unknown'}>
              {t.currentPriceSol === undefined ? 'no price' : 'no basis'}
            </span>
          ) : (
            <PnlSol value={t.unrealizedSol} usdPrice={solPriceUsd} />
          )}
        </td>
        <td className={cn(TD, 'text-right tabular text-fg-dim')}>{t.avgHoldSeconds === undefined ? <Dash /> : formatDuration(t.avgHoldSeconds)}</td>
        <td className={TD}>
          <BasisBadge complete={t.costBasisComplete} />
        </td>
        <td className={cn(TD, 'text-right')}>
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Hide' : 'Show'} the ${t.signatures.length} transactions behind ${symbol ?? 'this token'}`}
            onClick={() => onToggle(t.mint)}
            className="inline-flex size-6 items-center justify-center rounded text-muted hover:bg-panel-3 hover:text-fg"
          >
            {expanded ? <ChevronDown aria-hidden className="size-3.5" strokeWidth={1.75} /> : <ChevronRight aria-hidden className="size-3.5" strokeWidth={1.75} />}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={COLS.length} className="border-b border-line bg-panel-2 px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted">
              <span>
                First trade <span className="text-fg-dim">{formatDateTime(t.firstTradeAt)}</span>
              </span>
              <span>
                Last trade <span className="text-fg-dim">{formatDateTime(t.lastTradeAt)}</span>
              </span>
              <span>
                {t.signatures.length} transaction{t.signatures.length === 1 ? '' : 's'} audited
              </span>
              {t.remainingCostSol !== undefined && (
                <span>
                  Remaining cost <span className="text-fg-dim">{formatSol(t.remainingCostSol)}</span>
                </span>
              )}
              {t.currentPriceSol !== undefined && (
                <span>
                  Current price <span className="text-fg-dim">{formatSol(t.currentPriceSol, { maxDecimals: 12 })}</span>
                </span>
              )}
            </div>
            <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
              {t.signatures.slice(0, SHOWN_SIGNATURES).map((sig) => (
                <li key={sig}>
                  <TxLink signature={sig} className="text-2xs" />
                </li>
              ))}
              {t.signatures.length > SHOWN_SIGNATURES && <li className="text-2xs text-faint">+{t.signatures.length - SHOWN_SIGNATURES} more</li>}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
});

function SkeletonRow() {
  return (
    <tr className="h-8" aria-hidden>
      {COLS.map((c) => (
        <td key={c.id} className={c.id === 'token' ? TD_STICKY : TD}>
          {c.id !== 'expand' && <Skeleton className={cn('h-2.5', c.align === 'right' ? 'ml-auto w-3/5' : 'w-3/4')} />}
        </td>
      ))}
    </tr>
  );
}

/** PnL tab: per-token FIFO results with a basis badge and an expandable signature audit. */
export function PnlTable({ pnl }: { pnl: WalletPnlView }) {
  const { report, identities, solPriceUsd, activity, pricesError, pricesUpdatedAt, positions } = pnl;
  // The badge follows current prices only when some open position is actually priced; otherwise the history's age.
  const pricedView = positions.priced > 0 && pricesUpdatedAt !== undefined;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Stable, so memoized rows do not all re-render when one row toggles.
  const toggle = useCallback(
    (mint: string) =>
      setExpanded((s) => {
        const next = new Set(s);
        if (next.has(mint)) next.delete(mint);
        else next.add(mint);
        return next;
      }),
    [],
  );

  const loading = activity.infinite.isPending;
  let empty: ReactNode = null;
  if (activity.infinite.isError && !report) {
    empty = (
      <EmptyState tone="error" title="PnL unavailable">
        {describeError(activity.infinite.error)}
      </EmptyState>
    );
  } else if (report && report.tokens.length === 0) {
    empty = (
      <EmptyState title="No token trades in the analysed window">
        {report.window.transactionsAnalyzed} transaction{report.window.transactionsAnalyzed === 1 ? '' : 's'} analysed; none was a SOL-denominated buy or sell.
        {!report.window.historyComplete && ' Use "Analyze more" above to load older history.'}
      </EmptyState>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {report && report.caveats.length > 0 && (
        <details className="group/caveats shrink-0 border-b border-line bg-panel">
          <summary className="flex h-7 cursor-pointer list-none items-center gap-1.5 px-3 text-2xs text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden className="size-3 transition-transform group-open/caveats:rotate-90" strokeWidth={1.75} />
            {report.caveats.length} caveat{report.caveats.length === 1 ? '' : 's'} · FIFO · SOL-denominated
          </summary>
          <ul className="space-y-1 border-t border-line px-3 py-2 text-2xs text-fg-dim">
            {report.caveats.map((c) => (
              <li key={c} className="flex gap-2">
                <span aria-hidden className="text-faint">
                  –
                </span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="relative min-h-0 flex-1 overflow-auto" aria-busy={loading || undefined}>
        <table className="w-full min-w-[1120px] table-fixed border-separate border-spacing-0 text-xs">
          <caption className="sr-only">Per-token PnL</caption>
          <colgroup>
            {COLS.map((c) => (
              <col key={c.id} className={c.width} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.id} scope="col" title={c.title} className={cn(c.id === 'token' ? TH_STICKY : TH, c.align === 'right' ? 'text-right' : 'text-left')}>
                  {c.label || <span className="sr-only">Details</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report?.tokens.map((t) => (
              <PnlRow key={t.mint} token={t} identities={identities} solPriceUsd={solPriceUsd} expanded={expanded.has(t.mint)} onToggle={toggle} />
            ))}
            {loading && Array.from({ length: 6 }, (_, i) => <SkeletonRow key={i} />)}
          </tbody>
        </table>
        {empty && <div className="sticky left-0 w-full">{empty}</div>}
      </div>
      <footer className={FOOTER}>
        {report ? (
          <span className="tabular">
            {report.tokens.length} token{report.tokens.length === 1 ? '' : 's'} · {report.window.swapsCounted} buys/sells · {report.window.transactionsAnalyzed} transactions analysed
          </span>
        ) : (
          <span>{activity.infinite.isError ? 'No data' : 'Loading'}</span>
        )}
        <span aria-hidden className="text-faint">
          ·
        </span>
        <span>Prices: Jupiter Price V3 ÷ SOL price</span>
        {pricesError !== undefined && pricesError !== null && (
          <>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <span className="text-warn" title={describeError(pricesError)}>
              Current prices unavailable
            </span>
          </>
        )}
        <span className="ml-auto flex items-center gap-2 pl-3">
          <span className="text-faint">≈USD at the current SOL price{solPriceUsd !== undefined ? ` (${formatUsd(solPriceUsd, { compact: false })})` : ''}</span>
          {/* Realized PnL is immutable history; the age that matters is that of the prices behind unrealized PnL. */}
          <FreshnessBadge
            updatedAt={pricedView ? pricesUpdatedAt : activity.infinite.data?.pages[0]?.fetchedAt}
            error={activity.infinite.isError && !report ? describeError(activity.infinite.error) : positions.open > 0 && pricesError ? describeError(pricesError) : null}
            staleAfterMs={pricedView ? 120_000 : Number.POSITIVE_INFINITY}
          />
        </span>
      </footer>
    </div>
  );
}
