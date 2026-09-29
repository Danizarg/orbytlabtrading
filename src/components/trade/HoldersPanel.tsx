'use client';

import { WalletLink } from '@/components/ui/AddressLink';
import { cn } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/EmptyState';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import { HOLDER_LIST_NOTE, type useHolders } from '@/data/hooks/useHolders';
import { formatAmount, formatCompact, formatPct } from '@/lib/core/format';
import { errorLines } from '@/lib/services/token';
import { Dash, ErrorLines, SkeletonRows, SourceLine } from './parts';
import { ROW, TD, TD_NUM, TH, TH_NUM } from './tableStyles';

type HoldersState = ReturnType<typeof useHolders>;

const SEGMENTS: ReadonlyArray<{ key: 'top10Pct' | 'top11to20Pct' | 'top21to40Pct' | 'restPct'; label: string; className: string }> = [
  { key: 'top10Pct', label: 'Top 10', className: 'bg-down' },
  { key: 'top11to20Pct', label: '11–20', className: 'bg-warn' },
  { key: 'top21to40Pct', label: '21–40', className: 'bg-info' },
  { key: 'restPct', label: 'Rest', className: 'bg-up' },
];

export function HoldersPanel({ holders }: { holders: HoldersState }) {
  const { snapshot, hasList } = holders;
  const dist = snapshot?.distribution;
  const top10 = dist?.top10Pct;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-line px-3 text-xs">
        <span className="text-muted">
          Holders <span className="tabular text-fg">{snapshot?.totalHolders === undefined ? <Dash /> : formatCompact(snapshot.totalHolders)}</span>
        </span>
        <span className="text-muted">
          Top10{' '}
          <span className={cn('tabular', top10 === undefined ? 'text-faint' : top10 > 50 ? 'text-down' : top10 > 30 ? 'text-warn' : 'text-fg')}>
            {top10 === undefined ? <Dash /> : formatPct(top10, { signed: false, decimals: 1 })}
          </span>
        </span>
        {dist && (
          <span aria-hidden className="flex h-1.5 w-32 overflow-hidden rounded-full bg-line-strong" title={SEGMENTS.map((s) => `${s.label} ${formatPct(dist[s.key], { signed: false, decimals: 1 })}`).join(' · ')}>
            {SEGMENTS.map((s) => {
              const v = dist[s.key];
              return v === undefined ? null : <span key={s.key} className={cn('h-full', s.className)} style={{ width: `${Math.min(100, Math.max(0, v))}%` }} />;
            })}
          </span>
        )}
        <span className="ml-auto">
          <FreshnessBadge updatedAt={holders.fetchedAt} error={holders.error ? 'Holder data unavailable' : undefined} />
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {holders.isPending && <SkeletonRows rows={8} cols={4} />}
        {!holders.isPending && !snapshot && holders.error !== undefined && (
          <EmptyState title="Holder data unavailable" tone="error">
            <ErrorLines lines={errorLines(holders.error)} className="text-left" />
          </EmptyState>
        )}
        {!holders.isPending && !snapshot && holders.error === undefined && <EmptyState title="No holder data">No provider reported holder data for this token.</EmptyState>}
        {snapshot && !hasList && !holders.listConfigured && (
          <EmptyState title="Holder summary only">
            {HOLDER_LIST_NOTE}. The count and concentration above come from {holders.source === 'geckoterminal' ? 'GeckoTerminal' : 'the configured provider'}.
          </EmptyState>
        )}
        {snapshot && !hasList && holders.listConfigured && (
          <EmptyState title={holders.listError !== undefined ? 'Holder list unavailable' : 'No holder list'} tone={holders.listError !== undefined ? 'error' : 'neutral'}>
            {holders.listError !== undefined ? (
              <ErrorLines lines={errorLines(holders.listError)} className="text-left" />
            ) : (
              'The holder list provider returned no holders for this token.'
            )}
          </EmptyState>
        )}
        {snapshot && hasList && (
          <table className="w-full min-w-[560px] table-fixed border-separate border-spacing-0">
            <caption className="sr-only">Largest holders</caption>
            <colgroup>
              <col className="w-8" />
              <col className="w-36" />
              <col className="w-28" />
              <col className="w-28" />
              <col className="w-20" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className={TH_NUM}>
                  #
                </th>
                <th scope="col" className={TH}>
                  Wallet
                </th>
                <th scope="col" className={TH}>
                  Label
                </th>
                <th scope="col" className={TH_NUM}>
                  Amount
                </th>
                <th scope="col" className={TH_NUM}>
                  Supply
                </th>
                <th scope="col" className={TH}>
                  <span className="sr-only">Share</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {snapshot.top.map((h, i) => {
                const pct = h.pctOfSupply ?? (snapshot.supply && snapshot.supply > 0 ? (h.amount / snapshot.supply) * 100 : undefined);
                return (
                  <tr key={h.tokenAccount ?? `${h.owner}-${i}`} className={ROW}>
                    <td className={cn(TD_NUM, 'text-faint')}>{i + 1}</td>
                    <td className={TD}>
                      <WalletLink address={h.owner} showTools />
                    </td>
                    <td className={cn(TD, h.isProgramAccount ? 'text-info' : 'text-muted')}>{h.label ?? (h.isProgramAccount ? 'Program' : '')}</td>
                    <td className={TD_NUM}>{formatAmount(h.amount, { maxDecimals: 0 })}</td>
                    <td className={cn(TD_NUM, pct !== undefined && pct > 10 ? 'text-warn' : undefined)}>{pct === undefined ? <Dash /> : formatPct(pct, { signed: false, decimals: 2 })}</td>
                    <td className={TD}>
                      <span aria-hidden className="block h-1 w-full max-w-24 overflow-hidden rounded-full bg-line-strong">
                        {pct !== undefined && <span className="block h-full bg-brand" style={{ width: `${Math.min(100, pct)}%` }} />}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {snapshot && (
        <SourceLine source={holders.source} contributors={holders.contributors} fetchedAt={holders.fetchedAt} freshness={holders.freshness} notes={holders.notes} className="shrink-0 border-t border-line" />
      )}
    </div>
  );
}
