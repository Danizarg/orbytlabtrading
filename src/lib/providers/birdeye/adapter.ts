import 'server-only';

/**
 * Birdeye Data API adapter (SERVER-ONLY, keyed; https://public-api.birdeye.so).
 *
 * Auth is the `X-API-KEY` header plus `x-chain: solana`; the key never goes in
 * the URL and every request is labelled 'birdeye'. Responses use the
 * `{ success, data }` envelope; `success: false` is surfaced as an error, never
 * as empty data.
 *
 * Endpoints (docs verified 2026-09-28/29, data.birdeye.so/docs):
 * - GET /defi/v3/ohlcv — token-level USD candles, up to 5,000; 1s kept 2 weeks, 15s 3 months;
 *   empty buckets are not padded. `mode=count` takes time_from OR time_to (not both).
 *   The pair endpoint (/defi/v3/ohlcv/pair) is deliberately NOT used: it prices the pair's
 *   base in its quote currency (SOL for most memecoin pools) with no USD option, and the
 *   base is not necessarily the requested token, so its candles cannot be labelled USD.
 * - GET /defi/v3/token/txs — ≤100 per call, block_unix_time in seconds.
 * - GET /defi/v3/token/holder — ≤100 per call (token-account rows by default), total holder
 *   count; `top10HoldPercent` sums the top token accounts, liquidity vaults included.
 * - GET /defi/token_security (Lite+) + GET /token/v1/holder-profile (Standard+).
 * - GET /defi/v3/token/meme/list — launchpad lists with progress_percent / graduated.
 */

import { address, isOffCurveAddress } from '@solana/kit';
import { fillMissing } from '@/lib/core/chain';
import { launchpadPdasOf, staticLiquidityLabel } from '@/lib/providers/helius/labels';
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
  INTERVAL_SECONDS,
  type CandleSeries,
  type Freshness,
  type HolderSnapshot,
  type Interval,
  type PulseColumn,
  type PulseToken,
  type RiskReport,
  type Sourced,
  type Trade,
} from '@/lib/core/types';
import { describeError, isAbortError, isProviderError, ProviderError } from '@/lib/net/errors';
import type { JsonFetcher } from '@/lib/net/types';
import {
  parseHolderPage,
  parseHolderProfile,
  parseMemeItem,
  parseOhlcvItems,
  parseSecurity,
  parseTrade,
  rec,
  text,
  type Rec,
} from './parse';

export const BIRDEYE_BASE_URL = 'https://public-api.birdeye.so';

/** Intervals served natively by OHLCV v3 (Birdeye has no 5s candles). */
export const BIRDEYE_INTERVALS = ['1s', '15s', '1m', '5m', '15m', '1h', '4h', '1d'] as const satisfies readonly Interval[];
type BirdeyeInterval = (typeof BIRDEYE_INTERVALS)[number];

/** ORBYT interval → Birdeye `type` (hours/days are upper-case upstream). */
export const BIRDEYE_OHLCV_TYPE: Record<BirdeyeInterval, string> = {
  '1s': '1s',
  '15s': '15s',
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1H',
  '4h': '4H',
  '1d': '1D',
};

export const BIRDEYE_MAX_CANDLES = 5_000;
export const BIRDEYE_MAX_TRADES = 100;
export const BIRDEYE_MAX_HOLDERS = 100;
export const BIRDEYE_PULSE_LIMIT = 50;
/** Caveat on Birdeye's token-account-level top-10 share (ORBYT's own distributions exclude liquidity accounts). */
export const BIRDEYE_TOP10_NOTE = 'Top-10 share from Birdeye; it may include bonding-curve or pool accounts.';
/** Birdeye's top-10 share is withheld when a known curve / pool account is among the accounts it sums. */
export const BIRDEYE_TOP10_OMITTED_NOTE = "Birdeye's top-10 share counts bonding-curve or pool accounts as holders; omitted.";
/** Rows behind Birdeye's top-10 share: always requested so each one can be checked. */
const TOP10_ROWS = 10;

const PROVIDER = 'birdeye' as const;
const DEFAULT_CANDLES = 300;
const DEFAULT_TRADES = 50;
const DEFAULT_HOLDERS = 20;
/** Final Stretch: curve at least half complete… */
const FINAL_MIN_PROGRESS_PCT = 50;
/** …and traded within the last hour, so long-stalled curves don't crowd the column. */
const FINAL_ACTIVE_WINDOW_S = 3_600;
/** v3 txs rejects `after_time` older than 30 days (without `owner`). */
const AFTER_TIME_MAX_AGE_MS = 29 * 86_400_000;

export interface BirdeyeOptions {
  apiKey: string;
  fetcher: JsonFetcher;
  /** Defaults to https://public-api.birdeye.so. */
  baseUrl?: string;
}

export interface BirdeyeAdapter extends ChartDataProvider, TransactionProvider, HolderProvider, TokenRiskProvider, LaunchpadProvider {
  readonly id: 'birdeye';
}

type Params = Record<string, string | number | boolean | undefined>;

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
      // Birdeye answers 403 for IP allow/deny-list blocks and endpoints outside the plan.
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

/** Off-curve owner = PDA (bonding curve, pool authority, program vault). */
function isProgramOwner(owner: string): boolean | undefined {
  try {
    return isOffCurveAddress(address(owner));
  } catch {
    return undefined;
  }
}

function isBirdeyeInterval(interval: Interval): interval is BirdeyeInterval {
  return (BIRDEYE_INTERVALS as readonly Interval[]).includes(interval);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function createBirdeye(opts: BirdeyeOptions): BirdeyeAdapter {
  const { apiKey, fetcher } = opts;
  const base = (opts.baseUrl ?? BIRDEYE_BASE_URL).replace(/\/+$/, '');

  async function get(path: string, params: Params, signal?: AbortSignal): Promise<Rec> {
    if (!apiKey) throw new ProviderError(PROVIDER, 'not_configured', `${PROVIDER}: API key missing`);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
    let body: unknown;
    try {
      body = await fetcher(PROVIDER, `${base}${path}?${query.toString()}`, {
        headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana' },
        label: PROVIDER,
        signal,
      });
    } catch (error) {
      throw mapTransportError(error, apiKey);
    }
    const envelope = rec(body);
    if (!envelope) throw malformed(path);
    if (envelope.success === false) {
      const detail = text(envelope.message);
      throw new ProviderError(PROVIDER, 'http', `${PROVIDER}: request rejected${detail ? ` (${redact(detail, apiKey)})` : ''}`);
    }
    if (envelope.data === null) throw new ProviderError(PROVIDER, 'not_found', `${PROVIDER}: no data for this token`);
    const data = rec(envelope.data);
    if (!data) throw malformed(path);
    return data;
  }

  async function getCandles(query: CandlesQuery, signal?: AbortSignal): Promise<Sourced<CandleSeries>> {
    const { interval } = query;
    if (!isBirdeyeInterval(interval)) {
      throw new ProviderError(PROVIDER, 'unsupported', `${PROVIDER}: ${interval} candles are not available`);
    }
    assertMint(query.mint);
    const limit = clampInt(query.limit, DEFAULT_CANDLES, 1, BIRDEYE_MAX_CANDLES);
    const path = '/defi/v3/ohlcv';
    const before = query.before !== undefined && Number.isFinite(query.before) ? Math.floor(query.before) : undefined;
    const timeTo = before !== undefined ? before - 1 : Math.floor(Date.now() / 1000);
    // Always token-level USD (see the header): a requested pool is not honoured, and the series says so.
    const common: Params = { address: query.mint, type: BIRDEYE_OHLCV_TYPE[interval], currency: 'usd' };

    let data: Rec;
    let countMode = true;
    try {
      data = await get(path, { ...common, mode: 'count', count_limit: limit, time_to: timeTo }, signal);
    } catch (error) {
      // Docs disagree on whether count mode may omit time_from; fall back to an explicit window on HTTP 400.
      if (!isProviderError(error) || error.status !== 400) throw error;
      countMode = false;
      const timeFrom = Math.max(0, timeTo - limit * INTERVAL_SECONDS[interval]);
      data = await get(path, { ...common, mode: 'range', time_from: timeFrom, time_to: timeTo }, signal);
    }
    const fetchedAt = Date.now();
    const parsed = parseOhlcvItems(data.items);
    if (!parsed) throw malformed('ohlcv');

    let candles = before !== undefined ? parsed.candles.filter((c) => c.time < before) : parsed.candles;
    if (candles.length > limit) candles = candles.slice(-limit);
    const series: CandleSeries = { interval, candles };
    // In count mode a short page means history is exhausted before `time_to` (dropped rows still count as received).
    if (countMode) series.hasMore = parsed.received >= limit;

    // USD was requested: candles priced in anything else must not reach a USD chart.
    if (parsed.currencies.some((c) => c !== 'usd')) throw malformed('ohlcv currency');
    const notes = query.pool ? ['Birdeye candles aggregate all pools of the token (USD).'] : [];
    return sourced(series, fetchedAt, 'fast', notes);
  }

  async function getTrades(query: TradesQuery, signal?: AbortSignal): Promise<Sourced<Trade[]>> {
    const { mint } = query;
    assertMint(mint);
    const since = query.since !== undefined && Number.isFinite(query.since) ? query.since : undefined;
    const afterTime = since !== undefined && Date.now() - since < AFTER_TIME_MAX_AGE_MS ? Math.floor(since / 1000) : undefined;
    const data = await get(
      '/defi/v3/token/txs',
      {
        address: mint,
        offset: 0,
        limit: clampInt(query.limit, DEFAULT_TRADES, 1, BIRDEYE_MAX_TRADES),
        tx_type: 'swap',
        sort_type: 'desc',
        pool_id: query.pool && isSolanaAddress(query.pool) ? query.pool : undefined,
        after_time: afterTime,
      },
      signal,
    );
    const fetchedAt = Date.now();
    if (!Array.isArray(data.items)) throw malformed('trades');
    const trades: Trade[] = [];
    for (const item of data.items) {
      const trade = parseTrade(item, mint);
      if (trade && (since === undefined || trade.timestamp > since)) trades.push(trade);
    }
    return sourced(trades, fetchedAt, 'fast');
  }

  async function getHolders(mint: string, limit = DEFAULT_HOLDERS, signal?: AbortSignal): Promise<Sourced<HolderSnapshot>> {
    assertMint(mint);
    const max = clampInt(limit, DEFAULT_HOLDERS, 1, BIRDEYE_MAX_HOLDERS);
    // Same 30 CU for any page size up to 100: fetch at least the ten accounts behind Birdeye's top-10 share.
    const [data, pdas] = await Promise.all([
      get('/defi/v3/token/holder', { address: mint, offset: 0, limit: Math.max(max, TOP10_ROWS) }, signal),
      launchpadPdasOf(mint),
    ]);
    const fetchedAt = Date.now();
    const page = parseHolderPage(data, isProgramOwner, (owner) => staticLiquidityLabel(owner, pdas.curve, pdas.pumpSwapPool));
    if (!page) throw malformed('holders');
    const snapshot: HolderSnapshot = { mint, top: page.entries.slice(0, max), updatedAt: fetchedAt };
    if (page.totalHolders !== undefined) snapshot.totalHolders = page.totalHolders;

    // Birdeye's top-10 share sums token accounts, liquidity vaults included, while ORBYT's
    // concentration excludes them. A known curve / pool vault among those accounts makes the
    // figure wrong for that definition, so it is withheld; an unlabelled program-derived owner
    // only might be one, so the figure stays with a caveat. Plain wallets need no caveat.
    const notes: string[] = [];
    if (page.top10Pct !== undefined) {
      const top10 = page.entries.slice(0, TOP10_ROWS);
      if (top10.some((h) => h.label !== undefined)) {
        notes.push(BIRDEYE_TOP10_OMITTED_NOTE);
      } else {
        snapshot.distribution = { top10Pct: page.top10Pct };
        if (top10.some((h) => h.isProgramAccount)) notes.push(BIRDEYE_TOP10_NOTE);
      }
    }
    return sourced(snapshot, fetchedAt, 'indexed', notes);
  }

  async function getRisk(mint: string, signal?: AbortSignal): Promise<Sourced<RiskReport>> {
    assertMint(mint);
    const [security, profile] = await Promise.allSettled([
      get('/defi/token_security', { address: mint }, signal),
      get('/token/v1/holder-profile', { token_address: mint }, signal),
    ]);
    for (const result of [security, profile]) {
      if (result.status === 'rejected' && isAbortError(result.reason)) throw result.reason;
    }
    if (security.status === 'rejected' && profile.status === 'rejected') throw security.reason;

    const fetchedAt = Date.now();
    let report: RiskReport = { mint, flags: [], sources: [PROVIDER], updatedAt: fetchedAt };
    const notes: string[] = [];
    if (security.status === 'fulfilled') {
      const { fields, flags } = parseSecurity(security.value);
      report = { ...report, ...fields, flags };
    } else {
      notes.push(`Token security unavailable (${describeError(security.reason)}).`);
    }
    if (profile.status === 'fulfilled') {
      // token_security wins for overlapping fields (top10, creator holding); tags add snipers/bundlers/insiders.
      report = fillMissing<RiskReport>(report, parseHolderProfile(profile.value));
    } else {
      notes.push(`Holder profile unavailable (${describeError(profile.reason)}).`);
    }
    return sourced(report, fetchedAt, 'indexed', notes);
  }

  async function getPulse(column: PulseColumn, signal?: AbortSignal): Promise<Sourced<PulseToken[]>> {
    const nowS = Math.floor(Date.now() / 1000);
    const byColumn: Record<PulseColumn, Params> = {
      new: { sort_by: 'creation_time', sort_type: 'desc', graduated: false },
      final: {
        sort_by: 'progress_percent',
        sort_type: 'desc',
        graduated: false,
        min_progress_percent: FINAL_MIN_PROGRESS_PCT,
        min_last_trade_unix_time: nowS - FINAL_ACTIVE_WINDOW_S,
      },
      migrated: { sort_by: 'graduated_time', sort_type: 'desc', graduated: true },
    };
    const data = await get('/defi/v3/token/meme/list', { ...byColumn[column], offset: 0, limit: BIRDEYE_PULSE_LIMIT }, signal);
    const fetchedAt = Date.now();
    if (!Array.isArray(data.items)) throw malformed('meme list');
    const tokens: PulseToken[] = [];
    for (const item of data.items) {
      const token = parseMemeItem(item, column, fetchedAt);
      if (token) tokens.push(token);
    }
    return sourced(tokens, fetchedAt, 'fast');
  }

  return { id: PROVIDER, intervals: BIRDEYE_INTERVALS, getCandles, getTrades, getHolders, getRisk, getPulse };
}
