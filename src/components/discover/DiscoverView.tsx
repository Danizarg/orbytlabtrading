'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import { Tabs } from '@/components/ui/Tabs';
import { useDiscover } from '@/data/hooks/useDiscover';
import type { DiscoverWindow } from '@/lib/core/providers';
import {
  activeFilterCount,
  CLEAR_FILTERS,
  DISCOVER_LISTS,
  DISCOVER_WINDOWS,
  errorLines,
  filterRows,
  GAINERS_NOTE,
  nextSort,
  parseDiscoverParams,
  serializeDiscoverParams,
  sortRows,
  type DiscoverFilters,
  type DiscoverListKey,
  type DiscoverParams,
  type SortKey,
  type SortState,
} from '@/lib/services/discover';
import { FiltersPopover } from './FiltersPopover';
import { LoadError, RefreshWarning, SourceFooter, sourceName } from './StatusParts';
import { TokenTable } from './TokenTable';

const WINDOW_ITEMS = DISCOVER_WINDOWS.map((w) => ({ value: w, label: w }));
const LIST_LABEL = Object.fromEntries(DISCOVER_LISTS.map((l) => [l.value, l.label])) as Record<DiscoverListKey, string>;

/**
 * Rewrite the query string from the CURRENT URL (not a render-time snapshot),
 * so quick successive edits compose. Next syncs replaceState into its router.
 */
function replaceParams(change: (current: DiscoverParams) => DiscoverParams) {
  const current = parseDiscoverParams(new URLSearchParams(window.location.search));
  const qs = serializeDiscoverParams(change(current));
  const path = window.location.pathname;
  window.history.replaceState(null, '', qs ? `${path}?${qs}` : path);
}

/**
 * /discover: ranked Solana token lists in a dense sortable table. The URL is
 * the source of truth for list, window and filters (shareable, and nav links
 * to /discover reset the view); changes use history.replaceState, which Next
 * syncs into useSearchParams without a server round trip.
 */
export function DiscoverView() {
  const searchParams = useSearchParams();
  const params = useMemo(() => parseDiscoverParams(searchParams), [searchParams]);
  const [sort, setSort] = useState<SortState | null>(null);
  const { list, window: win, filters } = params;
  const { query, enrichment, rows, winner } = useDiscover(list, win);

  const setList = useCallback((value: DiscoverListKey) => {
    replaceParams((p) => ({ ...p, list: value }));
    setSort(null);
  }, []);
  const setWindow = useCallback((value: DiscoverWindow) => replaceParams((p) => ({ ...p, window: value })), []);
  const setFilters = useCallback(
    (patch: Partial<DiscoverFilters>) => replaceParams((p) => ({ ...p, filters: { ...p.filters, ...patch } })),
    [],
  );
  const onSort = useCallback((key: SortKey) => setSort((s) => nextSort(s, key)), []);

  // Age filtering uses the fetch time as "now" (render stays pure; ages move with each poll).
  const filtered = useMemo(() => (rows ? filterRows(rows, filters, query.dataUpdatedAt) : []), [rows, filters, query.dataUpdatedAt]);
  const visible = useMemo(() => sortRows(filtered, sort, win), [filtered, sort, win]);

  const result = query.data;
  const placeholder = query.isPlaceholderData;
  const indexed = result?.freshness === 'indexed';
  const hidden = (rows?.length ?? 0) - filtered.length;
  const source = sourceName(result, winner);

  let empty: ReactNode = null;
  if (query.isError && !result) {
    empty = <LoadError what="Discover" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  } else if (rows && rows.length === 0) {
    empty = (
      <EmptyState title="No tokens returned">
        {source ?? 'The provider'} returned an empty {LIST_LABEL[list]} list. It refreshes automatically.
      </EmptyState>
    );
  } else if (rows && visible.length === 0) {
    empty = (
      <EmptyState title="No tokens match the filters">
        {hidden} token{hidden === 1 ? '' : 's'} hidden.{' '}
        <button type="button" onClick={() => setFilters(CLEAR_FILTERS)} className="text-brand-strong hover:underline">
          Reset filters
        </button>
      </EmptyState>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-76px)] min-h-[460px] flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel px-3 py-2 lg:h-11 lg:flex-nowrap lg:py-0">
        <h1 className="font-display text-sm font-semibold tracking-tight text-fg">Discover</h1>
        <div className="max-w-full min-w-0 overflow-x-auto scrollbar-none">
          <Tabs ariaLabel="Token list" items={DISCOVER_LISTS} value={list} onChange={setList} />
        </div>
        <Tabs ariaLabel="Stats window" items={WINDOW_ITEMS} value={win} onChange={setWindow} size="xs" />
        <FiltersPopover value={filters} onChange={setFilters} />
        {list === 'gainers' && (
          <span className="text-2xs text-muted" title={GAINERS_NOTE}>
            Sorted sample of trending tokens · by {win} change
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {source && !placeholder && <span className="hidden text-2xs text-muted sm:inline">{source}</span>}
          <FreshnessBadge
            updatedAt={placeholder ? undefined : result?.fetchedAt}
            error={query.isError ? errorLines(query.error).join(' · ') : null}
            staleAfterMs={indexed ? 150_000 : 60_000}
          />
        </div>
      </div>

      {query.isError && result && !placeholder && <RefreshWarning error={query.error} updatedAt={result.fetchedAt} />}

      <ErrorBoundary label="Discover table" resetKeys={[list, win]} className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-panel p-4 text-center">
        <TokenTable
          rows={visible}
          win={win}
          sort={sort}
          onSort={onSort}
          loading={query.isPending}
          dimmed={placeholder}
          empty={empty}
          caption={`${LIST_LABEL[list]} Solana tokens, ${win} window`}
        />
      </ErrorBoundary>

      <SourceFooter
        result={placeholder ? undefined : result}
        winner={winner}
        enrichment={enrichment.data}
        rows={visible}
        count={
          result && !placeholder ? (
            <>
              {visible.length} token{visible.length === 1 ? '' : 's'}
              {activeFilterCount(filters) > 0 && hidden > 0 && <span className="text-faint"> · {hidden} filtered out</span>}
            </>
          ) : query.isError ? (
            'No data'
          ) : (
            'Loading'
          )
        }
      />
    </div>
  );
}
