'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, type ReactNode } from 'react';
import { CopyButton } from '@/components/ui/CopyButton';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/components/ui/cn';
import type { DiscoverWindow } from '@/lib/core/providers';
import { shortAddress } from '@/lib/core/solana';
import type { TokenRow } from '@/lib/core/types';
import type { SortKey, SortState } from '@/lib/services/discover';
import { RemoveButton } from './cells';
import { COLUMNS, TABLE_MIN_WIDTH, type ColumnDef } from './columns';
import { TD, TD_ACTION, TD_RANK, TD_TOKEN, TH, TH_RANK, TH_TOKEN } from './tableStyles';
import { TokenTableRow, type TableVariant } from './TokenTableRow';

export interface TokenTableProps {
  rows: readonly TokenRow[];
  win: DiscoverWindow;
  sort: SortState | null;
  onSort: (key: SortKey) => void;
  variant?: TableVariant;
  /** Initial load: render skeleton rows when there are no rows yet. */
  loading?: boolean;
  /** Extra skeleton rows (watchlist tokens still loading). */
  skeletonRows?: number;
  /** Rows belong to a previous list while the new one loads. */
  dimmed?: boolean;
  /** Watchlist mints no provider knows (kept so they can be removed). */
  missing?: readonly string[];
  /** Shown under the header when there is nothing to list (empty, filtered out, error). */
  empty?: ReactNode;
  caption: string;
}

const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

function HeaderCell({ col, win, sort, onSort, variant }: { col: ColumnDef; win: DiscoverWindow; sort: SortState | null; onSort: (key: SortKey) => void; variant: TableVariant }) {
  const className = cn(col.id === 'rank' ? TH_RANK : col.id === 'token' ? TH_TOKEN : TH, ALIGN[col.align]);
  const title = col.title?.(win);
  const label = col.label(win);
  if (!col.sortKey) {
    return (
      <th scope="col" className={className} title={title}>
        {label || <span className="sr-only">{variant === 'watchlist' ? 'Remove' : 'Watchlist'}</span>}
      </th>
    );
  }
  const key = col.sortKey;
  const active = sort?.key === key ? sort.dir : undefined;
  return (
    <th scope="col" className={className} aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : undefined}>
      <button
        type="button"
        onClick={() => onSort(key)}
        title={title ? `${title} · sort` : 'Sort'}
        className={cn(
          'inline-flex max-w-full items-center gap-0.5 rounded-sm transition-colors hover:text-fg',
          col.align === 'right' && 'flex-row-reverse',
          active && 'text-fg',
        )}
      >
        <span className="truncate">{variant === 'watchlist' && key === 'rank' ? '#' : label}</span>
        {active === 'asc' && <ArrowUp aria-hidden className="size-3 shrink-0 text-brand" />}
        {active === 'desc' && <ArrowDown aria-hidden className="size-3 shrink-0 text-brand" />}
      </button>
    </th>
  );
}

function SkeletonRow() {
  return (
    <tr className="h-9" aria-hidden>
      {COLUMNS.map((c) => (
        <td key={c.id} className={c.id === 'rank' ? TD_RANK : c.id === 'token' ? TD_TOKEN : TD}>
          {c.id === 'token' ? (
            <div className="flex items-center gap-2">
              <Skeleton className="size-6 shrink-0 rounded-full" />
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="h-2 w-14" />
              </div>
            </div>
          ) : c.id === 'action' || c.id === 'rank' ? null : (
            <Skeleton className={cn('h-2.5', c.align === 'right' ? 'ml-auto w-3/5' : 'w-3/4')} />
          )}
        </td>
      ))}
    </tr>
  );
}

function MissingRow({ mint }: { mint: string }) {
  return (
    <tr className="group h-9">
      <td className={TD_RANK} />
      <td className={TD_TOKEN}>
        <span className="flex items-center gap-1 text-2xs text-muted">
          <span className="font-mono" title={mint}>
            {shortAddress(mint, 6, 6)}
          </span>
          <CopyButton value={mint} label="Copy mint address" />
        </span>
      </td>
      <td className={cn(TD, 'text-2xs text-muted')} colSpan={COLUMNS.length - 3}>
        Not listed by Jupiter, GeckoTerminal or DEX Screener right now
      </td>
      <td className={TD_ACTION}>
        <RemoveButton mint={mint} />
      </td>
    </tr>
  );
}

/**
 * Dense sortable token table (Discover and watchlist). Real <table>
 * semantics, sticky header and sticky rank/token columns inside its own
 * scroll container (horizontal scroll on narrow screens).
 */
export function TokenTable({
  rows,
  win,
  sort,
  onSort,
  variant = 'discover',
  loading = false,
  skeletonRows = 0,
  dimmed = false,
  missing,
  empty,
  caption,
}: TokenTableProps) {
  const router = useRouter();
  const onOpen = useCallback(
    (mint: string, newTab: boolean) => {
      const href = `/trade/${mint}`;
      if (newTab) window.open(href, '_blank', 'noopener,noreferrer');
      else router.push(href);
    },
    [router],
  );

  const skeletons = loading && !rows.length ? 16 : skeletonRows;
  const showEmpty = !loading && !rows.length && !missing?.length && !skeletons && empty;

  return (
    <div className="relative min-h-0 flex-1 overflow-auto bg-panel" aria-busy={loading || dimmed || undefined}>
      <table className={cn('w-full table-fixed border-separate border-spacing-0 text-xs', TABLE_MIN_WIDTH)}>
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          {COLUMNS.map((c) => (
            <col key={c.id} className={c.width} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <HeaderCell key={c.id} col={c} win={win} sort={sort} onSort={onSort} variant={variant} />
            ))}
          </tr>
        </thead>
        <tbody className={cn('transition-opacity duration-150', dimmed && 'opacity-50')}>
          {rows.map((row) => (
            <TokenTableRow key={row.token.mint} row={row} win={win} variant={variant} onOpen={onOpen} />
          ))}
          {missing?.map((mint) => (
            <MissingRow key={mint} mint={mint} />
          ))}
          {Array.from({ length: skeletons }, (_, i) => (
            <SkeletonRow key={`skeleton-${i}`} />
          ))}
        </tbody>
      </table>
      {/* Outside the table so it centres in the visible width, not the 1250 px table. */}
      {showEmpty && <div className="sticky left-0 w-full">{empty}</div>}
    </div>
  );
}
