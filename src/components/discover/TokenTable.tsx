'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CopyButton } from '@/components/ui/CopyButton';
import { cn } from '@/components/ui/cn';
import type { DiscoverWindow } from '@/lib/core/providers';
import { shortAddress } from '@/lib/core/solana';
import type { TokenRow } from '@/lib/core/types';
import { ROWS_PER_CHUNK, type SortKey, type SortState } from '@/lib/services/discover';
import { RemoveButton } from './cells';
import { COLUMNS, TABLE_MIN_WIDTH, type ColumnDef } from './columns';
import { tradeHref } from './prefetch';
import { SkeletonRow } from './TableSkeleton';
import { ROW_H, TD, TD_ACTION, TD_RANK, TD_TOKEN, TH, TH_RANK, TH_TOKEN } from './tableStyles';
import { TokenTableRow, type TableVariant } from './TokenTableRow';

export interface TokenTableProps {
  rows: readonly TokenRow[];
  win: DiscoverWindow;
  sort: SortState | null;
  onSort: (key: SortKey) => void;
  variant?: TableVariant;
  /** Initial load: render skeleton rows when there are no rows yet. */
  loading?: boolean;
  /** Skeleton rows: during the initial load (default 16), or extra rows (watchlist tokens still loading). */
  skeletonRows?: number;
  /** Rows belong to a previous list while the new one loads. */
  dimmed?: boolean;
  /** Watchlist mints no provider knows (kept so they can be removed). */
  missing?: readonly string[];
  /** Shown under the header when there is nothing to list (empty, filtered out, error). */
  empty?: ReactNode;
  /** Hover / focus intent on a row (token page prefetch). */
  onHover?: (row: TokenRow) => void;
  /** Pointer left the table (cancels a pending hover intent). */
  onHoverEnd?: () => void;
  /** When this changes the rendered chunk count resets (e.g. the list tab). */
  resetKey?: unknown;
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
        {active === 'asc' && <ArrowUp aria-hidden className="size-3 shrink-0 text-brand" strokeWidth={1.75} />}
        {active === 'desc' && <ArrowDown aria-hidden className="size-3 shrink-0 text-brand" strokeWidth={1.75} />}
      </button>
    </th>
  );
}

function MissingRow({ mint }: { mint: string }) {
  return (
    <tr className={cn('group', ROW_H)}>
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
        No market data source lists this token right now
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
 * scroll container (horizontal scroll on narrow screens). Long lists render
 * in chunks: the next chunk mounts when the sentinel row scrolls near the
 * viewport (or on the fallback button), so 500+ rows never paint at once.
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
  onHover,
  onHoverEnd,
  resetKey,
  caption,
}: TokenTableProps) {
  const router = useRouter();
  const onOpen = useCallback(
    (mint: string, newTab: boolean) => {
      const href = tradeHref(mint);
      if (newTab) window.open(href, '_blank', 'noopener,noreferrer');
      else router.push(href);
    },
    [router],
  );

  const [limit, setLimit] = useState(ROWS_PER_CHUNK);
  const [prevReset, setPrevReset] = useState(resetKey);
  if (prevReset !== resetKey) {
    setPrevReset(resetKey);
    setLimit(ROWS_PER_CHUNK);
  }
  const shown = rows.length > limit ? rows.slice(0, limit) : rows;
  const remaining = rows.length - shown.length;
  const grow = useCallback(() => setLimit((l) => l + ROWS_PER_CHUNK), []);

  const containerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    const root = containerRef.current;
    if (!el || !root || remaining <= 0 || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && grow(), { root, rootMargin: '0px 0px 480px 0px' });
    io.observe(el);
    return () => io.disconnect();
    // `limit` remounts the sentinel after each chunk so a still-visible sentinel re-triggers.
  }, [remaining, limit, grow]);

  const skeletons = loading && !rows.length ? skeletonRows || 16 : skeletonRows;
  const showEmpty = !loading && !rows.length && !missing?.length && !skeletons && empty;

  return (
    <div
      ref={containerRef}
      className="relative min-h-0 flex-1 overflow-auto bg-panel"
      aria-busy={loading || dimmed || undefined}
      onMouseLeave={onHoverEnd}
    >
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
          {shown.map((row) => (
            <TokenTableRow key={row.token.mint} row={row} win={win} variant={variant} onOpen={onOpen} onHover={onHover} />
          ))}
          {remaining > 0 && (
            <tr key={`more-${limit}`} ref={sentinelRef} className={ROW_H}>
              <td className={TD_RANK} />
              <td className={cn(TD_TOKEN, 'text-2xs text-muted')} colSpan={COLUMNS.length - 1}>
                <button type="button" onClick={grow} className="rounded-sm text-muted hover:text-fg">
                  Show {Math.min(ROWS_PER_CHUNK, remaining)} more
                </button>
                <span className="text-faint"> · {remaining.toLocaleString('en-US')} below</span>
              </td>
            </tr>
          )}
          {missing?.map((mint) => (
            <MissingRow key={mint} mint={mint} />
          ))}
          {Array.from({ length: skeletons }, (_, i) => (
            <SkeletonRow key={`skeleton-${i}`} />
          ))}
        </tbody>
      </table>
      {/* Outside the table so it centres in the visible width, not across the full table width. */}
      {showEmpty && <div className="sticky left-0 w-full">{empty}</div>}
    </div>
  );
}
