'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { Tabs } from '@/components/ui/Tabs';
import { useHolders } from '@/data/hooks/useHolders';
import { useRisk } from '@/data/hooks/useRisk';
import { useTokenOverview } from '@/data/hooks/useTokenOverview';
import { useTrades } from '@/data/hooks/useTrades';
import type { LiveTick } from '@/lib/analytics/candles';
import { formatCompact } from '@/lib/core/format';
import type { HolderSnapshot, RiskReport, Sourced } from '@/lib/core/types';
import { onchainHeaderPrice } from '@/lib/onchain/headerPrice';
import { chainWinner, curveMarketCapUsd, curvePriceUsd, curveQuoteSymbol, errorLines, isIndexedPool, parsePoolParam } from '@/lib/services/token';
import { ChartPanel } from './ChartPanel';
import { HoldersPanel } from './HoldersPanel';
import { InfoPanel } from './InfoPanel';
import { LaunchpadCard } from './LaunchpadCard';
import { ErrorLines, Pane } from './parts';
import { PoolsPanel } from './PoolsPanel';
import { RiskCard } from './RiskCard';
import { StatsGrid } from './StatsGrid';
import { TokenHeader } from './TokenHeader';
import { TradePanel } from './TradePanel';
import { TradesTable } from './TradesTable';
import { rehydrateTradeSettings } from './tradeSettings';

type Tab = 'trades' | 'holders' | 'pools' | 'info';

/**
 * /trade/[mint]: header strip, chart + tabs on the left, Axiom-style trade
 * panel, stats, audit and launchpad cards on the right. Every panel has its
 * own error boundary so one failing source never blanks the page. Below
 * 1024 px the grid stacks: chart, trade panel, tabs, stats, audit, launchpad.
 */
export function TradePage({ mint }: { mint: string }) {
  const searchParams = useSearchParams();
  const poolParam = parsePoolParam(searchParams.get('pool'));
  const t = useTokenOverview(mint, { pool: poolParam });
  const pool = t.primaryPool;
  const poolIndexed = isIndexedPool(pool);
  // A live pump.fun curve: its trades decode straight from the program logs (the curve PDA is the pool).
  const pumpCurve = pool?.dex === 'pumpfun' && pool.isBondingCurve === true && !t.frozenPools.has(pool.address) && t.curve?.complete !== true;
  const tradesState = useTrades(mint, pool?.address, { indexed: poolIndexed, pumpCurve, solUsd: t.solUsd, supply: t.supply });
  const [tab, setTab] = useState<Tab>('trades');

  // Saved trade-panel / chart preferences apply after mount so SSR and hydration markup match.
  useEffect(() => rehydrateTradeSettings(), []);

  const geckoInfo = t.queries.info.data;
  const geckoRisk = useMemo<Sourced<RiskReport> | undefined>(() => (geckoInfo ? { ...geckoInfo, data: geckoInfo.data.risk } : undefined), [geckoInfo]);
  const geckoHolders = useMemo<Sourced<HolderSnapshot> | undefined>(() => (geckoInfo ? { ...geckoInfo, data: geckoInfo.data.holders } : undefined), [geckoInfo]);
  const risk = useRisk(mint, { gecko: geckoRisk, geckoError: t.queries.info.error, mintInfo: t.mintInfo });
  const holders = useHolders(mint, { summary: geckoHolders, summaryError: t.queries.info.error });

  const liveCurve = t.curve && !t.curve.complete ? t.curve : undefined;
  const curvePrice = liveCurve ? curvePriceUsd(liveCurve, t.solUsd) : undefined;
  const curvePriceSol = liveCurve && curveQuoteSymbol(liveCurve) === 'SOL' ? liveCurve.priceQuote : undefined;
  const curveAt = t.curveFetchedAt;
  const curveTick = useMemo<LiveTick | undefined>(
    () => (curvePrice !== undefined && curveAt !== undefined ? { timeSec: Math.floor(curveAt / 1000), price: curvePrice } : undefined),
    [curvePrice, curveAt],
  );
  const curveTickSol = useMemo<LiveTick | undefined>(
    () => (curvePriceSol !== undefined && curvePriceSol > 0 && curveAt !== undefined ? { timeSec: Math.floor(curveAt / 1000), price: curvePriceSol } : undefined),
    [curvePriceSol, curveAt],
  );
  // No market provider prices the token yet (seconds old): the newer of the on-chain curve read and the last on-chain trade.
  const curveMc = liveCurve ? curveMarketCapUsd(liveCurve, t.solUsd) : undefined;
  const tradesList = tradesState.trades;
  const supply = t.supply;
  const onchainPrice = useMemo(
    () => onchainHeaderPrice({ curve: { priceUsd: curvePrice, marketCapUsd: curveMc, at: curveAt }, trades: tradesList, supply }),
    [curvePrice, curveMc, curveAt, tradesList, supply],
  );
  const marketPriced = t.market?.priceUsd !== undefined;
  const priceUsd = t.market?.priceUsd ?? onchainPrice?.priceUsd;
  // Native candles need the charted pool to be indexed upstream (a curve decoded only on-chain has no OHLCV yet).
  const poolsAnswered = t.queries.pools.data !== undefined || t.queries.pools.isError;
  const hasPool = poolsAnswered ? poolIndexed : undefined;
  // The token row's price doubles as the chart's live tick when Jupiter or ORBYT's route answered it (10 s poll),
  // so the chart does not spend a second Jupiter request on the same price.
  const rowWinner = chainWinner(t.queries.row.data);
  const rowPriceUsd = t.market?.priceUsd;
  const rowFetchedAt = t.fetchedAt;
  const rowPrice = useMemo(
    () => ((rowWinner === 'jupiter' || rowWinner === 'orbyt') && rowPriceUsd !== undefined && rowPriceUsd > 0 && rowFetchedAt !== undefined ? { price: rowPriceUsd, at: rowFetchedAt } : undefined),
    [rowWinner, rowPriceUsd, rowFetchedAt],
  );

  if (t.isMint === false && t.listed === false) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState title="Not a token mint" tone="warn">
          <p>{mint}</p>
          <p className="mt-1">The address is not a token mint on Solana mainnet, and no market data source lists it.</p>
          <ErrorLines lines={[t.queries.mintInfo.error, t.error].filter((e) => e != null).flatMap(errorLines)} className="mt-2 text-left" />
        </EmptyState>
      </div>
    );
  }

  const tabs = [
    { value: 'trades' as const, label: 'Trades', badge: tradesState.trades.length ? <Badge>{formatCompact(tradesState.trades.length)}</Badge> : undefined },
    { value: 'holders' as const, label: 'Holders', badge: holders.snapshot?.totalHolders !== undefined ? <Badge>{formatCompact(holders.snapshot.totalHolders)}</Badge> : undefined },
    { value: 'pools' as const, label: 'Pools', badge: t.pools.length ? <Badge>{t.pools.length}</Badge> : undefined },
    { value: 'info' as const, label: 'Info' },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:h-[calc(100dvh-var(--shell-header-h)-var(--shell-footer-h))] lg:overflow-hidden">
      <ErrorBoundary label="Token header" resetKeys={[mint]}>
        <TokenHeader
          state={t}
          priceUsd={priceUsd}
          priceSource={marketPriced ? undefined : onchainPrice?.label}
          fallbackMarketCapUsd={t.market?.marketCapUsd === undefined ? onchainPrice?.marketCapUsd : undefined}
        />
      </ErrorBoundary>
      {t.listed === false && t.isMint && (
        <p className="border-b border-line bg-warn-soft px-3 py-1 text-2xs text-warn">
          Not listed by Jupiter, GeckoTerminal or DEX Screener yet. Showing on-chain data{t.curve ? ' and the pump.fun bonding curve' : ''} only.
        </p>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-line lg:grid-cols-[minmax(0,1fr)_336px] lg:grid-rows-[minmax(0,3fr)_minmax(0,2fr)]">
        <ErrorBoundary label="Chart" resetKeys={[mint]} className="order-1 flex min-h-[380px] items-center justify-center bg-panel lg:col-start-1 lg:row-start-1 lg:min-h-0">
          <ChartPanel
            mint={mint}
            pool={pool}
            poolIndexed={poolIndexed}
            hasPool={hasPool}
            supply={t.supply}
            trades={tradesState.trades}
            feed={tradesState.feed}
            tradesEnabled={tradesState.enabled}
            curveTick={curveTick}
            curveTickSol={curveTickSol}
            rowPrice={rowPrice}
            aggregateTicks={!t.poolOverridden}
            solUsd={t.solUsd}
            className="order-1 min-h-[380px] lg:col-start-1 lg:row-start-1 lg:min-h-0"
          />
        </ErrorBoundary>

        <Pane
          className="order-3 min-h-[420px] lg:col-start-1 lg:row-start-2 lg:min-h-0"
          headClassName="px-2"
          title={<Tabs items={tabs} value={tab} onChange={setTab} size="xs" ariaLabel="Token details" className="-ml-1 normal-case tracking-normal" />}
          bodyClassName="flex min-h-0 flex-col"
        >
          <ErrorBoundary label="Token details" resetKeys={[mint, tab]}>
            {tab === 'trades' && (
              <TradesTable
                trades={tradesState.trades}
                feed={tradesState.feed}
                supply={t.supply}
                error={tradesState.error}
                isPending={tradesState.isPending}
                enabled={tradesState.enabled}
                poolsPending={!poolsAnswered}
                quoteSymbol={pool?.quoteSymbol}
              />
            )}
            {tab === 'holders' && <HoldersPanel holders={holders} />}
            {tab === 'pools' && <PoolsPanel mint={mint} pools={t.pools} primary={pool} frozen={t.frozenPools} overridden={t.poolOverridden} query={t.queries.pools} />}
            {tab === 'info' && <InfoPanel state={t} />}
          </ErrorBoundary>
        </Pane>

        <aside className="contents bg-line lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:flex lg:min-h-0 lg:flex-col lg:gap-px lg:overflow-y-auto" aria-label="Trade and token details">
          <ErrorBoundary label="Trade panel" resetKeys={[mint]} className="order-2 flex min-h-32 items-center justify-center bg-panel lg:order-none">
            <TradePanel mint={mint} symbol={t.meta.symbol} decimals={t.meta.decimals} priceUsd={priceUsd} className="order-2 lg:order-none" />
          </ErrorBoundary>
          <ErrorBoundary label="Stats" resetKeys={[mint]} className="order-4 flex min-h-24 items-center justify-center bg-panel lg:order-none">
            <StatsGrid market={t.market} loading={t.queries.row.isPending} className="order-4 shrink-0 lg:order-none" />
          </ErrorBoundary>
          <ErrorBoundary label="Audit" resetKeys={[mint]} className="order-5 flex min-h-24 items-center justify-center bg-panel lg:order-none">
            <RiskCard
              risk={risk.risk}
              fetchedAt={risk.fetchedAt}
              freshness={risk.freshness}
              attempts={risk.attempts}
              notes={risk.notes}
              error={risk.error}
              isPending={risk.isPending}
              authoritiesFromChain={t.mintInfo !== undefined}
              className="order-5 shrink-0 lg:order-none"
            />
          </ErrorBoundary>
          <ErrorBoundary label="Launchpad" resetKeys={[mint]} className="order-6 flex min-h-24 items-center justify-center bg-panel lg:order-none">
            <LaunchpadCard
              mint={mint}
              launchpad={t.launchpad}
              curve={t.curve}
              curveFetchedAt={t.curveFetchedAt}
              solUsd={t.solUsd}
              creator={t.meta.creator}
              pools={t.pools}
              className="order-6 shrink-0 lg:order-none"
            />
          </ErrorBoundary>
          <div aria-hidden className="hidden flex-1 bg-panel lg:block" />
        </aside>
      </div>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className={cn('rounded-sm bg-panel-3 px-1 text-2xs tabular text-muted')}>{children}</span>;
}
