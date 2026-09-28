/**
 * Discover / watchlist composition (isomorphic, pure).
 *
 * Everything here is provider-agnostic and free of React so it can be unit
 * tested: list loading over a failover chain, enrichment merging, client-side
 * sorting and filtering, and URL parameter parsing. Nothing in this module
 * invents a value: merges only fill gaps (`fillMissing`), sorts keep unknown
 * values last, and filters never treat an unknown metric as passing a bound.
 */

import { ChainError, fillMissing, runChain, type ChainAttempt, type ChainResult } from '@/lib/core/chain';
import { normalizeDex } from '@/lib/core/dex';
import {
  PROVIDER_LABELS,
  type DiscoverList,
  type DiscoverWindow,
  type ProviderId,
  type TokenDiscoveryProvider,
  type TokenRowsProvider,
} from '@/lib/core/providers';
import type { LaunchStage, LaunchpadState, StatWindow, TokenRow, WindowStats } from '@/lib/core/types';
import { describeError } from '@/lib/net/errors';
import type { JupiterUltraInfo } from '@/lib/providers/jupiter';

// ---------------------------------------------------------------------------
// Lists, windows and URL parameters
// ---------------------------------------------------------------------------

/** Discover tabs. `gainers` is the trending list re-sorted client-side by the window's price change. */
export type DiscoverListKey = DiscoverList | 'gainers';

export const DISCOVER_LISTS: readonly { value: DiscoverListKey; label: string }[] = [
  { value: 'trending', label: 'Trending' },
  { value: 'top', label: 'Top volume' },
  { value: 'organic', label: 'Organic' },
  { value: 'new', label: 'New' },
  { value: 'gainers', label: 'Gainers' },
];

export const DISCOVER_WINDOWS: readonly DiscoverWindow[] = ['5m', '1h', '6h', '24h'];

export const WINDOW_STAT: Readonly<Record<DiscoverWindow, StatWindow>> = { '5m': 'm5', '1h': 'h1', '6h': 'h6', '24h': 'h24' };

/** Rows requested per list (Jupiter category max; GeckoTerminal returns one 20-pool page). */
export const DISCOVER_LIMIT = 100;

export const GAINERS_NOTE = 'Gainers is a sorted sample of trending tokens, not a market-wide ranking';

export type StageFilter = 'all' | 'bonding' | 'graduated' | 'amm';
export const STAGE_FILTERS: readonly { value: StageFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'bonding', label: 'Bonding' },
  { value: 'graduated', label: 'Graduated' },
  { value: 'amm', label: 'AMM' },
];

/** Max-age presets (URL value → milliseconds). */
export const AGE_PRESETS: readonly { value: string; label: string; ms: number }[] = [
  { value: '1h', label: '1h', ms: 3_600_000 },
  { value: '6h', label: '6h', ms: 6 * 3_600_000 },
  { value: '24h', label: '24h', ms: 86_400_000 },
  { value: '3d', label: '3d', ms: 3 * 86_400_000 },
  { value: '7d', label: '7d', ms: 7 * 86_400_000 },
  { value: '30d', label: '30d', ms: 30 * 86_400_000 },
];

export interface DiscoverFilters {
  minLiquidityUsd?: number;
  minMarketCapUsd?: number;
  /** One of AGE_PRESETS values. */
  maxAge?: string;
  stage: StageFilter;
  hideFlagged: boolean;
}

export const DEFAULT_FILTERS: DiscoverFilters = { stage: 'all', hideFlagged: false };

/** Patch that clears every filter (explicit undefined bounds override set ones when merged). */
export const CLEAR_FILTERS: DiscoverFilters = {
  minLiquidityUsd: undefined,
  minMarketCapUsd: undefined,
  maxAge: undefined,
  stage: 'all',
  hideFlagged: false,
};

export interface DiscoverParams {
  list: DiscoverListKey;
  window: DiscoverWindow;
  filters: DiscoverFilters;
}

export const DEFAULT_LIST: DiscoverListKey = 'trending';
export const DEFAULT_WINDOW: DiscoverWindow = '1h';

type SearchParamsLike = URLSearchParams | Record<string, string | string[] | undefined>;

function param(sp: SearchParamsLike, key: string): string | undefined {
  if (sp instanceof URLSearchParams) return sp.get(key) ?? undefined;
  const value = sp[key];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Parse a USD amount typed by a trader: "10k", "1.5m", "$50,000", "2b".
 * Returns undefined for empty, invalid, zero or negative input (no bound).
 */
export function parseUsdInput(raw: string | undefined | null): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().toLowerCase().replace(/[$,\s_]/g, '');
  // A trailing dot ("10.") is accepted so typing "10.5" never flashes invalid.
  const m = /^(\d+(?:\.\d*)?|\.\d+)([kmb])?$/.exec(s);
  if (!m) return undefined;
  const mult = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1;
  const n = Number(m[1]) * mult;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Compact USD for inputs and URLs: 10000 → "10k", 1500000 → "1.5m". */
export function formatUsdInput(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return '';
  const fmt = (v: number) => String(Number(v.toFixed(3)));
  if (n >= 1e9 && n % 1e7 === 0) return `${fmt(n / 1e9)}b`;
  if (n >= 1e6 && n % 1e4 === 0) return `${fmt(n / 1e6)}m`;
  if (n >= 1e3 && n % 10 === 0) return `${fmt(n / 1e3)}k`;
  return fmt(n);
}

function isListKey(v: string | undefined): v is DiscoverListKey {
  return DISCOVER_LISTS.some((l) => l.value === v);
}

function isWindow(v: string | undefined): v is DiscoverWindow {
  return DISCOVER_WINDOWS.includes(v as DiscoverWindow);
}

function isStage(v: string | undefined): v is StageFilter {
  return STAGE_FILTERS.some((s) => s.value === v);
}

/** URL → params. Unknown or invalid values fall back to defaults. */
export function parseDiscoverParams(sp: SearchParamsLike): DiscoverParams {
  const list = param(sp, 'list');
  const window = param(sp, 'w');
  const stage = param(sp, 'stage');
  const age = param(sp, 'age');
  const filters: DiscoverFilters = {
    stage: isStage(stage) ? stage : 'all',
    hideFlagged: param(sp, 'flagged') === 'hide',
  };
  const liq = parseUsdInput(param(sp, 'liq'));
  const mc = parseUsdInput(param(sp, 'mc'));
  if (liq !== undefined) filters.minLiquidityUsd = liq;
  if (mc !== undefined) filters.minMarketCapUsd = mc;
  if (AGE_PRESETS.some((p) => p.value === age)) filters.maxAge = age;
  return {
    list: isListKey(list) ? list : DEFAULT_LIST,
    window: isWindow(window) ? window : DEFAULT_WINDOW,
    filters,
  };
}

/** Params → query string (defaults omitted, so the canonical URL is bare). */
export function serializeDiscoverParams(p: DiscoverParams): string {
  const sp = new URLSearchParams();
  if (p.list !== DEFAULT_LIST) sp.set('list', p.list);
  if (p.window !== DEFAULT_WINDOW) sp.set('w', p.window);
  const liq = formatUsdInput(p.filters.minLiquidityUsd);
  const mc = formatUsdInput(p.filters.minMarketCapUsd);
  if (liq) sp.set('liq', liq);
  if (mc) sp.set('mc', mc);
  if (p.filters.maxAge && AGE_PRESETS.some((a) => a.value === p.filters.maxAge)) sp.set('age', p.filters.maxAge);
  if (p.filters.stage !== 'all') sp.set('stage', p.filters.stage);
  if (p.filters.hideFlagged) sp.set('flagged', 'hide');
  return sp.toString();
}

export function activeFilterCount(f: DiscoverFilters): number {
  let n = 0;
  if (f.minLiquidityUsd !== undefined) n++;
  if (f.minMarketCapUsd !== undefined) n++;
  if (f.maxAge !== undefined) n++;
  if (f.stage !== 'all') n++;
  if (f.hideFlagged) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Row accessors
// ---------------------------------------------------------------------------

export function windowStats(row: TokenRow, window: DiscoverWindow): WindowStats | undefined {
  return row.market.stats[WINDOW_STAT[window]];
}

function finite(n: number | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Total transactions in the window; only when both halves are known. */
export function txCount(stats: WindowStats | undefined): number | undefined {
  const buys = finite(stats?.buys);
  const sells = finite(stats?.sells);
  return buys !== undefined && sells !== undefined ? buys + sells : undefined;
}

/**
 * Launch stage. Explicit launchpad data wins; a row whose main pool is a
 * regular AMM pool (and no launchpad history is known) counts as `amm`.
 */
export function stageOf(row: TokenRow): LaunchStage {
  const stage = row.token.launchpad?.stage;
  if (stage && stage !== 'unknown') return stage;
  if (row.pool && row.pool.dex !== 'unknown') return 'amm';
  return 'unknown';
}

/** Bonding-curve progress for the avatar ring (bonding tokens only). */
export function bondingProgress(row: TokenRow): number | undefined {
  const lp = row.token.launchpad;
  return lp?.stage === 'bonding' ? finite(lp.progressPct) : undefined;
}

function readFlag(risk: object | undefined, key: string): unknown {
  return risk ? (risk as Record<string, unknown>)[key] : undefined;
}

/**
 * Raised red flags from real provider data: a provider "suspicious" flag
 * (Jupiter audit.isSus, when a source passes it through), or a mint / freeze
 * authority that is still active. Unknown authority state is not a flag.
 */
export function flagReasons(row: TokenRow): string[] {
  const reasons: string[] = [];
  const risk = row.risk;
  if (readFlag(risk, 'isSus') === true) reasons.push('Flagged suspicious');
  if (risk?.mintAuthorityDisabled === false) reasons.push('Mint authority active');
  if (risk?.freezeAuthorityDisabled === false) reasons.push('Freeze authority active');
  return reasons;
}

export function isFlagged(row: TokenRow): boolean {
  return flagReasons(row).length > 0;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export function maxAgeMs(filters: DiscoverFilters): number | undefined {
  return AGE_PRESETS.find((p) => p.value === filters.maxAge)?.ms;
}

/**
 * Apply filters. A bound on a metric the provider did not report excludes the
 * row: an unknown liquidity cannot be shown to be above a minimum.
 */
export function filterRows(rows: readonly TokenRow[], filters: DiscoverFilters, now: number): TokenRow[] {
  const ageMs = maxAgeMs(filters);
  return rows.filter((row) => {
    if (filters.minLiquidityUsd !== undefined) {
      const liq = finite(row.market.liquidityUsd);
      if (liq === undefined || liq < filters.minLiquidityUsd) return false;
    }
    if (filters.minMarketCapUsd !== undefined) {
      const mc = finite(row.market.marketCapUsd);
      if (mc === undefined || mc < filters.minMarketCapUsd) return false;
    }
    if (ageMs !== undefined) {
      const created = finite(row.token.createdAt);
      if (created === undefined || now - created > ageMs) return false;
    }
    if (filters.stage !== 'all' && stageOf(row) !== filters.stage) return false;
    if (filters.hideFlagged && isFlagged(row)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type SortKey =
  | 'rank'
  | 'age'
  | 'price'
  | 'change'
  | 'mc'
  | 'liq'
  | 'vol'
  | 'txns'
  | 'traders'
  | 'holders'
  | 'top10'
  | 'dev'
  | 'snipers'
  | 'insiders'
  | 'bundlers';

export type SortDir = 'asc' | 'desc';

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

/** First-click direction: rank and age read naturally ascending, metrics descending (largest first). */
export function defaultDir(key: SortKey): SortDir {
  return key === 'rank' || key === 'age' ? 'asc' : 'desc';
}

/** Header click cycle: default direction → reversed → back to the provider's order. */
export function nextSort(current: SortState | null, key: SortKey): SortState | null {
  if (!current || current.key !== key) return { key, dir: defaultDir(key) };
  if (current.dir === defaultDir(key)) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return null;
}

/**
 * Sort value for a column. `age` is the negated creation time so that
 * ascending means youngest first. Unknown → undefined.
 */
export function sortValue(row: TokenRow, key: SortKey, window: DiscoverWindow): number | undefined {
  const stats = windowStats(row, window);
  switch (key) {
    case 'rank':
      return finite(row.rank);
    case 'age': {
      const created = finite(row.token.createdAt);
      return created === undefined ? undefined : -created;
    }
    case 'price':
      return finite(row.market.priceUsd);
    case 'change':
      return finite(stats?.priceChangePct);
    case 'mc':
      return finite(row.market.marketCapUsd);
    case 'liq':
      return finite(row.market.liquidityUsd);
    case 'vol':
      return finite(stats?.volumeUsd);
    case 'txns':
      return txCount(stats);
    case 'traders':
      return finite(stats?.traders);
    case 'holders':
      return finite(row.market.holders);
    case 'top10':
      return finite(row.risk?.top10Pct);
    case 'dev':
      return finite(row.risk?.devHoldingPct);
    case 'snipers':
      return finite(row.risk?.snipersPct);
    case 'insiders':
      return finite(row.risk?.insidersPct);
    case 'bundlers':
      return finite(row.risk?.bundlersPct);
  }
}

/** Numeric comparator that keeps unknown values last in BOTH directions. */
export function compareNullable(a: number | undefined, b: number | undefined, dir: SortDir): number {
  const aKnown = typeof a === 'number' && Number.isFinite(a);
  const bKnown = typeof b === 'number' && Number.isFinite(b);
  if (!aKnown && !bKnown) return 0;
  if (!aKnown) return 1;
  if (!bKnown) return -1;
  return dir === 'asc' ? a - b : b - a;
}

/** Stable client-side sort (ties keep the provider's order). `null` keeps the input order. */
export function sortRows(rows: readonly TokenRow[], sort: SortState | null, window: DiscoverWindow): TokenRow[] {
  if (!sort) return [...rows];
  return rows
    .map((row, index) => ({ row, index, value: sortValue(row, sort.key, window) }))
    .sort((a, b) => compareNullable(a.value, b.value, sort.dir) || a.index - b.index)
    .map((x) => x.row);
}

/** Gainers: trending rows by the window's price change (desc, unknown last), re-ranked. */
export function sortGainers(rows: readonly TokenRow[], window: DiscoverWindow): TokenRow[] {
  return sortRows(rows, { key: 'change', dir: 'desc' }, window).map((row, i) => ({ ...row, rank: i + 1 }));
}

// ---------------------------------------------------------------------------
// Base list loading (failover chain)
// ---------------------------------------------------------------------------

export interface DiscoverSources {
  /** ORBYT /api/v1/discover proxy; pass only when a keyed provider backs it (capabilities.serverDiscover). */
  server?: TokenDiscoveryProvider | null;
  jupiter: TokenDiscoveryProvider;
  gecko: TokenDiscoveryProvider;
}

/** The upstream list behind a tab (gainers is a view over trending). */
export function baseListOf(list: DiscoverListKey): DiscoverList {
  return list === 'gainers' ? 'trending' : list;
}

/**
 * Load one discovery list: server proxy (keyed) → Jupiter → GeckoTerminal.
 * Organic has no GeckoTerminal equivalent. An empty answer moves on to the
 * next provider; if every provider answers empty, that honest empty list is
 * returned. The gainers ordering is applied by `toGainers` so trending and
 * gainers can share one cached request.
 */
export function loadDiscoverList(
  sources: DiscoverSources,
  list: DiscoverList,
  window: DiscoverWindow,
  signal?: AbortSignal,
): Promise<ChainResult<TokenRow[]>> {
  const query = { list, window, limit: DISCOVER_LIMIT };
  const { server, jupiter, gecko } = sources;
  return runChain<TokenRow[]>(
    `discover ${list}`,
    [
      server && { id: server.id, run: () => server.discover(query, signal) },
      { id: jupiter.id, run: () => jupiter.discover(query, signal) },
      list !== 'organic' && { id: gecko.id, run: () => gecko.discover(query, signal) },
    ],
    { signal, accept: (r) => r.data.length > 0 },
  );
}

/** Trending result → gainers view (sorted sample), with the caveat attached. */
export function toGainers(result: ChainResult<TokenRow[]>, window: DiscoverWindow): ChainResult<TokenRow[]> {
  return { ...result, data: sortGainers(result.data, window), notes: [...(result.notes ?? []), GAINERS_NOTE] };
}

// ---------------------------------------------------------------------------
// Watchlist rows (failover chain + gap fill)
// ---------------------------------------------------------------------------

export interface TokenRowsSources {
  /** ORBYT /api/v1/tokens proxy; pass only when capabilities.serverDiscover. */
  server?: TokenRowsProvider | null;
  jupiter: TokenRowsProvider;
  gecko: TokenRowsProvider;
  dex: TokenRowsProvider;
}

export type TokenRowsResult = ChainResult<TokenRow[]> & {
  /** Requested mints no provider returned. */
  missing: string[];
};

/** Rows in the order of `mints`, one per mint (first occurrence wins). */
export function orderByMints(rows: readonly TokenRow[], mints: readonly string[]): TokenRow[] {
  const byMint = new Map<string, TokenRow>();
  for (const row of rows) if (!byMint.has(row.token.mint)) byMint.set(row.token.mint, row);
  const out: TokenRow[] = [];
  for (const mint of mints) {
    const row = byMint.get(mint);
    if (row) {
      out.push(row);
      byMint.delete(mint);
    }
  }
  return out;
}

/**
 * Rows for arbitrary mints (watchlist): server → Jupiter → GeckoTerminal →
 * DEX Screener. Mints the winning provider does not know are looked up once
 * more on DEX Screener (generous keyless budget) so a thin index does not
 * silently drop a watched token; anything still unknown is reported as
 * missing, never padded with placeholder numbers.
 */
export async function loadTokenRows(sources: TokenRowsSources, mints: readonly string[], signal?: AbortSignal): Promise<TokenRowsResult> {
  const list = [...new Set(mints)];
  const { server, jupiter, gecko, dex } = sources;
  const result = await runChain<TokenRow[]>(
    'token rows',
    [
      server && { id: server.id, run: () => server.getRows(list, signal) },
      { id: jupiter.id, run: () => jupiter.getRows(list, signal) },
      { id: gecko.id, run: () => gecko.getRows(list, signal) },
      { id: dex.id, run: () => dex.getRows(list, signal) },
    ],
    { signal, accept: (r) => r.data.length > 0 },
  );
  let rows = result.data;
  const notes = [...(result.notes ?? [])];
  const contributors = new Set<ProviderId>(result.contributors ?? []);
  const found = new Set(rows.map((r) => r.token.mint));
  let missing = list.filter((m) => !found.has(m));
  if (missing.length && result.source !== dex.id) {
    try {
      const extra = await dex.getRows(missing, signal);
      const fill = extra.data.filter((r) => missing.includes(r.token.mint));
      if (fill.length) {
        rows = [...rows, ...fill];
        contributors.add(dex.id);
        const filled = new Set(fill.map((r) => r.token.mint));
        missing = missing.filter((m) => !filled.has(m));
      }
    } catch (error) {
      notes.push(`Gap fill failed (${describeError(error)})`);
    }
  }
  contributors.delete(result.source);
  return {
    ...result,
    data: orderByMints(rows, list),
    ...(contributors.size ? { contributors: [...contributors] } : {}),
    ...(notes.length ? { notes } : {}),
    missing,
  };
}

/**
 * Mint set to request for a changing watchlist: removing tokens reuses the
 * previous (superset) request instead of spending another call; any new mint
 * triggers a fresh request for exactly the current set. Inputs are sorted.
 */
export function stableFetchSet(prev: readonly string[], current: readonly string[]): readonly string[] {
  if (prev.length === current.length && prev.every((m, i) => m === current[i])) return prev;
  if (current.length > 0 && prev.length - current.length <= 10) {
    const have = new Set(prev);
    if (current.every((m) => have.has(m))) return prev;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Enrichment (Jupiter Ultra risk extras + DEX Screener pool / socials)
// ---------------------------------------------------------------------------

export interface RowEnrichment {
  /** Jupiter Ultra search extras (snipers / insiders / bundlers / bonding progress). */
  ultra?: JupiterUltraInfo;
  /** DEX Screener main-pair row (pool / DEX label, logo and social fallbacks). */
  dex?: TokenRow;
}

export interface EnrichmentSnapshot {
  byMint: Record<string, RowEnrichment>;
  /** Last successful fetch per source (ms). */
  ultraAt?: number;
  dexAt?: number;
  /** Last failure per source, cleared by the next success. */
  errors: { ultra?: string; dex?: string };
}

type RowRisk = NonNullable<TokenRow['risk']>;

/** True when `secondary` has a defined value for a key `primary` lacks. */
function fillsGap(primary: object | undefined, secondary: object | undefined): boolean {
  if (!secondary) return false;
  const p = (primary ?? {}) as Record<string, unknown>;
  return Object.entries(secondary).some(([k, v]) => v !== undefined && p[k] === undefined);
}

/** Fill-only merge of one row with its enrichment. Primary values are never overwritten. */
export function enrichRow(row: TokenRow, e: RowEnrichment | undefined): TokenRow {
  if (!e || (!e.ultra && !e.dex)) return row;
  let token = row.token;
  let pool = row.pool;
  let risk = row.risk;

  const dexRow = e.dex;
  if (dexRow && dexRow.token.mint === token.mint) {
    const t = dexRow.token;
    const identity = { symbol: t.symbol, name: t.name, image: t.image, createdAt: t.createdAt, launchpad: t.launchpad };
    if (fillsGap(token, identity)) token = fillMissing(token, identity);
    if (fillsGap(token.socials, t.socials)) token = { ...token, socials: fillMissing({ ...token.socials }, t.socials) };
    if (!pool && dexRow.pool) pool = dexRow.pool;
  }

  const ultra = e.ultra;
  if (ultra) {
    if (fillsGap(risk, ultra.risk)) risk = fillMissing<RowRisk>({ ...risk }, ultra.risk);
    const p = finite(ultra.progressPct);
    if (p !== undefined) {
      const lp = token.launchpad;
      if (!lp || lp.stage === 'unknown') {
        // Jupiter reports curve progress only for launchpad tokens; 100 means graduated.
        const next: LaunchpadState = p >= 100 ? { stage: 'graduated' } : { stage: 'bonding', progressPct: p, progressSource: 'jupiter' };
        token = { ...token, launchpad: next };
      } else if (lp.stage === 'bonding' && lp.progressPct === undefined) {
        token = { ...token, launchpad: { ...lp, progressPct: p, progressSource: 'jupiter' } };
      }
    }
  }

  if (token === row.token && pool === row.pool && risk === row.risk) return row;
  const out: TokenRow = { ...row, token };
  if (pool) out.pool = pool;
  if (risk) out.risk = risk;
  return out;
}

export function enrichRows(rows: readonly TokenRow[], snapshot: EnrichmentSnapshot | undefined): TokenRow[] {
  if (!snapshot) return [...rows];
  return rows.map((row) => enrichRow(row, snapshot.byMint[row.token.mint]));
}

/** Rows that still lack what Ultra supplies (sniper/insider/bundler shares or curve progress). */
export function needsUltra(row: TokenRow): boolean {
  const r = row.risk;
  const riskKnown = r?.snipersPct !== undefined && r.insidersPct !== undefined && r.bundlersPct !== undefined;
  const lp = row.token.launchpad;
  const progressKnown = lp?.stage !== 'bonding' || lp.progressPct !== undefined;
  return !(riskKnown && progressKnown);
}

/** Rows without a pool / DEX label (Jupiter rows); GeckoTerminal rows already carry one. */
export function needsDex(row: TokenRow): boolean {
  return !row.pool;
}

export interface EnrichmentFetchers {
  ultra: (mints: string[]) => Promise<Record<string, JupiterUltraInfo>>;
  dexRows: (mints: string[]) => Promise<TokenRow[]>;
}

export interface EnrichmentCacheOptions {
  /** Per-mint refresh age (ms). */
  ttlMs?: number;
  /** Minimum gap between Ultra calls (keyless Jupiter budget is shared with the base list). */
  ultraMinGapMs?: number;
  /** Minimum gap between DEX Screener batches. */
  dexMinGapMs?: number;
  /** Max mints enriched per load. */
  maxMints?: number;
  now?: () => number;
}

export interface EnrichmentCache {
  load(rows: readonly TokenRow[]): Promise<EnrichmentSnapshot>;
}

interface Entry<T> {
  at: number;
  value?: T;
}

/**
 * Incremental per-mint enrichment cache shared by Discover and the watchlist.
 * Each load fetches only mints that are new or older than `ttlMs`, so a list
 * whose membership changes a little every poll costs one small call, while
 * the minimum gaps cap the request rate regardless of how often it runs.
 * Unknown mints are cached as "no data" until they age out. Failures are
 * reported in the snapshot and retried after the gap.
 */
export function createEnrichmentCache(fetchers: EnrichmentFetchers, opts: EnrichmentCacheOptions = {}): EnrichmentCache {
  const ttl = opts.ttlMs ?? 55_000;
  const ultraGap = opts.ultraMinGapMs ?? 30_000;
  const dexGap = opts.dexMinGapMs ?? 10_000;
  const maxMints = opts.maxMints ?? 100;
  const now = opts.now ?? Date.now;

  const ultra = new Map<string, Entry<JupiterUltraInfo>>();
  const dex = new Map<string, Entry<TokenRow>>();
  let lastUltraCall = Number.NEGATIVE_INFINITY;
  let lastDexCall = Number.NEGATIVE_INFINITY;
  let ultraAt: number | undefined;
  let dexAt: number | undefined;
  const errors: EnrichmentSnapshot['errors'] = {};
  let inflight: Promise<unknown> | null = null;

  function prune(t: number) {
    const maxAge = ttl * 10;
    for (const map of [ultra, dex] as Map<string, Entry<unknown>>[]) {
      if (map.size < 1_000) continue;
      for (const [mint, entry] of map) if (t - entry.at > maxAge) map.delete(mint);
    }
  }

  function due<T>(map: Map<string, Entry<T>>, mints: string[], t: number): string[] {
    return mints.filter((m) => {
      const entry = map.get(m);
      return !entry || t - entry.at >= ttl;
    });
  }

  async function refresh(rows: readonly TokenRow[]): Promise<void> {
    const t = now();
    prune(t);
    const scoped = rows.slice(0, maxMints);
    const ultraDue = due(ultra, scoped.filter(needsUltra).map((r) => r.token.mint), t);
    const dexDue = due(dex, scoped.filter(needsDex).map((r) => r.token.mint), t);
    const tasks: Promise<void>[] = [];

    if (ultraDue.length && t - lastUltraCall >= ultraGap) {
      lastUltraCall = t;
      tasks.push(
        fetchers.ultra(ultraDue).then(
          (data) => {
            const at = now();
            for (const mint of ultraDue) ultra.set(mint, { at, value: data[mint] });
            ultraAt = at;
            delete errors.ultra;
          },
          (error: unknown) => {
            errors.ultra = describeError(error);
          },
        ),
      );
    }

    if (dexDue.length && t - lastDexCall >= dexGap) {
      lastDexCall = t;
      tasks.push(
        fetchers.dexRows(dexDue).then(
          (data) => {
            const at = now();
            const byMint = new Map(data.map((r) => [r.token.mint, r] as const));
            for (const mint of dexDue) dex.set(mint, { at, value: byMint.get(mint) });
            dexAt = at;
            delete errors.dex;
          },
          (error: unknown) => {
            errors.dex = describeError(error);
          },
        ),
      );
    }

    await Promise.all(tasks);
  }

  return {
    async load(rows) {
      // Serialize loads so overlapping runs never request the same mints twice.
      while (inflight) await inflight.catch(() => undefined);
      const run = refresh(rows);
      inflight = run;
      try {
        await run;
      } finally {
        inflight = null;
      }
      const byMint: Record<string, RowEnrichment> = {};
      for (const row of rows.slice(0, maxMints)) {
        const mint = row.token.mint;
        const u = ultra.get(mint)?.value;
        const d = dex.get(mint)?.value;
        if (u || d) byMint[mint] = { ...(u ? { ultra: u } : {}), ...(d ? { dex: d } : {}) };
      }
      return {
        byMint,
        ...(ultraAt !== undefined ? { ultraAt } : {}),
        ...(dexAt !== undefined ? { dexAt } : {}),
        errors: { ...errors },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure)
// ---------------------------------------------------------------------------

/** Chain attempts worth showing: `not_configured` server routes are skipped silently. */
export function visibleFailures(attempts: readonly ChainAttempt[] | undefined): ChainAttempt[] {
  return (attempts ?? []).filter((a) => !a.ok && a.code !== 'not_configured');
}

/** "Jupiter: rate limited" from a chain attempt (error strings start with the provider id). */
export function describeAttempt(attempt: ChainAttempt): string {
  const label = attempt.provider === 'orbyt' ? 'ORBYT API' : PROVIDER_LABELS[attempt.provider];
  const detail = attempt.code === 'empty' ? 'no data' : (attempt.error ?? 'failed').replace(/^[a-z][a-z-]*:\s*/i, '');
  return `${label}: ${detail}`;
}

/** User-facing lines for a failed load: one per provider tried (silent 501s omitted). */
export function errorLines(error: unknown): string[] {
  if (error instanceof ChainError) {
    const lines = visibleFailures(error.attempts).map(describeAttempt);
    if (lines.length) return lines;
  }
  return [describeError(error)];
}

const GECKO_IDS: ReadonlySet<ProviderId> = new Set<ProviderId>(['geckoterminal', 'coingecko']);

/** GeckoTerminal's licence asks for attribution wherever its data is shown. */
export function showsGeckoData(result: { source: ProviderId; contributors?: ProviderId[] } | undefined, rows?: readonly TokenRow[]): boolean {
  if (!result) return false;
  if (GECKO_IDS.has(result.source) || result.contributors?.some((p) => GECKO_IDS.has(p))) return true;
  return rows?.some((r) => GECKO_IDS.has(r.market.source)) ?? false;
}

export type RiskMetric = 'top10' | 'dev' | 'snipers' | 'insiders' | 'bundlers';

/** Risk colour level per the design brief: top10 > 30 warn, > 50 danger; dev > 10 warn; snipers/insiders/bundlers > 20 warn. */
export function riskLevel(metric: RiskMetric, pct: number | undefined): 'ok' | 'warn' | 'danger' | 'unknown' {
  if (pct === undefined || !Number.isFinite(pct)) return 'unknown';
  switch (metric) {
    case 'top10':
      return pct > 50 ? 'danger' : pct > 30 ? 'warn' : 'ok';
    case 'dev':
      return pct > 10 ? 'warn' : 'ok';
    default:
      return pct > 20 ? 'warn' : 'ok';
  }
}

/** Buy share of the window's transactions (0–100); undefined unless both sides are known and non-zero in total. */
export function buyShare(stats: WindowStats | undefined): number | undefined {
  const total = txCount(stats);
  const buys = finite(stats?.buys);
  if (total === undefined || buys === undefined || total <= 0) return undefined;
  return (buys / total) * 100;
}

/**
 * Venue label for a launchpad display name, matching the DEX labels pools
 * carry ('pump.fun' → 'Pump.fun', 'Meteora DBC' → 'Meteora DBC', 'stonkfun' → 'StonkFun').
 */
export function launchpadVenue(launchpad: string | undefined): string | undefined {
  const name = launchpad?.trim();
  if (!name) return undefined;
  return normalizeDex('orbyt', name.toLowerCase().replace(/\./g, '').replace(/\s+/g, '-')).label;
}

/** Short launchpad badge text ('pump.fun' → 'Pump', 'Meteora DBC' → 'DBC'). */
export function launchpadBadge(launchpad: string | undefined): string | undefined {
  if (!launchpad) return undefined;
  const v = launchpad.toLowerCase();
  if (v.includes('pump')) return 'Pump';
  if (v.includes('bonk')) return 'Bonk';
  if (v.includes('launchlab')) return 'LaunchLab';
  if (v.includes('dbc')) return 'DBC';
  if (v.includes('bags')) return 'Bags';
  if (v.includes('moonshot')) return 'Moonshot';
  if (v.includes('boop')) return 'Boop';
  const name = launchpadVenue(launchpad) ?? launchpad;
  return name.length > 10 ? `${name.slice(0, 9)}…` : name;
}
