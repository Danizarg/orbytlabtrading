'use client';

import { Maximize2, RotateCcw, SkipForward } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { PriceChart } from '@/components/chart/PriceChart';
import { scaleCandles } from '@/components/chart/format';
import { cn } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/EmptyState';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import { Skeleton } from '@/components/ui/Skeleton';
import { useCandles, type PriceObservation } from '@/data/hooks/useCandles';
import type { QuotePrice } from '@/data/hooks/useQuotePrice';
import type { TradeFeed } from '@/data/hooks/useTrades';
import type { LiveTick } from '@/lib/analytics/candles';
import { formatTime } from '@/lib/core/format';
import { shortAddress } from '@/lib/core/solana';
import type { PoolInfo, Trade } from '@/lib/core/types';
import { fallbackNote } from '@/lib/onchain/candleFallback';
import { describeAttempt, errorLines, INTERVAL_LABELS, isLiveFreshness, isSolQuoted, visibleFailures } from '@/lib/services/token';
import { Chip, ErrorLines, Pane, QuotePriceNote, SourceLine, UpdatedAgo } from './parts';
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
  price: 'last bar follows the token price (10 s poll)',
} as const;

/**
 * Chart panel (lightweight-charts is loaded on demand inside PriceChart):
 * interval bar, Price / MC and USD / SOL toggles, log scale,
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
  curveTickSol,
  rowPrice,
  aggregateTicks,
  poolIndexed,
  solUsd,
  quotePrice,
  className,
}: {
  mint: string;
  pool?: PoolInfo;
  /** The charted pool is listed by an aggregator (native candles exist upstream). */
  poolIndexed: boolean;
  hasPool: boolean | undefined;
  supply?: number;
  trades: readonly Trade[];
  feed?: TradeFeed;
  tradesEnabled: boolean;
  curveTick?: LiveTick;
  /** The bonding-curve read priced in SOL (SOL-quoted curves). */
  curveTickSol?: LiveTick;
  /** Token row price (Jupiter / ORBYT route) used as the live tick. */
  rowPrice?: PriceObservation;
  /** Token-level prices may move the last bar (false for a user-pinned pool). */
  aggregateTicks: boolean;
  solUsd?: number;
  /** USD price of a non-SOL, non-stable quote asset: trades on such a pool are valued with it. */
  quotePrice?: QuotePrice;
  className?: string;
}) {
  // Saved interval / currency apply after mount; wait for them before fetching candles.
  const settingsReady = useTradeSettings((s) => s.hydrated);
  const interval = useTradeSettings((s) => s.interval);
  const setInterval = useTradeSettings((s) => s.setInterval);
  const chartMode = useTradeSettings((s) => s.chartMode);
  const setChartMode = useTradeSettings((s) => s.setChartMode);
  const currencyPref = useTradeSettings((s) => s.currency);
  const setCurrency = useTradeSettings((s) => s.setCurrency);
  const logScale = useTradeSettings((s) => s.logScale);
  const setLogScale = useTradeSettings((s) => s.setLogScale);
  const [fitSignal, setFitSignal] = useState(0);
  const [realtimeSignal, setRealtimeSignal] = useState(0);
  const [autoscaleSignal, setAutoscaleSignal] = useState(0);

  const c = useCandles({
    mint,
    // GeckoTerminal is only asked for indexed pools; ORBYT's route resolves a pool itself.
    pool: poolIndexed ? pool?.address : undefined,
    hasPool,
    interval,
    currency: currencyPref,
    quoteIsSol: isSolQuoted(pool),
    solUsd,
    trades,
    tradeSolPrices: feed?.solPrices,
    tradesEnabled,
    tradesRealtime: feed?.realtime ?? false,
    tradesFreshness: feed?.freshness,
    tradesFetchedAt: feed?.fetchedAt,
    curveTick,
    curveTickSol,
    rowPrice,
    aggregateTicks,
    onchain: feed?.onchain,
    poolCreatedAt: pool?.createdAt,
    enabled: settingsReady,
  });

  const mcMode = chartMode === 'mc' && supply !== undefined;
  const candles = useMemo(() => (mcMode && supply !== undefined ? scaleCandles(c.candles, supply) : c.candles), [c.candles, mcMode, supply]);
  const seriesKey = `${mint}|${c.pool ?? ''}|${interval}|${c.kind ?? ''}`;

  const derivedTrades = c.derivation?.trades ?? 0;
  const derivedTooFew = c.kind === 'trades' && derivedTrades < 2;
  // Held trades the bars could not use (no USD price yet).
  const unpricedTrades = c.kind === 'trades' ? Math.max(0, trades.length - derivedTrades) : 0;
  const showChart = c.available && !derivedTooFew && candles.length > 0;
  const loading = c.isPending && !candles.length;
  // Trade-built bars depend on the trade feed: its failure (e.g. the on-chain feed could not read the chain) is the chart's too.
  const tradeFeedFailures = c.kind === 'trades' && feed ? visibleFailures(feed.attempts) : [];
  const attempts = c.kind === 'trades' && feed ? [...feed.attempts, ...c.attempts] : c.attempts;

  let empty: ReactNode = null;
  if (!c.available) {
    empty = <EmptyState title={`${INTERVAL_LABELS[interval]} candles unavailable`}>{c.reason}</EmptyState>;
  } else if (derivedTooFew && derivedTrades === 0 && tradeFeedFailures.length > 0) {
    empty = (
      <EmptyState title="Trades unavailable" tone="error">
        <ErrorLines lines={tradeFeedFailures.map(describeAttempt)} className="text-left" />
      </EmptyState>
    );
  } else if (derivedTooFew && unpricedTrades > 0 && c.currency === 'usd') {
    // Trades are in hand but none can be valued yet (e.g. the pool's quote asset has no USD price): say so, not "0 trades".
    empty = (
      <EmptyState title="Waiting for a USD price">
        {trades.length} trade{trades.length === 1 ? '' : 's'} received; {derivedTrades} with a USD price.
        {pool?.quoteSymbol && !isSolQuoted(pool) ? ` This pool is quoted in ${pool.quoteSymbol}: bars are drawn once ${pool.quoteSymbol}'s USD price is known.` : ' Bars are drawn once the trades can be valued in USD.'}
      </EmptyState>
    );
  } else if (derivedTooFew) {
    empty = (
      <EmptyState title="Waiting for trades">
        {c.fallback ? 'No indexed candles for this pool yet' : `No native ${INTERVAL_LABELS[interval]} source`}: these candles are built from this pool&apos;s
        {c.fromOnchain ? ' on-chain' : ''} trades. {derivedTrades} trade{derivedTrades === 1 ? '' : 's'}
        {c.currency === 'sol' ? ' with a SOL leg' : ''} received so far; at least 2 are needed to draw a bar.
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

  // LIVE only for on-chain / realtime inputs: the curve read, or a realtime (not merely 'fast') trade feed.
  // Trade-built bars move with every trade of a realtime feed.
  const live = c.liveSource === 'curve' || ((c.liveSource === 'trades' || c.kind === 'trades') && isLiveFreshness(feed?.freshness));

  return (
    // The body must be a flex column: the canvas area takes the height left by the toolbar and the source line.
    <Pane className={className} bodyClassName="flex flex-col">
      <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-2 scrollbar-none">
        <div role="group" aria-label="Interval" className="flex items-center gap-0.5">
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
          <Chip active={c.currency === 'usd'} onClick={() => setCurrency('usd')} title="Prices and volume in USD">
            USD
          </Chip>
          <Chip
            active={c.currency === 'sol'}
            disabled={!c.currencyOption.available}
            onClick={() => setCurrency('sol')}
            title={c.currencyOption.reason}
          >
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
          {c.loadingOlder && <span className="text-2xs text-faint">{c.kind === 'trades' ? 'Loading older trades…' : 'Loading history…'}</span>}
          <FreshnessBadge
            updatedAt={c.fetchedAt}
            live={live}
            liveWindowMs={c.liveSource === 'curve' ? 8_000 : 15_000}
            error={c.error !== undefined && !candles.length ? 'Candles unavailable' : undefined}
            stale={c.delayed}
          />
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        {c.available && !derivedTooFew && (
          // PriceChart's root is `relative` and cn() does not merge conflicting utilities, so an
          // `absolute inset-0` class on it would lose to `relative` and collapse the chart: position a wrapper.
          <div className={cn('absolute inset-0', !showChart && 'invisible')}>
            <PriceChart
              candles={candles}
              intervalSec={c.intervalSec}
              seriesKey={seriesKey}
              mode={mcMode ? 'mc' : 'price'}
              currency={c.currency}
              logScale={logScale}
              fitSignal={fitSignal}
              realtimeSignal={realtimeSignal}
              autoscaleSignal={autoscaleSignal}
              onNeedHistory={c.hasMore ? c.loadOlder : undefined}
              className="h-full w-full"
            />
          </div>
        )}
        {loading && !empty && (
          <div aria-busy="true" className="absolute inset-0 flex items-end gap-1 px-4 pb-8">
            <span className="sr-only">Loading chart</span>
            {Array.from({ length: 28 }, (_, i) => (
              <Skeleton key={i} className="flex-1" style={{ height: `${25 + ((i * 37) % 55)}%` }} />
            ))}
          </div>
        )}
        {empty && <div className="absolute inset-0 flex items-center justify-center bg-panel">{empty}</div>}
      </div>

      <SourceLine
        // Trade-built bars are attributed to the trade feed that supplied the trades.
        source={c.kind === 'trades' ? feed?.source : c.source}
        fetchedAt={undefined}
        attempts={attempts}
        notes={c.notes}
        className="h-6 shrink-0 flex-nowrap overflow-hidden border-t border-line py-0"
        extra={
          <>
            {c.kind === 'trades' && c.derivation && (
              <span className="text-fg-dim">
                Built from {c.derivation.trades} {c.fromOnchain ? 'on-chain' : 'real'} trade{c.derivation.trades === 1 ? '' : 's'} since {formatTime(c.derivation.from)}
              </span>
            )}
            {c.kind === 'trades' && c.missedTrades > 0 && (
              <span className="text-warn" title="The pool traded faster than the RPC budget allows while the log stream was silent: bars miss those trades">
                subset: {c.missedTrades} listed transaction{c.missedTrades === 1 ? '' : 's'} not loaded
              </span>
            )}
            {c.kind === 'trades' && c.fallback && <span>{fallbackNote(c.fallback)}</span>}
            {c.kind !== 'trades' && c.source && <span>OHLCV</span>}
            {c.currency === 'sol' && <span>in SOL</span>}
            {c.kind === 'trades' && c.currency === 'usd' && <QuotePriceNote quote={quotePrice} />}
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
