'use client';

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useCapabilities } from '@/client/capabilities';
import { mintInfoOptions } from '@/data/hooks/useMintInfo';
import { poolsOptions } from '@/data/hooks/usePools';
import { tokenRowOptions } from '@/data/hooks/useTokenOverview';
import { dex } from '@/data/sources';
import { runChain, type ChainResult } from '@/lib/core/chain';
import type { PoolInfo, TokenRow } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import { rowToTokenResult } from '@/lib/services/discover';

export const tradeHref = (mint: string) => `/trade/${mint}`;

/** Pointer rest time before a row counts as hover intent (skims across the table prefetch nothing). */
export const HOVER_INTENT_MS = 120;

export interface TradePrefetch {
  /** Pointer entered / focus landed on a row. */
  intent: (row: TokenRow) => void;
  /** Pointer left the table: drop a pending intent. */
  cancel: () => void;
}

/**
 * The token page's pool list from DEX Screener only. The page's own chain
 * falls back to GeckoTerminal, whose ~8 calls/min per browser feed the
 * Discover universe, so a hover never spends it: when DEX Screener has no
 * pairs (or fails) nothing is cached and the token page runs its full chain.
 * Existing pool data is left alone (the token page refetches it when stale).
 */
async function prefetchPools(client: QueryClient, mint: string): Promise<void> {
  const options = poolsOptions(mint);
  if (client.getQueryData(options.queryKey) !== undefined) return;
  try {
    await client.fetchQuery({
      ...options,
      retry: false,
      queryFn: async ({ signal }): Promise<ChainResult<PoolInfo[]>> => {
        const result = await runChain<PoolInfo[]>('pools', [{ id: 'dexscreener', run: () => dex.getPools(mint, signal) }], {
          accept: (r) => r.data.length > 0,
          signal,
        });
        if (!result.data.length) throw new ProviderError('dexscreener', 'not_found', 'dexscreener: no pairs');
        return result;
      },
    });
  } catch {
    const query = client.getQueryCache().find({ queryKey: options.queryKey, exact: true });
    if (!query || query.state.data !== undefined) return;
    // Leave no error state behind for the token page to render before its own fetch…
    if (query.getObserversCount() === 0) client.removeQueries({ queryKey: options.queryKey, exact: true });
    // …or, when the page mounted meanwhile (it joined this request), run its own full chain now.
    else void client.refetchQueries({ queryKey: options.queryKey, exact: true });
  }
}

/**
 * Warm the token page on hover intent, once per mint for this view:
 * - the route segment (router.prefetch; row links keep viewport prefetch off),
 * - the token row query, seeded from the row already on screen (same query
 *   key the token page uses, real fetch time kept; costs no request),
 * - pools (DEX Screener only) and the on-chain mint account (ORBYT route,
 *   public RPC fallback), under the token page's own query keys.
 * Jupiter and GeckoTerminal are never called here: their per-browser budgets
 * feed the Discover lists.
 */
export function usePrefetchTrade(): TradePrefetch {
  const router = useRouter();
  const client = useQueryClient();
  const { serverDiscover } = useCapabilities();
  const done = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const run = useCallback(
    (row: TokenRow) => {
      const mint = row.token.mint;
      if (done.current.has(mint)) return;
      done.current.add(mint);
      try {
        router.prefetch(tradeHref(mint));
      } catch {
        /* route prefetch is best effort */
      }
      // Typed key (DataTag): the seed must match the token page's own result shape.
      const key = tokenRowOptions(mint, serverDiscover).queryKey;
      if (client.getQueryData(key) === undefined) {
        client.setQueryData(key, rowToTokenResult(row), { updatedAt: row.market.updatedAt });
      }
      void prefetchPools(client, mint);
      void client.prefetchQuery(mintInfoOptions(mint));
    },
    [router, client, serverDiscover],
  );

  const cancel = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const intent = useCallback(
    (row: TokenRow) => {
      cancel();
      if (done.current.has(row.token.mint)) return;
      timer.current = setTimeout(() => {
        timer.current = undefined;
        run(row);
      }, HOVER_INTENT_MS);
    },
    [cancel, run],
  );

  useEffect(() => cancel, [cancel]);

  return useMemo(() => ({ intent, cancel }), [intent, cancel]);
}
