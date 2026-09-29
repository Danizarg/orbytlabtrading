'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useCapabilities } from '@/client/capabilities';
import type { TokenRow } from '@/lib/core/types';
import { enrichRows, loadTokenRows, orderByMints, stableFetchSet } from '@/lib/services/discover';
import { dex, gecko, jup, server } from '../sources';
import { pollFor, useEnrichmentSnapshot, useRowEnrichment, winnerOf } from './useDiscover';

/** Refresh cadence: Jupiter / keyed server every 20 s; GeckoTerminal fallback every 60 s (its cache age). */
const POLL_ROWS = 20_000;
const POLL_ROWS_INDEXED = 60_000;

/**
 * Rows for arbitrary mints (the watchlist): server tokens proxy (keyed) →
 * Jupiter → GeckoTerminal → DEX Screener, gap-filled once from DEX Screener,
 * then enriched like Discover. Rows come back in the order of `mints`.
 *
 * - `pending`: mints not covered by the data on screen yet (just added).
 * - `missing`: mints no provider returned.
 */
export function useTokenRows(mints: readonly string[]) {
  const { serverDiscover } = useCapabilities();
  const sorted = useMemo(() => [...new Set(mints)].sort(), [mints]);

  // Removing a token reuses the previous (superset) request instead of spending a call.
  const [fetchSet, setFetchSet] = useState<readonly string[]>(sorted);
  const nextSet = stableFetchSet(fetchSet, sorted);
  if (nextSet !== fetchSet) setFetchSet(nextSet);

  const query = useQuery({
    queryKey: ['token-rows', nextSet.join(','), serverDiscover],
    queryFn: ({ signal }) =>
      loadTokenRows({ server: serverDiscover ? server.tokens : null, jupiter: jup, gecko, dex }, nextSet, signal),
    enabled: nextSet.length > 0,
    placeholderData: keepPreviousData,
    refetchInterval: (q) => pollFor(winnerOf(q.state.data), POLL_ROWS, POLL_ROWS_INDEXED),
    staleTime: 10_000,
    retry: 1,
  });

  const baseRows = query.data?.data;
  useRowEnrichment(baseRows);
  const enrichment = useEnrichmentSnapshot(baseRows);

  const rows = useMemo<TokenRow[] | undefined>(() => {
    if (!baseRows) return undefined;
    return orderByMints(enrichRows(baseRows, enrichment), mints);
  }, [baseRows, enrichment, mints]);

  const { missing, pending } = useMemo(() => {
    const found = new Set(rows?.map((r) => r.token.mint));
    const unknown = new Set(query.data?.missing);
    return {
      missing: mints.filter((m) => !found.has(m) && unknown.has(m)),
      pending: mints.filter((m) => !found.has(m) && !unknown.has(m)),
    };
  }, [rows, query.data, mints]);

  return { query, enrichment, rows, missing, pending, winner: winnerOf(query.data) };
}
