'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { runChain, type ChainResult } from '@/lib/core/chain';
import type { BondingCurveState } from '@/lib/core/types';
import { POLL } from '../query';
import { browserCurves, server } from '../sources';

/**
 * Decoded pump.fun bonding curve for one mint, read on-chain every 3 s while
 * the curve is live (browser publicnode RPC first, ORBYT's RPC route as the
 * fallback). `null` means the account exists on neither read: the token is
 * not (or no longer) a pump.fun curve, so polling slows right down.
 */

export const bondingCurveKey = (mint: string) => ['bonding-curve', mint] as const;

export async function loadBondingCurve(mint: string, signal?: AbortSignal): Promise<ChainResult<BondingCurveState | null>> {
  const result = await runChain<Record<string, BondingCurveState>>(
    'bonding-curve',
    [
      { id: 'solana-rpc', run: () => browserCurves.getCurves([mint], signal) },
      { id: 'orbyt', run: () => server.curves.getCurves([mint], signal) },
    ],
    { signal },
  );
  return { ...result, data: result.data[mint] ?? null };
}

/** Poll cadence: live curve 3 s; completed or absent curve once a minute (a migration only flips `complete` once). */
export function curvePollInterval(curve: BondingCurveState | null | undefined): number {
  if (curve === undefined) return POLL.realtime;
  if (curve === null || curve.complete) return POLL.slow;
  return POLL.realtime;
}

export function useBondingCurve(mint: string, enabled: boolean) {
  return useQuery({
    queryKey: bondingCurveKey(mint),
    queryFn: ({ signal }) => loadBondingCurve(mint, signal),
    enabled,
    // Both RPC reads failing is transient: back off to 10 s instead of hammering both every 3 s.
    refetchInterval: (query) => (query.state.status === 'error' || query.state.fetchFailureCount > 0 ? POLL.fast : curvePollInterval(query.state.data?.data)),
    staleTime: 2_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });
}
