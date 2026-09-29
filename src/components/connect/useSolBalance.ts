'use client';

import { useQuery } from '@tanstack/react-query';
import { LAMPORTS_PER_SOL } from '@/lib/core/solana';
import { isAbortError } from '@/lib/net/errors';
import { browserRpc, server } from '@/data/sources';

export interface SolBalance {
  sol: number;
  /** Where the number came from, for the tooltip. */
  source: 'Solana RPC (publicnode)' | 'ORBYT server RPC';
  fetchedAt: number;
}

/**
 * Native SOL balance of the connected wallet: the browser-allowed public RPC
 * first, ORBYT's server portfolio route (server-side RPC) as the fallback.
 * Only runs while `enabled` (the account menu is open).
 */
export function useSolBalance(address: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['connect', 'sol-balance', address],
    enabled: !!address && enabled,
    staleTime: 10_000,
    refetchInterval: enabled ? 30_000 : false,
    queryFn: async ({ signal }): Promise<SolBalance> => {
      const owner = address!;
      try {
        const lamports = await browserRpc.getBalance(owner, signal);
        return { sol: lamports / LAMPORTS_PER_SOL, source: 'Solana RPC (publicnode)', fetchedAt: Date.now() };
      } catch (e) {
        if (isAbortError(e)) throw e;
        const portfolio = await server.portfolio.getPortfolio(owner, signal);
        return { sol: portfolio.data.sol, source: 'ORBYT server RPC', fetchedAt: portfolio.fetchedAt };
      }
    },
  });
}
