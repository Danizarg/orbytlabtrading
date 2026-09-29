'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { useDiscover, useEnrichmentSnapshot, useRowEnrichment, useUniverse } from '@/data/hooks/useDiscover';
import { PROVIDER_LABELS, type DiscoverWindow } from '@/lib/core/providers';
import type { TokenRow } from '@/lib/core/types';
import {
  activeFilterCount,
  CLEAR_FILTERS,
  DISCOVER_LISTS,
  DISCOVER_WINDOWS,
  enrichmentTarget,
  enrichRows,
  errorLines,
  filterRows,
  GAINERS_NOTE,
  nextSort,
  parseDiscoverParams,
  serializeDiscoverParams,
  sortRows,
  summarizeUniverse,
  type DiscoverFilters,
  type DiscoverListKey,
  type DiscoverParams,
  type SortKey,
  type SortState,
} from '@/lib/services/discover';
import { FiltersPopover } from './FiltersPopover';
import { usePrefetchTrade } from './prefetch';
import { LoadError, RefreshWarning, SourceFooter, sourceName, UniverseFooter } from './StatusParts';
import { TokenTable } from './TokenTable';

const WINDOW_ITEMS = DISCOVER_WINDOWS.map((w) => ({ value: w, label: w }));
const LIST_LABEL = Object.fromEntries(DISCOVER_LISTS.map((l) => [l.value, l.label])) as Record<DiscoverListKey, string>;
const NO_ROWS: TokenRow[] = [];

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
 * /discover: every Solana memecoin the keyless sources list ("All", the
 * merged universe) plus the ranked named lists, in one dense sortable table.
 * The URL is the source of truth for list, window and filters (shareable,
 * and nav links to /discover reset the view); changes use
 * history.replaceState, which Next syncs into useSearchParams without a
 * server round trip.
 */
export function DiscoverView() {
  const searchParams = useSearchParams();
  const params = useMemo(() => parseDiscoverParams(searchParams), [searchParams]);
  const [sort, setSort] = useState<SortState | null>(null);
  const { list, window: win, filters } = params;
  const isAll = list === 'all';
  const named = useDiscover(list, win, !isAll);
  const { snapshot: universe, retry: retryUniverse } = useUniverse(win, isAll);
  const prefetch = usePrefetchTrade();

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

  // Base rows: the universe shows partial results as sources answer; a named list is one chain result.
  const summary = useMemo(() => summarizeUniverse(universe), [universe]);
  const namedResult = isAll ? undefined : named.query.data;
  const base: TokenRow[] | undefined = isAll ? (universe.rows.length || !universe.settling ? universe.rows : undefined) : namedResult?.data;

  // Enriched rows are a pure function of the base rows and the enrichment cache revision;
  // the fetch trigger below follows what is on screen (top of the sorted list).
  const enrichment = useEnrichmentSnapshot(base);
  const rows = useMemo(() => (base ? enrichRows(base, enrichment) : undefined), [base, enrichment]);
  // Age filtering uses the fetch time as "now" (render stays pure; ages move with each poll).
  const dataAt = isAll ? (summary.updatedAt ?? 0) : named.query.dataUpdatedAt;
  const sorted = useMemo(() => sortRows(rows ?? NO_ROWS, sort, win), [rows, sort, win]);
  const visible = useMemo(() => filterRows(sorted, filters, dataAt), [sorted, filters, dataAt]);
  const target = useMemo(() => enrichmentTarget(visible, sorted), [visible, sorted]);
  useRowEnrichment(target);

  const placeholder = !isAll && named.query.isPlaceholderData;
  const hidden = (rows?.length ?? 0) - visible.length;
  const indexed = isAll || namedResult?.freshness === 'indexed';
  const source = isAll ? universe.contributors.map((p) => PROVIDER_LABELS[p]).join(' · ') || undefined : sourceName(namedResult, named.winner);
  const allFailing = isAll && summary.failing > 0 && summary.failing === summary.sourcesTotal;
  const loading = isAll ? base === undefined : named.query.isPending;

  const listItems = useMemo<TabItem<DiscoverListKey>[]>(
    () =>
      DISCOVER_LISTS.map((l) =>
        l.value === 'all' && universe.rows.length
          ? { ...l, badge: <span className="tabular text-2xs text-muted">{universe.rows.length.toLocaleString('en-US')}</span> }
          : l,
      ),
    [universe.rows.length],
  );

  let empty: ReactNode = null;
  if (isAll ? summary.allFailed : named.query.isError && !namedResult) {
    empty = isAll ? (
      <LoadError what="Discover" lines={summary.errors} onRetry={retryUniverse} />
    ) : (
      <LoadError what="Discover" error={named.query.error} onRetry={() => void named.query.refetch()} retrying={named.query.isFetching} />
    );
  } else if (rows && rows.length === 0) {
    empty = (
      <EmptyState title="No tokens returned">
        {isAll ? 'Every source answered with an empty list.' : `${source ?? 'The provider'} returned an empty ${LIST_LABEL[list]} list.`} It refreshes
        automatically.
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
          <Tabs ariaLabel="Token list" items={listItems} value={list} onChange={setList} />
        </div>
        <Tabs ariaLabel="Stats window" items={WINDOW_ITEMS} value={win} onChange={setWindow} size="xs" />
        <FiltersPopover value={filters} onChange={setFilters} />
        {list === 'gainers' && (
          <span className="text-2xs text-muted" title={GAINERS_NOTE}>
            Sorted sample of trending tokens · by {win} change
          </span>
        )}
        {isAll && summary.pending > 0 && (
          <span className="text-2xs tabular text-muted" title="Sources are read one at a time to stay within each provider's request budget">
            Loading {summary.sourcesTotal - summary.pending}/{summary.sourcesTotal} sources
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {source && !placeholder && (
            <span className="hidden max-w-64 truncate text-2xs text-muted sm:inline" title={source}>
              {source}
            </span>
          )}
          <FreshnessBadge
            updatedAt={placeholder ? undefined : isAll ? summary.updatedAt : namedResult?.fetchedAt}
            error={isAll ? (summary.allFailed ? summary.errors.join(' · ') : null) : named.query.isError ? errorLines(named.query.error).join(' · ') : null}
            staleAfterMs={indexed ? 150_000 : 60_000}
          />
        </div>
      </div>

      {isAll
        ? allFailing && rows && rows.length > 0 && <RefreshWarning lines={summary.errors} updatedAt={summary.updatedAt} />
        : named.query.isError && namedResult && !placeholder && <RefreshWarning error={named.query.error} updatedAt={namedResult.fetchedAt} />}

      <ErrorBoundary label="Discover table" resetKeys={[list, win]} className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-panel p-4 text-center">
        <TokenTable
          rows={visible}
          win={win}
          sort={sort}
          onSort={onSort}
          loading={loading}
          dimmed={placeholder}
          empty={empty}
          onHover={prefetch}
          resetKey={list}
          caption={`${LIST_LABEL[list]} Solana tokens, ${win} window`}
        />
      </ErrorBoundary>

      {isAll ? (
        <UniverseFooter summary={summary} enrichment={enrichment} visible={visible.length} hidden={hidden} showsGecko={universe.contributors.includes('geckoterminal')} />
      ) : (
        <SourceFooter
          result={placeholder ? undefined : namedResult}
          winner={named.winner}
          enrichment={enrichment}
          rows={visible}
          count={
            namedResult && !placeholder ? (
              <>
                {visible.length} token{visible.length === 1 ? '' : 's'}
                {activeFilterCount(filters) > 0 && hidden > 0 && <span className="text-faint"> · {hidden} filtered out</span>}
              </>
            ) : named.query.isError ? (
              'No data'
            ) : (
              'Loading'
            )
          }
        />
      )}
    </div>
  );
}
