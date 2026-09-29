'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { computePnl } from '@/lib/analytics/pnl';
import type { PnlReport } from '@/lib/core/types';
import {
  activityMints,
  assemblePnlInput,
  mergeActivityItems,
  nextPnlTarget,
  openPositionMints,
  PNL_AUTO_PAGES,
  PNL_MAX_PAGES,
  type ActivityCoverage,
} from '@/lib/services/wallet';
import { POLL } from '../query';
import { jup } from '../sources';
import { useMintIdentities, walletKeys, type MintIdentities } from './usePortfolio';
import { useSolPrice } from './useSolPrice';
import { useWalletActivity, type WalletActivityView } from './useWalletActivity';

const EMPTY_MINTS: readonly string[] = [];

export interface WalletPnlView {
  /** FIFO, SOL-denominated report over the loaded pages; undefined until the first page arrives. */
  report: PnlReport | undefined;
  coverage: ActivityCoverage;
  identities: MintIdentities;
  activity: WalletActivityView;
  /** Pages loaded so far and the number the analysis is working towards. */
  pagesLoaded: number;
  target: number;
  /** Still fetching pages towards `target`. */
  analyzing: boolean;
  /** More history exists and the cap (30 pages) is not reached. */
  canAnalyzeMore: boolean;
  analyzeMore: () => void;
  /** Open positions priced for unrealized PnL / open positions in total. */
  pricedOpen: number;
  openPositions: number;
  pricesError: unknown;
  solPriceUsd: number | undefined;
}

/**
 * Progressive wallet PnL: loads activity pages automatically up to 3 (or
 * until history is exhausted), then 3 more per "Analyze more" (cap 30).
 * Unrealized PnL uses current Jupiter USD prices ÷ the SOL price (SOL
 * denominated like the rest of the report). Shares the activity page cache
 * with the Activity tab.
 */
export function useWalletPnl(address: string): WalletPnlView {
  const activity = useWalletActivity(address);
  const sol = useSolPrice();
  // The target is keyed by wallet so a different address starts over without an effect.
  const [goal, setGoal] = useState<{ address: string; target: number }>({ address, target: PNL_AUTO_PAGES });
  const target = goal.address === address ? goal.target : PNL_AUTO_PAGES;

  const { infinite } = activity;
  const pages = infinite.data?.pages;
  const pagesLoaded = pages?.length ?? 0;
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = infinite;

  useEffect(() => {
    if (pagesLoaded === 0 || pagesLoaded >= target || !hasNextPage || isFetchingNextPage || isError) return;
    void fetchNextPage({ cancelRefetch: false });
  }, [pagesLoaded, target, hasNextPage, isFetchingNextPage, isError, fetchNextPage]);

  const fetchedPages = useMemo(() => pages?.map((p) => p.data) ?? [], [pages]);
  const mints = useMemo(() => (fetchedPages.length ? activityMints(mergeActivityItems(fetchedPages)) : EMPTY_MINTS), [fetchedPages]);
  const identities = useMintIdentities(mints);
  const symbols = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [mint, identity] of Object.entries(identities.byMint)) if (identity?.symbol) out[mint] = identity.symbol;
    return out;
  }, [identities.byMint]);

  // First pass without prices decides which open positions need a current price.
  const preliminary = useMemo(
    () => (fetchedPages.length ? computePnl(assemblePnlInput({ wallet: address, pages: fetchedPages, symbols })) : undefined),
    [address, fetchedPages, symbols],
  );
  const openMints = useMemo(() => (preliminary ? openPositionMints(preliminary) : EMPTY_MINTS), [preliminary]);
  const priceKey = openMints.join(',');

  const prices = useQuery({
    queryKey: walletKeys.pnlPrices(priceKey),
    queryFn: ({ signal }) => jup.getPrices([...openMints], signal),
    enabled: openMints.length > 0,
    refetchInterval: POLL.indexed,
    staleTime: 20_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });

  const solPriceUsd = sol.data?.data.priceUsd;
  const pricesUsd = prices.data?.data;
  const report = useMemo(
    () =>
      fetchedPages.length
        ? computePnl(assemblePnlInput({ wallet: address, pages: fetchedPages, pricesUsd, solPriceUsd, symbols }))
        : undefined,
    [address, fetchedPages, pricesUsd, solPriceUsd, symbols],
  );

  const analyzeMore = useCallback(
    () => setGoal((g) => ({ address, target: nextPnlTarget(Math.max(g.address === address ? g.target : PNL_AUTO_PAGES, pagesLoaded)) })),
    [address, pagesLoaded],
  );
  const pricedOpen = useMemo(() => openMints.filter((m) => (pricesUsd?.[m] ?? 0) > 0 && (solPriceUsd ?? 0) > 0).length, [openMints, pricesUsd, solPriceUsd]);

  return {
    report,
    coverage: activity.coverage,
    identities,
    activity,
    pagesLoaded,
    target,
    analyzing: pagesLoaded < target && !!hasNextPage && !isError,
    canAnalyzeMore: !!hasNextPage && pagesLoaded < PNL_MAX_PAGES && !isError,
    analyzeMore,
    pricedOpen,
    openPositions: openMints.length,
    pricesError: prices.error,
    solPriceUsd,
  };
}
