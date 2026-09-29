'use client';

import { ChevronDown, RotateCw, TriangleAlert } from 'lucide-react';
import { memo, useMemo, type ReactNode } from 'react';
import { useNow } from '@/client/hooks/useNow';
import { TxLink, WalletLink } from '@/components/ui/AddressLink';
import { EmptyState } from '@/components/ui/EmptyState';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/components/ui/cn';
import { useMintIdentities, type MintIdentities } from '@/data/hooks/usePortfolio';
import { ACTIVITY_HEAD_POLL_MS, type ActivitySection, type WalletActivityView } from '@/data/hooks/useWalletActivity';
import { formatAge } from '@/lib/core/format';
import { PROVIDER_LABELS } from '@/lib/core/providers';
import type { WalletActivity } from '@/lib/core/types';
import { describeError } from '@/lib/net/errors';
import { activityMints, IDENTITY_LOOKUP_MAX, signedSol, usdEstimate } from '@/lib/services/wallet';
import { AmountCell, Dash, KindBadge, ProgramCell, SolCell, TimeCell, TokenCell, UsdCell } from './cells';
import { BTN, FOOTER, TD, TD_STICKY, TH, TH_STICKY } from './styles';

const COLS: ReadonlyArray<{ id: string; label: string; width: string; align: 'left' | 'right' }> = [
  { id: 'time', label: 'Time', width: 'w-20', align: 'left' },
  { id: 'kind', label: 'Kind', width: 'w-24', align: 'left' },
  { id: 'token', label: 'Token', width: 'w-52', align: 'left' },
  { id: 'amount', label: 'Amount', width: 'w-28', align: 'right' },
  { id: 'sol', label: 'SOL', width: 'w-28', align: 'right' },
  { id: 'usd', label: 'USD ≈', width: 'w-24', align: 'right' },
  { id: 'program', label: 'Program', width: 'w-28', align: 'left' },
  { id: 'counterparty', label: 'Counterparty', width: 'w-28', align: 'left' },
  { id: 'tx', label: 'Tx', width: 'w-24', align: 'right' },
];

const ActivityRow = memo(function ActivityRow({ activity, identities, solPriceUsd }: { activity: WalletActivity; identities: MintIdentities; solPriceUsd?: number }) {
  const a = activity;
  const identity = a.tokenMint ? identities.byMint[a.tokenMint] : undefined;
  const sol = signedSol(a);
  const usd = usdEstimate(a, solPriceUsd);
  return (
    <tr className={cn('group h-8', !a.success && 'opacity-60')}>
      <td className={TD_STICKY}>
        <TimeCell at={a.timestamp} />
      </td>
      <td className={TD}>
        <KindBadge kind={a.kind} failed={!a.success} />
      </td>
      <td className={TD}>
        <TokenCell mint={a.tokenMint} identity={identity} symbol={a.tokenSymbol} />
      </td>
      <td className={cn(TD, 'text-right')}>
        <AmountCell value={a.tokenAmount} symbol={identity?.symbol ?? a.tokenSymbol} />
      </td>
      <td className={cn(TD, 'text-right')}>
        <SolCell value={sol} />
      </td>
      <td className={cn(TD, 'text-right')}>
        <UsdCell estimate={usd} />
      </td>
      <td className={TD}>
        <ProgramCell program={a.program} />
      </td>
      <td className={TD}>{a.counterparty ? <WalletLink address={a.counterparty} className="text-2xs" /> : <Dash />}</td>
      <td className={cn(TD, 'text-right')}>
        <TxLink signature={a.signature} className="text-2xs" />
      </td>
    </tr>
  );
});

function SectionRow({ section }: { section: ActivitySection }) {
  const { page, scanned, items, added, gap } = section;
  const count = items.length;
  return (
    <tr className="h-6">
      <td colSpan={COLS.length} className="sticky left-0 border-b border-line bg-panel-2 px-2 text-2xs whitespace-nowrap text-muted">
        <span className="tabular">
          Page {page} · scanned {scanned} signature{scanned === 1 ? '' : 's'} · {count} activit{count === 1 ? 'y' : 'ies'}
          {added > 0 && ` · ${added} new since load`}
        </span>
        {page === 1 && <span className="text-faint"> · newest page refreshes every {ACTIVITY_HEAD_POLL_MS / 1000} s</span>}
        {gap && (
          <span className="text-warn" title="A refresh returned a full page of transactions newer than everything shown, so some in between may be missing. Reload the page to re-read from the newest.">
            {' '}
            · possible gap between refreshes
          </span>
        )}
      </td>
    </tr>
  );
}

function SkeletonRow() {
  return (
    <tr className="h-8" aria-hidden>
      {COLS.map((c) => (
        <td key={c.id} className={c.id === 'time' ? TD_STICKY : TD}>
          <Skeleton className={cn('h-2.5', c.align === 'right' ? 'ml-auto w-3/5' : 'w-3/4')} />
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

/**
 * Activity tab: parsed wallet transactions newest first, grouped by fetched
 * page with the number of signatures scanned per page, and "Load older".
 */
export function ActivityFeed({ activity, solPriceUsd }: { activity: WalletActivityView; solPriceUsd?: number }) {
  const { infinite, head, items, sections, coverage, updatedAt, refreshError, olderError } = activity;
  const mints = useMemo(() => activityMints(items, IDENTITY_LOOKUP_MAX), [items]);
  const identities = useMintIdentities(mints);
  const loading = infinite.isPending;
  const first = infinite.data?.pages[0];

  let empty: ReactNode = null;
  if (infinite.isError && !first) {
    empty = (
      <EmptyState tone="error" title="Activity unavailable">
        <p>{describeError(infinite.error)}</p>
        <button type="button" onClick={() => void infinite.refetch()} disabled={infinite.isFetching} className={`${BTN} mt-3`}>
          <RotateCw aria-hidden className={cn('size-3', infinite.isFetching && 'motion-safe:animate-spin')} strokeWidth={1.75} /> Retry
        </button>
      </EmptyState>
    );
  } else if (first && items.length === 0) {
    empty = (
      <EmptyState title="No activity found">
        {coverage.scanned > 0
          ? `${coverage.scanned} signature${coverage.scanned === 1 ? '' : 's'} scanned, none changed this wallet's balances.`
          : 'The index returned no transactions for this wallet.'}
      </EmptyState>
    );
  }

  const source = first ? (first.source === 'orbyt' ? 'Solana RPC via ORBYT API' : `${PROVIDER_LABELS[first.source]} via ORBYT API`) : undefined;
  const notes = first?.notes ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {refreshError !== undefined && first && (
        <div role="status" className="flex h-7 shrink-0 items-center gap-2 overflow-x-auto border-b border-line bg-warn-soft px-3 text-2xs whitespace-nowrap text-warn scrollbar-none">
          <TriangleAlert aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
          Refresh failed · {describeError(refreshError)} · showing data from <Ago at={updatedAt} /> · retrying automatically
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-auto" aria-busy={loading || undefined}>
        <table className="w-full min-w-[1040px] table-fixed border-separate border-spacing-0 text-xs">
          <caption className="sr-only">Wallet activity</caption>
          <colgroup>
            {COLS.map((c) => (
              <col key={c.id} className={c.width} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.id} scope="col" className={cn(c.id === 'time' ? TH_STICKY : TH, c.align === 'right' ? 'text-right' : 'text-left')}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sections.map((s) => (
              <SectionGroup key={s.page} section={s} identities={identities} solPriceUsd={solPriceUsd} />
            ))}
            {loading && Array.from({ length: 10 }, (_, i) => <SkeletonRow key={i} />)}
            {infinite.isFetchingNextPage && Array.from({ length: 3 }, (_, i) => <SkeletonRow key={`next-${i}`} />)}
          </tbody>
        </table>
        {empty && <div className="sticky left-0 w-full">{empty}</div>}
        {first && infinite.hasNextPage && (
          <div className="sticky left-0 flex w-full items-center justify-center gap-3 border-b border-line py-2">
            {olderError !== undefined && !infinite.isFetchingNextPage && (
              <span role="alert" className="inline-flex items-center gap-1 text-2xs text-warn">
                <TriangleAlert aria-hidden className="size-3" strokeWidth={1.75} />
                Older page failed · {describeError(olderError)}
              </span>
            )}
            <button type="button" onClick={() => void infinite.fetchNextPage({ cancelRefetch: false })} disabled={infinite.isFetchingNextPage} className={BTN}>
              {olderError !== undefined ? <RotateCw aria-hidden className="size-3" strokeWidth={1.75} /> : <ChevronDown aria-hidden className="size-3" strokeWidth={1.75} />}
              {infinite.isFetchingNextPage ? 'Loading older…' : olderError !== undefined ? 'Retry' : 'Load older'}
            </button>
          </div>
        )}
        {first && !infinite.hasNextPage && items.length > 0 && <p className="sticky left-0 w-full py-2 text-center text-2xs text-faint">Start of history</p>}
      </div>
      <footer className={FOOTER}>
        <span className="tabular">
          {first ? `${items.length} activit${items.length === 1 ? 'y' : 'ies'} · ${coverage.scanned} scanned · ${coverage.pages} page${coverage.pages === 1 ? '' : 's'}` : infinite.isError ? 'No data' : 'Loading'}
        </span>
        {source && (
          <>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <span>
              Source: <span className="text-fg-dim">{source}</span>
              {head.isFetching && <span className="text-faint"> · refreshing</span>}
            </span>
          </>
        )}
        {notes.length > 0 && (
          <>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <span title={notes.join('\n')}>{notes[notes.length - 1]}</span>
          </>
        )}
        <span className="ml-auto flex items-center gap-2 pl-3">
          <span className="text-faint">USD ≈ now (SOL × current SOL price)</span>
          <FreshnessBadge
            updatedAt={updatedAt}
            error={refreshError !== undefined ? describeError(refreshError) : infinite.isError && !first ? describeError(infinite.error) : null}
            staleAfterMs={ACTIVITY_HEAD_POLL_MS * 3}
          />
        </span>
      </footer>
    </div>
  );
}

function SectionGroup({ section, identities, solPriceUsd }: { section: ActivitySection; identities: MintIdentities; solPriceUsd?: number }) {
  return (
    <>
      <SectionRow section={section} />
      {section.items.map((a) => (
        <ActivityRow key={a.signature} activity={a} identities={identities} solPriceUsd={solPriceUsd} />
      ))}
    </>
  );
}
