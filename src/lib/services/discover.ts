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
import { isSolanaAddress, MINTS } from '@/lib/core/solana';
import type { Freshness, LaunchStage, LaunchpadState, Sourced, StatWindow, TokenRow, WindowStats } from '@/lib/core/types';
import { describeError, isAbortError, isProviderError } from '@/lib/net/errors';
import type { JsonFetcher } from '@/lib/net/types';
import { GECKOTERMINAL_ACCEPT, GECKOTERMINAL_BASE_URLS } from '@/lib/providers/geckoterminal';
import { parseList, rowFromPool } from '@/lib/providers/geckoterminal/parse';
import type { JupiterUltraInfo } from '@/lib/providers/jupiter';

// ---------------------------------------------------------------------------
// Lists, windows and URL parameters
// ---------------------------------------------------------------------------

/**
 * Discover tabs. `all` is the deduplicated union of every keyless list
 * (see "Universe" below); `gainers` is the trending list re-sorted
 * client-side by the window's price change.
 */
export type DiscoverListKey = DiscoverList | 'gainers' | 'all';

export const DISCOVER_LISTS: readonly { value: DiscoverListKey; label: string }[] = [
  { value: 'all', label: 'All' },
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

export const DEFAULT_LIST: DiscoverListKey = 'all';
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
  /** Keyless fallback; omit (null) when GeckoTerminal is loaded separately (the universe). */
  gecko?: TokenDiscoveryProvider | null;
}

/**
 * SOL and USD stablecoins are quote assets, not Discover tokens. Jupiter's
 * lists already drop them, but GeckoTerminal's network-wide pool lists lead
 * with SOL/USDC-style pools whose base token is SOL or a stablecoin.
 */
export const DISCOVER_EXCLUDED_MINTS: ReadonlySet<string> = new Set([
  MINTS.SOL,
  MINTS.USDC,
  MINTS.USDT,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT (canonical SPL mint)
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', // USD1
]);

export function isExcludedMint(mint: string): boolean {
  return DISCOVER_EXCLUDED_MINTS.has(mint);
}

/** Drop excluded mints from a ranked list, renumbering ranks so they stay contiguous. */
export function withoutExcluded(result: Sourced<TokenRow[]>): Sourced<TokenRow[]> {
  if (!result.data.some((r) => isExcludedMint(r.token.mint))) return result;
  const data = result.data
    .filter((r) => !isExcludedMint(r.token.mint))
    .map((r, i) => (r.rank === undefined || r.rank === i + 1 ? r : { ...r, rank: i + 1 }));
  return { ...result, data };
}

/** The upstream list behind a tab (gainers is a view over trending; `all` has no single upstream list). */
export function baseListOf(list: DiscoverListKey): DiscoverList {
  return list === 'gainers' || list === 'all' ? 'trending' : list;
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
      server && { id: server.id, run: () => server.discover(query, signal).then(withoutExcluded) },
      { id: jupiter.id, run: () => jupiter.discover(query, signal).then(withoutExcluded) },
      gecko && list !== 'organic' && { id: gecko.id, run: () => gecko.discover(query, signal).then(withoutExcluded) },
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
        // A known launchpad name (stage still unknown) is kept.
        const known: Pick<LaunchpadState, 'launchpad'> = lp?.launchpad ? { launchpad: lp.launchpad } : {};
        const next: LaunchpadState =
          p >= 100 ? { ...known, stage: 'graduated' } : { ...known, stage: 'bonding', progressPct: p, progressSource: 'jupiter' };
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

/**
 * Per-row memo: the enrichment cache hands out the same Ultra / DEX Screener
 * objects until it refetches them, so an unchanged (row, ultra, dex) triple
 * maps to the same output object and memoized table rows skip re-rendering.
 */
const enrichMemo = new WeakMap<TokenRow, { ultra?: JupiterUltraInfo; dex?: TokenRow; out: TokenRow }>();

export function enrichRows(rows: readonly TokenRow[], snapshot: EnrichmentSnapshot | undefined): TokenRow[] {
  if (!snapshot) return [...rows];
  return rows.map((row) => {
    const e = snapshot.byMint[row.token.mint];
    if (!e) return row;
    const prev = enrichMemo.get(row);
    if (prev && prev.ultra === e.ultra && prev.dex === e.dex) return prev.out;
    const out = enrichRow(row, e);
    enrichMemo.set(row, { ultra: e.ultra, dex: e.dex, out });
    return out;
  });
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
  /** Max mints per Ultra call / DEX Screener batch (one Jupiter Ultra request). */
  maxMints?: number;
  /**
   * Cached values older than this are no longer served (the row shows "—"
   * again): rows that left the enrichment target never display risk shares
   * from minutes ago as if they were current.
   */
  maxServeAgeMs?: number;
  now?: () => number;
}

/**
 * Immutable handle on the cache contents at one point in time: a new object
 * after every fetch settles, so React can derive enriched rows from
 * (rows, revision) with useSyncExternalStore + useMemo and no effects.
 */
export interface EnrichmentRevision {
  readonly n: number;
  /** Snapshot for `rows` from cached data only (no fetching). */
  peek(rows: readonly TokenRow[]): EnrichmentSnapshot;
}

export const EMPTY_ENRICHMENT_REVISION: EnrichmentRevision = { n: 0, peek: () => ({ byMint: {}, errors: {} }) };

export interface EnrichmentCache {
  /** Fetch what is new or stale for `rows` (within the rate gaps), then return their snapshot. */
  load(rows: readonly TokenRow[]): Promise<EnrichmentSnapshot>;
  /** Current revision (identity changes whenever cached data changes). */
  revision(): EnrichmentRevision;
  /** Notified after every fetch settles. */
  subscribe(listener: () => void): () => void;
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
  const maxServeAge = opts.maxServeAgeMs ?? ttl * 5;
  const now = opts.now ?? Date.now;

  const ultra = new Map<string, Entry<JupiterUltraInfo>>();
  const dex = new Map<string, Entry<TokenRow>>();
  let lastUltraCall = Number.NEGATIVE_INFINITY;
  let lastDexCall = Number.NEGATIVE_INFINITY;
  let ultraAt: number | undefined;
  let dexAt: number | undefined;
  const errors: EnrichmentSnapshot['errors'] = {};
  let inflight: Promise<unknown> | null = null;
  const listeners = new Set<() => void>();
  let revisionCount = 0;

  function served<T>(entry: Entry<T> | undefined, t: number): T | undefined {
    return entry && t - entry.at <= maxServeAge ? entry.value : undefined;
  }

  /**
   * Cached data for every row (not only the fetch cap): a sorted or filtered
   * view enriches rows deep in the unsorted list, and those must render too.
   */
  function snapshot(rows: readonly TokenRow[]): EnrichmentSnapshot {
    const byMint: Record<string, RowEnrichment> = {};
    const t = now();
    for (const row of rows) {
      const mint = row.token.mint;
      const u = served(ultra.get(mint), t);
      const d = served(dex.get(mint), t);
      if (u || d) byMint[mint] = { ...(u ? { ultra: u } : {}), ...(d ? { dex: d } : {}) };
    }
    return {
      byMint,
      ...(ultraAt !== undefined ? { ultraAt } : {}),
      ...(dexAt !== undefined ? { dexAt } : {}),
      errors: { ...errors },
    };
  }

  let revision: EnrichmentRevision = { n: ++revisionCount, peek: snapshot };

  function bump() {
    revision = { n: ++revisionCount, peek: snapshot };
    listeners.forEach((l) => l());
  }

  function prune(t: number) {
    for (const map of [ultra, dex] as Map<string, Entry<unknown>>[]) {
      if (map.size < 1_000) continue;
      for (const [mint, entry] of map) if (t - entry.at > maxServeAge) map.delete(mint);
    }
  }

  /**
   * Mints to request in one call (≤ maxMints): never-fetched mints first, then
   * stale ones, each in row order. A target longer than one call is covered
   * over successive calls instead of starving everything past the first batch.
   */
  function due<T>(map: Map<string, Entry<T>>, mints: string[], t: number): string[] {
    const fresh: string[] = [];
    const stale: string[] = [];
    for (const m of mints) {
      const entry = map.get(m);
      if (!entry) fresh.push(m);
      else if (t - entry.at >= ttl) stale.push(m);
    }
    return [...fresh, ...stale].slice(0, maxMints);
  }

  async function refresh(rows: readonly TokenRow[]): Promise<void> {
    const t = now();
    prune(t);
    const ultraDue = due(ultra, rows.filter(needsUltra).map((r) => r.token.mint), t);
    const dexDue = due(dex, rows.filter(needsDex).map((r) => r.token.mint), t);
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
            bump();
          },
          (error: unknown) => {
            errors.ultra = describeError(error);
            bump();
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
            bump();
          },
          (error: unknown) => {
            errors.dex = describeError(error);
            bump();
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
      return snapshot(rows);
    },
    revision: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
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
const INDEXED_ROW_SOURCES: ReadonlySet<ProviderId> = new Set<ProviderId>(['geckoterminal', 'coingecko', 'dexscreener']);

/**
 * A Discover row as a token-page row result, used to seed the token page's
 * cache on hover so its header paints instantly with the row already on
 * screen (no request). It keeps the row's real fetch time and source, so the
 * token page shows its true age and refetches it on mount once stale.
 */
export function rowToTokenResult(row: TokenRow): ChainResult<TokenRow> {
  const source = row.market.source;
  return {
    data: row,
    source,
    fetchedAt: row.market.updatedAt,
    freshness: INDEXED_ROW_SOURCES.has(source) ? 'indexed' : 'fast',
    attempts: [{ provider: source, ok: true }],
  };
}

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

// ---------------------------------------------------------------------------
// Universe ("All"): the largest honest token set keyless sources allow
// ---------------------------------------------------------------------------

/**
 * Every keyless list ORBYT can read from the browser, loaded independently
 * and merged by mint. Order = merge precedence and default row order.
 */
export type UniverseSourceId =
  | 'jup-trending'
  | 'jup-top'
  | 'jup-organic'
  | 'gt-trending'
  | 'gt-vol-1'
  | 'gt-vol-2'
  | 'gt-vol-3'
  | 'gt-tx-1'
  | 'gt-tx-2'
  | 'gt-tx-3'
  | 'ds-promoted'
  | 'jup-new'
  | 'gt-new-1'
  | 'gt-new-2';

export type UniverseProvider = Extract<ProviderId, 'jupiter' | 'geckoterminal' | 'dexscreener'>;

export interface UniverseSourceDef {
  id: UniverseSourceId;
  provider: UniverseProvider;
  label: string;
  /** Re-fetch cadence (ms); never faster than the upstream cache. */
  refreshMs: number;
  /** The list depends on the selected stats window (re-fetched when it changes). */
  windowed: boolean;
}

export const UNIVERSE_SOURCES: readonly UniverseSourceDef[] = [
  { id: 'jup-trending', provider: 'jupiter', label: 'Jupiter trending', refreshMs: 30_000, windowed: true },
  { id: 'jup-top', provider: 'jupiter', label: 'Jupiter top traded', refreshMs: 45_000, windowed: true },
  { id: 'jup-organic', provider: 'jupiter', label: 'Jupiter top organic', refreshMs: 60_000, windowed: true },
  { id: 'gt-trending', provider: 'geckoterminal', label: 'GeckoTerminal trending', refreshMs: 60_000, windowed: true },
  { id: 'gt-vol-1', provider: 'geckoterminal', label: 'GeckoTerminal top volume p1', refreshMs: 180_000, windowed: false },
  { id: 'gt-vol-2', provider: 'geckoterminal', label: 'GeckoTerminal top volume p2', refreshMs: 180_000, windowed: false },
  { id: 'gt-vol-3', provider: 'geckoterminal', label: 'GeckoTerminal top volume p3', refreshMs: 180_000, windowed: false },
  { id: 'gt-tx-1', provider: 'geckoterminal', label: 'GeckoTerminal top transactions p1', refreshMs: 180_000, windowed: false },
  { id: 'gt-tx-2', provider: 'geckoterminal', label: 'GeckoTerminal top transactions p2', refreshMs: 180_000, windowed: false },
  { id: 'gt-tx-3', provider: 'geckoterminal', label: 'GeckoTerminal top transactions p3', refreshMs: 180_000, windowed: false },
  { id: 'ds-promoted', provider: 'dexscreener', label: 'DEX Screener promoted', refreshMs: 60_000, windowed: false },
  { id: 'jup-new', provider: 'jupiter', label: 'Jupiter recent', refreshMs: 30_000, windowed: false },
  { id: 'gt-new-1', provider: 'geckoterminal', label: 'GeckoTerminal new pools p1', refreshMs: 120_000, windowed: false },
  { id: 'gt-new-2', provider: 'geckoterminal', label: 'GeckoTerminal new pools p2', refreshMs: 120_000, windowed: false },
];

/**
 * Minimum gap between two calls to the same provider from the universe
 * loader. GeckoTerminal keyless is ~8 calls/min per browser: 15 s → ≤ 4/min,
 * so the token page opened from Discover still finds half of its sliding
 * one-minute budget free for candles, trades and token info (the GeckoTerminal
 * cadences above add up to ~4 calls/min). Jupiter is 4 per 10 s shared with
 * the SOL price chip and Ultra enrichment (3.5 s → ≤ 3 per 10 s).
 */
export const UNIVERSE_SPACING_MS: Readonly<Record<UniverseProvider, number>> = {
  jupiter: 3_500,
  geckoterminal: 15_000,
  dexscreener: 1_500,
};

/** Retry delay after the n-th consecutive failure of one source. */
export function universeBackoffMs(failures: number): number {
  return Math.min(120_000, 20_000 * 2 ** Math.max(0, failures - 1));
}

// --- DEX Screener promotion feeds --------------------------------------------

/** Paid boosts (top, latest) and latest profiles; 60 req/min each upstream. */
export const DEXSCREENER_FEED_PATHS = ['/token-boosts/top/v1', '/token-boosts/latest/v1', '/token-profiles/latest/v1'] as const;
export const DEX_PROMOTED_MAX_MINTS = 120;
export const DEX_PROMOTED_NOTE = 'DEX Screener promoted = paid boosts and profiles, not a market ranking';

/** Solana token addresses in a boosts / profiles feed payload, feed order, de-duplicated. */
export function parseDexFeed(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  const out = new Set<string>();
  for (const item of payload) {
    if (typeof item !== 'object' || item === null) continue;
    const { chainId, tokenAddress } = item as { chainId?: unknown; tokenAddress?: unknown };
    if (chainId !== 'solana' || typeof tokenAddress !== 'string') continue;
    const mint = tokenAddress.trim();
    if (isSolanaAddress(mint)) out.add(mint);
  }
  return [...out];
}

/**
 * Promoted tokens with real market rows: the three feeds are read together
 * (a failed feed only shrinks the set), then the mints go through the
 * provider's row lookup so every value is live pair data.
 */
export async function loadDexPromoted(
  fetcher: JsonFetcher,
  rows: TokenRowsProvider,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<Sourced<TokenRow[]>> {
  const base = baseUrl.replace(/\/+$/, '');
  const settled = await Promise.allSettled(
    DEXSCREENER_FEED_PATHS.map((path) =>
      fetcher<unknown>('dexscreener', `${base}${path}`, { label: `dexscreener ${path.split('/')[1] ?? 'feed'}`, cacheMs: 30_000, signal }),
    ),
  );
  const seen = new Set<string>();
  const mints: string[] = [];
  let failed = 0;
  let firstError: unknown;
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      for (const mint of parseDexFeed(r.value)) {
        if (seen.has(mint)) continue;
        seen.add(mint);
        mints.push(mint);
      }
    } else {
      if (isAbortError(r.reason)) throw r.reason;
      failed++;
      firstError ??= r.reason;
    }
  }
  if (failed === settled.length) throw firstError;
  const notes = [DEX_PROMOTED_NOTE];
  if (failed) notes.push(`${failed} of ${settled.length} DEX Screener feeds failed (${describeError(firstError)})`);
  const list = mints.slice(0, DEX_PROMOTED_MAX_MINTS);
  if (!list.length) return { data: [], source: 'dexscreener', fetchedAt: Date.now(), freshness: 'indexed', notes };
  const result = await rows.getRows(list, signal);
  return { ...result, data: orderByMints(result.data, list), notes: [...notes, ...(result.notes ?? [])] };
}

// --- GeckoTerminal network-wide pool pages -------------------------------------

export type GeckoPoolSort = 'h24_volume_usd_desc' | 'h24_tx_count_desc';

const GECKO_POOL_INCLUDE = 'include=base_token,quote_token,dex';

/** Same URL shapes as the GeckoTerminal adapter, so identical requests share the browser response cache. */
export function geckoListPath(kind: 'pools' | 'new_pools', page: number, sort?: GeckoPoolSort): string {
  const p = Math.min(10, Math.max(1, Math.floor(page)));
  return kind === 'pools'
    ? `/networks/solana/pools?${GECKO_POOL_INCLUDE}&sort=${sort ?? 'h24_volume_usd_desc'}&page=${p}`
    : `/networks/solana/new_pools?${GECKO_POOL_INCLUDE}&page=${p}`;
}

/** One row per base token from a JSON:API pool list (first pool wins). */
export function geckoRowsFromList(payload: unknown, fetchedAt: number, label: string): TokenRow[] {
  const doc = parseList('geckoterminal', payload, `geckoterminal ${label}`);
  const seen = new Set<string>();
  const rows: TokenRow[] = [];
  for (const res of doc.data) {
    const row = rowFromPool(res, doc.included, 'geckoterminal', fetchedAt);
    if (!row || seen.has(row.token.mint)) continue;
    seen.add(row.token.mint);
    rows.push(row);
  }
  return rows;
}

export async function loadGeckoList(fetcher: JsonFetcher, path: string, label: string, signal?: AbortSignal): Promise<Sourced<TokenRow[]>> {
  const payload = await fetcher<unknown>('geckoterminal', `${GECKOTERMINAL_BASE_URLS.keyless}${path}`, {
    headers: { accept: GECKOTERMINAL_ACCEPT },
    label: `geckoterminal ${label}`,
    cacheMs: 15_000,
    signal,
  });
  const fetchedAt = Date.now();
  return { data: geckoRowsFromList(payload, fetchedAt, label), source: 'geckoterminal', fetchedAt, freshness: 'indexed' };
}

// --- Merge ---------------------------------------------------------------------

/** Which row leads when several sources know a mint (lower = richer, fresher data). */
const SOURCE_PRECEDENCE: Partial<Record<ProviderId, number>> = { jupiter: 0, coingecko: 1, geckoterminal: 1, dexscreener: 2 };

function precedence(row: TokenRow): number {
  return SOURCE_PRECEDENCE[row.market.source] ?? 3;
}

function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const IDENTITY_KEYS = ['symbol', 'name', 'image', 'decimals', 'createdAt', 'launchpad', 'verified', 'creator'] as const;
const MARKET_KEYS = ['priceUsd', 'priceSol', 'marketCapUsd', 'fdvUsd', 'liquidityUsd', 'holders'] as const;
const WINDOW_KEYS: readonly StatWindow[] = ['m5', 'h1', 'h6', 'h24'];

/**
 * Fill-only merge of two rows for one mint. Primary values are never
 * overwritten; stats are filled per whole window so buys, sells and volume of
 * a window always come from a single provider. Returns `primary` itself when
 * nothing is filled (row identity is what memoized rows key on).
 */
export function mergeRows(primary: TokenRow, secondary: TokenRow): TokenRow {
  if (primary.token.mint !== secondary.token.mint) return primary;
  let token = primary.token;
  let market = primary.market;
  let pool = primary.pool;
  let risk = primary.risk;

  const identity = pick(secondary.token, IDENTITY_KEYS);
  if (fillsGap(token, identity)) token = fillMissing(token, identity);
  if (fillsGap(token.socials, secondary.token.socials)) token = { ...token, socials: fillMissing({ ...token.socials }, secondary.token.socials) };

  const marketFill = pick(secondary.market, MARKET_KEYS);
  if (fillsGap(market, marketFill)) market = fillMissing(market, marketFill);
  const missingWindows = WINDOW_KEYS.filter((w) => !market.stats[w] && secondary.market.stats[w]);
  if (missingWindows.length) {
    const stats = { ...market.stats };
    for (const w of missingWindows) stats[w] = secondary.market.stats[w];
    market = { ...market, stats };
  }

  if (!pool && secondary.pool) pool = secondary.pool;
  if (fillsGap(risk, secondary.risk)) risk = fillMissing<RowRisk>({ ...risk }, secondary.risk);

  if (token === primary.token && market === primary.market && pool === primary.pool && risk === primary.risk) return primary;
  const out: TokenRow = { ...primary, token, market };
  if (pool) out.pool = pool;
  if (risk) out.risk = risk;
  return out;
}

export interface UniverseEntry {
  status: 'idle' | 'loading' | 'ok' | 'error';
  /** Last good rows (kept while a refresh is loading or has failed). */
  rows: readonly TokenRow[];
  /** Window the rows were fetched for (windowed sources). */
  window?: DiscoverWindow;
  fetchedAt?: number;
  freshness?: Freshness;
  source?: ProviderId;
  notes?: readonly string[];
  error?: string;
  /** Not retried before this time (backoff after a failure). */
  retryAt?: number;
  /** Consecutive failures. */
  failures: number;
}

export type UniverseEntries = Readonly<Partial<Record<UniverseSourceId, UniverseEntry>>>;

export const EMPTY_ENTRY: UniverseEntry = { status: 'idle', rows: [], failures: 0 };

export function emptyEntries(defs: readonly UniverseSourceDef[] = UNIVERSE_SOURCES): UniverseEntries {
  const out: Partial<Record<UniverseSourceId, UniverseEntry>> = {};
  for (const def of defs) out[def.id] = EMPTY_ENTRY;
  return out;
}

/** Per-mint memo so an unchanged token keeps its row object across refreshes of other sources. */
export type MergeCache = Map<string, { inputs: readonly TokenRow[]; rank: number; out: TokenRow }>;

function sameRows(a: readonly TokenRow[], b: readonly TokenRow[]): boolean {
  return a.length === b.length && a.every((row, i) => row === b[i]);
}

export interface MergedUniverse {
  rows: TokenRow[];
  contributors: ProviderId[];
}

/**
 * Union of every source, one row per mint, ranked by first appearance in
 * source order. The richest source leads a mint (Jupiter → GeckoTerminal →
 * DEX Screener) and the others only fill its gaps.
 */
export function mergeUniverse(entries: UniverseEntries, defs: readonly UniverseSourceDef[] = UNIVERSE_SOURCES, cache?: MergeCache): MergedUniverse {
  const inputs = new Map<string, TokenRow[]>();
  const order: string[] = [];
  const contributors = new Set<ProviderId>();
  for (const def of defs) {
    const entry = entries[def.id];
    if (!entry?.rows.length) continue;
    if (entry.source) contributors.add(entry.source);
    for (const row of entry.rows) {
      const mint = row.token.mint;
      if (isExcludedMint(mint)) continue;
      const list = inputs.get(mint);
      if (list) list.push(row);
      else {
        inputs.set(mint, [row]);
        order.push(mint);
      }
    }
  }
  const rows: TokenRow[] = [];
  order.forEach((mint, i) => {
    const list = inputs.get(mint);
    const rank = i + 1;
    if (!list?.length) return;
    const prev = cache?.get(mint);
    if (prev && prev.rank === rank && sameRows(prev.inputs, list)) {
      rows.push(prev.out);
      return;
    }
    const [lead, ...rest] = [...list].sort((a, b) => precedence(a) - precedence(b));
    if (!lead) return;
    const merged = rest.reduce(mergeRows, lead);
    const out = merged.rank === rank ? merged : { ...merged, rank };
    cache?.set(mint, { inputs: list, rank, out });
    rows.push(out);
  });
  if (cache) for (const mint of cache.keys()) if (!inputs.has(mint)) cache.delete(mint);
  return { rows, contributors: [...contributors] };
}

// --- Scheduling --------------------------------------------------------------------

export interface ProviderClock {
  lastStartAt: Partial<Record<UniverseProvider, number>>;
  inflight: Partial<Record<UniverseProvider, number>>;
}

/** Re-check interval while a provider is cooling down after a 429. */
export const COOLDOWN_RECHECK_MS = 5_000;

/** Earliest time a source may run again; undefined while it is in flight. */
export function dueAt(def: UniverseSourceDef, entry: UniverseEntry, window: DiscoverWindow): number | undefined {
  if (entry.status === 'loading') return undefined;
  let at = entry.fetchedAt === undefined || (def.windowed && entry.window !== window) ? 0 : entry.fetchedAt + def.refreshMs;
  if (entry.retryAt !== undefined) at = Math.max(at, entry.retryAt);
  return at;
}

export interface SchedulePick {
  task?: UniverseSourceDef;
  /** When no task is due: time until the next one may run (undefined = nothing pending). */
  waitMs?: number;
}

/**
 * Next source to fetch: one call in flight per provider, provider spacing
 * respected, cooldowns waited out. A source that has never answered beats a
 * refresh so the first paint fills up before anything re-polls; among
 * refreshes the most overdue wins (source order breaks ties), so a provider
 * running at its spacing limit never starves the sources listed last.
 */
export function pickNext(
  defs: readonly UniverseSourceDef[],
  entries: UniverseEntries,
  now: number,
  window: DiscoverWindow,
  clock: ProviderClock,
  spacing: Readonly<Record<UniverseProvider, number>> = UNIVERSE_SPACING_MS,
  coolingDown?: (provider: UniverseProvider) => boolean,
): SchedulePick {
  let mostOverdue: { def: UniverseSourceDef; due: number } | undefined;
  let firstFresh: UniverseSourceDef | undefined;
  let wait: number | undefined;
  for (const def of defs) {
    const entry = entries[def.id] ?? EMPTY_ENTRY;
    const due = dueAt(def, entry, window);
    if (due === undefined || (clock.inflight[def.provider] ?? 0) > 0) continue;
    const last = clock.lastStartAt[def.provider];
    let at = last === undefined ? due : Math.max(due, last + spacing[def.provider]);
    if (coolingDown?.(def.provider)) at = Math.max(at, now + COOLDOWN_RECHECK_MS);
    if (at <= now) {
      if (!mostOverdue || due < mostOverdue.due) mostOverdue = { def, due };
      if (entry.fetchedAt === undefined) {
        firstFresh = def;
        break;
      }
    } else {
      wait = wait === undefined ? at - now : Math.min(wait, at - now);
    }
  }
  const task = firstFresh ?? mostOverdue?.def;
  if (task) return { task };
  return wait === undefined ? {} : { waitMs: wait };
}

// --- Loader -------------------------------------------------------------------------

export interface UniverseSnapshot {
  window: DiscoverWindow;
  entries: UniverseEntries;
  rows: TokenRow[];
  contributors: ProviderId[];
  /** Latest successful fetch across sources (ms). */
  updatedAt?: number;
  /** True until every source has answered at least once (data or error). */
  settling: boolean;
  running: boolean;
}

export interface UniverseLoaderOptions {
  fetch: (def: UniverseSourceDef, window: DiscoverWindow, signal: AbortSignal) => Promise<Sourced<TokenRow[]>>;
  defs?: readonly UniverseSourceDef[];
  window?: DiscoverWindow;
  spacing?: Readonly<Record<UniverseProvider, number>>;
  now?: () => number;
  coolingDown?: (provider: UniverseProvider) => boolean;
  backoffMs?: (failures: number) => number;
}

export interface UniverseLoader {
  subscribe(listener: () => void): () => void;
  getSnapshot(): UniverseSnapshot;
  setWindow(window: DiscoverWindow): void;
  /** Start (or resume) fetching; due sources run at once, spaced per provider. */
  start(): void;
  /** Pause: aborts in-flight calls, keeps every row. */
  stop(): void;
  /** Manual retry: failing sources become due immediately (spacing still applies). */
  retry(): void;
}

/**
 * Drives the universe: loads sources one provider-call at a time within the
 * spacing rules, publishes a merged snapshot after every answer (partial
 * results appear as they arrive), keeps the last good rows of a source whose
 * refresh fails, and backs off failing sources without blocking the others.
 */
export function createUniverseLoader(opts: UniverseLoaderOptions): UniverseLoader {
  const defs = opts.defs ?? UNIVERSE_SOURCES;
  const now = opts.now ?? Date.now;
  const spacing = opts.spacing ?? UNIVERSE_SPACING_MS;
  const backoff = opts.backoffMs ?? universeBackoffMs;
  const clock: ProviderClock = { lastStartAt: {}, inflight: {} };
  const cache: MergeCache = new Map();
  const listeners = new Set<() => void>();
  let entries = emptyEntries(defs);
  let window = opts.window ?? DEFAULT_WINDOW;
  let running = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function build(): UniverseSnapshot {
    const { rows, contributors } = mergeUniverse(entries, defs, cache);
    let updatedAt: number | undefined;
    let settling = false;
    for (const def of defs) {
      const e = entries[def.id] ?? EMPTY_ENTRY;
      if (e.fetchedAt !== undefined) updatedAt = Math.max(updatedAt ?? 0, e.fetchedAt);
      if (e.fetchedAt === undefined && e.failures === 0) settling = true;
    }
    return { window, entries, rows, contributors, ...(updatedAt !== undefined ? { updatedAt } : {}), settling, running };
  }

  let snapshot = build();

  function emit(): void {
    snapshot = build();
    listeners.forEach((l) => l());
  }

  function patch(id: UniverseSourceId, update: Partial<UniverseEntry>): void {
    entries = { ...entries, [id]: { ...(entries[id] ?? EMPTY_ENTRY), ...update } };
  }

  function finish(def: UniverseSourceDef): void {
    clock.inflight[def.provider] = Math.max(0, (clock.inflight[def.provider] ?? 0) - 1);
  }

  function launch(def: UniverseSourceDef, signal: AbortSignal): void {
    const w = window;
    clock.lastStartAt[def.provider] = now();
    clock.inflight[def.provider] = (clock.inflight[def.provider] ?? 0) + 1;
    patch(def.id, { status: 'loading' });
    opts.fetch(def, w, signal).then(
      (result) => {
        finish(def);
        patch(def.id, {
          status: 'ok',
          rows: result.data,
          window: w,
          fetchedAt: result.fetchedAt || now(),
          freshness: result.freshness,
          source: result.source,
          notes: result.notes,
          error: undefined,
          retryAt: undefined,
          failures: 0,
        });
        emit();
        schedule();
      },
      (error: unknown) => {
        finish(def);
        const prev = entries[def.id] ?? EMPTY_ENTRY;
        if (isAbortError(error) || signal.aborted) {
          // Paused, not failed: becomes due again when the loader resumes. A source whose
          // last completed attempt failed stays failing (failures reset only on success).
          patch(def.id, { status: prev.failures > 0 ? 'error' : prev.fetchedAt !== undefined ? 'ok' : 'idle' });
        } else {
          const failures = prev.failures + 1;
          const retryAfter = isProviderError(error) && error.retryAfterMs ? error.retryAfterMs : 0;
          patch(def.id, { status: 'error', error: describeError(error), failures, retryAt: now() + Math.max(backoff(failures), retryAfter) });
        }
        emit();
        schedule();
      },
    );
  }

  function schedule(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!running || !controller) return;
    let started = false;
    for (;;) {
      const pick = pickNext(defs, entries, now(), window, clock, spacing, opts.coolingDown);
      if (pick.task) {
        launch(pick.task, controller.signal);
        started = true;
        continue; // another provider may be due as well
      }
      if (pick.waitMs !== undefined) timer = setTimeout(schedule, Math.max(50, pick.waitMs));
      break;
    }
    if (started) emit();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    setWindow(next) {
      if (next === window) return;
      window = next;
      emit();
      schedule();
    },
    start() {
      if (running) return;
      running = true;
      controller = new AbortController();
      emit();
      schedule();
    },
    stop() {
      if (!running) return;
      running = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      controller?.abort();
      controller = undefined;
      emit();
    },
    retry() {
      let changed = false;
      for (const def of defs) {
        const e = entries[def.id];
        if (e?.status === 'error' && e.retryAt !== undefined) {
          patch(def.id, { retryAt: undefined });
          changed = true;
        }
      }
      if (!changed) return;
      emit();
      schedule();
    },
  };
}

// --- Presentation ---------------------------------------------------------------------

export interface UniverseProviderStatus {
  provider: UniverseProvider;
  label: string;
  total: number;
  /** Sources with data whose last refresh succeeded. */
  ok: number;
  /** Sources with data whose last refresh failed (rows kept). */
  stale: number;
  /** Sources still waiting for a first answer. */
  pending: number;
  /** Sources that have never answered and failed (or are retrying after failing). */
  failed: number;
  /** First error line and the earliest retry among failing sources. */
  error?: string;
  retryAt?: number;
}

export interface UniverseSummary {
  loaded: number;
  sourcesTotal: number;
  sourcesWithData: number;
  pending: number;
  failing: number;
  /** Nothing has ever answered and every source has failed. */
  allFailed: boolean;
  updatedAt?: number;
  providers: UniverseProviderStatus[];
  /** "GeckoTerminal trending: rate limited" lines for failing sources. */
  errors: string[];
}

export function summarizeUniverse(
  snapshot: Pick<UniverseSnapshot, 'entries' | 'rows' | 'updatedAt'>,
  defs: readonly UniverseSourceDef[] = UNIVERSE_SOURCES,
): UniverseSummary {
  const byProvider = new Map<UniverseProvider, UniverseProviderStatus>();
  const errors: string[] = [];
  let sourcesWithData = 0;
  let pending = 0;
  let failing = 0;
  for (const def of defs) {
    const e = snapshot.entries[def.id] ?? EMPTY_ENTRY;
    let p = byProvider.get(def.provider);
    if (!p) {
      p = { provider: def.provider, label: PROVIDER_LABELS[def.provider], total: 0, ok: 0, stale: 0, pending: 0, failed: 0 };
      byProvider.set(def.provider, p);
    }
    p.total++;
    const hasData = e.fetchedAt !== undefined;
    if (hasData) sourcesWithData++;
    // A source retrying after a failure is still failing until it answers
    // (failures reset only on success), so error states do not flicker away
    // for the duration of every retry.
    const retrying = e.status === 'loading' && e.failures > 0;
    if (e.status === 'error' || retrying) {
      failing++;
      if (hasData) p.stale++;
      else p.failed++;
      const line = `${def.label}: ${(e.error ?? 'failed').replace(/^[a-z][a-z-]*:\s*/i, '')}`;
      if (!errors.includes(line)) errors.push(line);
      p.error ??= line;
      if (!retrying && e.retryAt !== undefined && (p.retryAt === undefined || e.retryAt < p.retryAt)) p.retryAt = e.retryAt;
    } else if (hasData) {
      p.ok++;
    } else {
      pending++;
      p.pending++;
    }
  }
  return {
    loaded: snapshot.rows.length,
    sourcesTotal: defs.length,
    sourcesWithData,
    pending,
    failing,
    allFailed: sourcesWithData === 0 && pending === 0 && failing === defs.length,
    ...(snapshot.updatedAt !== undefined ? { updatedAt: snapshot.updatedAt } : {}),
    providers: [...byProvider.values()],
    errors,
  };
}

/** Sorted, de-duplicated mint key for React Query keys and effect dependencies. */
export function mintSetKey(rows: readonly TokenRow[] | undefined): string {
  return rows?.length ? [...new Set(rows.map((r) => r.token.mint))].sort().join(',') : '';
}

/** Rows rendered per chunk of the infinite-scroll table. */
export const ROWS_PER_CHUNK = 60;

/**
 * Mints kept enriched per view (five table chunks). The cache requests at
 * most one Ultra batch (100 mints) per 30 s, new mints first, so a longer
 * target costs no extra calls: it is covered over successive batches.
 */
export const ENRICH_ROWS = 300;

/**
 * Which rows to enrich: what is on screen first (top of the sorted, filtered
 * list), then the top of the unfiltered list so a stage / flag filter can
 * still discover rows whose stage or flags only enrichment reveals. Capped at
 * `limit`.
 */
export function enrichmentTarget(visible: readonly TokenRow[], all: readonly TokenRow[], limit = ENRICH_ROWS): TokenRow[] {
  const out: TokenRow[] = [];
  const seen = new Set<string>();
  for (const list of [visible, all]) {
    for (const row of list) {
      if (out.length >= limit) return out;
      if (seen.has(row.token.mint)) continue;
      seen.add(row.token.mint);
      out.push(row);
    }
  }
  return out;
}
