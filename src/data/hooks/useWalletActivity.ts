'use client';

import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { isSolanaAddress } from '@/lib/core/solana';
import type { Sourced, WalletActivity, WalletActivityPage } from '@/lib/core/types';
import {
  accumulateHead,
  ACTIVITY_PAGE_SIZE,
  activityCoverage,
  mergeActivityItems,
  retryDelayMs,
  type ActivityCoverage,
  type ActivityHeadPage,
} from '@/lib/services/wallet';
import { server } from '../sources';
import { walletKeys } from './usePortfolio';

/** Newest page refresh cadence (the server caches it 3–5 s; the RPC path costs up to 16 calls). */
export const ACTIVITY_HEAD_POLL_MS = 20_000;

export interface ActivitySection {
  /** 1-based page number as fetched (page 1 also carries live head items). */
  page: number;
  /** Signatures the index returned when this page was fetched (including failed / unparsed ones). */
  scanned: number;
  items: WalletActivity[];
  /** Page 1 only: activities that arrived through the newest-page refresh after the first load. */
  added: number;
  /** Page 1 only: a refresh found a full page of newer transactions, so some in between may be missing. */
  gap: boolean;
}

export interface WalletActivityView {
  infinite: ReturnType<typeof useActivityPages>;
  head: ReturnType<typeof useActivityHead>;
  /** Newest first, de-duplicated across the live head and every loaded page. */
  items: WalletActivity[];
  /** Items grouped by fetched page, for "scanned N signatures" dividers. */
  sections: ActivitySection[];
  coverage: ActivityCoverage;
  /** When the newest data on screen was fetched (head refresh or first page). */
  updatedAt: number | undefined;
  /** Newest-page refresh failure while the last good data is still shown. */
  refreshError: unknown;
  /** Loading an older page failed ("Load older" retries it). */
  olderError: unknown;
}

function useActivityPages(address: string) {
  return useInfiniteQuery({
    queryKey: walletKeys.activity(address),
    queryFn: ({ pageParam, signal }) => server.activity.getActivity(address, { before: pageParam, limit: ACTIVITY_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: Sourced<WalletActivityPage>) => last.data.nextCursor,
    enabled: isSolanaAddress(address),
    // Confirmed pages are immutable; new transactions arrive through the head query.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 2,
    retryDelay: retryDelayMs,
  });
}

function useActivityHead(address: string, seed: Sourced<WalletActivityPage> | undefined, seededAt: number) {
  const client = useQueryClient();
  return useQuery<Sourced<ActivityHeadPage>>({
    queryKey: walletKeys.activityHead(address),
    queryFn: async ({ signal }) => {
      const fresh = await server.activity.getActivity(address, { limit: ACTIVITY_PAGE_SIZE }, signal);
      // One read returns only the newest 15 signatures; earlier reads are folded in so a busy wallet's
      // transactions do not vanish from the list between refreshes.
      const prev = client.getQueryData<Sourced<ActivityHeadPage>>(walletKeys.activityHead(address));
      const first = client.getQueryData<{ pages: Sourced<WalletActivityPage>[] }>(walletKeys.activity(address))?.pages[0];
      return { ...fresh, data: accumulateHead(prev?.data, fresh.data, first?.data.items ?? [], ACTIVITY_PAGE_SIZE) };
    },
    // Starts from the first page just loaded, so the first head refresh happens 20 s later
    // instead of re-requesting the same page (the RPC path costs up to 16 calls).
    enabled: seed !== undefined && isSolanaAddress(address),
    initialData: seed,
    initialDataUpdatedAt: seededAt,
    refetchInterval: ACTIVITY_HEAD_POLL_MS,
    staleTime: 15_000,
    retry: 1,
    retryDelay: retryDelayMs,
  });
}

/**
 * Wallet activity from the server route (RPC; Helius indexed history when
 * configured): an infinite list of 15-item pages (`nextCursor` → `before`)
 * plus a head query that re-reads the newest page every 20 s and is merged
 * by signature, so new transactions appear without refetching older pages.
 */
export function useWalletActivity(address: string): WalletActivityView {
  const infinite = useActivityPages(address);
  const pages = infinite.data?.pages;
  const head = useActivityHead(address, pages?.[0], infinite.dataUpdatedAt);
  const headPage = head.data?.data;

  const { items, sections } = useMemo(() => {
    const fetched = pages?.map((p) => p.data) ?? [];
    if (!fetched.length) return { items: [] as WalletActivity[], sections: [] as ActivitySection[] };
    const seen = new Set<string>();
    const out: ActivitySection[] = [];
    fetched.forEach((page, i) => {
      const withHead = i === 0 && headPage;
      const merged = withHead ? mergeActivityItems([headPage, page]) : mergeActivityItems([page]);
      const items = merged.filter((a) => {
        if (seen.has(a.signature)) return false;
        seen.add(a.signature);
        return true;
      });
      const own = new Set(page.items.map((a) => a.signature));
      out.push({
        page: i + 1,
        scanned: page.scanned,
        items,
        added: withHead ? items.filter((a) => !own.has(a.signature)).length : 0,
        gap: withHead ? headPage.gap === true : false,
      });
    });
    return { items: out.flatMap((s) => s.items), sections: out };
  }, [pages, headPage]);

  const coverage = useMemo(() => activityCoverage(pages?.map((p) => p.data) ?? [], items.length), [pages, items.length]);

  const updatedAt = head.data?.fetchedAt ?? pages?.[0]?.fetchedAt;
  const refreshError = head.isError ? head.error : undefined;
  const olderError = infinite.isFetchNextPageError ? infinite.error : undefined;

  return { infinite, head, items, sections, coverage, updatedAt, refreshError, olderError };
}
