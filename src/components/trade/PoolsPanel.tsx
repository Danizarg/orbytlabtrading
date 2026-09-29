'use client';

import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import type { UseQueryResult } from '@tanstack/react-query';
import { cn } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/EmptyState';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import type { ChainResult } from '@/lib/core/chain';
import { formatCompact, formatPrice, formatUsd } from '@/lib/core/format';
import { explorer, shortAddress } from '@/lib/core/solana';
import type { PoolInfo } from '@/lib/core/types';
import { errorLines, tokenTradeHref } from '@/lib/services/token';
import { Age, Dash, ErrorLines, SkeletonRows, SourceLine } from './parts';
import { ROW, TD, TD_NUM, TH, TH_NUM } from './tableStyles';

export function PoolsPanel({
  mint,
  pools,
  primary,
  frozen,
  overridden,
  query,
}: {
  mint: string;
  pools: readonly PoolInfo[];
  primary?: PoolInfo;
  frozen: ReadonlySet<string>;
  overridden: boolean;
  query: UseQueryResult<ChainResult<PoolInfo[]>>;
}) {
  const result = query.data;
  // React Query reports `null` when there is no error.
  const error = query.error ?? undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-line px-3 text-xs">
        <span className="text-muted">
          {pools.length} pool{pools.length === 1 ? '' : 's'}
        </span>
        {overridden && (
          <Link href={tokenTradeHref(mint)} replace scroll={false} className="text-2xs text-brand-strong hover:underline">
            Reset to most liquid
          </Link>
        )}
        <span className="ml-auto">
          <FreshnessBadge updatedAt={result?.fetchedAt} error={error && !result ? 'Pools unavailable' : undefined} />
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {query.isPending && !pools.length && <SkeletonRows rows={4} cols={6} />}
        {!query.isPending && !pools.length && error !== undefined && (
          <EmptyState title="Pools unavailable" tone="error">
            <ErrorLines lines={errorLines(error)} className="text-left" />
          </EmptyState>
        )}
        {!query.isPending && !pools.length && error === undefined && <EmptyState title="No pool indexed">DEX Screener and GeckoTerminal list no pool for this token yet.</EmptyState>}
        {pools.length > 0 && (
          <table className="w-full min-w-[720px] table-fixed border-separate border-spacing-0">
            <caption className="sr-only">Liquidity pools for this token</caption>
            <colgroup>
              <col className="w-36" />
              <col className="w-20" />
              <col className="w-24" />
              <col className="w-20" />
              <col className="w-20" />
              <col className="w-20" />
              <col className="w-16" />
              <col className="w-24" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className={TH}>
                  DEX
                </th>
                <th scope="col" className={TH}>
                  Pair
                </th>
                <th scope="col" className={TH_NUM}>
                  Price
                </th>
                <th scope="col" className={TH_NUM}>
                  Liq
                </th>
                <th scope="col" className={TH_NUM}>
                  Vol 24h
                </th>
                <th scope="col" className={TH_NUM}>
                  TXs 24h
                </th>
                <th scope="col" className={TH_NUM}>
                  Age
                </th>
                <th scope="col" className={TH}>
                  Pool
                </th>
              </tr>
            </thead>
            <tbody>
              {pools.map((p) => {
                const active = p.address === primary?.address;
                const isFrozen = frozen.has(p.address);
                const txns = p.txns24h ? p.txns24h.buys + p.txns24h.sells : undefined;
                return (
                  <tr key={p.address} className={cn(ROW, active && 'bg-brand-soft/40')}>
                    <td className={TD}>
                      <div className="flex items-center gap-1.5">
                        {isFrozen ? (
                          <span className="text-muted" title="Bonding curve completed; price frozen at migration">
                            {p.dexLabel}
                          </span>
                        ) : (
                          <Link href={tokenTradeHref(mint, p.address)} replace scroll={false} className="font-medium text-fg hover:text-brand-strong" aria-current={active ? 'true' : undefined}>
                            {p.dexLabel}
                          </Link>
                        )}
                        {p.isBondingCurve && <span className="rounded-sm border border-line px-1 text-2xs text-muted">{isFrozen ? 'migrated' : 'curve'}</span>}
                        {active && <span className="rounded-sm bg-brand-soft px-1 text-2xs text-brand-strong">active</span>}
                      </div>
                    </td>
                    <td className={TD}>{p.quoteSymbol ? `${p.baseMint === mint ? '' : 'quote/'}${p.quoteSymbol}` : <Dash />}</td>
                    <td className={TD_NUM}>{p.priceUsd === undefined ? <Dash /> : formatPrice(p.priceUsd)}</td>
                    <td className={TD_NUM}>{p.liquidityUsd === undefined ? <Dash /> : formatUsd(p.liquidityUsd)}</td>
                    <td className={TD_NUM}>{p.volume24hUsd === undefined ? <Dash /> : formatUsd(p.volume24hUsd)}</td>
                    <td className={TD_NUM}>{txns === undefined ? <Dash /> : formatCompact(txns)}</td>
                    <td className={TD_NUM}>
                      <Age from={p.createdAt} />
                    </td>
                    <td className={TD}>
                      <a href={explorer.account(p.address)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-muted hover:text-brand-strong" title={p.address}>
                        {shortAddress(p.address)}
                        <ExternalLink className="size-3" />
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {result && <SourceLine source={result.source} contributors={result.contributors} fetchedAt={result.fetchedAt} freshness={result.freshness} attempts={result.attempts} notes={result.notes} className="shrink-0 border-t border-line" />}
    </div>
  );
}
