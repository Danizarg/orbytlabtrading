'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useCapabilities } from '@/client/capabilities';
import { runChain, type ChainResult } from '@/lib/core/chain';
import type { QuoteRequest } from '@/lib/core/providers';
import type { SwapQuote } from '@/lib/core/types';
import { buildQuoteRequest, quoteMatchesRequest, type QuoteSide } from '@/lib/services/token';
import { POLL } from '../query';
import { jup, server } from '../sources';

/**
 * Swap quote preview. ORBYT's quote route (keyed Jupiter) when configured,
 * else the keyless Jupiter quote from the browser. Debounced 400 ms, only
 * while the panel is mounted and the amount is positive, and refreshed every
 * 10 s while the tab is visible.
 */

export const QUOTE_DEBOUNCE_MS = 400;

export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function loadQuote(request: QuoteRequest, serverQuote: boolean, signal?: AbortSignal): Promise<ChainResult<SwapQuote>> {
  return runChain<SwapQuote>(
    'quote',
    [
      serverQuote && { id: 'orbyt', run: () => server.quote.getQuote(request, signal) },
      { id: 'jupiter', run: () => jup.getQuote(request, signal) },
    ],
    { signal },
  );
}

export interface QuoteInput {
  mint: string;
  side: QuoteSide;
  /** Amount typed by the user: SOL for buys, tokens for sells. */
  amount: string;
  tokenDecimals: number | undefined;
  slippageBps: number;
  enabled?: boolean;
}

export function useQuote(input: QuoteInput) {
  const { serverQuote } = useCapabilities();
  const amount = useDebouncedValue(input.amount, QUOTE_DEBOUNCE_MS);
  const { mint, side, tokenDecimals, slippageBps } = input;
  const request = useMemo(() => buildQuoteRequest({ side, mint, amount, tokenDecimals, slippageBps }), [side, mint, amount, tokenDecimals, slippageBps]);
  const enabled = (input.enabled ?? true) && request !== undefined;

  const query = useQuery({
    queryKey: ['quote', request?.inputMint ?? '', request?.outputMint ?? '', request?.amountRaw ?? '', request?.slippageBps ?? 0, serverQuote],
    queryFn: ({ signal }) => {
      if (!request) throw new Error('quote: no request');
      return loadQuote(request, serverQuote, signal);
    },
    enabled,
    refetchInterval: POLL.fast,
    staleTime: 5_000,
    // While a new amount is quoted, keep the previous quote on screen (marked stale) only for the same
    // pair direction: a buy quote must never stand in for a sell and vice versa.
    placeholderData: (previous) => (quoteMatchesRequest(previous?.data, request) ? previous : undefined),
    retry: 1,
  });

  const debouncing = input.amount !== amount;
  // A cleared or invalid amount disables the query: show no quote rather than the last one.
  const result = enabled ? query.data : undefined;
  return {
    quote: result?.data,
    result,
    request,
    /** The typed amount is newer than the debounced one. */
    debouncing,
    /** The quote on screen belongs to a previous amount / slippage (a new one is loading). */
    stale: result !== undefined && (query.isPlaceholderData || debouncing),
    error: enabled ? (query.error ?? undefined) : undefined,
    isPending: enabled && query.isPending,
    isFetching: query.isFetching,
    query,
  };
}
