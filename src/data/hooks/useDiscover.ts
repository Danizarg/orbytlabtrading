'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useCapabilities } from '@/client/capabilities';
import { ChainError, type ChainResult } from '@/lib/core/chain';
import type { DiscoverWindow, ProviderId } from '@/lib/core/providers';
import type { Sourced, TokenRow } from '@/lib/core/types';
import { browserFetcher, isBrowserCoolingDown } from '@/lib/net/browser';
import { ProviderError, type ProviderErrorCode } from '@/lib/net/errors';
import { DEXSCREENER_BASE_URL } from '@/lib/providers/dexscreener';
import {
  baseListOf,
  createEnrichmentCache,
  createUniverseLoader,
  DEFAULT_WINDOW,
  EMPTY_ENRICHMENT_REVISION,
  errorLines,
  geckoListPath,
  loadDexPromoted,
  loadDiscoverList,
  loadGeckoList,
  mintSetKey,
  toGainers,
  visibleFailures,
  type DiscoverListKey,
  type EnrichmentCache,
  type EnrichmentSnapshot,
  type UniverseLoader,
  type UniverseSnapshot,
  type UniverseSourceDef,
} from '@/lib/services/discover';
import { POLL } from '../query';
import { dex, gecko, jup, server } from '../sources';

/**
 * Discover data.
 *
 * - Named lists (trending / top / organic / new / gainers): one ranked list
 *   over the failover chain server proxy → Jupiter → GeckoTerminal, polled
 *   every 15 s (30 s once it fell back to GeckoTerminal, i.e. ≤ 2 GeckoTerminal
 *   calls a minute).
 * - "All": the universe loader below, every keyless list merged by mint and
 *   refreshed one provider-call at a time within the keyless budgets.
 * - Fill-only enrichment (Jupiter Ultra risk extras, DEX Screener pools) is
 *   shared by both and by the watchlist; Ultra is called at most once per
 *   30 s, so Jupiter sees at most 2 requests in any 15 s window from a
 *   named list.
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

// ---------------------------------------------------------------------------
// Enrichment (shared by Discover, the universe and the watchlist)
// ---------------------------------------------------------------------------

// One enrichment cache per browser session.
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
 * Fetch trigger: enrichment for the target rows (on screen first), keyed on
 * their mint set. The cache fetches only new or stale mints (≥ 55 s), at most
 * one Ultra batch of 100 per 30 s (never-fetched mints first), so re-running
 * every 30 s is cheap and a list whose membership shifts slightly costs one
 * small request. Rendering reads the cache through `useEnrichmentSnapshot`.
 */
export function useRowEnrichment(rows: readonly TokenRow[] | undefined) {
  const mintKey = useMemo(() => mintSetKey(rows), [rows]);
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

const getServerRevision = () => EMPTY_ENRICHMENT_REVISION;

/**
 * Enrichment snapshot for `rows` straight from the shared cache (no fetch).
 * Re-derived whenever a fetch settles, so enriched rows are a pure function
 * of (rows, cache revision): no state syncing, no effects.
 */
export function useEnrichmentSnapshot(rows: readonly TokenRow[] | undefined): EnrichmentSnapshot | undefined {
  const store = enrichmentCache();
  const revision = useSyncExternalStore(store.subscribe, store.revision, getServerRevision);
  return useMemo(() => (rows?.length ? revision.peek(rows) : undefined), [revision, rows]);
}

// ---------------------------------------------------------------------------
// Named lists
// ---------------------------------------------------------------------------

export function useDiscover(list: DiscoverListKey, window: DiscoverWindow, enabled = true) {
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
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: (q) => pollFor(winnerOf(q.state.data), POLL.discovery, POLL.indexed),
    staleTime: 10_000,
    retry: 1,
  });

  return { query, winner: winnerOf(query.data) };
}

// ---------------------------------------------------------------------------
// Universe ("All")
// ---------------------------------------------------------------------------

/** A failed chain becomes one provider error so the source status line reads "Jupiter trending: rate limited". */
function unwrapChain(error: unknown): never {
  if (error instanceof ChainError) {
    const last = visibleFailures(error.attempts).at(-1);
    const code = (last?.code ?? 'http') as ProviderErrorCode;
    throw new ProviderError(last?.provider ?? 'jupiter', code, errorLines(error).join(' · '));
  }
  throw error;
}

const GECKO_PAGE: Partial<Record<UniverseSourceDef['id'], { kind: 'pools' | 'new_pools'; page: number; sort?: 'h24_volume_usd_desc' | 'h24_tx_count_desc' }>> = {
  'gt-vol-1': { kind: 'pools', page: 1, sort: 'h24_volume_usd_desc' },
  'gt-vol-2': { kind: 'pools', page: 2, sort: 'h24_volume_usd_desc' },
  'gt-vol-3': { kind: 'pools', page: 3, sort: 'h24_volume_usd_desc' },
  'gt-tx-1': { kind: 'pools', page: 1, sort: 'h24_tx_count_desc' },
  'gt-tx-2': { kind: 'pools', page: 2, sort: 'h24_tx_count_desc' },
  'gt-tx-3': { kind: 'pools', page: 3, sort: 'h24_tx_count_desc' },
  'gt-new-1': { kind: 'new_pools', page: 1 },
  'gt-new-2': { kind: 'new_pools', page: 2 },
};

/** Real fetch per universe source (keyless browser calls; keyed server route first for Jupiter lists when configured). */
function universeFetch(serverDiscover: boolean) {
  const jupiterSources = { server: serverDiscover ? server.discover : null, jupiter: jup, gecko: null };
  return (def: UniverseSourceDef, window: DiscoverWindow, signal: AbortSignal): Promise<Sourced<TokenRow[]>> => {
    switch (def.id) {
      case 'jup-trending':
        return loadDiscoverList(jupiterSources, 'trending', window, signal).catch(unwrapChain);
      case 'jup-top':
        return loadDiscoverList(jupiterSources, 'top', window, signal).catch(unwrapChain);
      case 'jup-organic':
        return loadDiscoverList(jupiterSources, 'organic', window, signal).catch(unwrapChain);
      case 'jup-new':
        return loadDiscoverList(jupiterSources, 'new', window, signal).catch(unwrapChain);
      case 'gt-trending':
        return gecko.discover({ list: 'trending', window }, signal);
      case 'ds-promoted':
        return loadDexPromoted(browserFetcher, dex, DEXSCREENER_BASE_URL, signal);
      default: {
        const page = GECKO_PAGE[def.id];
        if (!page) return Promise.reject(new ProviderError('orbyt', 'unsupported', `orbyt: unknown universe source ${def.id}`));
        const label = `${page.kind === 'pools' ? (page.sort === 'h24_tx_count_desc' ? 'top pools by transactions' : 'top pools by volume') : 'new pools'} p${page.page}`;
        return loadGeckoList(browserFetcher, geckoListPath(page.kind, page.page, page.sort), label, signal);
      }
    }
  };
}

// One loader per browser session (per capability set), so leaving and returning to Discover paints instantly.
const loaders = new Map<boolean, UniverseLoader>();
function universeLoader(serverDiscover: boolean): UniverseLoader {
  let loader = loaders.get(serverDiscover);
  if (!loader) {
    loader = createUniverseLoader({ fetch: universeFetch(serverDiscover), coolingDown: isBrowserCoolingDown });
    loaders.set(serverDiscover, loader);
  }
  return loader;
}

const EMPTY_SNAPSHOT: UniverseSnapshot = { window: DEFAULT_WINDOW, entries: {}, rows: [], contributors: [], settling: true, running: false };
const getEmptySnapshot = () => EMPTY_SNAPSHOT;

/**
 * The merged universe for the "All" tab. Runs only while `enabled` and the
 * tab is visible; pausing keeps every row so the table never blanks.
 */
export function useUniverse(window: DiscoverWindow, enabled = true): { snapshot: UniverseSnapshot; retry: () => void } {
  const { serverDiscover } = useCapabilities();
  const loader = universeLoader(serverDiscover);
  const snapshot = useSyncExternalStore(loader.subscribe, loader.getSnapshot, getEmptySnapshot);

  useEffect(() => {
    if (enabled) loader.setWindow(window);
  }, [loader, enabled, window]);

  useEffect(() => {
    if (!enabled) return;
    const sync = () => {
      if (document.hidden) loader.stop();
      else loader.start();
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      loader.stop();
    };
  }, [loader, enabled]);

  return { snapshot, retry: loader.retry };
}
