'use client';

import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import { ChainError, runChain, type ChainResult } from '@/lib/core/chain';
import type { MintInfo } from '@/lib/core/types';
import { getMintInfo } from '@/lib/providers/solana';
import { browserRpc, server } from '../sources';

/**
 * On-chain mint account (supply, decimals, authorities, token program).
 * ORBYT's route (server RPC) first, the browser-allowed public RPC as the
 * independent fallback. Supply rarely changes, so this is cached for minutes.
 */

export const mintInfoKey = (mint: string) => ['mint-info', mint] as const;

export function loadMintInfo(mint: string, signal?: AbortSignal): Promise<ChainResult<MintInfo>> {
  return runChain<MintInfo>(
    'mint-info',
    [
      { id: 'orbyt', run: () => server.mint(mint, signal) },
      {
        id: 'solana-rpc',
        run: async () => {
          const info = await getMintInfo(browserRpc, mint, signal);
          return { data: info, source: 'solana-rpc', fetchedAt: info.fetchedAt, freshness: 'realtime' };
        },
      },
    ],
    { signal },
  );
}

export function mintInfoOptions(mint: string) {
  return queryOptions({
    queryKey: mintInfoKey(mint),
    queryFn: ({ signal }) => loadMintInfo(mint, signal),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchInterval: 5 * 60_000,
    placeholderData: keepPreviousData,
    // "Not a token mint" is a definitive answer, not a transient failure.
    retry: (count, error) => !(error instanceof ChainError && error.allNotFound) && count < 1,
  });
}

export function useMintInfo(mint: string) {
  return useQuery(mintInfoOptions(mint));
}
