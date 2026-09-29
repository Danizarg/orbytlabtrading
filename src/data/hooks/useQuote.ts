'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCapabilities } from '@/client/capabilities';
import { runChain, type ChainResult } from '@/lib/core/chain';
import type { QuoteRequest } from '@/lib/core/providers';
import type { Sourced, SwapQuote } from '@/lib/core/types';
import { browserFetcher } from '@/lib/net/browser';
import { JUPITER_BASE_URL, JUPITER_ID, parseUltraOrder } from '@/lib/providers/jupiter';
import { buildQuoteRequest, quoteMatchesRequest, type QuoteSide } from '@/lib/services/token';
import { POLL } from '../query';
import { server } from '../sources';

/**
 * Live swap quote for the trade panel, from the same Jupiter product that
 * executes the trade: GET /swap/v2/order WITHOUT a taker (a quote only, no
 * transaction; labelled "Jupiter Ultra"), keyless from the browser through
 * the Jupiter budget. ORBYT's keyed quote route is the fallback when it is
 * configured (e.g. this browser is rate limited). Debounced 400 ms, only
 * while the panel is mounted and the amount is positive, refreshed every
 * 10 s while the tab is visible, and paused while a trade is in flight.
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

/** Jupiter Ultra quote: /swap/v2/order without a taker (the product the panel executes with). */
export async function loadUltraQuote(request: QuoteRequest, signal?: AbortSignal): Promise<Sourced<SwapQuote>> {
  const params = new URLSearchParams({ inputMint: request.inputMint, outputMint: request.outputMint, amount: request.amountRaw });
  if (request.slippageBps !== undefined) params.set('slippageBps', String(request.slippageBps));
  const payload = await browserFetcher<unknown>(JUPITER_ID, `${JUPITER_BASE_URL}/swap/v2/order?${params.toString()}`, {
    label: 'jupiter swap/v2/order',
    // A quote is only useful fresh: no response cache, and no transport retry. The query retries
    // once, so a failing refresh costs at most 2 of the browser's 4 Jupiter calls per 10 s (a
    // transport retry on top would spend all 4 and starve the page's other Jupiter reads).
    retries: 0,
    signal,
  });
  const fetchedAt = Date.now();
  return { data: parseUltraOrder(payload, request, request.slippageBps, fetchedAt), source: JUPITER_ID, fetchedAt, freshness: 'realtime' };
}

export function loadQuote(request: QuoteRequest, serverQuote: boolean, signal?: AbortSignal): Promise<ChainResult<SwapQuote>> {
  return runChain<SwapQuote>(
    'quote',
    [
      { id: JUPITER_ID, run: () => loadUltraQuote(request, signal) },
      serverQuote && { id: 'orbyt', run: () => server.quote.getQuote(request, signal) },
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
  /** Keep the current quote on screen but stop refreshing it (a trade is in flight). */
  paused?: boolean;
}

export function useQuote(input: QuoteInput) {
  const { serverQuote } = useCapabilities();
  const amount = useDebouncedValue(input.amount, QUOTE_DEBOUNCE_MS);
  // Slippage is debounced too: clicking through the presets or typing a custom value must not
  // spend one Jupiter request (of the browser's 4 per 10 s) per intermediate value.
  const slippageBps = useDebouncedValue(input.slippageBps, QUOTE_DEBOUNCE_MS);
  const { mint, side, tokenDecimals } = input;
  const request = useMemo(() => buildQuoteRequest({ side, mint, amount, tokenDecimals, slippageBps }), [side, mint, amount, tokenDecimals, slippageBps]);
  const enabled = (input.enabled ?? true) && request !== undefined;
  const paused = input.paused ?? false;

  const query = useQuery({
    queryKey: ['quote', request?.inputMint ?? '', request?.outputMint ?? '', request?.amountRaw ?? '', request?.slippageBps ?? 0, serverQuote],
    queryFn: ({ signal }) => {
      if (!request) throw new Error('quote: no request');
      return loadQuote(request, serverQuote, signal);
    },
    enabled,
    refetchInterval: paused ? false : POLL.fast,
    refetchOnWindowFocus: !paused,
    staleTime: 5_000,
    // While a new amount is quoted, keep the previous quote on screen (marked stale) only for the same
    // pair direction: a buy quote must never stand in for a sell and vice versa.
    placeholderData: (previous) => (quoteMatchesRequest(previous?.data, request) ? previous : undefined),
    retry: 1,
  });

  // Leaving the pause (a trade just finished): refresh right away when the quote on screen is due.
  const { refetch, dataUpdatedAt } = query;
  const wasPaused = useRef(paused);
  useEffect(() => {
    const resumed = wasPaused.current && !paused;
    wasPaused.current = paused;
    if (resumed && enabled && Date.now() - dataUpdatedAt >= POLL.fast) void refetch();
  }, [paused, enabled, dataUpdatedAt, refetch]);

  const debouncing = input.amount !== amount || input.slippageBps !== slippageBps;
  // A cleared or invalid amount disables the query: show no quote rather than the last one.
  const result = enabled ? query.data : undefined;
  return {
    quote: result?.data,
    result,
    request,
    /** The typed amount or slippage is newer than the debounced one. */
    debouncing,
    /** The quote on screen belongs to a previous amount / slippage (a new one is loading). */
    stale: result !== undefined && (query.isPlaceholderData || debouncing),
    error: enabled ? (query.error ?? undefined) : undefined,
    isPending: enabled && query.isPending,
    isFetching: query.isFetching,
    query,
  };
}
