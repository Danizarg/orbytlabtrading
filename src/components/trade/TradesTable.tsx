'use client';

import { memo, useMemo, useState } from 'react';
import { TxLink, WalletLink } from '@/components/ui/AddressLink';
import { cn } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/EmptyState';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import { Tabs } from '@/components/ui/Tabs';
import type { QuotePrice } from '@/data/hooks/useQuotePrice';
import type { TradeFeed } from '@/data/hooks/useTrades';
import { tradeUsdValue } from '@/lib/analytics/trades';
import { formatAmount, formatDateTime, formatPrice, formatUsd } from '@/lib/core/format';
import type { Trade } from '@/lib/core/types';
import { errorLines, filterTrades, isLiveFreshness, marketCapAtTrade, parseMinUsd, type TradeSideFilter } from '@/lib/services/token';
import { Age, Dash, ErrorLines, QuotePriceNote, SkeletonRows, SourceLine } from './parts';
import { ROW, TD, TD_NUM, TH, TH_NUM } from './tableStyles';

/** Rows rendered at once (the feed may hold more for the chart). */
const MAX_ROWS = 300;

const SIDE_TABS = [
  { value: 'all', label: 'All' },
  { value: 'buy', label: 'Buys' },
  { value: 'sell', label: 'Sells' },
] as const;

const TradeRow = memo(function TradeRow({ trade, fresh, supply, solColumn }: { trade: Trade; fresh: boolean; supply?: number; solColumn: boolean }) {
  const usd = tradeUsdValue(trade);
  const mc = marketCapAtTrade(trade, supply);
  const buy = trade.side === 'buy';
  // Adaptive decimals: a 0.00004 SOL trade must not round to "0". A SOL leg under another quote's column
  // (a trade routed from SOL into a GLDx pool) carries its unit.
  const quote =
    trade.solAmount !== undefined
      ? `${formatAmount(trade.solAmount)}${solColumn ? '' : ' SOL'}`
      : trade.quoteAmount !== undefined
        ? `${formatAmount(trade.quoteAmount)} ${trade.quoteSymbol ?? ''}`.trim()
        : undefined;
  // New rows slide in (row) and flash their value cells in the trade's direction.
  const flash = fresh ? (buy ? 'motion-safe:animate-flash-up' : 'motion-safe:animate-flash-down') : undefined;
  return (
    <tr className={cn(ROW, fresh && 'motion-safe:animate-slide-in')}>
      <td className={TD}>
        <Age from={trade.timestamp} title={formatDateTime(trade.timestamp)} className="text-muted" />
      </td>
      <td className={cn(TD, 'font-medium', buy ? 'text-up' : 'text-down')}>{buy ? 'Buy' : 'Sell'}</td>
      <td className={cn(TD_NUM, buy ? 'text-up' : 'text-down', flash)}>{trade.priceUsd === undefined ? <Dash /> : formatPrice(trade.priceUsd)}</td>
      <td className={TD_NUM}>{trade.tokenAmount === undefined ? <Dash /> : formatAmount(trade.tokenAmount, { maxDecimals: 2 })}</td>
      <td className={TD_NUM}>{quote ?? <Dash />}</td>
      <td className={cn(TD_NUM, 'text-fg', flash)}>{usd === undefined ? <Dash /> : formatUsd(usd)}</td>
      <td className={TD_NUM}>{mc === undefined ? <Dash /> : formatUsd(mc)}</td>
      <td className={TD}>{trade.wallet ? <WalletLink address={trade.wallet} /> : <Dash />}</td>
      <td className={cn(TD, 'text-right')}>
        <TxLink signature={trade.signature} />
      </td>
    </tr>
  );
});

export function TradesTable({
  trades,
  feed,
  supply,
  error,
  isPending,
  enabled,
  poolsPending = false,
  quoteSymbol,
  quotePrice,
}: {
  trades: readonly Trade[];
  feed?: TradeFeed;
  supply?: number;
  error: unknown;
  isPending: boolean;
  enabled: boolean;
  /** The pool list is still loading (the feed cannot start yet). */
  poolsPending?: boolean;
  quoteSymbol?: string;
  /** USD price of a non-SOL, non-stable quote asset: trades on such a pool are valued with it. */
  quotePrice?: QuotePrice;
}) {
  const [side, setSide] = useState<TradeSideFilter>('all');
  const [minUsdText, setMinUsdText] = useState('');
  const minUsd = parseMinUsd(minUsdText);
  const filtered = useMemo(() => filterTrades(trades, { side, minUsd }), [trades, side, minUsd]);
  const rows = filtered.length > MAX_ROWS ? filtered.slice(0, MAX_ROWS) : filtered;
  const fresh = feed?.fresh;
  const onchain = feed?.onchain;
  const solColumn = quoteSymbol === undefined || ['SOL', 'WSOL'].includes(quoteSymbol.toUpperCase());

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
        <Tabs items={SIDE_TABS} value={side} onChange={setSide} size="xs" ariaLabel="Trade side" />
        <label className="flex h-6 items-center gap-1 rounded bg-panel-2 px-1.5 text-2xs text-muted">
          Min $
          <input
            inputMode="decimal"
            aria-label="Minimum trade value in USD"
            placeholder="0"
            value={minUsdText}
            onChange={(e) => setMinUsdText(e.target.value.slice(0, 10))}
            className="w-12 bg-transparent text-right tabular text-fg-dim outline-none placeholder:text-faint"
          />
        </label>
        <span className="text-2xs tabular text-faint">
          {filtered.length}
          {filtered.length !== trades.length ? ` / ${trades.length}` : ''}
        </span>
        <span className="ml-auto">
          <FreshnessBadge
            updatedAt={feed?.fetchedAt}
            live={isLiveFreshness(feed?.freshness)}
            // The on-chain feed confirms itself at least every 8 s (reconciliation) even when nobody trades.
            liveWindowMs={onchain ? 12_000 : 8_000}
            error={error && !feed ? 'Trade feed unavailable' : undefined}
          />
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!enabled && poolsPending && <SkeletonRows rows={12} cols={7} />}
        {!enabled && !poolsPending && <EmptyState title="Waiting for a pool">Trades load once a pool or bonding curve is known for this token.</EmptyState>}
        {enabled && isPending && !trades.length && <SkeletonRows rows={12} cols={7} />}
        {enabled && !isPending && !trades.length && error !== undefined && (
          <EmptyState title="Trade feed unavailable" tone="error">
            <ErrorLines lines={errorLines(error)} className="text-left" />
          </EmptyState>
        )}
        {enabled && !isPending && !trades.length && error === undefined && feed && (
          <EmptyState title="No trades yet">{onchain ? 'No successful trade of this token on this pool on-chain yet.' : 'The provider has not indexed a trade for this pool.'}</EmptyState>
        )}
        {trades.length > 0 && (
          <table className="w-full min-w-[760px] table-fixed border-separate border-spacing-0">
            <caption className="sr-only">Recent trades, newest first</caption>
            <colgroup>
              <col className="w-14" />
              <col className="w-12" />
              <col className="w-24" />
              <col className="w-24" />
              <col className="w-20" />
              <col className="w-20" />
              <col className="w-20" />
              <col className="w-28" />
              <col className="w-16" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className={TH}>
                  Age
                </th>
                <th scope="col" className={TH}>
                  Side
                </th>
                <th scope="col" className={TH_NUM}>
                  Price
                </th>
                <th scope="col" className={TH_NUM}>
                  Amount
                </th>
                <th scope="col" className={TH_NUM}>
                  {quoteSymbol ?? 'SOL'}
                </th>
                <th scope="col" className={TH_NUM}>
                  USD
                </th>
                <th scope="col" className={TH_NUM} title="Market cap at execution (price × current supply when the provider reports none)">
                  MC
                </th>
                <th scope="col" className={TH}>
                  Wallet
                </th>
                <th scope="col" className={cn(TH, 'text-right')}>
                  Tx
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <TradeRow key={t.signature} trade={t} fresh={fresh?.has(t.signature) ?? false} supply={supply} solColumn={solColumn} />
              ))}
            </tbody>
          </table>
        )}
        {trades.length > 0 && !filtered.length && <EmptyState title="No trades match the filters" />}
      </div>
      {feed && (
        <SourceLine
          source={feed.source}
          contributors={feed.contributors}
          fetchedAt={feed.fetchedAt}
          freshness={feed.freshness}
          attempts={feed.attempts}
          notes={feed.notes}
          className="shrink-0 border-t border-line"
          extra={
            <>
              {onchain && (
                <span>
                  {feed.freshness === 'stream' ? (onchain.pumpCurve ? 'pump.fun trade events streamed from Solana logs' : 'streamed via Solana log subscription') : 'on-chain transactions'} · reconciled every 8 s
                </span>
              )}
              <QuotePriceNote quote={quotePrice} />
              {filtered.length > MAX_ROWS && <span>newest {MAX_ROWS} of {filtered.length} shown</span>}
            </>
          }
        />
      )}
    </div>
  );
}
