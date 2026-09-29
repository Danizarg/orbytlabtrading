'use client';

import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { isSolanaAddress } from '@/lib/core/solana';
import type { Sourced, WalletActivity, WalletActivityPage } from '@/lib/core/types';
import { ACTIVITY_PAGE_SIZE, activityCoverage, mergeActivityItems, type ActivityCoverage } from '@/lib/services/wallet';
import { server } from '../sources';
import { walletKeys } from './usePortfolio';

/** Newest page refresh cadence (the server caches it 3–5 s; the RPC path costs up to 16 calls). */
export const ACTIVITY_HEAD_POLL_MS = 20_000;

export interface ActivitySection {
  /** 1-based page number as fetched (page 1 also carries live head items). */
  page: number;
  /** Signatures the index returned for this page (including failed / unparsed ones). */
  scanned: number;
  items: WalletActivity[];
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
  /** Refresh failure while older data is still shown. */
  refreshError: unknown;
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
  });
}

function useActivityHead(address: string, enabled: boolean) {
  return useQuery({
    queryKey: walletKeys.activityHead(address),
    queryFn: ({ signal }) => server.activity.getActivity(address, { limit: ACTIVITY_PAGE_SIZE }, signal),
    enabled: enabled && isSolanaAddress(address),
    refetchInterval: ACTIVITY_HEAD_POLL_MS,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
    retry: 1,
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
  const head = useActivityHead(address, infinite.isSuccess);

  const pages = infinite.data?.pages;
  const headPage = head.data?.data;

  const { items, sections } = useMemo(() => {
    const fetched = pages?.map((p) => p.data) ?? [];
    if (!fetched.length && !headPage) return { items: [] as WalletActivity[], sections: [] as ActivitySection[] };
    const seen = new Set<string>();
    const out: ActivitySection[] = [];
    fetched.forEach((page, i) => {
      const merged = i === 0 && headPage ? mergeActivityItems([headPage, page]) : mergeActivityItems([page]);
      const items = merged.filter((a) => {
        if (seen.has(a.signature)) return false;
        seen.add(a.signature);
        return true;
      });
      out.push({ page: i + 1, scanned: i === 0 && headPage ? headPage.scanned : page.scanned, items });
    });
    return { items: out.flatMap((s) => s.items), sections: out };
  }, [pages, headPage]);

  const coverage = useMemo(() => activityCoverage(pages?.map((p) => p.data) ?? [], items.length), [pages, items.length]);

  const updatedAt = head.data && !head.isPlaceholderData ? head.data.fetchedAt : pages?.[0]?.fetchedAt;
  const refreshError = head.isError ? head.error : infinite.isError && pages?.length ? infinite.error : undefined;

  return { infinite, head, items, sections, coverage, updatedAt, refreshError };
}
