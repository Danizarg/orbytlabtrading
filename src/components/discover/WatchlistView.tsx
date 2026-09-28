'use client';

import { Star } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useHydrated } from '@/client/hooks/useHydrated';
import { MAX_WATCHLIST, usePreferences } from '@/client/store/preferences';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import { Tabs } from '@/components/ui/Tabs';
import { useTokenRows } from '@/data/hooks/useTokenRows';
import type { DiscoverWindow } from '@/lib/core/providers';
import { DISCOVER_WINDOWS, errorLines, nextSort, sortRows, type SortKey, type SortState } from '@/lib/services/discover';
import { LoadError, RefreshWarning, SourceFooter, sourceName } from './StatusParts';
import { TokenTable } from './TokenTable';

const WINDOW_ITEMS = DISCOVER_WINDOWS.map((w) => ({ value: w, label: w }));
const NONE: readonly string[] = [];

/** /watchlist: the Discover table fed by the browser-local watchlist, in the user's order. */
export function WatchlistView() {
  const hydrated = useHydrated();
  const stored = usePreferences((s) => s.watchlist);
  // The persisted list only exists in the browser: render the server snapshot (empty) until hydrated.
  const watchlist = hydrated ? stored : NONE;
  const [win, setWin] = useState<DiscoverWindow>('24h');
  const [sort, setSort] = useState<SortState | null>(null);
  const onSort = useCallback((key: SortKey) => setSort((s) => nextSort(s, key)), []);
  const { query, enrichment, rows, missing, pending, winner } = useTokenRows(watchlist);

  // "#" is the position in the user's watchlist.
  const ranked = useMemo(() => {
    const position = new Map(watchlist.map((m, i) => [m, i + 1] as const));
    return (rows ?? []).map((r) => {
      const rank = position.get(r.token.mint);
      return rank === undefined || r.rank === rank ? r : { ...r, rank };
    });
  }, [rows, watchlist]);
  const visible = useMemo(() => sortRows(ranked, sort, win), [ranked, sort, win]);

  const result = query.data;
  const source = sourceName(result, winner);
  const count = watchlist.length;

  let empty: ReactNode = null;
  if (hydrated && count === 0) {
    empty = (
      <EmptyState title="Your watchlist is empty">
        <p>
          Star a token with <Star aria-hidden className="inline size-3 align-[-2px] text-warn" />
          <span className="sr-only">the star button</span> in Discover or on its token page to follow it here. Up to {MAX_WATCHLIST} tokens, saved in
          this browser only.
        </p>
        <Link href="/discover" className="mt-3 inline-flex h-7 items-center rounded-md border border-line-strong px-2.5 text-2xs font-medium text-fg-dim hover:bg-hover hover:text-fg">
          Open Discover
        </Link>
      </EmptyState>
    );
  } else if (query.isError && !result) {
    empty = <LoadError what="Watchlist data" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  }

  const loading = !hydrated || (count > 0 && !result && !query.isError);

  return (
    <div className="flex h-[calc(100dvh-76px)] min-h-[460px] flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel px-3 py-2 lg:h-11 lg:flex-nowrap lg:py-0">
        <h1 className="font-display text-sm font-semibold tracking-tight text-fg">Watchlist</h1>
        <span className="text-2xs tabular text-muted" title={`Up to ${MAX_WATCHLIST} tokens, stored in this browser`}>
          {hydrated ? count : '—'}/{MAX_WATCHLIST}
        </span>
        <Tabs ariaLabel="Stats window" items={WINDOW_ITEMS} value={win} onChange={setWin} size="xs" />
        {count > 0 && (
          <div className="ml-auto flex items-center gap-2">
            {source && <span className="hidden text-2xs text-muted sm:inline">{source}</span>}
            <FreshnessBadge
              updatedAt={result?.fetchedAt}
              error={query.isError ? errorLines(query.error).join(' · ') : null}
              staleAfterMs={result?.freshness === 'indexed' ? 180_000 : 90_000}
            />
          </div>
        )}
      </div>

      {query.isError && result && <RefreshWarning error={query.error} updatedAt={result.fetchedAt} />}

      <ErrorBoundary label="Watchlist table" resetKeys={[win]} className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-panel p-4 text-center">
        <TokenTable
          rows={visible}
          win={win}
          sort={sort}
          onSort={onSort}
          variant="watchlist"
          loading={loading}
          skeletonRows={result ? pending.length : 0}
          missing={result ? missing : undefined}
          empty={empty}
          caption={`Watchlist tokens, ${win} window`}
        />
      </ErrorBoundary>

      <SourceFooter
        result={count > 0 ? result : undefined}
        winner={winner}
        enrichment={count > 0 ? enrichment.data : undefined}
        rows={visible}
        count={
          hydrated && count > 0 ? (
            <>
              {visible.length} of {count} token{count === 1 ? '' : 's'}
              {missing.length > 0 && <span className="text-faint"> · {missing.length} not listed</span>}
            </>
          ) : hydrated ? (
            '0 tokens'
          ) : (
            'Loading watchlist'
          )
        }
      />
    </div>
  );
}
