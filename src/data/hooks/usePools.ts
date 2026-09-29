'use client';

import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { ChainResult } from '@/lib/core/chain';
import type { BondingCurveState, LaunchStage, PoolInfo } from '@/lib/core/types';
import { chainWinner, poolFromCurve, selectPrimaryPool } from '@/lib/services/token';
import { POLL } from '../query';
import { dex, gecko, isServerStale, runWithServerFallback, server } from '../sources';

/**
 * Pools / pairs for a token: DEX Screener (cheap, 300 req/min) first,
 * GeckoTerminal as the independent fallback, then ORBYT's /api/v1/pools
 * (both sources merged server-side, CDN-cached 60 s) when a browser source
 * failed, e.g. this visitor's GeckoTerminal quota is spent. Refreshed every
 * 60 s; a failed refresh keeps the last list (`delayed`). The primary pool
 * (chart + trades) is the most liquid active pool, the curve itself while
 * bonding, or the ?pool= selection.
 */

export const poolsKey = (mint: string) => ['pools', mint] as const;

export function loadPools(mint: string, signal?: AbortSignal): Promise<ChainResult<PoolInfo[]>> {
  return runWithServerFallback<PoolInfo[]>(
    'pools',
    [
      { id: 'dexscreener', run: () => dex.getPools(mint, signal) },
      { id: 'geckoterminal', run: () => gecko.getPools(mint, signal) },
    ],
    { id: 'orbyt', run: () => server.pools.getPools(mint, signal) },
    { accept: (r) => r.data.length > 0, signal },
  );
}

export function poolsOptions(mint: string) {
  return queryOptions({
    queryKey: poolsKey(mint),
    queryFn: ({ signal }) => loadPools(mint, signal),
    staleTime: 30_000,
    refetchInterval: POLL.slow,
    placeholderData: keepPreviousData,
    retry: 1,
  });
}

export interface PoolsInput {
  /** Provider-reported launch stage (Jupiter / GeckoTerminal). */
  stage?: LaunchStage;
  /** Decoded pump.fun curve (`null` = checked, not a curve). */
  curve?: BondingCurveState | null;
  /** SOL/USD for pricing a curve that providers have not indexed yet. */
  solUsd?: number;
  /** ?pool= selection. */
  override?: string;
}

export function usePools(mint: string, input: PoolsInput) {
  const query = useQuery(poolsOptions(mint));
  const listed = query.data?.data;
  const { stage, curve, solUsd, override } = input;

  const selection = useMemo(() => {
    let pools = listed ?? [];
    // A pump.fun curve that no provider lists yet is still a real venue (the curve account is the pool).
    if (curve && !curve.complete && !pools.some((p) => p.address === curve.curve)) pools = [...pools, poolFromCurve(curve, solUsd)];
    return selectPrimaryPool(mint, pools, { stage, curveComplete: curve?.complete, override: override ?? null });
  }, [mint, listed, stage, curve, solUsd, override]);

  // Stale-while-error: the previous list stays on screen; panels label it "Delayed".
  const delayed = query.data !== undefined && (query.isRefetchError || isServerStale(query.data));
  return { query, winner: chainWinner(query.data), delayed, ...selection };
}
