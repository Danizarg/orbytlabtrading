'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { computePnl } from '@/lib/analytics/pnl';
import type { PnlReport } from '@/lib/core/types';
import {
  activityMints,
  assemblePnlInput,
  IDENTITY_LOOKUP_MAX,
  mergeActivityItems,
  missingPriceMints,
  nextPnlTarget,
  openPositionMints,
  openPositionStats,
  pickPrices,
  PNL_AUTO_PAGES,
  PNL_MAX_PAGES,
  pricesAsOf,
  retryDelayMs,
  type ActivityCoverage,
  type OpenPositionStats,
} from '@/lib/services/wallet';
import { POLL } from '../query';
import { jup } from '../sources';
import { useMintIdentities, walletKeys, type MintIdentities } from './usePortfolio';
import { useSolPrice } from './useSolPrice';
import { useWalletActivity, type WalletActivityView } from './useWalletActivity';

const EMPTY_MINTS: readonly string[] = [];
const EMPTY_PRICES: Readonly<Record<string, number>> = {};

export interface WalletPnlOptions {
  /**
   * Current USD prices the page already has (priced holdings). Open positions
   * found here are not requested again, which keeps the wallet page inside
   * Jupiter's 4 calls / 10 s browser budget.
   */
  knownPricesUsd?: Readonly<Record<string, number>>;
  /** False while those prices are still loading: PnL waits rather than requesting the same mints twice. */
  knownPricesSettled?: boolean;
  /** When `knownPricesUsd` was fetched. */
  knownPricesUpdatedAt?: number;
  /** Mints the page already asked a price for (priced or not); PnL does not ask Jupiter again for those. */
  attemptedMints?: ReadonlySet<string>;
}

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
  /** Loading an older page failed; retry that page (the analysis resumes towards `target`). */
  moreFailed: boolean;
  retryMore: () => void;
  /** Open / priced / valued (current price and known cost) positions in the report. */
  positions: OpenPositionStats;
  /** Age of the OLDEST price behind unrealized PnL (undefined when no open position is priced). */
  pricesUpdatedAt: number | undefined;
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
export function useWalletPnl(address: string, options: WalletPnlOptions = {}): WalletPnlView {
  const activity = useWalletActivity(address);
  const sol = useSolPrice();
  const known = options.knownPricesUsd ?? EMPTY_PRICES;
  const knownSettled = options.knownPricesSettled ?? true;
  const knownAt = options.knownPricesUpdatedAt;
  const attempted = options.attemptedMints;
  // The target is keyed by wallet so a different address starts over without an effect.
  const [goal, setGoal] = useState<{ address: string; target: number }>({ address, target: PNL_AUTO_PAGES });
  const target = goal.address === address ? goal.target : PNL_AUTO_PAGES;

  const { infinite } = activity;
  const pages = infinite.data?.pages;
  const pagesLoaded = pages?.length ?? 0;
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = infinite;

  // Walk older pages one at a time towards the target; a failed page stops the walk until retried.
  useEffect(() => {
    if (pagesLoaded === 0 || pagesLoaded >= target || !hasNextPage || isFetchingNextPage || isFetchNextPageError) return;
    void fetchNextPage({ cancelRefetch: false });
  }, [pagesLoaded, target, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  const fetchedPages = useMemo(() => pages?.map((p) => p.data) ?? [], [pages]);
  const mints = useMemo(
    () => (fetchedPages.length ? activityMints(mergeActivityItems(fetchedPages), IDENTITY_LOOKUP_MAX) : EMPTY_MINTS),
    [fetchedPages],
  );
  const identities = useMintIdentities(mints);
  const symbols = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [mint, identity] of Object.entries(identities.byMint)) if (identity?.symbol) out[mint] = identity.symbol;
    return out;
  }, [identities.byMint]);

  // Open positions do not depend on prices, so a price-free pass decides which mints need one.
  const openMints = useMemo(
    () => (fetchedPages.length ? openPositionMints(computePnl(assemblePnlInput({ wallet: address, pages: fetchedPages }))) : EMPTY_MINTS),
    [address, fetchedPages],
  );
  const missing = useMemo(
    () => (knownSettled ? missingPriceMints(openMints, known, attempted) : EMPTY_MINTS),
    [knownSettled, openMints, known, attempted],
  );
  const priceKey = missing.join(',');

  const prices = useQuery({
    queryKey: walletKeys.pnlPrices(priceKey),
    queryFn: ({ signal }) => jup.getPrices([...missing], signal),
    enabled: missing.length > 0,
    refetchInterval: POLL.indexed,
    staleTime: 20_000,
    placeholderData: keepPreviousData,
    retry: 2,
    retryDelay: retryDelayMs,
  });

  const fetched = prices.data?.data;
  const fetchedAt = prices.data?.fetchedAt;
  const pricesUsd = useMemo(() => pickPrices(openMints, [known, fetched]), [openMints, known, fetched]);
  const solPriceUsd = sol.data?.data.priceUsd;
  const report = useMemo(
    () =>
      fetchedPages.length
        ? computePnl(assemblePnlInput({ wallet: address, pages: fetchedPages, pricesUsd, solPriceUsd, symbols }))
        : undefined,
    [address, fetchedPages, pricesUsd, solPriceUsd, symbols],
  );
  const positions = useMemo(() => openPositionStats(report), [report]);
  const pricesUpdatedAt = useMemo(
    () =>
      pricesAsOf(openMints, [
        { prices: known, at: knownAt },
        { prices: fetched, at: fetchedAt },
      ]),
    [openMints, known, knownAt, fetched, fetchedAt],
  );

  const analyzeMore = useCallback(
    () => setGoal((g) => ({ address, target: nextPnlTarget(Math.max(g.address === address ? g.target : PNL_AUTO_PAGES, pagesLoaded)) })),
    [address, pagesLoaded],
  );
  const retryMore = useCallback(() => void fetchNextPage({ cancelRefetch: false }), [fetchNextPage]);

  return {
    report,
    coverage: activity.coverage,
    identities,
    activity,
    pagesLoaded,
    target,
    analyzing: pagesLoaded > 0 && pagesLoaded < target && !!hasNextPage && !isFetchNextPageError,
    canAnalyzeMore: !!hasNextPage && pagesLoaded < PNL_MAX_PAGES && !isFetchNextPageError,
    analyzeMore,
    moreFailed: isFetchNextPageError,
    retryMore,
    positions,
    pricesUpdatedAt,
    pricesError: prices.error,
    solPriceUsd,
  };
}
