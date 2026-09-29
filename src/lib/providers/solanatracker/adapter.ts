import 'server-only';

/**
 * Solana Tracker Data API adapter (SERVER-ONLY, keyed; https://data.solanatracker.io).
 *
 * Auth is the `x-api-key` header; the key never goes in the URL and every
 * request is labelled 'solanatracker'. The free plan allows 10,000 requests a
 * month at 3 req/s, so:
 * - one GET /tokens/multi/all serves all three Pulse columns and is shared for
 *   10 s through a module-level cache (keyed by transport + key);
 * - callers should still cache route responses (see the report for budgets).
 *
 * Endpoints: /tokens/multi/all (Pulse), /tokens/{mint} (risk),
 * /chart/{mint}[/{pool}] (USD candles), /trades/{mint}[/{pool}]?hideArb=true
 * (swaps involving the token only), /tokens/{mint}/holders?enrich=identity
 * (top 100 + total holder count + pool/dev/bot/KOL labels).
 */

import { address as toAddress, isOffCurveAddress } from '@solana/kit';
import type {
  CandlesQuery,
  ChartDataProvider,
  HolderProvider,
  LaunchpadProvider,
  TokenRiskProvider,
  TradesQuery,
  TransactionProvider,
} from '@/lib/core/providers';
import { isSolanaAddress } from '@/lib/core/solana';
import {
  INTERVALS,
  INTERVAL_SECONDS,
  type CandleSeries,
  type Freshness,
  type HolderSnapshot,
  type PulseColumn,
  type PulseToken,
  type RiskReport,
  type Sourced,
  type Trade,
} from '@/lib/core/types';
import { isAbortError, isProviderError, ProviderError } from '@/lib/net/errors';
import type { JsonFetcher } from '@/lib/net/types';
import { DISTRIBUTION_NOTE, launchpadPdasOf, staticLiquidityLabel } from '@/lib/providers/helius/labels';
import { parseCandles, parseHolders, parsePulseToken, parseRiskReport, parseTrade, PULSE_KEYS, rec, text, tradeRows, type Rec } from './parse';

export const SOLANATRACKER_BASE_URL = 'https://data.solanatracker.io';
/** Chart `type` values match ORBYT's interval ids one-to-one, down to 1s. */
export const SOLANATRACKER_INTERVALS = INTERVALS;
/** One /tokens/multi/all response serves all Pulse columns for this long. */
export const SOLANATRACKER_PULSE_CACHE_MS = 10_000;
export const SOLANATRACKER_PULSE_LIMIT = 50;
export const SOLANATRACKER_MAX_TRADES = 500;
export const SOLANATRACKER_MAX_HOLDERS = 100;
/** The chart endpoint documents no candle cap; bound the requested window. */
export const SOLANATRACKER_MAX_CANDLES = 5_000;

const PROVIDER = 'solanatracker' as const;
const DEFAULT_CANDLES = 300;
const DEFAULT_TRADES = 100;
const DEFAULT_HOLDERS = 20;

export interface SolanaTrackerOptions {
  apiKey: string;
  fetcher: JsonFetcher;
  /** Defaults to https://data.solanatracker.io. */
  baseUrl?: string;
}

export interface SolanaTrackerAdapter extends LaunchpadProvider, TokenRiskProvider, ChartDataProvider, TransactionProvider, HolderProvider {
  readonly id: 'solanatracker';
}

type Params = Record<string, string | number | boolean | undefined>;

// ---------------------------------------------------------------------------
// Pulse cache (module scope: one upstream call feeds all three columns)
// ---------------------------------------------------------------------------

interface Overview {
  lists: Rec;
  fetchedAt: number;
}

interface OverviewEntry {
  startedAt: number;
  promise: Promise<Overview>;
}

/** Keyed by transport (tests get isolated caches), then by base URL + key. */
const overviewCache = new WeakMap<JsonFetcher, Map<string, OverviewEntry>>();

/** Let one caller stop waiting without cancelling the shared upstream request. */
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  const aborted = () => new ProviderError(PROVIDER, 'aborted', `${PROVIDER}: aborted`);
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function redact(message: string, apiKey: string): string {
  const out = apiKey ? message.split(apiKey).join('***') : message;
  return out.slice(0, 160);
}

/** Normalize any transport failure into a key-free ProviderError. */
function mapTransportError(error: unknown, apiKey: string): unknown {
  if (isAbortError(error)) return error;
  if (isProviderError(error)) {
    if (error.status === 401) {
      return new ProviderError(PROVIDER, 'not_configured', `${PROVIDER}: API key rejected (HTTP 401)`, { status: 401, cause: error });
    }
    if (error.status === 403) {
      return new ProviderError(PROVIDER, 'http', `${PROVIDER}: access denied (HTTP 403)`, { status: 403, cause: error });
    }
    const safe = redact(error.message, apiKey);
    if (safe === error.message) return error;
    return new ProviderError(PROVIDER, error.code, safe, { status: error.status, retryAfterMs: error.retryAfterMs });
  }
  return new ProviderError(PROVIDER, 'network', `${PROVIDER}: request failed`);
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined || !Number.isFinite(value) ? fallback : Math.floor(value);
  return Math.max(min, Math.min(n, max));
}

function sourced<T>(data: T, fetchedAt: number, freshness: Freshness, notes?: string[]): Sourced<T> {
  const out: Sourced<T> = { data, source: PROVIDER, fetchedAt, freshness };
  if (notes?.length) out.notes = notes;
  return out;
}

function malformed(what: string): ProviderError {
  return new ProviderError(PROVIDER, 'malformed', `${PROVIDER}: unexpected ${what} payload`);
}

function assertMint(mint: string): void {
  if (!isSolanaAddress(mint)) throw new ProviderError(PROVIDER, 'not_found', `${PROVIDER}: invalid mint address`);
}

function isProgramOwner(owner: string): boolean | undefined {
  try {
    return isOffCurveAddress(toAddress(owner));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function createSolanaTracker(opts: SolanaTrackerOptions): SolanaTrackerAdapter {
  const { apiKey, fetcher } = opts;
  const base = (opts.baseUrl ?? SOLANATRACKER_BASE_URL).replace(/\/+$/, '');

  async function get(path: string, params: Params, signal?: AbortSignal): Promise<unknown> {
    if (!apiKey) throw new ProviderError(PROVIDER, 'not_configured', `${PROVIDER}: API key missing`);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
    const qs = query.toString();
    let body: unknown;
    try {
      body = await fetcher(PROVIDER, `${base}${path}${qs ? `?${qs}` : ''}`, {
        headers: { 'x-api-key': apiKey },
        label: PROVIDER,
        signal,
      });
    } catch (error) {
      throw mapTransportError(error, apiKey);
    }
    // Errors are documented as `{ error: string }`; never read one as data.
    const errorText = text(rec(body)?.error);
    if (errorText) throw new ProviderError(PROVIDER, 'http', `${PROVIDER}: ${redact(errorText, apiKey)}`);
    return body;
  }

  function loadOverview(signal?: AbortSignal): Promise<Overview> {
    let perFetcher = overviewCache.get(fetcher);
    if (!perFetcher) {
      perFetcher = new Map();
      overviewCache.set(fetcher, perFetcher);
    }
    const cacheKey = `${base}|${apiKey}`;
    const hit = perFetcher.get(cacheKey);
    if (hit && Date.now() - hit.startedAt < SOLANATRACKER_PULSE_CACHE_MS) return withAbort(hit.promise, signal);

    // Shared by all columns: issued without any single caller's signal.
    const promise = get('/tokens/multi/all', { limit: SOLANATRACKER_PULSE_LIMIT }).then((body): Overview => {
      const lists = rec(body);
      if (!lists) throw malformed('token overview');
      return { lists, fetchedAt: Date.now() };
    });
    const entry: OverviewEntry = { startedAt: Date.now(), promise };
    const cache = perFetcher;
    cache.set(cacheKey, entry);
    promise.catch(() => {
      if (cache.get(cacheKey) === entry) cache.delete(cacheKey);
    });
    return withAbort(promise, signal);
  }

  async function getPulse(column: PulseColumn, signal?: AbortSignal): Promise<Sourced<PulseToken[]>> {
    const { lists, fetchedAt } = await loadOverview(signal);
    const list = lists[PULSE_KEYS[column]];
    if (!Array.isArray(list)) throw malformed(`token overview (${PULSE_KEYS[column]})`);
    const tokens: PulseToken[] = [];
    for (const item of list) {
      const token = parsePulseToken(item, column, fetchedAt);
      if (token) tokens.push(token);
    }
    return sourced(tokens, fetchedAt, 'fast');
  }

  async function getRisk(mint: string, signal?: AbortSignal): Promise<Sourced<RiskReport>> {
    assertMint(mint);
    const info = rec(await get(`/tokens/${mint}`, {}, signal));
    if (!info || (!rec(info.token) && !rec(info.risk))) throw malformed('token info');
    const fetchedAt = Date.now();
    return sourced(parseRiskReport(info, mint, fetchedAt), fetchedAt, 'indexed');
  }

  async function getCandles(query: CandlesQuery, signal?: AbortSignal): Promise<Sourced<CandleSeries>> {
    const { interval } = query;
    if (!SOLANATRACKER_INTERVALS.includes(interval)) {
      throw new ProviderError(PROVIDER, 'unsupported', `${PROVIDER}: ${interval} candles are not available`);
    }
    assertMint(query.mint);
    const limit = clampInt(query.limit, DEFAULT_CANDLES, 1, SOLANATRACKER_MAX_CANDLES);
    const pool = query.pool && isSolanaAddress(query.pool) ? query.pool : undefined;
    const before = query.before !== undefined && Number.isFinite(query.before) ? Math.floor(query.before) : undefined;
    const timeTo = before !== undefined ? before - 1 : Math.floor(Date.now() / 1000);
    const timeFrom = Math.max(0, timeTo - limit * INTERVAL_SECONDS[interval]);
    const path = pool ? `/chart/${query.mint}/${pool}` : `/chart/${query.mint}`;
    const body = await get(path, { type: interval, time_from: timeFrom, time_to: timeTo, currency: 'usd' }, signal);
    const fetchedAt = Date.now();
    const parsed = parseCandles(body);
    if (!parsed) throw malformed('chart');
    let candles = before !== undefined ? parsed.filter((c) => c.time < before) : parsed;
    if (candles.length > limit) candles = candles.slice(-limit);
    const series: CandleSeries = { interval, candles };
    if (pool) series.pool = pool;
    return sourced(series, fetchedAt, 'fast');
  }

  async function getTrades(query: TradesQuery, signal?: AbortSignal): Promise<Sourced<Trade[]>> {
    const { mint } = query;
    assertMint(mint);
    const pool = query.pool && isSolanaAddress(query.pool) ? query.pool : undefined;
    const since = query.since !== undefined && Number.isFinite(query.since) ? query.since : undefined;
    const body = await get(
      pool ? `/trades/${mint}/${pool}` : `/trades/${mint}`,
      // hideArb: "keep swap legs involving the requested token" — a multi-hop leg between
      // two other tokens would otherwise carry another token's amount and price.
      { limit: clampInt(query.limit, DEFAULT_TRADES, 1, SOLANATRACKER_MAX_TRADES), sortDirection: 'DESC', hideArb: true },
      signal,
    );
    const fetchedAt = Date.now();
    const rows = tradeRows(body);
    if (!rows) throw malformed('trades');
    const trades: Trade[] = [];
    for (const row of rows) {
      const trade = parseTrade(row, pool);
      if (trade && (since === undefined || trade.timestamp > since)) trades.push(trade);
    }
    return sourced(trades, fetchedAt, 'fast');
  }

  async function getHolders(mint: string, limit = DEFAULT_HOLDERS, signal?: AbortSignal): Promise<Sourced<HolderSnapshot>> {
    assertMint(mint);
    const max = clampInt(limit, DEFAULT_HOLDERS, 1, SOLANATRACKER_MAX_HOLDERS);
    // Top 100 plus the total holder count in one request (the /holders/top variant has no total).
    // enrich=identity labels pool, developer, bot and KOL wallets (no extra request).
    const [body, pdas] = await Promise.all([get(`/tokens/${mint}/holders`, { enrich: 'identity' }, signal), launchpadPdasOf(mint)]);
    const fetchedAt = Date.now();
    const parsed = parseHolders(body, mint, max, fetchedAt, isProgramOwner, (owner) => staticLiquidityLabel(owner, pdas.curve, pdas.pumpSwapPool));
    if (!parsed) throw malformed('holders');
    const notes = parsed.snapshot.distribution && parsed.liquidity ? [DISTRIBUTION_NOTE] : [];
    return sourced(parsed.snapshot, fetchedAt, 'indexed', notes);
  }

  return { id: PROVIDER, intervals: SOLANATRACKER_INTERVALS, getPulse, getRisk, getCandles, getTrades, getHolders };
}
