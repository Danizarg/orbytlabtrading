import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuoteRequest } from '@/lib/core/providers';
import { ProviderError } from '@/lib/net/errors';
import { minReceived } from '@/components/trade/panel/amounts';

vi.mock('@/lib/net/browser', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/net/browser')>()), browserFetcher: vi.fn() }));

const { browserFetcher } = await import('@/lib/net/browser');
const { server } = await import('../sources');
const { loadQuote, loadUltraQuote } = await import('./useQuote');

const fetcher = vi.mocked(browserFetcher);
const fixture = (file: string): unknown => JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/jupiter', file), 'utf8'));

const SOL = 'So11111111111111111111111111111111111111112';
const PUMP = '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump';
const request: QuoteRequest = { inputMint: SOL, outputMint: PUMP, amountRaw: '50000000', inputDecimals: 9, outputDecimals: 6, slippageBps: 500 };

beforeEach(() => {
  fetcher.mockReset();
  vi.restoreAllMocks();
});

describe('loadUltraQuote', () => {
  it('quotes /swap/v2/order without a taker, labelled Jupiter Ultra', async () => {
    fetcher.mockResolvedValue(fixture('swap_v2_order_quote_bonding_curve_manual_slippage.json'));
    const result = await loadUltraQuote(request);

    const [provider, url, init] = fetcher.mock.calls[0]!;
    expect(provider).toBe('jupiter');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.jup.ag/swap/v2/order');
    expect(Object.fromEntries(u.searchParams)).toEqual({ inputMint: SOL, outputMint: PUMP, amount: '50000000', slippageBps: '500' });
    expect(u.searchParams.has('taker')).toBe(false);
    // No transport retry: with the query's single retry a failing refresh costs at most 2 of the 4 Jupiter calls per 10 s.
    expect(init).toMatchObject({ label: 'jupiter swap/v2/order', retries: 0 });
    expect(init?.cacheMs).toBeUndefined();

    expect(result.source).toBe('jupiter');
    expect(result.data).toMatchObject({ router: 'Jupiter Ultra', route: ['Pump.fun'], slippageBps: 500, feeBps: 10, inAmount: 0.05, outAmount: 493_502.569631 });
    expect(result.data.priceImpactPct).toBeCloseTo(3.0978, 3);
    // The panel's min. received matches Jupiter's otherAmountThreshold (468827441149 raw, 6 decimals).
    expect(minReceived(result.data.outAmount, result.data.slippageBps)).toBeCloseTo(468_827.441149, 5);
  });
});

describe('loadQuote', () => {
  it('uses the Ultra quote first', async () => {
    fetcher.mockResolvedValue(fixture('swap_v2_order_quote_bonding_curve_manual_slippage.json'));
    const spy = vi.spyOn(server.quote, 'getQuote');
    const result = await loadQuote(request, true);
    expect(result.data.router).toBe('Jupiter Ultra');
    expect(result.attempts).toEqual([{ provider: 'jupiter', ok: true }]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to ORBYT’s keyed quote route when configured, and keeps the Jupiter failure visible', async () => {
    fetcher.mockRejectedValue(new ProviderError('jupiter', 'rate_limited', 'jupiter swap/v2/order: HTTP 429', { status: 429 }));
    const quote = { inputMint: SOL, outputMint: PUMP, inAmount: 0.05, outAmount: 490_000, route: ['Pump.fun'], router: 'Metis', fetchedAt: 1 };
    vi.spyOn(server.quote, 'getQuote').mockResolvedValue({ data: quote, source: 'orbyt', fetchedAt: 1, freshness: 'realtime' });
    const result = await loadQuote(request, true);
    expect(result.data.router).toBe('Metis');
    expect(result.attempts.map((a) => [a.provider, a.ok])).toEqual([
      ['jupiter', false],
      ['orbyt', true],
    ]);
  });

  it('without a configured server quote, the Jupiter error surfaces', async () => {
    fetcher.mockRejectedValue(new ProviderError('jupiter', 'http', 'jupiter swap/v2/order: HTTP 500', { status: 500 }));
    const spy = vi.spyOn(server.quote, 'getQuote');
    await expect(loadQuote(request, false)).rejects.toMatchObject({ name: 'ChainError' });
    expect(spy).not.toHaveBeenCalled();
  });
});
