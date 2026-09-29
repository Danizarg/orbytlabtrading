'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { runChain } from '@/lib/core/chain';
import { MINTS } from '@/lib/core/solana';
import type { SolPrice, Sourced } from '@/lib/core/types';
import { qk } from '../query';
import { gecko, jup } from '../sources';

/**
 * SOL/USD price used across the app (market caps from SOL-denominated data,
 * USD estimates). Jupiter Price V3 first, GeckoTerminal as fallback.
 */
export async function loadSolPrice(signal?: AbortSignal): Promise<Sourced<SolPrice>> {
  return runChain<SolPrice>(
    'sol-price',
    [
      { id: 'jupiter', run: () => jup.getSolPrice(signal) },
      {
        id: 'geckoterminal',
        run: async () => {
          const r = await gecko.getMarkets([MINTS.SOL], signal);
          const m = r.data[MINTS.SOL];
          if (!m?.priceUsd) throw new Error('geckoterminal: SOL price unavailable');
          return { ...r, data: { priceUsd: m.priceUsd, change24hPct: m.stats.h24?.priceChangePct, updatedAt: r.fetchedAt } };
        },
      },
    ],
    { signal },
  );
}

/** Shared SOL/USD price query (30 s refresh; one request per browser for the whole app). */
export function useSolPrice() {
  return useQuery({
    queryKey: qk.solPrice(),
    queryFn: ({ signal }) => loadSolPrice(signal),
    refetchInterval: 30_000,
    staleTime: 20_000,
    placeholderData: keepPreviousData,
  });
}
