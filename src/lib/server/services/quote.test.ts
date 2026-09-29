import { describe, expect, it, vi } from 'vitest';
import type { QuoteRequest, TradingProvider } from '@/lib/core/providers';
import type { Sourced, SwapQuote } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import { BadRequestError, NoRouteError, NotConfiguredError } from './errors';
import { isNoRouteError, loadQuote } from './quote';

const SOL = 'So11111111111111111111111111111111111111112';
const MINT = '4ov9rwwS4iBHeTWGCrVaQYW1HzWK51MSfs8csGAApump';

const REQUEST: QuoteRequest = { inputMint: SOL, outputMint: MINT, amountRaw: '1000000000', inputDecimals: 9, outputDecimals: 6, slippageBps: 500 };

function trading(impl: (r: QuoteRequest) => Promise<Sourced<SwapQuote>>): TradingProvider & { getQuote: ReturnType<typeof vi.fn> } {
  return { id: 'jupiter', getQuote: vi.fn(impl) };
}

describe('isNoRouteError', () => {
  it('treats 400/422 and not-found answers as a final "no route"', () => {
    expect(isNoRouteError(new ProviderError('jupiter', 'http', 'jupiter: HTTP 400', { status: 400 }))).toBe(true);
    expect(isNoRouteError(new ProviderError('jupiter', 'http', 'jupiter: HTTP 422', { status: 422 }))).toBe(true);
    expect(isNoRouteError(new ProviderError('jupiter', 'not_found', 'jupiter: not found', { status: 404 }))).toBe(true);
  });

  it('keeps rate limits, server errors, timeouts, aborts and foreign errors as outages', () => {
    expect(isNoRouteError(new ProviderError('jupiter', 'rate_limited', 'jupiter: HTTP 429', { status: 429 }))).toBe(false);
    expect(isNoRouteError(new ProviderError('jupiter', 'http', 'jupiter: HTTP 503', { status: 503 }))).toBe(false);
    expect(isNoRouteError(new ProviderError('jupiter', 'timeout', 'jupiter: timeout'))).toBe(false);
    expect(isNoRouteError(new ProviderError('jupiter', 'aborted', 'jupiter: aborted'))).toBe(false);
    expect(isNoRouteError(new Error('HTTP 400'))).toBe(false);
  });
});

describe('loadQuote', () => {
  it('rejects identical mints as bad input before checking configuration', async () => {
    await expect(loadQuote({ ...REQUEST, outputMint: SOL }, { jupiter: null })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('is not configured without the Jupiter key', async () => {
    await expect(loadQuote(REQUEST, { jupiter: null })).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it('passes the validated request through and returns the real quote', async () => {
    const quote = { data: { outAmount: 123 } as unknown as SwapQuote, source: 'jupiter' as const, fetchedAt: 1, freshness: 'realtime' as const };
    const jupiter = trading(async () => quote);
    await expect(loadQuote(REQUEST, { jupiter })).resolves.toBe(quote);
    expect(jupiter.getQuote).toHaveBeenCalledWith(REQUEST);
  });

  it('turns a router rejection into NoRouteError naming the provider, and rethrows outages', async () => {
    const noRoute = trading(async () => {
      throw new ProviderError('jupiter', 'http', 'jupiter quote: Metis and Jupiter Ultra both failed', { status: 400 });
    });
    const error = await loadQuote(REQUEST, { jupiter: noRoute }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoRouteError);
    expect((error as NoRouteError).provider).toBe('jupiter');

    const limited = new ProviderError('jupiter', 'rate_limited', 'jupiter: HTTP 429', { status: 429 });
    const outage = trading(async () => {
      throw limited;
    });
    await expect(loadQuote(REQUEST, { jupiter: outage })).rejects.toBe(limited);
  });
});
