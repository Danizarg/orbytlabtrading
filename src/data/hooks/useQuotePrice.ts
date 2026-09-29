'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { ProviderId } from '@/lib/core/providers';
import type { PoolInfo } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import { impliedQuoteUsd, otherQuoteMint } from '@/lib/services/token';
import { POLL } from '../query';
import { jup } from '../sources';

/** USD price of the charted pool's quote asset, with its provenance. */
export interface QuotePrice {
  mint: string;
  symbol?: string;
  priceUsd: number;
  source: ProviderId;
  /** Implied by the pool's own USD and quote prices rather than priced directly. */
  implied: boolean;
}

export const quotePriceKey = (mint: string) => ['quote-price', mint] as const;

/**
 * USD price of a pool's quote asset when it is neither SOL nor a stablecoin
 * (e.g. GLDx on StonkFun), so on-chain trades priced in it get USD figures
 * and the chart can draw them: Jupiter Price V3 every 30 s (one call; the
 * asset moves slowly next to a fresh token), or, once Jupiter failed, the
 * price implied by the pool's own USD / quote prices. Trades keep the price
 * they were first valued at. Undefined for SOL / stable quotes.
 */
export function useQuotePrice(pool: PoolInfo | undefined): QuotePrice | undefined {
  const mint = otherQuoteMint(pool);
  const query = useQuery({
    queryKey: quotePriceKey(mint ?? ''),
    queryFn: async ({ signal }) => {
      const result = await jup.getPrices([mint as string], signal);
      const price = result.data[mint as string];
      if (price === undefined) throw new ProviderError('jupiter', 'not_found', 'jupiter: no price for the quote asset');
      return price;
    },
    enabled: mint !== undefined,
    refetchInterval: (q) => (q.state.status === 'error' ? POLL.slow : POLL.indexed),
    staleTime: 20_000,
    retry: 1,
  });
  const direct = query.data;
  const implied = query.isError ? impliedQuoteUsd(pool) : undefined;
  const symbol = pool?.quoteSymbol;
  const source = pool?.source;
  return useMemo<QuotePrice | undefined>(() => {
    if (!mint) return undefined;
    const base = symbol ? { mint, symbol } : { mint };
    if (direct !== undefined) return { ...base, priceUsd: direct, source: 'jupiter', implied: false };
    if (implied !== undefined && source) return { ...base, priceUsd: implied, source, implied: true };
    return undefined;
  }, [mint, symbol, direct, implied, source]);
}
