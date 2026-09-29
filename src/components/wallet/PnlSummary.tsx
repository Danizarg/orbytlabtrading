'use client';

import { RotateCw, TriangleAlert } from 'lucide-react';
import { Skeleton } from '@/components/ui/Skeleton';
import type { WalletPnlView } from '@/data/hooks/useWalletPnl';
import { formatDateTime, formatDuration, formatPct, formatSol, formatUsd } from '@/lib/core/format';
import { describeError } from '@/lib/net/errors';
import { PNL_MAX_PAGES, PNL_MORE_PAGES, solToUsd } from '@/lib/services/wallet';
import { Dash, StatTile } from './cells';
import { BTN } from './styles';

const TILES = 7;

function toneOf(n: number | undefined): 'up' | 'down' | 'neutral' {
  if (n === undefined || n === 0) return 'neutral';
  return n > 0 ? 'up' : 'down';
}

function signedSol(n: number | undefined): string {
  if (n === undefined) return '—';
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatSol(Math.abs(n))}`;
}

function approxUsd(sol: number | undefined, solPriceUsd: number | undefined): string | undefined {
  const usd = solToUsd(sol, solPriceUsd);
  return usd === undefined ? undefined : `≈ ${usd < 0 ? '−' : ''}${formatUsd(Math.abs(usd))}`;
}

/**
 * PnL summary strip: seven stat tiles (realized, unrealized, win rate,
 * winners/losers, trades, volume, average hold) and a coverage banner that
 * says exactly how much history the numbers are based on.
 */
export function PnlSummary({ pnl }: { pnl: WalletPnlView }) {
  const { report, coverage, solPriceUsd, analyzing, canAnalyzeMore, analyzeMore, pagesLoaded, target, pricedOpen, openPositions, activity } = pnl;
  const { infinite } = activity;
  const usdNote = solPriceUsd !== undefined ? `at the current SOL price (${formatUsd(solPriceUsd, { compact: false })})` : 'SOL price unavailable';

  if (!report) {
    if (infinite.isError) {
      return (
        <div role="alert" className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 text-2xs text-down">
          <TriangleAlert aria-hidden className="size-3" strokeWidth={1.75} />
          PnL unavailable · {describeError(infinite.error)}
          <button type="button" onClick={() => void infinite.refetch()} className={`${BTN} ml-2`}>
            <RotateCw aria-hidden className="size-3" strokeWidth={1.75} /> Retry
          </button>
        </div>
      );
    }
    return (
      <div aria-busy="true" aria-label="Loading PnL" className="grid shrink-0 grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-4 xl:grid-cols-7">
        {Array.from({ length: TILES }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5 bg-panel px-3 py-2">
            <Skeleton className="h-2 w-12" />
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-2 w-14" />
          </div>
        ))}
      </div>
    );
  }

  const { totals, window } = report;
  const winners = totals.winners;
  const losers = totals.losers;

  return (
    <div className="shrink-0 border-b border-line">
      <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4 xl:grid-cols-7">
        <StatTile
          label="Realized"
          value={signedSol(totals.realizedSol)}
          sub={approxUsd(totals.realizedSol, solPriceUsd) ?? 'USD unavailable'}
          tone={toneOf(totals.realizedSol)}
          title={`Realized PnL over sells with a known cost basis · USD ${usdNote}`}
        />
        <StatTile
          label="Unrealized"
          value={totals.unrealizedSol === undefined ? <Dash /> : signedSol(totals.unrealizedSol)}
          sub={
            totals.unrealizedSol === undefined
              ? openPositions > 0
                ? `${pricedOpen}/${openPositions} open priced`
                : 'no open positions'
              : `${approxUsd(totals.unrealizedSol, solPriceUsd) ?? 'USD unavailable'}${openPositions > pricedOpen ? ` · ${pricedOpen}/${openPositions} priced` : ''}`
          }
          tone={toneOf(totals.unrealizedSol)}
          title={`Open positions at current Jupiter prices ÷ SOL price · USD ${usdNote}`}
        />
        <StatTile
          label="Win rate"
          value={totals.winRatePct === undefined ? <Dash /> : formatPct(totals.winRatePct, { signed: false, decimals: 1 })}
          sub={winners + losers > 0 ? `${winners + losers} closed with known basis` : 'no closed trades yet'}
          title="Winners ÷ (winners + losers), counting only tokens with a complete cost basis"
        />
        <StatTile
          label="W / L"
          value={
            <>
              <span className="text-up">{winners}</span>
              <span className="text-faint"> / </span>
              <span className="text-down">{losers}</span>
            </>
          }
          sub={`${report.tokens.length} token${report.tokens.length === 1 ? '' : 's'} traded`}
        />
        <StatTile label="Trades" value={totals.trades} sub={`${window.swapsCounted} buys/sells counted`} />
        <StatTile label="Volume" value={formatSol(totals.volumeSol)} sub={approxUsd(totals.volumeSol, solPriceUsd) ?? 'USD unavailable'} title={`SOL moved through buys and sells · USD ${usdNote}`} />
        <StatTile
          label="Avg hold"
          value={totals.avgHoldSeconds === undefined ? <Dash /> : formatDuration(totals.avgHoldSeconds)}
          sub="FIFO matched sells"
          title="Average holding time of sold units, matched FIFO"
        />
      </div>

      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-panel px-3 py-1 text-2xs text-muted">
        <span className="tabular">
          Based on <span className="text-fg-dim">{window.transactionsAnalyzed}</span> transaction{window.transactionsAnalyzed === 1 ? '' : 's'} across {coverage.pages} page
          {coverage.pages === 1 ? '' : 's'}
          {window.from !== undefined && window.to !== undefined && (
            <span className="hidden sm:inline">
              {' '}
              · {formatDateTime(window.from)} → {formatDateTime(window.to)}
            </span>
          )}
        </span>
        <span aria-hidden className="text-faint">
          ·
        </span>
        {window.historyComplete ? (
          <span className="text-fg-dim">Complete history</span>
        ) : (
          <span className="text-warn">History incomplete</span>
        )}
        <span aria-hidden className="text-faint">
          ·
        </span>
        <span title="Method">FIFO · SOL-denominated · USD {usdNote}</span>
        <span className="ml-auto flex items-center gap-2">
          {analyzing ? (
            <span className="inline-flex items-center gap-1 text-fg-dim">
              <RotateCw aria-hidden className="size-3 motion-safe:animate-spin" strokeWidth={1.75} />
              Analyzing · page {pagesLoaded + 1} of {target}
            </span>
          ) : infinite.isError ? (
            <span className="text-warn" title={describeError(infinite.error)}>
              Fetching more history failed
            </span>
          ) : null}
          {canAnalyzeMore && !analyzing && (
            <button type="button" onClick={analyzeMore} className={BTN} title={`Load ${PNL_MORE_PAGES} more pages (up to ${PNL_MAX_PAGES})`}>
              Analyze more
            </button>
          )}
          {!canAnalyzeMore && !window.historyComplete && pagesLoaded >= PNL_MAX_PAGES && <span title={`Capped at ${PNL_MAX_PAGES} pages`}>Analysis cap reached</span>}
        </span>
      </div>
    </div>
  );
}
