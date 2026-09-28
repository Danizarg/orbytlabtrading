import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProviderId, QuoteRequest } from '@/lib/core/providers';
import { isSolanaAddress } from '@/lib/core/solana';
import { isProviderError, ProviderError } from '@/lib/net/errors';
import type { JsonFetcher, JsonRequest } from '@/lib/net/types';
import { createJupiter, JUPITER_CACHE_MS } from './adapter';

type Json = Record<string, unknown>;
type Responder = unknown | ((url: string) => unknown);

interface Call {
  provider: ProviderId;
  url: string;
  init?: JsonRequest;
}

function load(file: string): unknown {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures', file), 'utf8'));
}

/** Fake transport: first route whose substring matches the URL answers (Error values are thrown). */
function fakeFetcher(routes: Array<[string, Responder]>) {
  const calls: Call[] = [];
  const fetcher: JsonFetcher = async <T,>(provider: ProviderId, url: string, init?: JsonRequest): Promise<T> => {
    calls.push({ provider, url, init });
    for (const [needle, responder] of routes) {
      if (!url.includes(needle)) continue;
      const value = typeof responder === 'function' ? (responder as (u: string) => unknown)(url) : responder;
      if (value instanceof Error) throw value;
      return structuredClone(value) as T;
    }
    throw new ProviderError(provider, 'not_found', `${init?.label ?? provider}: no fixture`);
  };
  return { fetcher, calls };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

/** Deterministic, distinct, valid base58 mints (32 bytes) for batching tests. */
function fakeMints(count: number): string[] {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const a = alphabet[Math.floor(i / 58) % 58] ?? '1';
    const b = alphabet[i % 58] ?? '1';
    // 43 chars led by 'J' always decode to exactly 32 bytes.
    out.push(`JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDv${a}${b}`);
  }
  if (!out.every(isSolanaAddress)) throw new Error('fakeMints produced an invalid address');
  return out;
}

function queryMints(url: string, param: 'query' | 'ids'): string[] {
  const value = new URL(url).searchParams.get(param) ?? '';
  return value ? value.split(',') : [];
}

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const AI6 = 'DKxXdaMC1so182urvrrnhs6V6fGTrttPS8br6JuEpump';
const FARTCOIN = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const CC = '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump';
const WALLET = 'JUPhop9E8ZfdJ5FNHhxQt4uAih822Vs4QpqsWcewFbq';

describe('createJupiter transport options', () => {
  it('is keyless by default on api.jup.ag and always labels requests', async () => {
    const { fetcher, calls } = fakeFetcher([['/price/v3', load('jupiter/price_v3_mixed_sol_usdc_graduated_bonding_illiquid.json')]]);
    const jupiter = createJupiter({ fetcher });
    expect(jupiter.id).toBe('jupiter');
    await jupiter.getPrices([SOL]);
    expect(calls[0]?.provider).toBe('jupiter');
    expect(calls[0]?.url).toBe(`https://api.jup.ag/price/v3?ids=${SOL}`);
    expect(calls[0]?.init?.headers).toBeUndefined();
    expect(calls[0]?.init?.label).toBe('jupiter price/v3');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('sends x-api-key only when a key is given and honours baseUrl', async () => {
    const { fetcher, calls } = fakeFetcher([['/price/v3', {}]]);
    const jupiter = createJupiter({ fetcher, apiKey: ' jup_test_key ', baseUrl: 'https://proxy.example/jup/' });
    await jupiter.getPrices([SOL]);
    expect(calls[0]?.url).toBe(`https://proxy.example/jup/price/v3?ids=${SOL}`);
    expect(calls[0]?.init?.headers).toEqual({ 'x-api-key': 'jup_test_key' });
    expect(calls[0]?.init?.label).not.toContain('jup_test_key');

    const blank = fakeFetcher([['/price/v3', {}]]);
    await createJupiter({ fetcher: blank.fetcher, apiKey: '  ' }).getPrices([SOL]);
    expect(blank.calls[0]?.init?.headers).toBeUndefined();
  });
});

describe('discover', () => {
  it('lists toptrending rows with ranks, window, headroom limit and cache', async () => {
    const { fetcher, calls } = fakeFetcher([['/tokens/v2/toptrending/1h', load('jupiter/tokens_v2_toptrending_1h.trimmed.json')]]);
    const before = Date.now();
    const result = await createJupiter({ fetcher }).discover({ list: 'trending', window: '1h', limit: 20 });
    expect(calls[0]?.url).toBe('https://api.jup.ag/tokens/v2/toptrending/1h?limit=25');
    expect(calls[0]?.init?.cacheMs).toBe(JUPITER_CACHE_MS.category);
    expect(result.source).toBe('jupiter');
    expect(result.freshness).toBe('fast');
    expect(result.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(result.data.map((r) => [r.rank, r.token.symbol])).toEqual([
      [1, 'CARDS'],
      [2, 'COLLECT'],
      [3, 'SI'],
    ]);
    expect(result.data[1]?.token.launchpad).toMatchObject({ stage: 'graduated', launchpad: 'pump.fun' });
    expect(result.data[0]?.market.updatedAt).toBe(result.fetchedAt);
  });

  it('filters SOL and stablecoins that the category endpoints return', async () => {
    const { fetcher, calls } = fakeFetcher([['/tokens/v2/toporganicscore/5m', load('jupiter/tokens_v2_toporganicscore_5m_limit3.json')]]);
    const result = await createJupiter({ fetcher }).discover({ list: 'organic', window: '5m' });
    expect(calls[0]?.url).toContain('/tokens/v2/toporganicscore/5m?limit=55');
    expect(result.data.map((r) => r.token.mint)).toEqual(['CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp']);
    expect(result.data[0]?.rank).toBe(1);
  });

  it('maps top → toptraded and caps the requested limit at 100', async () => {
    const { fetcher, calls } = fakeFetcher([['/tokens/v2/toptraded/24h', load('jupiter/tokens_v2_toptraded_24h_limit3.json')]]);
    const result = await createJupiter({ fetcher }).discover({ list: 'top', window: '24h', limit: 500 });
    expect(calls[0]?.url).toBe('https://api.jup.ag/tokens/v2/toptraded/24h?limit=100');
    expect(result.data.map((r) => r.token.symbol)).toEqual(['PUMP', 'cbBTC', 'ZEC']);
  });

  it('truncates to the requested limit after filtering', async () => {
    const { fetcher } = fakeFetcher([['/tokens/v2/toptrending/6h', load('jupiter/tokens_v2_toptrending_1h.trimmed.json')]]);
    const result = await createJupiter({ fetcher }).discover({ list: 'trending', window: '6h', limit: 2 });
    expect(result.data).toHaveLength(2);
  });

  it("lists 'new' from /tokens/v2/recent without a window", async () => {
    const { fetcher, calls } = fakeFetcher([['/tokens/v2/recent', load('jupiter/tokens_v2_recent.trimmed.json')]]);
    const result = await createJupiter({ fetcher }).discover({ list: 'new', window: '5m', limit: 2 });
    expect(calls[0]?.url).toBe('https://api.jup.ag/tokens/v2/recent');
    expect(calls[0]?.init?.cacheMs).toBe(JUPITER_CACHE_MS.recent);
    expect(result.data.map((r) => r.token.symbol)).toEqual(['SAAS', '0.1']);
    expect(result.data[1]?.market).not.toHaveProperty('priceUsd');
    expect(result.data[1]?.token.launchpad).toEqual({ stage: 'bonding', launchpad: 'Meteora DBC' });
  });

  it('maps the pump recent launchpad mix', async () => {
    const { fetcher } = fakeFetcher([['/tokens/v2/recent', load('pump/jupiter_lite_tokens_v2_recent_launchpad_mix_trimmed_2026-09-28.json')]]);
    const result = await createJupiter({ fetcher }).discover({ list: 'new', window: '1h' });
    expect(result.data.map((r) => r.token.launchpad)).toEqual([
      { stage: 'bonding', launchpad: 'pump.fun' },
      { stage: 'bonding', launchpad: 'Meteora DBC' },
      { stage: 'bonding', launchpad: 'stonkfun' },
    ]);
  });

  it('rejects malformed payloads and invalid windows', async () => {
    const { fetcher } = fakeFetcher([['/tokens/v2/', { data: [] }]]);
    const jupiter = createJupiter({ fetcher });
    const malformed = await rejection(jupiter.discover({ list: 'trending', window: '1h' }));
    expect(isProviderError(malformed) && malformed.code).toBe('malformed');
    const badWindow = await rejection(jupiter.discover({ list: 'trending', window: '2h' as '1h' }));
    expect(isProviderError(badWindow) && badWindow.code).toBe('unsupported');
  });

  it('propagates transport errors instead of returning empty data', async () => {
    const { fetcher } = fakeFetcher([['/tokens/v2/', new ProviderError('jupiter', 'rate_limited', 'jupiter tokens: HTTP 429', { status: 429 })]]);
    const error = await rejection(createJupiter({ fetcher }).discover({ list: 'top', window: '1h' }));
    expect(isProviderError(error) && error.code).toBe('rate_limited');
  });
});

describe('getRows / getMarkets / getMetadata', () => {
  const multi = load('jupiter/tokens_v2_search_multi_mints_graduated_fartcoin_jup.json');

  it('batches mints into one search and filters to requested mints', async () => {
    const { fetcher, calls } = fakeFetcher([['/tokens/v2/search', multi]]);
    const jupiter = createJupiter({ fetcher });
    const markets = await jupiter.getMarkets([AI6, FARTCOIN, AI6, 'not-a-mint', ' ']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.jup.ag/tokens/v2/search?query=${AI6},${FARTCOIN}`);
    expect(calls[0]?.init?.cacheMs).toBe(JUPITER_CACHE_MS.search);
    // JUP was returned but not requested: ignored.
    expect(Object.keys(markets.data).sort()).toEqual([AI6, FARTCOIN].sort());
    expect(markets.data[FARTCOIN]?.holders).toBe(189249);
    expect(markets.freshness).toBe('fast');
  });

  it('omits mints Jupiter does not know (never zero-filled)', async () => {
    const { fetcher } = fakeFetcher([['/tokens/v2/search', multi]]);
    const unknown = 'HcKBvtPXcBK4mY35pQT1SAr6jueEhp3bhc8Be25qpump';
    const meta = await createJupiter({ fetcher }).getMetadata([JUP, unknown]);
    expect(Object.keys(meta.data)).toEqual([JUP]);
    expect(meta.data[JUP]?.verified).toBe(true);
  });

  it('chunks by 100 mints (the 101st is silently dropped upstream)', async () => {
    const mints = fakeMints(250);
    expect(new Set(mints).size).toBe(250);
    const { fetcher, calls } = fakeFetcher([['/tokens/v2/search', (url: string) => queryMints(url, 'query').map((id) => ({ id, symbol: 'T', usdPrice: 1 }))]]);
    const rows = await createJupiter({ fetcher }).getRows(mints);
    expect(calls.map((c) => queryMints(c.url, 'query').length)).toEqual([100, 100, 50]);
    expect(rows.data).toHaveLength(250);
    expect(rows.data.map((r) => r.token.mint)).toEqual(mints);
    expect(rows.data[0]?.market.priceUsd).toBe(1);
    expect(rows.data[0]).not.toHaveProperty('rank');
  });

  it('does not fetch for an empty or invalid mint list', async () => {
    const { fetcher, calls } = fakeFetcher([]);
    const result = await createJupiter({ fetcher }).getRows(['', 'xyz']);
    expect(calls).toHaveLength(0);
    expect(result.data).toEqual([]);
  });

  it('fails the whole batch when one chunk fails (so failover can take over)', async () => {
    const mints = fakeMints(150);
    let n = 0;
    const { fetcher } = fakeFetcher([
      ['/tokens/v2/search', () => (n++ === 0 ? [] : new ProviderError('jupiter', 'http', 'jupiter tokens/v2/search: HTTP 500', { status: 500 }))],
    ]);
    const error = await rejection(createJupiter({ fetcher }).getMarkets(mints));
    expect(isProviderError(error) && error.code).toBe('http');
  });
});

describe('search', () => {
  it('encodes the text query and maps hits', async () => {
    const { fetcher, calls } = fakeFetcher([['/tokens/v2/search', load('jupiter/tokens_v2_search_symbol_SOL.trimmed.json')]]);
    const result = await createJupiter({ fetcher }).search(' so l&x ');
    expect(calls[0]?.url).toBe('https://api.jup.ag/tokens/v2/search?query=so%20l%26x');
    expect(result.data.map((h) => h.symbol)).toEqual(['SOL', 'JupSOL', 'FPSon']);
    const fpson = result.data[2];
    expect(fpson).not.toHaveProperty('liquidityUsd');
    expect(fpson).not.toHaveProperty('volume24hUsd');
    expect(fpson?.verified).toBe(true);
  });

  it('returns no hits for an empty query without calling Jupiter', async () => {
    const { fetcher, calls } = fakeFetcher([]);
    const result = await createJupiter({ fetcher }).search('   ');
    expect(result.data).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('getPrices / getSolPrice', () => {
  const mixed = load('jupiter/price_v3_mixed_sol_usdc_graduated_bonding_illiquid.json');

  it('returns only mints Jupiter prices', async () => {
    const unknown = 'HcKBvtPXcBK4mY35pQT1SAr6jueEhp3bhc8Be25qpump';
    const { fetcher, calls } = fakeFetcher([['/price/v3', mixed]]);
    const result = await createJupiter({ fetcher }).getPrices([SOL, USDC, CC, unknown]);
    expect(calls[0]?.init?.cacheMs).toBe(JUPITER_CACHE_MS.price);
    expect(result.data).toEqual({ [SOL]: 118.75666994538565, [USDC]: 0.9998767430654861, [CC]: 0.000007176875046711835 });
    expect(result.data).not.toHaveProperty(unknown);
  });

  it('treats {} as "no reliable price", not an error', async () => {
    const { fetcher } = fakeFetcher([['/price/v3', load('jupiter/price_v3_unknown_id_returns_empty_object.json')]]);
    const result = await createJupiter({ fetcher }).getPrices([CC]);
    expect(result.data).toEqual({});
  });

  it('chunks by 50 ids', async () => {
    const mints = fakeMints(120);
    const { fetcher, calls } = fakeFetcher([
      ['/price/v3', (url: string) => Object.fromEntries(queryMints(url, 'ids').map((id) => [id, { usdPrice: 2, decimals: 6 }]))],
    ]);
    const result = await createJupiter({ fetcher }).getPrices(mints);
    expect(calls.map((c) => queryMints(c.url, 'ids').length)).toEqual([50, 50, 20]);
    expect(Object.keys(result.data)).toHaveLength(120);
  });

  it('rejects a non-object payload as malformed', async () => {
    const { fetcher } = fakeFetcher([['/price/v3', [1, 2]]]);
    const error = await rejection(createJupiter({ fetcher }).getPrices([SOL]));
    expect(isProviderError(error) && error.code).toBe('malformed');
  });

  it('reads the SOL price and 24h change', async () => {
    const { fetcher, calls } = fakeFetcher([['/price/v3', mixed]]);
    const result = await createJupiter({ fetcher }).getSolPrice();
    expect(calls[0]?.url).toBe(`https://api.jup.ag/price/v3?ids=${SOL}`);
    expect(result.data).toEqual({ priceUsd: 118.75666994538565, change24hPct: -3.3889388583620854, updatedAt: result.fetchedAt });
  });

  it('fails when SOL is not priced', async () => {
    const { fetcher } = fakeFetcher([['/price/v3', {}]]);
    const error = await rejection(createJupiter({ fetcher }).getSolPrice());
    expect(isProviderError(error) && error.code).toBe('not_found');
  });
});

describe('getUltraInfo', () => {
  it('maps Ultra search extras per mint', async () => {
    const { fetcher, calls } = fakeFetcher([['/ultra/v1/search', load('jupiter/ultra_v1_search_mints_bonding_graduated_verified.json')]]);
    const result = await createJupiter({ fetcher }).getUltraInfo([CC, AI6, JUP]);
    expect(calls[0]?.url).toBe(`https://api.jup.ag/ultra/v1/search?query=${CC},${AI6},${JUP}`);
    expect(result.data[CC]?.progressPct).toBe(50.033290336154835);
    expect(result.data[AI6]?.progressPct).toBe(100);
    expect(result.data[JUP]).not.toHaveProperty('progressPct');
    expect(result.notes?.[0]).toMatch(/deprecated/);
  });

  it('chunks by 100 mints', async () => {
    const { fetcher, calls } = fakeFetcher([['/ultra/v1/search', []]]);
    await createJupiter({ fetcher }).getUltraInfo(fakeMints(101));
    expect(calls.map((c) => queryMints(c.url, 'query').length)).toEqual([100, 1]);
  });
});

describe('getRisk', () => {
  const bonding = load('jupiter/tokens_v2_search_bonding_curve_pumpfun_token.json');
  const ultra = load('jupiter/ultra_v1_search_mints_bonding_graduated_verified.json');

  it('merges Tokens V2 audit with Ultra extras', async () => {
    const { fetcher, calls } = fakeFetcher([
      ['/tokens/v2/search', bonding],
      ['/ultra/v1/search', ultra],
    ]);
    const result = await createJupiter({ fetcher }).getRisk(CC);
    expect(calls.map((c) => c.init?.label).sort()).toEqual(['jupiter tokens/v2/search', 'jupiter ultra/v1/search']);
    expect(result.data).toMatchObject({ mint: CC, top10Pct: 24.514412749176103, botHoldersPct: 34.9474765407767, devLaunches: 1264, sources: ['jupiter'] });
    expect(result.notes).toBeUndefined();
  });

  it('still answers from Tokens V2 when Ultra fails, with a note', async () => {
    const { fetcher } = fakeFetcher([
      ['/tokens/v2/search', bonding],
      ['/ultra/v1/search', new ProviderError('jupiter', 'http', 'jupiter ultra/v1/search: HTTP 503', { status: 503 })],
    ]);
    const result = await createJupiter({ fetcher }).getRisk(CC);
    expect(result.data).not.toHaveProperty('botHoldersPct');
    expect(result.data.mintAuthorityDisabled).toBe(true);
    expect(result.notes?.[0]).toMatch(/Ultra enrichment unavailable/);
  });

  it('reports not_found for unknown or invalid mints', async () => {
    const { fetcher } = fakeFetcher([
      ['/tokens/v2/search', []],
      ['/ultra/v1/search', []],
    ]);
    const jupiter = createJupiter({ fetcher });
    const missing = await rejection(jupiter.getRisk(CC));
    expect(isProviderError(missing) && missing.code).toBe('not_found');
    const invalid = await rejection(jupiter.getRisk('../etc'));
    expect(isProviderError(invalid) && invalid.code).toBe('not_found');
  });
});

describe('getPortfolio', () => {
  it('reads holdings without prices', async () => {
    const { fetcher, calls } = fakeFetcher([['/ultra/v1/holdings/', load('jupiter/ultra_v1_holdings.trimmed.json')]]);
    const result = await createJupiter({ fetcher }).getPortfolio(WALLET);
    expect(calls[0]?.url).toBe(`https://api.jup.ag/ultra/v1/holdings/${WALLET}`);
    expect(result.freshness).toBe('realtime');
    expect(result.data.sol).toBe(0.860805774);
    expect(result.data.tokens).toHaveLength(3);
    expect(result.data).toMatchObject({ pricedCount: 0, unpricedCount: 3, updatedAt: result.fetchedAt });
    expect(result.data).not.toHaveProperty('totalUsd');
  });

  it('rejects invalid wallets before calling Jupiter', async () => {
    const { fetcher, calls } = fakeFetcher([]);
    const error = await rejection(createJupiter({ fetcher }).getPortfolio('../../tokens/v2/recent'));
    expect(isProviderError(error) && error.code).toBe('not_found');
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed holdings payload', async () => {
    const { fetcher } = fakeFetcher([['/ultra/v1/holdings/', load('jupiter/ultra_v1_holdings_native.json')]]);
    const error = await rejection(createJupiter({ fetcher }).getPortfolio(WALLET));
    expect(isProviderError(error) && error.code).toBe('malformed');
  });
});

describe('getQuote', () => {
  const request: QuoteRequest = { inputMint: SOL, outputMint: AI6, amountRaw: '100000000', inputDecimals: 9, outputDecimals: 6 };

  it('quotes via Metis with the default 100 bps slippage', async () => {
    const { fetcher, calls } = fakeFetcher([['/swap/v1/quote', load('jupiter/swap_v1_quote_graduated_pumpswap.json')]]);
    const result = await createJupiter({ fetcher }).getQuote(request);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.jup.ag/swap/v1/quote?inputMint=${SOL}&outputMint=${AI6}&amount=100000000&slippageBps=100`);
    expect(calls[0]?.init?.cacheMs).toBeUndefined();
    expect(result.freshness).toBe('realtime');
    expect(result.data).toMatchObject({ router: 'Metis', inAmount: 0.1, outAmount: 40184.755771, slippageBps: 100, route: ['Pump.fun Amm'] });
    expect(result.data.fetchedAt).toBe(result.fetchedAt);
  });

  it('falls back to a Jupiter Ultra order quote when Metis fails', async () => {
    const { fetcher, calls } = fakeFetcher([
      ['/swap/v1/quote', new ProviderError('jupiter', 'http', 'jupiter swap/v1/quote: HTTP 400', { status: 400 })],
      ['/swap/v2/order', load('jupiter/swap_v2_order_quote_no_taker.json')],
    ]);
    const result = await createJupiter({ fetcher }).getQuote(request);
    expect(calls[1]?.url).toBe(`https://api.jup.ag/swap/v2/order?inputMint=${SOL}&outputMint=${AI6}&amount=100000000`);
    expect(calls[1]?.url).not.toContain('taker');
    expect(result.data).toMatchObject({ router: 'Jupiter Ultra', outAmount: 41665.048348, inUsd: 11.870625406582567, outUsd: 10.63333983640017, feeBps: 10 });
    expect(result.notes?.[0]).toMatch(/Jupiter Ultra/);
  });

  it('passes explicit slippage to both routers', async () => {
    const { fetcher, calls } = fakeFetcher([
      ['/swap/v1/quote', {}],
      ['/swap/v2/order', load('jupiter/swap_v2_order_quote_bonding_curve_manual_slippage.json')],
    ]);
    const bonding: QuoteRequest = { ...request, outputMint: CC, amountRaw: '50000000', slippageBps: 500 };
    const result = await createJupiter({ fetcher }).getQuote(bonding);
    expect(calls[0]?.url).toContain('slippageBps=500');
    expect(calls[1]?.url).toContain('slippageBps=500');
    expect(result.data).toMatchObject({ router: 'Jupiter Ultra', slippageBps: 500, route: ['Pump.fun'] });
  });

  it('surfaces an error when both routers fail', async () => {
    const { fetcher } = fakeFetcher([
      ['/swap/v1/quote', new ProviderError('jupiter', 'http', 'x', { status: 400 })],
      ['/swap/v2/order', new ProviderError('jupiter', 'rate_limited', 'y', { status: 429, retryAfterMs: 3000 })],
    ]);
    const error = await rejection(createJupiter({ fetcher }).getQuote(request));
    expect(isProviderError(error) && error.code).toBe('rate_limited');
    expect(isProviderError(error) && error.retryAfterMs).toBe(3000);
  });

  it('does not fall back after an abort', async () => {
    const { fetcher, calls } = fakeFetcher([['/swap/v1/quote', new ProviderError('jupiter', 'aborted', 'aborted')]]);
    const error = await rejection(createJupiter({ fetcher }).getQuote(request));
    expect(isProviderError(error) && error.code).toBe('aborted');
    expect(calls).toHaveLength(1);
  });

  it('validates the request before calling Jupiter', async () => {
    const { fetcher, calls } = fakeFetcher([]);
    const jupiter = createJupiter({ fetcher });
    for (const bad of [
      { ...request, amountRaw: '0' },
      { ...request, amountRaw: '1.5' },
      { ...request, outputMint: SOL },
      { ...request, inputMint: 'x' },
      { ...request, outputDecimals: -1 },
    ]) {
      const error = await rejection(jupiter.getQuote(bad));
      expect(isProviderError(error) && error.code).toBe('unsupported');
    }
    expect(calls).toHaveLength(0);
  });
});

describe('payload sanity', () => {
  it('fixture 429 body is not mistaken for data', async () => {
    const body = load('jupiter/error_429_keyless_rate_limited.json') as Json;
    const { fetcher } = fakeFetcher([['/tokens/v2/recent', body]]);
    const error = await rejection(createJupiter({ fetcher }).discover({ list: 'new', window: '1h' }));
    expect(isProviderError(error) && error.code).toBe('malformed');
  });
});
