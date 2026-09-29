'use client';

import { ArrowUpRight, RotateCw } from 'lucide-react';
import Link from 'next/link';
import { memo } from 'react';
import { useNow } from '@/client/hooks/useNow';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/components/ui/cn';
import type { PortfolioView } from '@/data/hooks/usePortfolio';
import { formatAge, formatAmount, formatPct, formatPrice, formatUsd } from '@/lib/core/format';
import { PROVIDER_LABELS } from '@/lib/core/providers';
import { describeError } from '@/lib/net/errors';
import { MAX_PRICED_HOLDINGS, type Holding } from '@/lib/services/wallet';
import { Dash, TokenCell } from './cells';
import { BTN, FOOTER, TD, TD_STICKY, TH, TH_STICKY } from './styles';

const COLS: ReadonlyArray<{ id: string; label: string; width: string; align: 'left' | 'right' }> = [
  { id: 'token', label: 'Token', width: 'w-60', align: 'left' },
  { id: 'balance', label: 'Balance', width: 'w-32', align: 'right' },
  { id: 'price', label: 'Price', width: 'w-28', align: 'right' },
  { id: 'value', label: 'Value', width: 'w-28', align: 'right' },
  { id: 'share', label: 'Share', width: 'w-36', align: 'right' },
  { id: 'trade', label: '', width: 'w-16', align: 'right' },
];

function ShareBar({ pct }: { pct?: number }) {
  if (pct === undefined) return <Dash />;
  return (
    <span className="flex items-center justify-end gap-2" title={`${pct.toFixed(2)}% of the portfolio total`}>
      <span aria-hidden className="h-[3px] w-16 overflow-hidden rounded-full bg-line-strong">
        <span className="block h-full bg-brand" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </span>
      <span className="w-12 tabular text-fg-dim">{formatPct(pct, { signed: false, decimals: pct >= 10 ? 1 : 2 })}</span>
    </span>
  );
}

const HoldingRow = memo(function HoldingRow({ holding }: { holding: Holding }) {
  const { mint, amount, priceUsd, valueUsd, sharePct, symbol, name, image, decimals } = holding;
  return (
    <tr className="group h-8">
      <td className={TD_STICKY}>
        <TokenCell mint={mint} identity={{ mint, symbol, name, image, decimals }} />
      </td>
      <td className={cn(TD, 'text-right')}>
        <span className="tabular text-fg" title={`${amount.toLocaleString('en-US', { maximumFractionDigits: decimals })}${symbol ? ` ${symbol}` : ''}`}>
          {formatAmount(amount)}
        </span>
      </td>
      <td className={cn(TD, 'text-right')}>{priceUsd === undefined ? <Dash /> : <span className="tabular text-fg-dim">{formatPrice(priceUsd)}</span>}</td>
      <td className={cn(TD, 'text-right')}>
        {valueUsd === undefined ? (
          <span className="text-2xs text-faint" title="No reliable quote from Jupiter Price V3 right now">
            unpriced
          </span>
        ) : (
          <span className="tabular text-fg">{formatUsd(valueUsd)}</span>
        )}
      </td>
      <td className={cn(TD, 'text-right')}>
        <ShareBar pct={sharePct} />
      </td>
      <td className={cn(TD, 'text-right')}>
        <Link href={`/trade/${mint}`} prefetch={false} className="inline-flex items-center gap-0.5 text-2xs text-muted hover:text-brand-strong" title={`Open ${symbol ?? 'token'} on the trade page`}>
          Trade <ArrowUpRight aria-hidden className="size-3" strokeWidth={1.75} />
        </Link>
      </td>
    </tr>
  );
});

function SolRow({ sol, price, value, share }: { sol: number; price?: number; value?: number; share?: number }) {
  return (
    <tr className="group h-8">
      <td className={TD_STICKY}>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="flex size-5 items-center justify-center rounded-full bg-panel-3 text-2xs font-bold text-fg-dim">
            ◎
          </span>
          <span className="font-semibold text-fg">SOL</span>
          <span className="hidden text-2xs text-muted xl:inline">Native balance</span>
        </span>
      </td>
      <td className={cn(TD, 'text-right')}>
        <span className="tabular text-fg" title={`${sol.toLocaleString('en-US', { maximumFractionDigits: 9 })} SOL`}>
          {formatAmount(sol, { maxDecimals: 4 })}
        </span>
      </td>
      <td className={cn(TD, 'text-right')}>{price === undefined ? <Dash /> : <span className="tabular text-fg-dim">{formatPrice(price)}</span>}</td>
      <td className={cn(TD, 'text-right')}>{value === undefined ? <Dash /> : <span className="tabular text-fg">{formatUsd(value)}</span>}</td>
      <td className={cn(TD, 'text-right')}>
        <ShareBar pct={share} />
      </td>
      <td className={TD} />
    </tr>
  );
}

function SkeletonRow() {
  return (
    <tr className="h-8" aria-hidden>
      <td className={TD_STICKY}>
        <div className="flex items-center gap-2">
          <Skeleton className="size-5 rounded-full" />
          <Skeleton className="h-2.5 w-24" />
        </div>
      </td>
      {COLS.slice(1).map((c) => (
        <td key={c.id} className={TD}>
          {c.id !== 'trade' && <Skeleton className="ml-auto h-2.5 w-3/5" />}
        </td>
      ))}
    </tr>
  );
}

function Ago({ at }: { at?: number }) {
  const now = useNow();
  if (!at || !now) return <span>—</span>;
  return <span title={new Date(at).toLocaleString()}>{formatAge(at, now)} ago</span>;
}

/** Holdings tab: SOL plus every token balance, valued only from real quotes. */
export function HoldingsTable({ view }: { view: PortfolioView }) {
  const { query, portfolio, prices, identities, skippedPricing, pricingPending } = view;
  const result = query.data;
  const loading = query.isPending;
  const tokens = portfolio?.tokens ?? [];
  const solShare = portfolio?.totalUsd && portfolio.solValueUsd !== undefined && portfolio.totalUsd > 0 ? (portfolio.solValueUsd / portfolio.totalUsd) * 100 : undefined;

  let empty: React.ReactNode = null;
  if (query.isError && !result) {
    empty = (
      <EmptyState tone="error" title="Holdings unavailable">
        <p>{describeError(query.error)}</p>
        <button type="button" onClick={() => void query.refetch()} disabled={query.isFetching} className={`${BTN} mt-3`}>
          <RotateCw aria-hidden className={cn('size-3', query.isFetching && 'motion-safe:animate-spin')} strokeWidth={1.75} /> Retry
        </button>
      </EmptyState>
    );
  } else if (portfolio && tokens.length === 0) {
    empty = <EmptyState title="No token balances">This wallet holds {portfolio.sol > 0 ? 'only SOL' : 'nothing'} right now.</EmptyState>;
  }

  const sourceLabel = result ? (result.source === 'orbyt' ? 'Solana RPC via ORBYT API' : PROVIDER_LABELS[result.source]) : undefined;
  const priceSource = prices.data ? PROVIDER_LABELS[prices.data.source] : result?.contributors?.length ? PROVIDER_LABELS[result.contributors[0]!] : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1 overflow-auto" aria-busy={loading || undefined}>
        <table className="w-full min-w-[720px] table-fixed border-separate border-spacing-0 text-xs">
          <caption className="sr-only">Token holdings</caption>
          <colgroup>
            {COLS.map((c) => (
              <col key={c.id} className={c.width} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.id} scope="col" className={cn(c.id === 'token' ? TH_STICKY : TH, c.align === 'right' ? 'text-right' : 'text-left')}>
                  {c.label || <span className="sr-only">Open</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className={cn('transition-opacity duration-150', query.isPlaceholderData && 'opacity-60')}>
            {portfolio && <SolRow sol={portfolio.sol} price={portfolio.solPriceUsd} value={portfolio.solValueUsd} share={solShare} />}
            {tokens.map((h) => (
              <HoldingRow key={h.mint} holding={h} />
            ))}
            {loading && !portfolio && Array.from({ length: 8 }, (_, i) => <SkeletonRow key={i} />)}
          </tbody>
        </table>
        {empty && <div className="sticky left-0 w-full">{empty}</div>}
      </div>
      <footer className={FOOTER}>
        {portfolio ? (
          <span className="tabular">
            {tokens.length} token{tokens.length === 1 ? '' : 's'} · {portfolio.pricedCount} priced
            {portfolio.unpricedCount > 0 && <span className="text-faint"> · {portfolio.unpricedCount} unpriced</span>}
          </span>
        ) : (
          <span>{query.isError ? 'No data' : 'Loading'}</span>
        )}
        {sourceLabel && (
          <>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <span>
              Balances: <span className="text-fg-dim">{sourceLabel}</span> · <Ago at={result?.fetchedAt} />
            </span>
          </>
        )}
        {(priceSource || pricingPending) && (
          <>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <span>
              Prices: <span className="text-fg-dim">{priceSource ?? 'Jupiter'}</span>
              {prices.data && (
                <>
                  {' '}
                  · <Ago at={prices.data.fetchedAt} />
                </>
              )}
              {pricingPending && ' · loading'}
            </span>
          </>
        )}
        {prices.isError && (
          <>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <span className="text-warn" title={describeError(prices.error)}>
              Price refresh failed{prices.data ? ' · showing last quotes' : ''}
            </span>
          </>
        )}
        {skippedPricing > 0 && (
          <>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <span className="text-warn" title={`The browser prices at most ${MAX_PRICED_HOLDINGS} tokens per wallet; the rest stay unpriced`}>
              {skippedPricing} beyond the pricing budget
            </span>
          </>
        )}
        {identities.error !== undefined && identities.error !== null && (
          <>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <span className="text-warn" title={describeError(identities.error)}>
              Token names unavailable
            </span>
          </>
        )}
        {result?.notes?.length ? (
          <>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <span title={result.notes.join('\n')}>{result.notes[result.notes.length - 1]}</span>
          </>
        ) : null}
      </footer>
    </div>
  );
}
