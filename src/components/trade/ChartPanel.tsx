'use client';

import { Maximize2, RotateCcw, SkipForward } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { PriceChart } from '@/components/chart/PriceChart';
import { scaleCandles } from '@/components/chart/format';
import { cn } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/EmptyState';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import { Skeleton } from '@/components/ui/Skeleton';
import { useCandles } from '@/data/hooks/useCandles';
import type { TradeFeed } from '@/data/hooks/useTrades';
import type { LiveTick } from '@/lib/analytics/candles';
import { formatTime } from '@/lib/core/format';
import { shortAddress } from '@/lib/core/solana';
import type { PoolInfo, Trade } from '@/lib/core/types';
import { errorLines, INTERVAL_LABELS, isGecko, providerLabel } from '@/lib/services/token';
import { Chip, ErrorLines, Pane, SourceLine, UpdatedAgo } from './parts';
import { useTradeSettings } from './tradeSettings';

function Divider() {
  return <span aria-hidden className="mx-1 h-4 w-px bg-line" />;
}

function ToolButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn('inline-flex size-6 items-center justify-center rounded transition-colors', active ? 'bg-brand-soft text-brand-strong' : 'text-muted hover:bg-hover hover:text-fg')}
    >
      {children}
    </button>
  );
}

const LIVE_TEXT = {
  trades: 'last bar ticks per trade',
  curve: 'last bar follows the on-chain curve price (3 s)',
  price: 'last bar follows Jupiter price (10 s)',
} as const;

/**
 * Chart panel: interval bar, Price / MC and USD / SOL toggles, log scale,
 * fit / auto-scale / go-to-realtime, the Lightweight Charts canvas and a
 * provenance line. Candles come from useCandles (never synthetic).
 */
export function ChartPanel({
  mint,
  pool,
  hasPool,
  supply,
  trades,
  feed,
  tradesEnabled,
  curveTick,
  className,
}: {
  mint: string;
  pool?: PoolInfo;
  hasPool: boolean | undefined;
  supply?: number;
  trades: readonly Trade[];
  feed?: TradeFeed;
  tradesEnabled: boolean;
  curveTick?: LiveTick;
  className?: string;
}) {
  const interval = useTradeSettings((s) => s.interval);
  const setInterval = useTradeSettings((s) => s.setInterval);
  const chartMode = useTradeSettings((s) => s.chartMode);
  const setChartMode = useTradeSettings((s) => s.setChartMode);
  const logScale = useTradeSettings((s) => s.logScale);
  const setLogScale = useTradeSettings((s) => s.setLogScale);
  const [fitSignal, setFitSignal] = useState(0);
  const [realtimeSignal, setRealtimeSignal] = useState(0);
  const [autoscaleSignal, setAutoscaleSignal] = useState(0);

  const c = useCandles({
    mint,
    pool: pool?.address,
    hasPool,
    interval,
    trades,
    tradesEnabled,
    tradesRealtime: feed?.realtime ?? false,
    tradesFreshness: feed?.freshness,
    tradesFetchedAt: feed?.fetchedAt,
    curveTick,
  });

  const mcMode = chartMode === 'mc' && supply !== undefined;
  const candles = useMemo(() => (mcMode && supply !== undefined ? scaleCandles(c.candles, supply) : c.candles), [c.candles, mcMode, supply]);
  const seriesKey = `${mint}|${c.pool ?? ''}|${interval}|${c.kind ?? ''}`;

  const derivedTooFew = c.kind === 'trades' && (c.derivation?.trades ?? 0) < 2;
  const showChart = c.available && !derivedTooFew && candles.length > 0;
  const loading = c.isPending && !candles.length;

  let empty: ReactNode = null;
  if (!c.available) {
    empty = <EmptyState title={`${INTERVAL_LABELS[interval]} candles unavailable`}>{c.reason}</EmptyState>;
  } else if (derivedTooFew) {
    empty = (
      <EmptyState title="Waiting for trades">
        {INTERVAL_LABELS[interval]} candles are built by ORBYT from real trades of this pool. {c.derivation?.trades ?? 0} trade{(c.derivation?.trades ?? 0) === 1 ? '' : 's'} so far; at least
        two are needed. Nothing is simulated.
      </EmptyState>
    );
  } else if (hasPool === false && !c.kind) {
    empty = <EmptyState title="No pool indexed yet">Charts start once DEX Screener or GeckoTerminal indexes a pool for this token.</EmptyState>;
  } else if (!loading && !candles.length && c.error !== undefined) {
    empty = (
      <EmptyState title="Candles unavailable" tone="error">
        <ErrorLines lines={errorLines(c.error)} className="text-left" />
      </EmptyState>
    );
  } else if (!loading && !candles.length && c.kind) {
    empty = <EmptyState title="No candles for this range">The provider returned no candles for this pool yet.</EmptyState>;
  }

  const live = c.liveSource === 'trades' || c.liveSource === 'curve';

  return (
    <Pane className={className}>
      <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-2 scrollbar-none">
        <div role="tablist" aria-label="Interval" className="flex items-center gap-0.5">
          {c.options.map((o) => (
            <Chip
              key={o.interval}
              active={o.interval === interval}
              disabled={!o.available}
              onClick={() => setInterval(o.interval)}
              title={o.reason}
              ariaPressed={o.interval === interval}
            >
              {INTERVAL_LABELS[o.interval]}
              {o.kind === 'trades' && <span aria-hidden className="size-1 rounded-full bg-brand" title="Built from real trades" />}
            </Chip>
          ))}
        </div>
        <Divider />
        <div role="group" aria-label="Scale" className="flex items-center gap-0.5">
          <Chip active={!mcMode} onClick={() => setChartMode('price')} title="Price per token">
            Price
          </Chip>
          <Chip
            active={mcMode}
            disabled={supply === undefined}
            onClick={() => setChartMode('mc')}
            title={supply === undefined ? 'Market cap needs the on-chain supply' : 'Market cap = price × on-chain supply'}
          >
            MC
          </Chip>
        </div>
        <Divider />
        <div role="group" aria-label="Currency" className="flex items-center gap-0.5">
          <Chip active title="Candles in USD">
            USD
          </Chip>
          <Chip disabled title={pool?.quoteSymbol === 'SOL' ? 'Native SOL candles need the GeckoTerminal currency=token option (pending)' : 'Pool quote is not SOL'}>
            SOL
          </Chip>
        </div>
        <Divider />
        <Chip active={logScale} onClick={() => setLogScale(!logScale)} title={logScale ? 'Logarithmic scale (click for linear)' : 'Linear scale (click for log)'}>
          Log
        </Chip>
        <ToolButton label="Fit all bars" onClick={() => setFitSignal((n) => n + 1)}>
          <Maximize2 aria-hidden className="size-3.5" />
        </ToolButton>
        <ToolButton label="Reset price auto-scale" onClick={() => setAutoscaleSignal((n) => n + 1)}>
          <RotateCcw aria-hidden className="size-3.5" />
        </ToolButton>
        <ToolButton label="Go to realtime" onClick={() => setRealtimeSignal((n) => n + 1)}>
          <SkipForward aria-hidden className="size-3.5" />
        </ToolButton>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          {c.loadingOlder && <span className="text-2xs text-faint">Loading history…</span>}
          <FreshnessBadge updatedAt={c.fetchedAt} live={live} liveWindowMs={c.liveSource === 'curve' ? 8_000 : 15_000} error={c.error !== undefined && !candles.length ? 'Candles unavailable' : undefined} />
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        {c.available && !derivedTooFew && (
          <PriceChart
            candles={candles}
            intervalSec={c.intervalSec}
            seriesKey={seriesKey}
            mode={mcMode ? 'mc' : 'price'}
            logScale={logScale}
            fitSignal={fitSignal}
            realtimeSignal={realtimeSignal}
            autoscaleSignal={autoscaleSignal}
            onNeedHistory={c.hasMore ? c.loadOlder : undefined}
            className={cn('absolute inset-0', !showChart && 'invisible')}
          />
        )}
        {loading && !empty && (
          <div aria-busy="true" className="absolute inset-0 flex items-end gap-1 px-4 pb-8">
            <span className="sr-only">Loading chart</span>
            {Array.from({ length: 28 }, (_, i) => (
              <Skeleton key={i} className="flex-1" style={{ height: `${25 + ((i * 37) % 55)}%` } as never} />
            ))}
          </div>
        )}
        {empty && <div className="absolute inset-0 flex items-center justify-center bg-panel">{empty}</div>}
      </div>

      <SourceLine
        source={c.source}
        fetchedAt={undefined}
        attempts={c.attempts}
        notes={c.notes}
        className="h-6 shrink-0 flex-nowrap overflow-hidden border-t border-line py-0"
        extra={
          <>
            {c.kind === 'trades' && c.derivation && (
              <span className="text-fg-dim">
                Built from {c.derivation.trades} real trade{c.derivation.trades === 1 ? '' : 's'} since {formatTime(c.derivation.from)}
              </span>
            )}
            {c.kind !== 'trades' && c.source && <span>{isGecko(c.source) ? 'GeckoTerminal OHLCV' : `${providerLabel(c.source)} candles`}</span>}
            {pool && (
              <span title={pool.address}>
                {pool.dexLabel} pool {shortAddress(pool.address)}
              </span>
            )}
            <UpdatedAgo at={c.fetchedAt} />
            {c.liveSource && <span>{LIVE_TEXT[c.liveSource]}</span>}
            {c.kind === 'trades' && feed && (feed.realtime ? <span>live trade feed</span> : <span>trade feed ~30 s delayed</span>)}
          </>
        }
      />
    </Pane>
  );
}
