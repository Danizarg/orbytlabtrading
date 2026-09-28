/**
 * Jupiter adapter (isomorphic: runs keyless in the browser or keyed on the
 * server through the injected JsonFetcher).
 *
 * Endpoints (all on https://api.jup.ag; lite-api.jup.ag is being retired and
 * datapi.jup.ag is undocumented, so neither is used):
 * - Tokens V2: /tokens/v2/{toptrending|toptraded|toporganicscore}/{window},
 *   /tokens/v2/recent, /tokens/v2/search
 * - Price V3: /price/v3
 * - Ultra v1 (deprecated but live): /ultra/v1/search, /ultra/v1/holdings/{wallet}
 * - Quotes: /swap/v1/quote (Metis), fallback /swap/v2/order without taker (Ultra)
 *
 * Keyless access is 5 requests per rolling 10 s per IP across ALL endpoints
 * (CDN cache hits count), so every read sets cacheMs for the browser transport.
 * Batch endpoints silently truncate (search 100 mints, price 50 ids): inputs
 * are chunked here. ORBYT never executes swaps: quotes are read-only.
 */

import { chunk, num } from '@/lib/core/chain';
import type {
  DiscoverList,
  DiscoverQuery,
  DiscoverWindow,
  MarketDataProvider,
  PortfolioProvider,
  PriceProvider,
  QuoteRequest,
  TokenDiscoveryProvider,
  TokenMetadataProvider,
  TokenRiskProvider,
  TokenRowsProvider,
  TokenSearchProvider,
  TradingProvider,
} from '@/lib/core/providers';
import { isSolanaAddress, MINTS } from '@/lib/core/solana';
import type {
  Freshness,
  Portfolio,
  RiskReport,
  SearchHit,
  SolPrice,
  Sourced,
  SwapQuote,
  TokenMarket,
  TokenMeta,
  TokenRow,
} from '@/lib/core/types';
import { isAbortError, isProviderError, ProviderError } from '@/lib/net/errors';
import type { JsonFetcher, JsonRequest } from '@/lib/net/types';
import {
  buildRiskReport,
  expectArray,
  expectObject,
  isDiscoverExcluded,
  isRecord,
  JUPITER_ID,
  type JupiterUltraInfo,
  mapSearchHit,
  mapTokenMarket,
  mapTokenMeta,
  mapTokenRow,
  mapUltraInfo,
  parseHoldings,
  parseMetisQuote,
  parseUltraOrder,
  priceOf,
  tokenId,
} from './normalize';

export const JUPITER_BASE_URL = 'https://api.jup.ag';

/** Upstream batch / list limits (verified 2026-09-28). */
export const JUPITER_LIMITS = {
  /** /tokens/v2/search: the 101st mint is silently dropped. */
  searchMints: 100,
  /** /price/v3: the 51st id is silently dropped. */
  priceIds: 50,
  /** /ultra/v1/search comma-separated mints. */
  ultraMints: 100,
  /** Category endpoints: limit 1..100 (default 50). */
  categoryMax: 100,
  categoryDefault: 50,
  /** /tokens/v2/recent always returns the latest 30 (no paging). */
  recent: 30,
  /** Fuzzy text search returns at most 20. */
  searchResults: 20,
} as const;

/** Browser-transport response cache per endpoint family (ms). */
export const JUPITER_CACHE_MS = {
  search: 15_000,
  recent: 4_000,
  category: 10_000,
  price: 5_000,
  holdings: 5_000,
} as const;

const DEFAULT_SLIPPAGE_BPS = 100;
/** Extra category rows requested to make up for filtered SOL/stablecoins. */
const DISCOVER_HEADROOM = 5;
const MAX_SEARCH_LENGTH = 64;

const CATEGORY: Record<Exclude<DiscoverList, 'new'>, string> = {
  trending: 'toptrending',
  top: 'toptraded',
  organic: 'toporganicscore',
};
const WINDOWS: ReadonlySet<DiscoverWindow> = new Set<DiscoverWindow>(['5m', '1h', '6h', '24h']);

export interface JupiterAdapterOptions {
  fetcher: JsonFetcher;
  /** Developer Platform key (x-api-key). Omit for keyless access (0.5 rps per IP). */
  apiKey?: string;
  /** Defaults to https://api.jup.ag. */
  baseUrl?: string;
}

export type { JupiterUltraInfo, JupiterUltraRisk } from './normalize';

export interface JupiterAdapter
  extends TokenDiscoveryProvider,
    TokenRowsProvider,
    MarketDataProvider,
    TokenMetadataProvider,
    TokenSearchProvider,
    PriceProvider,
    TokenRiskProvider,
    PortfolioProvider,
    TradingProvider {
  readonly id: 'jupiter';
  getSolPrice(signal?: AbortSignal): Promise<Sourced<SolPrice>>;
  /**
   * Deprecated Ultra search extras (bonding-curve progress, snipers, insiders,
   * bundlers, bot holders). Optional enrichment: callers must tolerate failure.
   */
  getUltraInfo(mints: string[], signal?: AbortSignal): Promise<Sourced<Record<string, JupiterUltraInfo>>>;
}

type GetInit = Omit<JsonRequest, 'method' | 'headers' | 'label' | 'body'>;

/** Valid, de-duplicated mints. Base58 only, so they are safe to join into a query string. */
function uniqueMints(mints: readonly string[]): string[] {
  const out = new Set<string>();
  for (const mint of mints) {
    const m = typeof mint === 'string' ? mint.trim() : '';
    if (isSolanaAddress(m)) out.add(m);
  }
  return [...out];
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function sourced<T>(data: T, fetchedAt: number, freshness: Freshness, notes?: string[]): Sourced<T> {
  return notes && notes.length ? { data, source: JUPITER_ID, fetchedAt, freshness, notes } : { data, source: JUPITER_ID, fetchedAt, freshness };
}

function invalidRequest(message: string): ProviderError {
  return new ProviderError(JUPITER_ID, 'unsupported', `jupiter: ${message}`);
}

export function createJupiter(opts: JupiterAdapterOptions): JupiterAdapter {
  const base = (opts.baseUrl?.trim() || JUPITER_BASE_URL).replace(/\/+$/, '');
  const apiKey = opts.apiKey?.trim();
  const headers: Record<string, string> | undefined = apiKey ? { 'x-api-key': apiKey } : undefined;

  function get(path: string, label: string, init: GetInit = {}): Promise<unknown> {
    // `label` keeps URLs (which may carry a proxy key) out of error messages.
    return opts.fetcher<unknown>(JUPITER_ID, `${base}${path}`, {
      ...init,
      method: 'GET',
      label: `jupiter ${label}`,
      ...(headers ? { headers } : {}),
    });
  }

  /** Tokens V2 objects for the given mints (chunked by 100), filtered to the request. */
  async function tokensByMint(mints: readonly string[], signal?: AbortSignal): Promise<{ tokens: Record<string, unknown>[]; fetchedAt: number }> {
    const list = uniqueMints(mints);
    if (!list.length) return { tokens: [], fetchedAt: Date.now() };
    const payloads = await Promise.all(
      chunk(list, JUPITER_LIMITS.searchMints).map((batch) =>
        get(`/tokens/v2/search?query=${batch.join(',')}`, 'tokens/v2/search', { cacheMs: JUPITER_CACHE_MS.search, signal }),
      ),
    );
    const fetchedAt = Date.now();
    const wanted = new Set(list);
    const seen = new Set<string>();
    const tokens: Record<string, unknown>[] = [];
    for (const payload of payloads) {
      for (const token of expectArray(payload, 'tokens/v2/search')) {
        const mint = tokenId(token);
        // Unknown mints are simply omitted upstream; anything not requested is ignored.
        if (!mint || !wanted.has(mint) || seen.has(mint) || !isRecord(token)) continue;
        seen.add(mint);
        tokens.push(token);
      }
    }
    return { tokens, fetchedAt };
  }

  async function discover(query: DiscoverQuery, signal?: AbortSignal): Promise<Sourced<TokenRow[]>> {
    let path: string;
    let label: string;
    let cacheMs: number;
    let limit: number;
    if (query.list === 'new') {
      limit = clampInt(query.limit, 1, JUPITER_LIMITS.recent, JUPITER_LIMITS.recent);
      path = '/tokens/v2/recent';
      label = 'tokens/v2/recent';
      cacheMs = JUPITER_CACHE_MS.recent;
    } else {
      const category = CATEGORY[query.list];
      if (!category) throw invalidRequest(`unknown discover list '${String(query.list)}'`);
      if (!WINDOWS.has(query.window)) throw invalidRequest(`unknown discover window '${String(query.window)}'`);
      limit = clampInt(query.limit, 1, JUPITER_LIMITS.categoryMax, JUPITER_LIMITS.categoryDefault);
      const requested = Math.min(JUPITER_LIMITS.categoryMax, limit + DISCOVER_HEADROOM);
      path = `/tokens/v2/${category}/${query.window}?limit=${requested}`;
      label = `tokens/v2/${category}`;
      cacheMs = JUPITER_CACHE_MS.category;
    }
    const payload = await get(path, label, { cacheMs, signal });
    const fetchedAt = Date.now();
    const rows: TokenRow[] = [];
    const seen = new Set<string>();
    for (const token of expectArray(payload, label)) {
      if (rows.length >= limit) break;
      if (!isRecord(token) || isDiscoverExcluded(token)) continue;
      const row = mapTokenRow(token, fetchedAt, rows.length + 1);
      if (!row || seen.has(row.token.mint)) continue;
      seen.add(row.token.mint);
      rows.push(row);
    }
    return sourced(rows, fetchedAt, 'fast');
  }

  async function getRows(mints: string[], signal?: AbortSignal): Promise<Sourced<TokenRow[]>> {
    const { tokens, fetchedAt } = await tokensByMint(mints, signal);
    const rows: TokenRow[] = [];
    for (const token of tokens) {
      const row = mapTokenRow(token, fetchedAt);
      if (row) rows.push(row);
    }
    return sourced(rows, fetchedAt, 'fast');
  }

  async function getMarkets(mints: string[], signal?: AbortSignal): Promise<Sourced<Record<string, TokenMarket>>> {
    const { tokens, fetchedAt } = await tokensByMint(mints, signal);
    const out: Record<string, TokenMarket> = {};
    for (const token of tokens) {
      const market = mapTokenMarket(token, fetchedAt);
      if (market) out[market.mint] = market;
    }
    return sourced(out, fetchedAt, 'fast');
  }

  async function getMetadata(mints: string[], signal?: AbortSignal): Promise<Sourced<Record<string, TokenMeta>>> {
    const { tokens, fetchedAt } = await tokensByMint(mints, signal);
    const out: Record<string, TokenMeta> = {};
    for (const token of tokens) {
      const meta = mapTokenMeta(token);
      if (meta) out[meta.mint] = meta;
    }
    return sourced(out, fetchedAt, 'fast');
  }

  /** Fuzzy symbol/name/mint search (max 20 results; e.g. 'SOL' also matches tokenized stocks). */
  async function search(text: string, signal?: AbortSignal): Promise<Sourced<SearchHit[]>> {
    const query = (typeof text === 'string' ? text.trim() : '').slice(0, MAX_SEARCH_LENGTH);
    // An empty query returns Jupiter's default top list, which is not a search result.
    if (!query) return sourced([], Date.now(), 'fast');
    const payload = await get(`/tokens/v2/search?query=${encodeURIComponent(query)}`, 'tokens/v2/search', {
      cacheMs: JUPITER_CACHE_MS.search,
      signal,
    });
    const fetchedAt = Date.now();
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const token of expectArray(payload, 'tokens/v2/search')) {
      const hit = mapSearchHit(token);
      if (!hit || seen.has(hit.mint)) continue;
      seen.add(hit.mint);
      hits.push(hit);
    }
    return sourced(hits, fetchedAt, 'fast');
  }

  async function priceEntries(mints: readonly string[], signal?: AbortSignal): Promise<{ entries: Map<string, Record<string, unknown>>; fetchedAt: number }> {
    const list = uniqueMints(mints);
    const entries = new Map<string, Record<string, unknown>>();
    if (!list.length) return { entries, fetchedAt: Date.now() };
    const batches = chunk(list, JUPITER_LIMITS.priceIds);
    const payloads = await Promise.all(
      batches.map((batch) => get(`/price/v3?ids=${batch.join(',')}`, 'price/v3', { cacheMs: JUPITER_CACHE_MS.price, signal })),
    );
    const fetchedAt = Date.now();
    payloads.forEach((payload, i) => {
      // Unknown or unpriceable ids are omitted (an all-unknown batch is `{}` with HTTP 200).
      const root = expectObject(payload, 'price/v3');
      for (const mint of batches[i] ?? []) {
        const entry = root[mint];
        if (isRecord(entry)) entries.set(mint, entry);
      }
    });
    return { entries, fetchedAt };
  }

  async function getPrices(mints: string[], signal?: AbortSignal): Promise<Sourced<Record<string, number>>> {
    const { entries, fetchedAt } = await priceEntries(mints, signal);
    const out: Record<string, number> = {};
    for (const [mint, entry] of entries) {
      const price = priceOf(entry);
      if (price !== undefined) out[mint] = price;
    }
    return sourced(out, fetchedAt, 'fast');
  }

  async function getSolPrice(signal?: AbortSignal): Promise<Sourced<SolPrice>> {
    const { entries, fetchedAt } = await priceEntries([MINTS.SOL], signal);
    const entry = entries.get(MINTS.SOL);
    const priceUsd = priceOf(entry);
    if (entry === undefined || priceUsd === undefined) {
      throw new ProviderError(JUPITER_ID, 'not_found', 'jupiter price/v3: no SOL price');
    }
    // priceChange24h is already percent points (nullable upstream).
    const change24hPct = num(entry.priceChange24h);
    const data: SolPrice = change24hPct === undefined ? { priceUsd, updatedAt: fetchedAt } : { priceUsd, change24hPct, updatedAt: fetchedAt };
    return sourced(data, fetchedAt, 'fast');
  }

  async function getUltraInfo(mints: string[], signal?: AbortSignal): Promise<Sourced<Record<string, JupiterUltraInfo>>> {
    const list = uniqueMints(mints);
    const out: Record<string, JupiterUltraInfo> = {};
    const notes = ['Jupiter Ultra search is deprecated; treat as optional enrichment'];
    if (!list.length) return sourced(out, Date.now(), 'fast', notes);
    const payloads = await Promise.all(
      chunk(list, JUPITER_LIMITS.ultraMints).map((batch) =>
        get(`/ultra/v1/search?query=${batch.join(',')}`, 'ultra/v1/search', { cacheMs: JUPITER_CACHE_MS.search, signal }),
      ),
    );
    const fetchedAt = Date.now();
    const wanted = new Set(list);
    for (const payload of payloads) {
      for (const token of expectArray(payload, 'ultra/v1/search')) {
        const mint = tokenId(token);
        if (!mint || !wanted.has(mint) || out[mint]) continue;
        const info = mapUltraInfo(token);
        if (info) out[mint] = info;
      }
    }
    return sourced(out, fetchedAt, 'fast', notes);
  }

  async function getRisk(mint: string, signal?: AbortSignal): Promise<Sourced<RiskReport>> {
    const target = typeof mint === 'string' ? mint.trim() : '';
    if (!isSolanaAddress(target)) throw new ProviderError(JUPITER_ID, 'not_found', 'jupiter: invalid mint address');
    const [tokensResult, ultraResult] = await Promise.allSettled([tokensByMint([target], signal), getUltraInfo([target], signal)]);
    if (tokensResult.status === 'rejected') throw tokensResult.reason;
    const token = tokensResult.value.tokens[0];
    if (!token) throw new ProviderError(JUPITER_ID, 'not_found', 'jupiter tokens/v2/search: token not found');

    const notes: string[] = [];
    let ultra: JupiterUltraInfo | undefined;
    if (ultraResult.status === 'fulfilled') {
      ultra = ultraResult.value.data[target];
    } else {
      if (isAbortError(ultraResult.reason)) throw ultraResult.reason;
      notes.push('Jupiter Ultra enrichment unavailable: sniper, insider, bundler and bot-holder data omitted');
    }
    const { fetchedAt } = tokensResult.value;
    return sourced(buildRiskReport(token, fetchedAt, ultra), fetchedAt, 'fast', notes);
  }

  async function getPortfolio(address: string, signal?: AbortSignal): Promise<Sourced<Portfolio>> {
    const wallet = typeof address === 'string' ? address.trim() : '';
    if (!isSolanaAddress(wallet)) throw new ProviderError(JUPITER_ID, 'not_found', 'jupiter: invalid wallet address');
    const payload = await get(`/ultra/v1/holdings/${wallet}`, 'ultra/v1/holdings', { cacheMs: JUPITER_CACHE_MS.holdings, signal });
    const fetchedAt = Date.now();
    const { portfolio, skipped } = parseHoldings(wallet, payload, fetchedAt);
    const notes = ['Balances only: token prices are not included'];
    if (skipped > 0) notes.push(`${skipped} token balance${skipped === 1 ? '' : 's'} could not be read and ${skipped === 1 ? 'is' : 'are'} omitted`);
    return sourced(portfolio, fetchedAt, 'realtime', notes);
  }

  async function getQuote(request: QuoteRequest, signal?: AbortSignal): Promise<Sourced<SwapQuote>> {
    const { inputMint, outputMint, amountRaw, inputDecimals, outputDecimals } = request;
    if (!isSolanaAddress(inputMint) || !isSolanaAddress(outputMint)) throw invalidRequest('invalid quote mint');
    if (inputMint === outputMint) throw invalidRequest('input and output mint are the same');
    if (typeof amountRaw !== 'string' || !/^\d+$/.test(amountRaw) || /^0+$/.test(amountRaw)) throw invalidRequest('invalid quote amount');
    for (const d of [inputDecimals, outputDecimals]) {
      if (!Number.isInteger(d) || d < 0 || d > 255) throw invalidRequest('invalid token decimals');
    }
    const explicitSlippage = request.slippageBps === undefined ? undefined : clampInt(request.slippageBps, 0, 10_000, DEFAULT_SLIPPAGE_BPS);
    const slippageBps = explicitSlippage ?? DEFAULT_SLIPPAGE_BPS;

    const metisParams = new URLSearchParams({ inputMint, outputMint, amount: amountRaw, slippageBps: String(slippageBps) });
    let primaryError: unknown;
    try {
      const payload = await get(`/swap/v1/quote?${metisParams.toString()}`, 'swap/v1/quote', { signal });
      const fetchedAt = Date.now();
      return sourced(parseMetisQuote(payload, request, slippageBps, fetchedAt), fetchedAt, 'realtime');
    } catch (error) {
      if (isAbortError(error)) throw error;
      primaryError = error;
    }

    // Fallback: Ultra order without a taker is a quote only (transaction: null).
    const orderParams = new URLSearchParams({ inputMint, outputMint, amount: amountRaw });
    if (explicitSlippage !== undefined) orderParams.set('slippageBps', String(explicitSlippage));
    try {
      const payload = await get(`/swap/v2/order?${orderParams.toString()}`, 'swap/v2/order', { signal });
      const fetchedAt = Date.now();
      return sourced(parseUltraOrder(payload, request, explicitSlippage, fetchedAt), fetchedAt, 'realtime', [
        'Metis quote unavailable; quoted by Jupiter Ultra',
      ]);
    } catch (error) {
      if (isAbortError(error) || !isProviderError(error)) throw error;
      throw new ProviderError(JUPITER_ID, error.code, 'jupiter quote: Metis and Jupiter Ultra both failed', {
        status: error.status,
        retryAfterMs: error.retryAfterMs,
        cause: new AggregateError([primaryError, error]),
      });
    }
  }

  return {
    id: JUPITER_ID,
    discover,
    getRows,
    getMarkets,
    getMetadata,
    search,
    getPrices,
    getSolPrice,
    getUltraInfo,
    getRisk,
    getPortfolio,
    getQuote,
  };
}
