'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useCapabilities } from '@/client/capabilities';
import { fillMissing } from '@/lib/core/chain';
import type { HolderSnapshot, Sourced } from '@/lib/core/types';
import { POLL } from '../query';
import { server } from '../sources';

/**
 * Holder list from ORBYT's holders route (Helius / Birdeye / Solana Tracker)
 * when a key backs it; otherwise the GeckoTerminal holder summary (count and
 * concentration, no list) that the token-info query already carries.
 */

export const HOLDERS_LIMIT = 50;
export const HOLDER_LIST_NOTE = 'Holder list requires a Helius, Birdeye or Solana Tracker key';

export const holdersKey = (mint: string) => ['holders', mint] as const;

export function useHolders(mint: string, input: { summary?: Sourced<HolderSnapshot>; summaryError?: unknown }) {
  const { serverHolders } = useCapabilities();
  const query = useQuery({
    queryKey: holdersKey(mint),
    queryFn: ({ signal }) => server.holders.getHolders(mint, HOLDERS_LIMIT, signal),
    enabled: serverHolders,
    refetchInterval: POLL.slow,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });

  const list = query.data;
  const { summary } = input;
  const snapshot = useMemo<HolderSnapshot | undefined>(() => {
    if (!list) return summary?.data;
    if (!summary) return list.data;
    // The keyed list may lack the token-level count / distribution: fill from the summary, never overwrite.
    return {
      ...fillMissing(list.data, { totalHolders: summary.data.totalHolders, distribution: summary.data.distribution }),
      distribution: list.data.distribution ?? summary.data.distribution,
    };
  }, [list, summary]);

  const primary = list ?? summary;
  return {
    snapshot,
    hasList: (list?.data.top.length ?? 0) > 0,
    source: primary?.source,
    contributors: list && summary && summary.source !== list.source ? [summary.source] : undefined,
    freshness: primary?.freshness,
    fetchedAt: primary?.fetchedAt,
    notes: [...new Set([...(list?.notes ?? []), ...(!list ? (summary?.notes ?? []) : [])])],
    /** A keyed holder-list provider is configured (so a missing list is a failure, not a missing key). */
    listConfigured: serverHolders,
    /** The keyed list request failed (shown next to the summary fallback). */
    listError: serverHolders && !list ? (query.error ?? undefined) : undefined,
    // Nothing to show at all. React Query reports `null` when there is no error.
    error: snapshot ? undefined : ((serverHolders ? query.error : null) ?? input.summaryError ?? undefined),
    isPending: serverHolders ? query.isPending && !summary : !summary && !input.summaryError,
    query,
  };
}
