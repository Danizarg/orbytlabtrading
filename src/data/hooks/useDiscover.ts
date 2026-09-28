'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useCapabilities } from '@/client/capabilities';
import type { ChainResult } from '@/lib/core/chain';
import type { DiscoverWindow, ProviderId } from '@/lib/core/providers';
import type { TokenRow } from '@/lib/core/types';
import {
  baseListOf,
  createEnrichmentCache,
  enrichRows,
  loadDiscoverList,
  toGainers,
  type DiscoverListKey,
  type EnrichmentCache,
  type EnrichmentSnapshot,
} from '@/lib/services/discover';
import { POLL } from '../query';
import { dex, gecko, jup, server } from '../sources';

/**
 * Discover data: one ranked list (server proxy → Jupiter → GeckoTerminal)
 * plus fill-only enrichment (Jupiter Ultra risk extras, DEX Screener pools).
 *
 * Keyless budget per browser on this page: the list polls every 15 s
 * (30 s when it fell back to GeckoTerminal, i.e. ≤ 2 GeckoTerminal calls a
 * minute) and Ultra is called at most once per 30 s, so Jupiter sees at most
 * 2 requests in any 15 s window from Discover.
 */

/** Provider whose step answered the chain ('orbyt' when the server route did). */
export function winnerOf(result: { attempts: ChainResult<unknown>['attempts'] } | undefined): ProviderId | undefined {
  return result?.attempts.find((a) => a.ok)?.provider;
}

/** Browser-called indexed sources are polled at their cache age, not faster. */
export function pollFor(winner: ProviderId | undefined, fast: number, indexed: number): number {
  return winner === 'geckoterminal' || winner === 'dexscreener' ? indexed : fast;
}

export const discoverKeys = {
  list: (list: DiscoverListKey, window: DiscoverWindow, serverDiscover: boolean) => {
    const base = baseListOf(list);
    // Jupiter's and GeckoTerminal's "new" lists ignore the window: don't refetch on window change.
    return ['discover', base, base === 'new' ? 'any' : window, serverDiscover] as const;
  },
  enrichment: (mintKey: string) => ['row-enrichment', mintKey] as const,
};

// One enrichment cache per browser session, shared by Discover and the watchlist.
let cache: EnrichmentCache | undefined;
function enrichmentCache(): EnrichmentCache {
  cache ??= createEnrichmentCache({
    // No abort signal: results land in the shared cache even if the view moved on,
    // and unsignalled calls are de-duplicated by the browser transport.
    ultra: async (mints) => (await jup.getUltraInfo(mints)).data,
    dexRows: async (mints) => (await dex.getRows(mints)).data,
  });
  return cache;
}

/**
 * Enrichment for the rows on screen, keyed on their mint set. The cache
 * fetches only new or stale mints (≥ 55 s), so re-running every 30 s is cheap
 * and a list whose membership shifts slightly costs one small request.
 */
export function useRowEnrichment(rows: readonly TokenRow[] | undefined) {
  const mintKey = useMemo(() => (rows?.length ? [...new Set(rows.map((r) => r.token.mint))].sort().join(',') : ''), [rows]);
  return useQuery<EnrichmentSnapshot>({
    queryKey: discoverKeys.enrichment(mintKey),
    queryFn: () => enrichmentCache().load(rows ?? []),
    enabled: mintKey.length > 0,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    staleTime: 25_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useDiscover(list: DiscoverListKey, window: DiscoverWindow) {
  const { serverDiscover } = useCapabilities();
  const base = baseListOf(list);
  const select = useCallback(
    (result: ChainResult<TokenRow[]>) => (list === 'gainers' ? toGainers(result, window) : result),
    [list, window],
  );

  const query = useQuery({
    queryKey: discoverKeys.list(list, window, serverDiscover),
    queryFn: ({ signal }) =>
      loadDiscoverList({ server: serverDiscover ? server.discover : null, jupiter: jup, gecko }, base, window, signal),
    select,
    placeholderData: keepPreviousData,
    refetchInterval: (q) => pollFor(winnerOf(q.state.data), POLL.discovery, POLL.indexed),
    staleTime: 10_000,
    retry: 1,
  });

  const enrichment = useRowEnrichment(query.data?.data);
  const rows = useMemo(() => (query.data ? enrichRows(query.data.data, enrichment.data) : undefined), [query.data, enrichment.data]);

  return { query, enrichment, rows, winner: winnerOf(query.data) };
}
