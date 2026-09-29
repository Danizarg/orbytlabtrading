'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { computePnl } from '@/lib/analytics/pnl';
import { isSolanaAddress } from '@/lib/core/solana';
import { ACTIVITY_PAGE_SIZE, assemblePnlInput, retryDelayMs } from '@/lib/services/wallet';
import { server } from '@/data/sources';
import { positionCost, type PositionCost } from './position';

export const positionKeys = {
  activity: (address: string) => ['trade', 'position-activity', address] as const,
};

/**
 * FIFO average cost of the connected wallet's holding, from its newest
 * activity page (15 transactions, ORBYT's activity route). Runs only while
 * the wallet holds the token, once per minute at most, and again after a
 * trade (the panel invalidates the key).
 */
export function usePositionCost(address: string | null, mint: string, balance: number | undefined) {
  const owner = address && isSolanaAddress(address) ? address : '';
  const enabled = owner.length > 0 && balance !== undefined && balance > 0;

  const query = useQuery({
    queryKey: positionKeys.activity(owner),
    queryFn: ({ signal }) => server.activity.getActivity(owner, { limit: ACTIVITY_PAGE_SIZE }, signal),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    retryDelay: retryDelayMs,
  });

  const page = query.data?.data;
  const cost = useMemo<PositionCost | undefined>(() => {
    if (!enabled || !page || balance === undefined) return undefined;
    return positionCost(computePnl(assemblePnlInput({ wallet: owner, pages: [page] })), mint, balance);
  }, [enabled, page, owner, mint, balance]);

  return { cost, isPending: enabled && query.isPending, error: enabled ? (query.error ?? undefined) : undefined };
}
