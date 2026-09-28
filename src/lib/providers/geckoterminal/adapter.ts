import { chunk } from '@/lib/core/chain';
import type {
  CandlesQuery,
  ChartDataProvider,
  DiscoverQuery,
  HolderProvider,
  LiquidityProvider,
  MarketDataProvider,
  TokenDiscoveryProvider,
  TokenMetadataProvider,
  TokenRiskProvider,
  TokenRowsProvider,
  TokenSearchProvider,
  TradesQuery,
  TransactionProvider,
} from '@/lib/core/providers';
import { isSolanaAddress } from '@/lib/core/solana';
import type {
  CandleSeries,
  Freshness,
  HolderSnapshot,
  Interval,
  LaunchpadState,
  RiskReport,
  SearchHit,
  Sourced,
  TokenMarket,
  TokenMeta,
  TokenRow,
  Trade,
} from '@/lib/core/types';
import { describeError, isAbortError, isProviderError, ProviderError } from '@/lib/net/errors';
import type { JsonFetcher, JsonRequest } from '@/lib/net/types';
import {
  clean,
  launchpadStateFromPool,
  marketFromToken,
  metaFromToken,
  parseList,
  parseOhlcv,
  parseSingle,
  parseTokenInfo,
  poolInfoFromResource,
  rowFromPool,
  rowFromToken,
  searchHitFromPool,
  tradeFromResource,
  type GeckoPoolInfo,
  type GeckoProviderId,
  type GeckoTokenInfo,
  type JsonApiList,
} from './parse';

/**
 * GeckoTerminal / CoinGecko on-chain DEX API adapter (isomorphic).
 *
 * - `keyless` (default): api.geckoterminal.com, provider id 'geckoterminal'.
 *   Meant for the browser (CORS *, each visitor spends their own ~10 calls/min
 *   per-IP quota), so every method uses as few requests as possible.
 * - `demo` / `pro`: CoinGecko hosts with a key header, provider id
 *   'coingecko'. Keys must stay server-side: only construct keyed adapters in
 *   route handlers. Paths after the base URL are identical on every host.
 *
 * Freshness (documented cache): keyless/demo data is ~60 s cached ('indexed');
 * on paid plans pool/token/OHLCV snapshots are ~10 s ('fast') and pool trades
 * are uncached ('realtime'). List endpoints stay 'indexed' (30 s paid cache).
 */

export type GeckoTerminalPlan = 'keyless' | 'demo' | 'pro';

export interface GeckoTerminalOptions {
  fetcher: JsonFetcher;
  /** Default 'keyless'. */
  plan?: GeckoTerminalPlan;
  /** CoinGecko Demo / Pro key; required for those plans (server-side only). */
  apiKey?: string;
  /** Override the plan's base URL (e.g. a same-origin proxy). */
  baseUrl?: string;
}

export const GECKOTERMINAL_BASE_URLS: Readonly<Record<GeckoTerminalPlan, string>> = {
  keyless: 'https://api.geckoterminal.com/api/v2',
  demo: 'https://api.coingecko.com/api/v3/onchain',
  pro: 'https://pro-api.coingecko.com/api/v3/onchain',
};

/** Exact Accept header: one string app-wide maximizes CDN hits (responses vary on Accept). */
export const GECKOTERMINAL_ACCEPT = 'application/json;version=20230203';

export interface DexPoolsOptions {
  /** Default 'h24_tx_count_desc' (the API default). No created-at sort exists. */
  sort?: 'h24_tx_count_desc' | 'h24_volume_usd_desc';
  /** 1–10 (20 pools per page). */
  page?: number;
}

export interface LaunchpadPoolState {
  /** Base token of the pool (the launched token). */
  mint: string;
  launchpad: LaunchpadState;
}

export interface GeckoTerminalAdapter
  extends TokenDiscoveryProvider,
    TokenSearchProvider,
    MarketDataProvider,
    TokenRowsProvider,
    LiquidityProvider,
    ChartDataProvider,
    TransactionProvider,
    TokenRiskProvider,
    TokenMetadataProvider,
    HolderProvider {
  readonly id: GeckoProviderId;
  readonly plan: GeckoTerminalPlan;
  getPools(mint: string, signal?: AbortSignal): Promise<Sourced<GeckoPoolInfo[]>>;
  /** tokens/{mint}/info in one request: metadata + risk + holder summary. */
  getTokenInfo(mint: string, signal?: AbortSignal): Promise<Sourced<GeckoTokenInfo>>;
  /**
   * Launchpad state per pool address via pools/multi (≤30 per call, chunked).
   * Pools that are not launchpad pools, and addresses the API does not know,
   * are absent. graduation_percentage is coarse and can lag the chain.
   */
  getLaunchpadStates(pools: string[], signal?: AbortSignal): Promise<Sourced<Record<string, LaunchpadPoolState>>>;
  /** Top pools of one DEX, e.g. 'pump-fun' for live bonding curves (Pulse Final-Stretch backfill). */
  getDexPools(dex: string, opts?: DexPoolsOptions, signal?: AbortSignal): Promise<Sourced<GeckoPoolInfo[]>>;
  /** Newest pools network-wide, bonding curves included (Pulse backfill; ~40 s behind the chain). */
  getNewPools(page?: number, signal?: AbortSignal): Promise<Sourced<GeckoPoolInfo[]>>;
}

const POOL_INCLUDE = 'include=base_token,quote_token,dex';
/** Max addresses per multi call on keyless/Demo (31 → HTTP 400). */
const MULTI_LIMIT = 30;
/** Pages beyond 10 need an Analyst+ plan. */
const MAX_PAGE = 10;
const DEFAULT_CANDLES = 300;
const MAX_CANDLES = 1000;

/** Browser response-cache windows (the server transport ignores cacheMs). */
const CACHE_MS = {
  info: 300_000,
  list: 15_000,
  tokens: 15_000,
  trades: 10_000,
  candles: 15_000,
  historicCandles: 600_000,
} as const;

const BASE_INTERVALS: readonly Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
/** timeframe=second is paid-only (live keyless call → 401). */
const PRO_INTERVALS: readonly Interval[] = ['1s', '15s', ...BASE_INTERVALS];

const CANDLE_PARAMS: Partial<Record<Interval, { timeframe: 'second' | 'minute' | 'hour' | 'day'; aggregate: number }>> = {
  '1s': { timeframe: 'second', aggregate: 1 },
  '15s': { timeframe: 'second', aggregate: 15 },
  '1m': { timeframe: 'minute', aggregate: 1 },
  '5m': { timeframe: 'minute', aggregate: 5 },
  '15m': { timeframe: 'minute', aggregate: 15 },
  '1h': { timeframe: 'hour', aggregate: 1 },
  '4h': { timeframe: 'hour', aggregate: 4 },
  '1d': { timeframe: 'day', aggregate: 1 },
};

const DEX_SORTS = new Set(['h24_tx_count_desc', 'h24_volume_usd_desc']);
const DISCOVER_DURATIONS = new Set(['5m', '1h', '6h', '24h']);
const TRADES_NOTE = 'GeckoTerminal trade feed is cached ~30 s';
const HOLDERS_NOTE = 'GeckoTerminal provides holder counts and distribution, not a holder list';

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function uniqueAddresses(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const v = typeof value === 'string' ? value.trim() : '';
    if (v && isSolanaAddress(v)) out.add(v);
  }
  return [...out];
}

export function createGeckoTerminal(opts: GeckoTerminalOptions): GeckoTerminalAdapter {
  const plan: GeckoTerminalPlan = opts.plan ?? 'keyless';
  const id: GeckoProviderId = plan === 'keyless' ? 'geckoterminal' : 'coingecko';
  const apiKey = opts.apiKey?.trim();
  if (plan !== 'keyless' && !apiKey) {
    throw new ProviderError(id, 'not_configured', `${id}: the ${plan} plan requires an API key`);
  }
  const base = (opts.baseUrl?.trim() || GECKOTERMINAL_BASE_URLS[plan]).replace(/\/+$/, '');
  const headers: Record<string, string> = { accept: GECKOTERMINAL_ACCEPT };
  if (plan === 'demo' && apiKey) headers['x-cg-demo-api-key'] = apiKey;
  if (plan === 'pro' && apiKey) headers['x-cg-pro-api-key'] = apiKey;
  const pro = plan === 'pro';
  /** Pool / token / OHLCV snapshots: ~60 s cache keyless & Demo, ~10 s on paid plans. */
  const snapshotFreshness: Freshness = pro ? 'fast' : 'indexed';
  const intervals = pro ? PRO_INTERVALS : BASE_INTERVALS;

  // -------------------------------------------------------------------------
  // Transport helpers
  // -------------------------------------------------------------------------

  async function get(path: string, label: string, init: { cacheMs?: number; signal?: AbortSignal } = {}) {
    const request: JsonRequest = { headers: { ...headers }, label: `${id} ${label}` };
    if (init.cacheMs) request.cacheMs = init.cacheMs;
    if (init.signal) request.signal = init.signal;
    const payload = await opts.fetcher<unknown>(id, `${base}${path}`, request);
    return { payload, fetchedAt: Date.now() };
  }

  async function getList(path: string, label: string, init: { cacheMs?: number; signal?: AbortSignal } = {}) {
    const { payload, fetchedAt } = await get(path, label, init);
    return { doc: parseList(id, payload, `${id} ${label}`), fetchedAt };
  }

  function sourced<T>(data: T, fetchedAt: number, freshness: Freshness, notes?: string[]): Sourced<T> {
    return clean<Sourced<T>>({ data, source: id, fetchedAt, freshness, notes: notes?.length ? notes : undefined });
  }

  function requireAddress(value: string | undefined, what: string): string {
    const v = value?.trim();
    if (!v || !isSolanaAddress(v)) throw new ProviderError(id, 'not_found', `${id}: invalid ${what} address`);
    return v;
  }

  /**
   * Chunked multi-address calls. Chunks run concurrently (the transport
   * enforces the budget). Partial failures keep the successful chunks and add
   * a note; when every chunk fails the first error is rethrown.
   */
  async function fetchChunks(
    addresses: string[],
    label: string,
    path: (part: string[]) => string,
    cacheMs: number,
    signal?: AbortSignal,
  ): Promise<{ docs: JsonApiList[]; fetchedAt: number; notes: string[] }> {
    const parts = chunk(addresses, MULTI_LIMIT);
    const settled = await Promise.allSettled(parts.map((part) => getList(path(part), label, { cacheMs, signal })));
    const docs: JsonApiList[] = [];
    let fetchedAt = Number.POSITIVE_INFINITY;
    let failedAddresses = 0;
    let firstError: unknown;
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        docs.push(result.value.doc);
        fetchedAt = Math.min(fetchedAt, result.value.fetchedAt);
      } else {
        failedAddresses += parts[i]?.length ?? 0;
        firstError ??= result.reason;
      }
    });
    const abort = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected' && isAbortError(r.reason));
    if (abort) throw abort.reason;
    if (!docs.length) throw firstError;
    const notes = failedAddresses
      ? [`${failedAddresses} of ${addresses.length} addresses could not be loaded (${describeError(firstError)})`]
      : [];
    return { docs, fetchedAt, notes };
  }

  function poolList(doc: JsonApiList): GeckoPoolInfo[] {
    const seen = new Set<string>();
    const pools: GeckoPoolInfo[] = [];
    for (const res of doc.data) {
      const pool = poolInfoFromResource(res, doc.included, id);
      if (!pool || seen.has(pool.address)) continue;
      seen.add(pool.address);
      pools.push(pool);
    }
    return pools;
  }

  function tokensMulti(mints: string[], signal?: AbortSignal) {
    // include=top_pools on every tokens/multi call so rows, markets and metadata share one cached response.
    return fetchChunks(mints, 'tokens/multi', (part) => `/networks/solana/tokens/multi/${part.join(',')}?include=top_pools`, CACHE_MS.tokens, signal);
  }

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  async function discover(query: DiscoverQuery, signal?: AbortSignal): Promise<Sourced<TokenRow[]>> {
    const notes: string[] = [];
    let path: string;
    switch (query.list) {
      case 'trending': {
        const duration = DISCOVER_DURATIONS.has(query.window) ? query.window : '24h';
        path = `/networks/solana/trending_pools?${POOL_INCLUDE}&duration=${duration}&page=1`;
        break;
      }
      case 'top':
        path = `/networks/solana/pools?${POOL_INCLUDE}&sort=h24_volume_usd_desc&page=1`;
        if (query.window !== '24h') notes.push('GeckoTerminal ranks top pools by 24h volume');
        break;
      case 'new':
        path = `/networks/solana/new_pools?${POOL_INCLUDE}&page=1`;
        break;
      default:
        throw new ProviderError(id, 'unsupported', `${id}: '${query.list}' discovery is not available`);
    }
    const { doc, fetchedAt } = await getList(path, `${query.list} pools`, { cacheMs: CACHE_MS.list, signal });
    const limit = query.limit !== undefined && query.limit > 0 ? Math.floor(query.limit) : Number.POSITIVE_INFINITY;
    const seen = new Set<string>();
    const rows: TokenRow[] = [];
    for (const res of doc.data) {
      if (rows.length >= limit) break;
      const row = rowFromPool(res, doc.included, id, fetchedAt);
      if (!row || seen.has(row.token.mint)) continue; // one row per base token, first (highest-ranked) pool wins
      seen.add(row.token.mint);
      rows.push({ ...row, rank: rows.length + 1 });
    }
    return sourced(rows, fetchedAt, 'indexed', notes);
  }

  async function search(query: string, signal?: AbortSignal): Promise<Sourced<SearchHit[]>> {
    const q = query.trim();
    if (!q) return sourced([], Date.now(), 'indexed');
    const path = `/search/pools?query=${encodeURIComponent(q)}&network=solana&${POOL_INCLUDE}&page=1`;
    const { doc, fetchedAt } = await getList(path, 'search', { cacheMs: CACHE_MS.list, signal });
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const res of doc.data) {
      const hit = searchHitFromPool(res, doc.included, id);
      if (!hit || seen.has(hit.mint)) continue;
      seen.add(hit.mint);
      hits.push(hit);
    }
    return sourced(hits, fetchedAt, 'indexed');
  }

  async function getMarkets(mints: string[], signal?: AbortSignal): Promise<Sourced<Record<string, TokenMarket>>> {
    const list = uniqueAddresses(mints);
    if (!list.length) return sourced({}, Date.now(), snapshotFreshness);
    const wanted = new Set(list);
    const { docs, fetchedAt, notes } = await tokensMulti(list, signal);
    const out: Record<string, TokenMarket> = {};
    for (const doc of docs) {
      for (const res of doc.data) {
        const market = marketFromToken(res, doc.included, id, fetchedAt);
        if (market && wanted.has(market.mint) && !out[market.mint]) out[market.mint] = market;
      }
    }
    return sourced(out, fetchedAt, snapshotFreshness, notes);
  }

  async function getRows(mints: string[], signal?: AbortSignal): Promise<Sourced<TokenRow[]>> {
    const list = uniqueAddresses(mints);
    if (!list.length) return sourced([], Date.now(), snapshotFreshness);
    const wanted = new Set(list);
    const { docs, fetchedAt, notes } = await tokensMulti(list, signal);
    const byMint = new Map<string, TokenRow>();
    for (const doc of docs) {
      for (const res of doc.data) {
        const row = rowFromToken(res, doc.included, id, fetchedAt);
        if (row && wanted.has(row.token.mint) && !byMint.has(row.token.mint)) byMint.set(row.token.mint, row);
      }
    }
    // Requested order; mints GeckoTerminal does not know are absent.
    const rows = list.map((mint) => byMint.get(mint)).filter((row): row is TokenRow => row !== undefined);
    return sourced(rows, fetchedAt, snapshotFreshness, notes);
  }

  async function getPools(mint: string, signal?: AbortSignal): Promise<Sourced<GeckoPoolInfo[]>> {
    const m = requireAddress(mint, 'token');
    const path = `/networks/solana/tokens/${m}/pools?${POOL_INCLUDE}&sort=h24_volume_usd_liquidity_desc`;
    const { doc, fetchedAt } = await getList(path, 'token pools', { cacheMs: CACHE_MS.list, signal });
    return sourced(poolList(doc), fetchedAt, 'indexed');
  }

  async function getCandles(query: CandlesQuery, signal?: AbortSignal): Promise<Sourced<CandleSeries>> {
    const params = CANDLE_PARAMS[query.interval];
    if (!params || !intervals.includes(query.interval)) {
      throw new ProviderError(id, 'unsupported', `${id}: ${query.interval} candles are not available on the ${plan} plan`);
    }
    const mint = requireAddress(query.mint, 'token');
    let pool: string;
    if (query.pool?.trim()) {
      pool = requireAddress(query.pool, 'pool');
    } else {
      // One extra call: GeckoTerminal's top pool (volume × liquidity) for the token.
      const top = (await getPools(mint, signal)).data[0]?.address;
      if (!top) throw new ProviderError(id, 'unsupported', `${id}: no pool available to chart this token`);
      pool = top;
    }
    const limit = clampInt(query.limit, 1, MAX_CANDLES, DEFAULT_CANDLES);
    const before = query.before !== undefined && Number.isFinite(query.before) && query.before > 0 ? Math.floor(query.before) : undefined;
    // currency=usd&token=<mint>: USD candles for OUR token even when it is the pool's quote side.
    let path = `/networks/solana/pools/${pool}/ohlcv/${params.timeframe}?aggregate=${params.aggregate}&limit=${limit}&currency=usd&token=${mint}`;
    if (before !== undefined) path += `&before_timestamp=${before}`;
    let response: { payload: unknown; fetchedAt: number };
    try {
      response = await get(path, `ohlcv ${query.interval}`, {
        cacheMs: before !== undefined ? CACHE_MS.historicCandles : CACHE_MS.candles,
        signal,
      });
    } catch (error) {
      if (params.timeframe === 'second' && isProviderError(error) && (error.status === 401 || error.status === 403)) {
        throw new ProviderError(id, 'unsupported', `${id}: second candles need a CoinGecko Analyst plan or above`, {
          status: error.status,
          cause: error,
        });
      }
      throw error;
    }
    const { candles, rows } = parseOhlcv(id, response.payload, `${id} ohlcv`);
    const series: CandleSeries = {
      interval: query.interval,
      candles: before !== undefined ? candles.filter((c) => c.time < before) : candles,
      pool,
      hasMore: rows >= limit,
    };
    return sourced(series, response.fetchedAt, snapshotFreshness);
  }

  async function getTrades(query: TradesQuery, signal?: AbortSignal): Promise<Sourced<Trade[]>> {
    if (!query.pool?.trim()) throw new ProviderError(id, 'unsupported', `${id}: trades require a pool address`);
    const mint = requireAddress(query.mint, 'token');
    const pool = requireAddress(query.pool, 'pool');
    // token=<mint> makes `kind` (buy/sell) relative to our token. Keyless: last 300 trades within 24 h.
    const path = `/networks/solana/pools/${pool}/trades?token=${mint}`;
    const { doc, fetchedAt } = await getList(path, 'pool trades', { cacheMs: pro ? undefined : CACHE_MS.trades, signal });
    const parsed = doc.data
      .map((res) => tradeFromResource(res, mint, pool, id))
      .filter((t): t is Trade => t !== undefined)
      .sort((a, b) => b.timestamp - a.timestamp);
    const seen = new Set<string>();
    const since = query.since;
    const limit = query.limit !== undefined && query.limit > 0 ? Math.floor(query.limit) : Number.POSITIVE_INFINITY;
    const trades: Trade[] = [];
    for (const trade of parsed) {
      if (trades.length >= limit) break;
      if (seen.has(trade.signature)) continue;
      seen.add(trade.signature);
      if (since !== undefined && trade.timestamp <= since) continue;
      trades.push(trade);
    }
    return pro ? sourced(trades, fetchedAt, 'realtime') : sourced(trades, fetchedAt, 'indexed', [TRADES_NOTE]);
  }

  async function getTokenInfo(mint: string, signal?: AbortSignal): Promise<Sourced<GeckoTokenInfo>> {
    const m = requireAddress(mint, 'token');
    const { payload, fetchedAt } = await get(`/networks/solana/tokens/${m}/info`, 'token info', { cacheMs: CACHE_MS.info, signal });
    const info = parseTokenInfo(parseSingle(id, payload, `${id} token info`).data, id, fetchedAt);
    if (!info) throw new ProviderError(id, 'malformed', `${id} token info: unexpected response`);
    // Token info is cached ~60 s upstream on every plan.
    return sourced(info, fetchedAt, 'indexed');
  }

  async function getRisk(mint: string, signal?: AbortSignal): Promise<Sourced<RiskReport>> {
    const info = await getTokenInfo(mint, signal);
    return { ...info, data: info.data.risk };
  }

  async function getHolders(mint: string, _limit?: number, signal?: AbortSignal): Promise<Sourced<HolderSnapshot>> {
    const info = await getTokenInfo(mint, signal);
    return { ...info, data: info.data.holders, notes: [HOLDERS_NOTE] };
  }

  async function getMetadata(mints: string[], signal?: AbortSignal): Promise<Sourced<Record<string, TokenMeta>>> {
    const list = uniqueAddresses(mints);
    const [single] = list;
    if (!single) return sourced({}, Date.now(), 'indexed');
    if (list.length === 1) {
      // Single mint: token info carries socials, description, image sizes and launchpad state.
      try {
        const info = await getTokenInfo(single, signal);
        return { ...info, data: { [info.data.meta.mint]: info.data.meta } };
      } catch (error) {
        // Batch semantics: a token GeckoTerminal does not know is simply absent.
        if (isProviderError(error) && error.code === 'not_found') return sourced({}, Date.now(), 'indexed');
        throw error;
      }
    }
    const wanted = new Set(list);
    const { docs, fetchedAt, notes } = await tokensMulti(list, signal);
    const out: Record<string, TokenMeta> = {};
    for (const doc of docs) {
      for (const res of doc.data) {
        const meta = metaFromToken(res);
        if (meta && wanted.has(meta.mint) && !out[meta.mint]) out[meta.mint] = meta;
      }
    }
    return sourced(out, fetchedAt, 'indexed', notes);
  }

  async function getLaunchpadStates(pools: string[], signal?: AbortSignal): Promise<Sourced<Record<string, LaunchpadPoolState>>> {
    const list = uniqueAddresses(pools);
    if (!list.length) return sourced({}, Date.now(), snapshotFreshness);
    const wanted = new Set(list);
    // No include: base mint and dex id come from relationships; unknown addresses are dropped by the API.
    const { docs, fetchedAt, notes } = await fetchChunks(
      list,
      'pools/multi',
      (part) => `/networks/solana/pools/multi/${part.join(',')}`,
      CACHE_MS.list,
      signal,
    );
    const out: Record<string, LaunchpadPoolState> = {};
    for (const doc of docs) {
      for (const res of doc.data) {
        const state = launchpadStateFromPool(res);
        if (state && wanted.has(state.pool) && !out[state.pool]) out[state.pool] = { mint: state.mint, launchpad: state.launchpad };
      }
    }
    return sourced(out, fetchedAt, snapshotFreshness, notes);
  }

  async function getDexPools(dex: string, options: DexPoolsOptions = {}, signal?: AbortSignal): Promise<Sourced<GeckoPoolInfo[]>> {
    const dexId = dex.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(dexId)) throw new ProviderError(id, 'unsupported', `${id}: invalid dex id`);
    const sort = options.sort && DEX_SORTS.has(options.sort) ? options.sort : 'h24_tx_count_desc';
    const page = clampInt(options.page, 1, MAX_PAGE, 1);
    const path = `/networks/solana/dexes/${dexId}/pools?${POOL_INCLUDE}&sort=${sort}&page=${page}`;
    const { doc, fetchedAt } = await getList(path, 'dex pools', { cacheMs: CACHE_MS.list, signal });
    return sourced(poolList(doc), fetchedAt, 'indexed');
  }

  async function getNewPools(page?: number, signal?: AbortSignal): Promise<Sourced<GeckoPoolInfo[]>> {
    const p = clampInt(page, 1, MAX_PAGE, 1);
    const { doc, fetchedAt } = await getList(`/networks/solana/new_pools?${POOL_INCLUDE}&page=${p}`, 'new pools', {
      cacheMs: CACHE_MS.list,
      signal,
    });
    return sourced(poolList(doc), fetchedAt, 'indexed');
  }

  return {
    id,
    plan,
    intervals,
    discover,
    search,
    getMarkets,
    getRows,
    getPools,
    getCandles,
    getTrades,
    getTokenInfo,
    getRisk,
    getHolders,
    getMetadata,
    getLaunchpadStates,
    getDexPools,
    getNewPools,
  };
}
