/**
 * Pulse launch scanner: pure state logic (isomorphic, unit-tested).
 *
 * /pulse keeps one Map<mint, PulseItem> fed by real sources with very
 * different latency: the PumpPortal stream, decoded pump.fun bonding curves,
 * Jupiter (Tokens V2 + Ultra), GeckoTerminal pool lists and, when keys are
 * configured, ORBYT's keyed server lists. This module decides how readings
 * merge, which tokens each column shows and what gets pruned:
 *
 * - Identity and static facts (symbol, name, image, creator, socials, dev buy)
 *   fill gaps only: the first real value wins.
 * - Values that legitimately change (price, market cap, liquidity, volume,
 *   txns, holders, bonding progress, risk) take the NEWEST reading. Every
 *   group remembers when its reading was true and the tier that produced it
 *   (stream / on-chain 3 > fast REST 2 > indexed 1). A lower tier replaces a
 *   higher-tier reading only once that reading is READING_HOLD_MS old.
 *   Decoded on-chain bonding progress ranks above every provider (tier 4), so
 *   it wins over provider-reported progress while it is fresh.
 * - The launch stage only moves forward (unknown → amm → bonding → graduated):
 *   a graduated token never returns to bonding.
 *
 * Nothing here invents a value: absent inputs stay absent and render "—".
 */

import { ChainError } from '@/lib/core/chain';
import { normalizeDex } from '@/lib/core/dex';
import { PROVIDER_LABELS, type ProviderId } from '@/lib/core/providers';
import { MINTS, PROGRAMS, STABLE_MINTS } from '@/lib/core/solana';
import type {
  BondingCurveState,
  Freshness,
  LaunchpadState,
  LaunchStage,
  PulseColumn,
  PulseToken,
  Socials,
  Sourced,
  TokenRow,
} from '@/lib/core/types';
import { isProviderError } from '@/lib/net/errors';
import type { GeckoPoolInfo } from '@/lib/providers/geckoterminal';
import type { JupiterUltraInfo } from '@/lib/providers/jupiter';
import type { MigrationEvent, NewTokenEvent } from '@/lib/streams/pumpportal';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Store cap; the oldest non-visible tokens are dropped beyond it. */
export const PULSE_MAX_ITEMS = 400;
/** New Pairs: bonding tokens created (or first detected) within this window. */
export const NEW_PAIRS_WINDOW_MS = 3 * 60 * 60_000;
/** Migrated: graduations within this window. */
export const MIGRATED_WINDOW_MS = 24 * 60 * 60_000;
/** Final Stretch threshold (bonding progress %). */
export const FINAL_STRETCH_MIN_PROGRESS = 60;
/** Bonding tokens at or above this progress are kept past the New Pairs window (they may still reach Final Stretch). */
export const FINAL_WATCH_PROGRESS = 40;
export const COLUMN_CAPS: Readonly<Record<PulseColumn, number>> = { new: 60, final: 40, migrated: 60 };
/** How long a higher-tier reading is protected from lower-tier readings. */
export const READING_HOLD_MS = 30_000;
/** A curve seen completing in this session stays in Final Stretch this long while its migration lands. */
export const COMPLETE_GRACE_MS = 5 * 60_000;
/** Tolerated client-clock skew for chain / provider timestamps slightly in the future. */
export const CLOCK_SKEW_MS = 10 * 60_000;
/** Tokens that cannot be placed in any column are dropped after this long without a change. */
export const UNPLACED_TTL_MS = 10 * 60_000;
/** An open on-chain curve read this recently lets a timeless graduation be approximated by its detection time. */
export const APPROX_GRADUATION_MS = 60_000;
/** A stream / backfill counts as live when it delivered within this window. */
export const LIVE_WINDOW_MS = 10_000;

/** How far behind the chain each freshness class typically is (ms). */
export const FRESHNESS_LAG_MS: Readonly<Record<Freshness, number>> = { stream: 0, realtime: 0, fast: 5_000, indexed: 45_000 };
export const FRESHNESS_TIER: Readonly<Record<Freshness, number>> = { stream: 3, realtime: 3, fast: 2, indexed: 1 };
/** Decoded on-chain progress outranks provider-reported progress of any claimed freshness while it is fresh. */
const ONCHAIN_PROGRESS_TIER = 4;

const STAGE_RANK: Readonly<Record<LaunchStage, number>> = { unknown: 0, amm: 1, bonding: 2, graduated: 3 };

/** Normalized AMM ids that launchpads migrate to (GeckoTerminal files Raydium CPMM under 'raydium'). */
export const MIGRATION_DEXES: ReadonlySet<string> = new Set(['pumpswap', 'raydium', 'raydium-cpmm', 'meteora-damm', 'meteora-damm-v2']);

/** GeckoTerminal's generic LaunchLab label; a specific launchpad (e.g. letsbonk) may refine it. */
const GENERIC_LAUNCHPAD = 'LaunchLab';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LiveGroup = 'price' | 'mcap' | 'liquidity' | 'volume' | 'txns' | 'holders' | 'progress' | 'risk';

export interface Reading {
  /** When the reading was true (ms). */
  at: number;
  source: ProviderId;
  tier: number;
}

export type PulseRisk = NonNullable<PulseToken['risk']>;

/** A token tracked by Pulse: the shared PulseToken model plus merge bookkeeping. */
export interface PulseItem extends PulseToken {
  /** Current reading per live group (time, provider, tier). */
  readings: Partial<Record<LiveGroup, Reading>>;
  /** Price in SOL when the current price reading was SOL-quoted. */
  priceSol?: number;
  /** createdAt is ORBYT's receipt time of the PumpPortal create event (chain time not yet known). */
  createdAtApprox?: boolean;
  /** graduatedAt is when ORBYT detected the graduation (exact time not yet known). */
  graduatedAtApprox?: boolean;
  /** Decoded pump.fun curve state: false = open, true = all sellable tokens bought. */
  curveComplete?: boolean;
  /** When this session saw the curve flip from open to complete. */
  completedAt?: number;
  /** Destination DEX label after migration, when known from data. */
  migratedDex?: string;
  /** pump.fun mayhem-mode coin (2B supply). */
  mayhem?: boolean;
}

/** One reading about one token from one source. */
export interface PulsePatch {
  mint: string;
  source: ProviderId;
  freshness: Freshness;
  /** When the reading was true (ms). Indexed sources pass fetchedAt minus their cache lag. */
  at: number;
  /** When ORBYT received it (ms). */
  receivedAt: number;
  /** Only update a tracked token; never insert. */
  updateOnly?: boolean;
  symbol?: string;
  name?: string;
  image?: string;
  uri?: string;
  creator?: string;
  createdAt?: number;
  createdAtApprox?: boolean;
  devBuySol?: number;
  socials?: Socials;
  mayhem?: boolean;
  stage?: LaunchStage;
  launchpad?: string;
  progressPct?: number;
  /** Defaults to `source`. */
  progressSource?: ProviderId;
  graduatedAt?: number;
  migratedPool?: string;
  migratedDex?: string;
  curveComplete?: boolean;
  priceUsd?: number;
  priceSol?: number;
  marketCapUsd?: number;
  marketCapSol?: number;
  liquidityUsd?: number;
  volumeUsd?: number;
  txns?: { buys?: number; sells?: number };
  holders?: number;
  risk?: PulseRisk;
}

export type LaunchpadFilter = 'all' | 'pump' | 'bonk' | 'other';

export interface PulseFilter {
  /** Minimum market cap in USD; tokens with unknown MC are hidden while set. */
  minMcUsd?: number;
  launchpad: LaunchpadFilter;
  requireSocials: boolean;
}

export const DEFAULT_PULSE_FILTER: PulseFilter = { launchpad: 'all', requireSocials: false };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

/** Set an optional key, deleting it when the value is undefined (absent data stays absent). */
function setOpt<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) delete obj[key];
  else obj[key] = value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural equality for the small JSON-like values stored on items. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) if (!sameValue(a[key], b[key])) return false;
    return true;
  }
  return false;
}

function compactRecord<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as T;
}

function hasKeys(value: object | undefined): boolean {
  return !!value && Object.keys(value).length > 0;
}

export function hasSocials(socials: Socials | undefined): boolean {
  return !!socials && !!(socials.website || socials.twitter || socials.telegram || socials.discord);
}

function toUsd(amount: number | undefined, solPriceUsd: number | undefined): number | undefined {
  return isNum(amount) && isNum(solPriceUsd) && solPriceUsd > 0 ? amount * solPriceUsd : undefined;
}

function byMint(a: PulseItem, b: PulseItem): number {
  return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
}

/** Reading time for an indexed/fast source: fetch time minus its typical lag. */
export function observedAt(fetchedAt: number, freshness: Freshness): number {
  return fetchedAt - FRESHNESS_LAG_MS[freshness];
}

function acceptReading(prev: Reading | undefined, next: Reading): boolean {
  if (!prev) return true;
  if (next.at < prev.at) return false;
  return next.tier >= prev.tier || next.at - prev.at >= READING_HOLD_MS;
}

// ---------------------------------------------------------------------------
// Merge (upsert)
// ---------------------------------------------------------------------------

const STATIC_KEYS = ['symbol', 'name', 'image', 'uri', 'creator', 'devBuySol', 'mayhem'] as const;

/**
 * Merge one reading into a tracked token. Returns `prev` itself when nothing
 * changed (so memoized consumers skip work); a reading that only confirms the
 * current values refreshes its timestamp without counting as a change.
 */
export function mergeItem(prev: PulseItem, p: PulsePatch): PulseItem {
  const next: PulseItem = { ...prev };
  let changed = false;
  let readings = prev.readings;
  const reading: Reading = { at: p.at, source: p.source, tier: FRESHNESS_TIER[p.freshness] };

  const bump = (group: LiveGroup, r: Reading = reading) => {
    const current = readings[group];
    if (current && current.at === r.at && current.source === r.source && current.tier === r.tier) return;
    if (readings === prev.readings) readings = { ...readings };
    readings[group] = r;
  };

  // Static identity: first real value wins.
  for (const key of STATIC_KEYS) {
    const value = p[key];
    if (next[key] === undefined && value !== undefined) {
      Object.assign(next, { [key]: value });
      changed = true;
    }
  }

  // Creation time: fill; a chain / provider time replaces the stream-receipt approximation.
  if (isNum(p.createdAt) && (next.createdAt === undefined || (next.createdAtApprox === true && !p.createdAtApprox))) {
    next.createdAt = p.createdAt;
    setOpt(next, 'createdAtApprox', p.createdAtApprox ? true : undefined);
    changed = true;
  }

  // Socials: per-key fill.
  if (p.socials && hasKeys(p.socials)) {
    const merged: Socials = { ...next.socials };
    let added = false;
    for (const key of ['website', 'twitter', 'telegram', 'discord'] as const) {
      const value = p.socials[key];
      if (merged[key] === undefined && value) {
        merged[key] = value;
        added = true;
      }
    }
    if (added) {
      next.socials = merged;
      changed = true;
    }
  }

  // Launchpad state (copy on write).
  let lp: LaunchpadState = prev.launchpad;
  const editLp = (): LaunchpadState => {
    if (lp === prev.launchpad) lp = { ...lp };
    return lp;
  };

  if (p.stage && STAGE_RANK[p.stage] > STAGE_RANK[lp.stage]) {
    const from = lp.stage;
    editLp().stage = p.stage;
    changed = true;
    // Graduation without an exact time is approximated only when this session
    // watched the curve: seen completing (migration follows within ~1 s), or
    // read open on-chain moments ago. Otherwise it stays unplaced until a
    // source reports the real time.
    if (p.stage === 'graduated' && p.graduatedAt === undefined && from === 'bonding' && lp.graduatedAt === undefined) {
      const progressAt = prev.readings.progress?.at;
      const sawOpen = prev.curveComplete === false && progressAt !== undefined && p.receivedAt - progressAt <= APPROX_GRADUATION_MS;
      if (prev.completedAt !== undefined || sawOpen) {
        lp.graduatedAt = prev.completedAt ?? p.receivedAt;
        next.graduatedAtApprox = true;
      }
    }
  }

  if (p.launchpad && p.launchpad !== lp.launchpad && (lp.launchpad === undefined || lp.launchpad === GENERIC_LAUNCHPAD)) {
    editLp().launchpad = p.launchpad;
    changed = true;
  }

  // Graduation facts only from graduation readings, and only once graduated.
  if (p.stage === 'graduated' && lp.stage === 'graduated') {
    if (isNum(p.graduatedAt) && (lp.graduatedAt === undefined || next.graduatedAtApprox === true)) {
      editLp().graduatedAt = p.graduatedAt;
      delete next.graduatedAtApprox;
      changed = true;
    }
    if (p.migratedPool && !lp.migratedPool) {
      editLp().migratedPool = p.migratedPool;
      changed = true;
    }
    if (p.migratedDex && !next.migratedDex) {
      next.migratedDex = p.migratedDex;
      changed = true;
    }
  }

  // Bonding progress: decoded on-chain readings outrank every provider value while fresh.
  const progressSource = p.progressSource ?? p.source;
  const progressReading: Reading = progressSource === 'solana-rpc' ? { ...reading, tier: ONCHAIN_PROGRESS_TIER } : reading;
  if (isNum(p.progressPct) && acceptReading(readings.progress, progressReading)) {
    const pct = clampPct(p.progressPct);
    if (lp.progressPct !== pct || lp.progressSource !== progressSource) {
      editLp().progressPct = pct;
      lp.progressSource = progressSource;
      changed = true;
    }
    bump('progress', progressReading);
  }

  // Curve completion: open → complete only; a transition seen live is timestamped.
  if (p.curveComplete !== undefined && p.curveComplete !== next.curveComplete) {
    if (p.curveComplete) {
      if (next.curveComplete === false) next.completedAt = p.at;
      next.curveComplete = true;
      changed = true;
    } else if (next.curveComplete === undefined) {
      next.curveComplete = false;
      changed = true;
    }
  }

  // Live groups: newest reading wins as a unit.
  const group = (g: LiveGroup, present: boolean, equal: () => boolean, apply: () => void) => {
    if (!present || !acceptReading(readings[g], reading)) return;
    if (!equal()) {
      apply();
      changed = true;
    }
    bump(g);
  };

  group(
    'price',
    isNum(p.priceUsd) || isNum(p.priceSol),
    () => next.priceUsd === p.priceUsd && next.priceSol === p.priceSol,
    () => {
      setOpt(next, 'priceUsd', p.priceUsd);
      setOpt(next, 'priceSol', p.priceSol);
    },
  );
  group(
    'mcap',
    isNum(p.marketCapUsd) || isNum(p.marketCapSol),
    () => next.marketCapUsd === p.marketCapUsd && next.marketCapSol === p.marketCapSol,
    () => {
      setOpt(next, 'marketCapUsd', p.marketCapUsd);
      setOpt(next, 'marketCapSol', p.marketCapSol);
    },
  );
  group('liquidity', isNum(p.liquidityUsd), () => next.liquidityUsd === p.liquidityUsd, () => setOpt(next, 'liquidityUsd', p.liquidityUsd));
  group('volume', isNum(p.volumeUsd), () => next.volumeUsd === p.volumeUsd, () => setOpt(next, 'volumeUsd', p.volumeUsd));
  group('holders', isNum(p.holders), () => next.holders === p.holders, () => setOpt(next, 'holders', p.holders));
  const txns = p.txns ? compactRecord({ buys: p.txns.buys, sells: p.txns.sells }) : undefined;
  group(
    'txns',
    hasKeys(txns),
    () => sameValue(next.txns, txns),
    () => setOpt(next, 'txns', txns),
  );

  // Risk: per-key newest wins; an older reading may still fill unknown keys.
  if (p.risk && hasKeys(p.risk)) {
    const incoming = compactRecord(p.risk);
    const newer = acceptReading(readings.risk, reading);
    const merged: PulseRisk = newer ? { ...next.risk, ...incoming } : { ...incoming, ...next.risk };
    if (!sameValue(merged, next.risk ?? {})) {
      next.risk = merged;
      changed = true;
    }
    if (newer) bump('risk');
  }

  if (!changed && readings === prev.readings) return prev;
  next.launchpad = lp;
  next.readings = readings;
  if (changed) {
    next.updatedAt = Math.max(prev.updatedAt, p.receivedAt);
    if (!next.sources.includes(p.source)) next.sources = [...next.sources, p.source];
  }
  return next;
}

/** A new tracked token from its first reading. */
export function createItem(p: PulsePatch): PulseItem {
  const base: PulseItem = {
    mint: p.mint,
    detectedAt: p.receivedAt,
    launchpad: { stage: 'unknown' },
    sources: [p.source],
    updatedAt: p.receivedAt,
    readings: {},
  };
  return mergeItem(base, p);
}

/**
 * Merge one reading from `source` into `existing`, or start tracking the
 * token. Returns `existing` itself when nothing changed, and `undefined` for
 * an update-only reading about a token that is not tracked.
 */
export function upsert(existing: PulseItem | undefined, patch: Omit<PulsePatch, 'source'>, source: ProviderId): PulseItem | undefined {
  const p: PulsePatch = { ...patch, source };
  if (existing) return mergeItem(existing, p);
  return p.updateOnly ? undefined : createItem(p);
}

/**
 * Apply readings in order. Copy-on-write: returns the same map (changed:false)
 * when no reading altered anything.
 */
export function applyPatches(
  items: ReadonlyMap<string, PulseItem>,
  patches: readonly PulsePatch[],
): { items: ReadonlyMap<string, PulseItem>; changed: boolean } {
  let next: Map<string, PulseItem> | null = null;
  for (const p of patches) {
    if (typeof p.mint !== 'string' || p.mint.length < 32 || p.mint.length > 44) continue;
    const prev = (next ?? items).get(p.mint);
    const merged = upsert(prev, p, p.source);
    if (merged && merged !== prev) {
      next ??= new Map(items);
      next.set(p.mint, merged);
    }
  }
  return next ? { items: next, changed: true } : { items, changed: false };
}

/** Equality for card rendering: ignores merge bookkeeping that is not displayed. */
export function sameCardData(a: PulseItem, b: PulseItem): boolean {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === 'readings' || key === 'updatedAt') continue;
    if (!sameValue(a[key as keyof PulseItem], b[key as keyof PulseItem])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Derived display values
// ---------------------------------------------------------------------------

/** Creation time used for New Pairs (chain / provider time, else first detection). */
export function pulseTime(item: PulseItem): number {
  return item.createdAt ?? item.detectedAt;
}

/** USD market cap, converting a SOL-denominated reading with the current SOL price when needed. */
export function marketCapUsdOf(item: PulseItem, solPriceUsd?: number): number | undefined {
  return item.marketCapUsd ?? toUsd(item.marketCapSol, solPriceUsd);
}

export function launchpadGroup(name: string | undefined): Exclude<LaunchpadFilter, 'all'> {
  const v = (name ?? '').toLowerCase();
  if (v === 'pump.fun' || v === 'pump') return 'pump';
  if (v.includes('bonk')) return 'bonk';
  return 'other';
}

const LAUNCHPAD_SHORT: Readonly<Record<string, string>> = {
  'pump.fun': 'Pump',
  letsbonk: 'Bonk',
  'meteora dbc': 'DBC',
  launchlab: 'LaunchLab',
  bags: 'Bags',
  moonshot: 'Moonshot',
  moonit: 'Moonit',
  boop: 'Boop',
  heaven: 'Heaven',
  stonkfun: 'Stonk',
};

/** Compact launchpad badge text ('pump.fun' → 'Pump'). */
export function launchpadShort(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const known = LAUNCHPAD_SHORT[name.toLowerCase()];
  if (known) return known;
  const clean = name.replace(/\.(fun|fm|xyz)$/i, '');
  return clean.length > 10 ? `${clean.slice(0, 9)}…` : clean.charAt(0).toUpperCase() + clean.slice(1);
}

export function isCurveTarget(item: PulseItem): boolean {
  return item.launchpad.stage === 'bonding' && item.launchpad.launchpad === 'pump.fun' && item.curveComplete !== true;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export function inColumn(column: PulseColumn, item: PulseItem, now: number): boolean {
  const lp = item.launchpad;
  switch (column) {
    case 'new': {
      if (lp.stage !== 'bonding' || item.curveComplete === true) return false;
      const age = now - pulseTime(item);
      return age <= NEW_PAIRS_WINDOW_MS && age >= -CLOCK_SKEW_MS;
    }
    case 'final': {
      if (lp.stage !== 'bonding' || !isNum(lp.progressPct) || lp.progressPct < FINAL_STRETCH_MIN_PROGRESS) return false;
      if (item.curveComplete !== true) return true;
      return item.completedAt !== undefined && now - item.completedAt <= COMPLETE_GRACE_MS;
    }
    case 'migrated': {
      if (lp.stage !== 'graduated' || lp.graduatedAt === undefined) return false;
      const age = now - lp.graduatedAt;
      return age <= MIGRATED_WINDOW_MS && age >= -CLOCK_SKEW_MS;
    }
  }
}

const COMPARATORS: Readonly<Record<PulseColumn, (a: PulseItem, b: PulseItem) => number>> = {
  new: (a, b) => pulseTime(b) - pulseTime(a) || b.detectedAt - a.detectedAt || byMint(a, b),
  final: (a, b) =>
    (b.launchpad.progressPct ?? 0) - (a.launchpad.progressPct ?? 0) || pulseTime(b) - pulseTime(a) || byMint(a, b),
  migrated: (a, b) => (b.launchpad.graduatedAt ?? 0) - (a.launchpad.graduatedAt ?? 0) || byMint(a, b),
};

export function matchesFilter(item: PulseItem, filter: PulseFilter, solPriceUsd?: number): boolean {
  if (filter.launchpad !== 'all' && launchpadGroup(item.launchpad.launchpad) !== filter.launchpad) return false;
  if (filter.requireSocials && !hasSocials(item.socials)) return false;
  if (isNum(filter.minMcUsd) && filter.minMcUsd > 0) {
    const mc = marketCapUsdOf(item, solPriceUsd);
    if (mc === undefined || mc < filter.minMcUsd) return false;
  }
  return true;
}

export function activeFilterCount(filter: PulseFilter): number {
  return (isNum(filter.minMcUsd) && filter.minMcUsd > 0 ? 1 : 0) + (filter.launchpad !== 'all' ? 1 : 0) + (filter.requireSocials ? 1 : 0);
}

/** Validate a filter read back from storage. */
export function sanitizeFilter(raw: unknown): PulseFilter {
  const r = isPlainObject(raw) ? raw : {};
  const launchpad: LaunchpadFilter = r.launchpad === 'pump' || r.launchpad === 'bonk' || r.launchpad === 'other' ? r.launchpad : 'all';
  const min = typeof r.minMcUsd === 'number' && Number.isFinite(r.minMcUsd) && r.minMcUsd > 0 ? Math.min(r.minMcUsd, 1e12) : undefined;
  return min === undefined ? { launchpad, requireSocials: r.requireSocials === true } : { minMcUsd: min, launchpad, requireSocials: r.requireSocials === true };
}

/**
 * New Pairs: bonding, created within 3 h, newest first (cap 60).
 * Final Stretch: bonding with progress ≥ 60 %, highest first (cap 40).
 * Migrated: graduated within 24 h, newest first (cap 60).
 * The filter applies before the cap.
 */
export function selectColumn(
  column: PulseColumn,
  items: Iterable<PulseItem>,
  now: number,
  opts: { filter?: PulseFilter; solPriceUsd?: number } = {},
): PulseItem[] {
  const out: PulseItem[] = [];
  for (const item of items) {
    if (!inColumn(column, item, now)) continue;
    if (opts.filter && !matchesFilter(item, opts.filter, opts.solPriceUsd)) continue;
    out.push(item);
  }
  out.sort(COMPARATORS[column]);
  const cap = COLUMN_CAPS[column];
  return out.length > cap ? out.slice(0, cap) : out;
}

/**
 * Hover-pause: keep the frozen order with current data (tokens that left the
 * store drop out) and count live tokens waiting to be shown.
 */
export function applyPause(
  frozen: readonly string[],
  live: readonly PulseItem[],
  items: ReadonlyMap<string, PulseItem>,
): { shown: PulseItem[]; queued: number } {
  const frozenSet = new Set(frozen);
  const shown: PulseItem[] = [];
  for (const mint of frozen) {
    const item = items.get(mint);
    if (item) shown.push(item);
  }
  let queued = 0;
  for (const item of live) if (!frozenSet.has(item.mint)) queued++;
  return { shown, queued };
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/** True when a token cannot appear in any column any more (or never could and went quiet). */
export function isExpired(item: PulseItem, now: number): boolean {
  const lp = item.launchpad;
  const quiet = now - item.updatedAt > UNPLACED_TTL_MS;
  if (lp.stage === 'graduated') {
    return lp.graduatedAt === undefined ? quiet : now - lp.graduatedAt > MIGRATED_WINDOW_MS;
  }
  if (lp.stage === 'bonding') {
    if (item.curveComplete === true) return item.completedAt !== undefined ? now - item.completedAt > COMPLETE_GRACE_MS && quiet : quiet;
    if (now - pulseTime(item) <= NEW_PAIRS_WINDOW_MS) return false;
    if (isNum(lp.progressPct) && lp.progressPct >= FINAL_WATCH_PROGRESS) return false;
    return quiet;
  }
  return quiet;
}

/**
 * Drop expired tokens, then the least recently changed non-visible tokens
 * until at most `max` remain. Visible tokens are never dropped.
 */
export function pruneItems(
  items: ReadonlyMap<string, PulseItem>,
  visible: ReadonlySet<string>,
  now: number,
  max: number = PULSE_MAX_ITEMS,
): ReadonlyMap<string, PulseItem> {
  let next: Map<string, PulseItem> | null = null;
  for (const [mint, item] of items) {
    if (visible.has(mint) || !isExpired(item, now)) continue;
    next ??= new Map(items);
    next.delete(mint);
  }
  const current: ReadonlyMap<string, PulseItem> = next ?? items;
  if (current.size <= max) return current;
  const candidates = [...current.values()].filter((item) => !visible.has(item.mint)).sort((a, b) => a.updatedAt - b.updatedAt || byMint(a, b));
  const out = new Map(current);
  for (const item of candidates.slice(0, current.size - max)) out.delete(item.mint);
  return out;
}

// ---------------------------------------------------------------------------
// Request batching
// ---------------------------------------------------------------------------

/**
 * Pick up to `cap` mints: priority tiers first (each tier least-recently
 * picked first, so every visible token gets its turn), then fill the rest
 * from `pool` in least-recently-picked order (rotation). `tierCaps[i]` limits
 * how many slots tier i may take per batch, so a full high-priority tier
 * cannot starve the tiers after it; unused slots flow on to later tiers.
 */
export function pickBatch(
  priority: ReadonlyArray<readonly string[]>,
  pool: Iterable<string>,
  lastPicked: ReadonlyMap<string, number>,
  cap: number,
  tierCaps: ReadonlyArray<number | undefined> = [],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const order = (list: Iterable<string>) =>
    [...list].filter((m) => !seen.has(m)).sort((a, b) => (lastPicked.get(a) ?? 0) - (lastPicked.get(b) ?? 0));
  const take = (list: Iterable<string>, max = Infinity) => {
    let taken = 0;
    for (const mint of order(list)) {
      if (out.length >= cap || taken >= max) return;
      if (seen.has(mint)) continue;
      seen.add(mint);
      out.push(mint);
      taken++;
    }
  };
  priority.forEach((tier, i) => take(tier, tierCaps[i]));
  take(pool);
  return out;
}

/**
 * One result from a request that was split into sub-batches (the browser
 * RPC caps getMultipleAccounts at 10 addresses): keyed data merged, the
 * newest part's provenance, notes de-duplicated.
 */
export function mergeSourcedRecords<T>(
  parts: ReadonlyArray<Sourced<Record<string, T>>>,
  fallback: { source: ProviderId; freshness: Freshness },
): Sourced<Record<string, T>> {
  const data: Record<string, T> = {};
  const notes = new Set<string>();
  let newest: Sourced<Record<string, T>> | undefined;
  for (const part of parts) {
    Object.assign(data, part.data);
    if (!newest || part.fetchedAt > newest.fetchedAt) newest = part;
    part.notes?.forEach((note) => notes.add(note));
  }
  const out: Sourced<Record<string, T>> = {
    data,
    source: newest?.source ?? fallback.source,
    fetchedAt: newest?.fetchedAt ?? Date.now(),
    freshness: newest?.freshness ?? fallback.freshness,
  };
  if (notes.size) out.notes = [...notes];
  return out;
}

// ---------------------------------------------------------------------------
// Readings from each source
// ---------------------------------------------------------------------------

export interface PatchMeta {
  source: ProviderId;
  freshness: Freshness;
  fetchedAt: number;
}

function basePatch(mint: string, meta: PatchMeta): PulsePatch {
  return { mint, source: meta.source, freshness: meta.freshness, at: observedAt(meta.fetchedAt, meta.freshness), receivedAt: meta.fetchedAt };
}

/** PumpPortal create event. MC in USD only when the event carries marketCapSol and a SOL price is known. */
export function patchFromNewToken(e: NewTokenEvent, solPriceUsd?: number): PulsePatch {
  const p: PulsePatch = {
    mint: e.mint,
    source: 'pumpportal',
    freshness: 'stream',
    at: e.receivedAt,
    receivedAt: e.receivedAt,
    stage: 'bonding',
    launchpad: e.launchpad,
    // Frames carry no chain time: receipt time (≲1 s after the create), flagged approximate.
    createdAt: e.receivedAt,
    createdAtApprox: true,
  };
  if (e.symbol) p.symbol = e.symbol;
  if (e.name) p.name = e.name;
  if (e.uri) p.uri = e.uri;
  if (e.creator) p.creator = e.creator;
  if (isNum(e.devBuySol)) p.devBuySol = e.devBuySol;
  if (isNum(e.progressPct)) p.progressPct = e.progressPct;
  if (isNum(e.marketCapSol)) {
    p.marketCapSol = e.marketCapSol;
    const usd = toUsd(e.marketCapSol, solPriceUsd);
    if (usd !== undefined) p.marketCapUsd = usd;
  }
  if (e.isMayhemMode !== undefined) p.mayhem = e.isMayhemMode;
  return p;
}

/** Display label for a PumpPortal migration destination ('pump-amm' → PumpSwap). */
export function migrationDexLabel(pool: string): string {
  if (pool === 'pump-amm' || pool === 'pumpswap') return 'PumpSwap';
  return normalizeDex('geckoterminal', pool).label;
}

/** PumpPortal migration event: graduated at receipt time. */
export function patchFromMigration(e: MigrationEvent): PulsePatch {
  const p: PulsePatch = {
    mint: e.mint,
    source: 'pumpportal',
    freshness: 'stream',
    at: e.receivedAt,
    receivedAt: e.receivedAt,
    stage: 'graduated',
    graduatedAt: e.receivedAt,
    migratedDex: migrationDexLabel(e.pool),
  };
  // pump-amm migrations come from pump.fun curves.
  if (e.pool === 'pump-amm') p.launchpad = 'pump.fun';
  return p;
}

/** Jupiter / keyed token row (identity, launch state, market, holders, audit). */
export function patchFromTokenRow(row: TokenRow, meta: PatchMeta): PulsePatch {
  const t = row.token;
  const m = row.market;
  const lp = t.launchpad;
  const p = basePatch(t.mint, meta);
  if (t.symbol) p.symbol = t.symbol;
  if (t.name) p.name = t.name;
  if (t.image) p.image = t.image;
  if (t.creator) p.creator = t.creator;
  if (isNum(t.createdAt)) p.createdAt = t.createdAt;
  if (t.socials && hasSocials(t.socials)) p.socials = t.socials;
  if (lp) {
    p.stage = lp.stage;
    if (lp.launchpad) p.launchpad = lp.launchpad;
    if (isNum(lp.progressPct)) {
      p.progressPct = lp.progressPct;
      if (lp.progressSource) p.progressSource = lp.progressSource;
    }
    if (lp.stage === 'graduated') {
      if (isNum(lp.graduatedAt)) p.graduatedAt = lp.graduatedAt;
      if (lp.migratedPool) p.migratedPool = lp.migratedPool;
      // The row's main pool names the destination DEX only when it IS the migration pool.
      if (lp.migratedPool && row.pool?.address === lp.migratedPool && row.pool.dexLabel) p.migratedDex = row.pool.dexLabel;
    }
  }
  if (isNum(m.priceUsd)) p.priceUsd = m.priceUsd;
  if (isNum(m.priceSol)) p.priceSol = m.priceSol;
  // Launchpad supply is fully minted at creation, so FDV is the market cap traders quote.
  const mc = m.marketCapUsd ?? (lp?.launchpad ? m.fdvUsd : undefined);
  if (isNum(mc)) p.marketCapUsd = mc;
  if (isNum(m.liquidityUsd)) p.liquidityUsd = m.liquidityUsd;
  if (isNum(m.holders)) p.holders = m.holders;
  const day = m.stats.h24;
  if (day) {
    if (isNum(day.volumeUsd)) p.volumeUsd = day.volumeUsd;
    if (isNum(day.buys) || isNum(day.sells)) p.txns = compactRecord({ buys: day.buys, sells: day.sells });
  }
  if (row.risk && hasKeys(row.risk)) p.risk = compactRecord({ ...row.risk });
  return p;
}

export type GeckoPoolKind = 'bonding' | 'migration' | 'other';

/** Launchpad bonding curve, post-migration AMM venue, or irrelevant. */
export function classifyGeckoPool(pool: GeckoPoolInfo): GeckoPoolKind {
  if (pool.baseMint === MINTS.SOL || STABLE_MINTS.has(pool.baseMint)) return 'other';
  if (pool.isBondingCurve) return 'bonding';
  if (MIGRATION_DEXES.has(pool.dex)) return 'migration';
  return 'other';
}

/**
 * GeckoTerminal pool → reading for its base token. Bonding pools carry the
 * token's creation time; migration pools carry graduation facts (apply them
 * only after the token's launchpad is confirmed; see geckoMigrationAction).
 */
export function patchFromGeckoPool(pool: GeckoPoolInfo, meta: PatchMeta): PulsePatch | null {
  const kind = classifyGeckoPool(pool);
  if (kind === 'other') return null;
  const p = basePatch(pool.baseMint, meta);
  const base = pool.baseToken;
  if (base?.symbol) p.symbol = base.symbol;
  if (base?.name) p.name = base.name;
  if (base?.image) p.image = base.image;
  if (kind === 'bonding') {
    p.stage = 'bonding';
    const launchpad = pool.launchpad?.launchpad;
    if (launchpad) p.launchpad = launchpad;
    if (isNum(pool.createdAt)) p.createdAt = pool.createdAt;
  } else {
    p.stage = 'graduated';
    if (isNum(pool.createdAt)) p.graduatedAt = pool.createdAt;
    p.migratedPool = pool.address;
    p.migratedDex = pool.dexLabel;
  }
  if (isNum(pool.priceUsd)) p.priceUsd = pool.priceUsd;
  if (pool.quoteMint === MINTS.SOL && isNum(pool.priceNative)) p.priceSol = pool.priceNative;
  const mc = pool.marketCapUsd ?? pool.fdvUsd;
  if (isNum(mc)) p.marketCapUsd = mc;
  if (isNum(pool.liquidityUsd)) p.liquidityUsd = pool.liquidityUsd;
  if (isNum(pool.volume24hUsd)) p.volumeUsd = pool.volume24hUsd;
  if (pool.txns24h) p.txns = { buys: pool.txns24h.buys, sells: pool.txns24h.sells };
  return p;
}

/**
 * What to do with a GeckoTerminal migration-venue pool: apply it to a token
 * already known as graduated (consistent pool / DEX), ignore it when it
 * contradicts the known migration, otherwise verify the launchpad first.
 */
export function geckoMigrationAction(item: PulseItem | undefined, pool: GeckoPoolInfo): 'apply' | 'verify' | 'ignore' {
  if (!item || item.launchpad.stage !== 'graduated') return 'verify';
  if (item.launchpad.migratedPool && item.launchpad.migratedPool !== pool.address) return 'ignore';
  if (item.migratedDex && item.migratedDex !== pool.dexLabel) return 'ignore';
  return 'apply';
}

/** Decoded pump.fun curve (exact, on-chain). USD values only for SOL-quoted curves with a known SOL price. */
export function patchFromCurve(c: BondingCurveState, solPriceUsd?: number): PulsePatch {
  const p: PulsePatch = {
    mint: c.mint,
    source: 'solana-rpc',
    freshness: 'realtime',
    at: c.fetchedAt,
    receivedAt: c.fetchedAt,
    updateOnly: true,
    progressPct: c.progressPct,
    progressSource: 'solana-rpc',
    curveComplete: c.complete,
  };
  if (c.creator) p.creator = c.creator;
  if (c.isMayhemMode !== undefined) p.mayhem = c.isMayhemMode;
  if (c.quoteMint === MINTS.SOL && !c.complete) {
    if (isNum(c.priceQuote)) {
      p.priceSol = c.priceQuote;
      const usd = toUsd(c.priceQuote, solPriceUsd);
      if (usd !== undefined) p.priceUsd = usd;
    }
    if (isNum(c.marketCapQuote)) {
      p.marketCapSol = c.marketCapQuote;
      const usd = toUsd(c.marketCapQuote, solPriceUsd);
      if (usd !== undefined) p.marketCapUsd = usd;
    }
  }
  return p;
}

/**
 * Jupiter Ultra extras: snipers / insiders / bundlers and bonding progress for
 * launchpads without an on-chain decoder. Ultra reports 100 for graduated
 * tokens, so a full curve is not taken as progress (graduation comes from
 * Tokens V2 instead).
 */
export function patchFromUltra(mint: string, info: JupiterUltraInfo, meta: PatchMeta): PulsePatch | null {
  const p = basePatch(mint, meta);
  p.updateOnly = true;
  if (isNum(info.progressPct) && info.progressPct < 99.95) {
    p.progressPct = info.progressPct;
    p.progressSource = meta.source;
  }
  const risk = compactRecord({ ...info.risk });
  if (hasKeys(risk)) p.risk = risk;
  return p.progressPct === undefined && !p.risk ? null : p;
}

// ---------------------------------------------------------------------------
// Destination DEX from the migration pool's owner program (on-chain)
// ---------------------------------------------------------------------------

/**
 * AMM programs that own launchpad graduation pools → normalized DEX id.
 * Verified 2026-09-29 against the owners of Jupiter `graduatedPool` accounts
 * (PumpSwap, Raydium AMM v4 / CPMM, Meteora DAMM v2 / DLMM) and Meteora's
 * DAMM v1 SDK. An owner outside this map stays unlabelled.
 */
export const POOL_PROGRAM_DEX: Readonly<Record<string, string>> = {
  [PROGRAMS.PUMP_AMM]: 'pumpswap',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'raydium',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'raydium-cpmm',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'raydium-clmm',
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: 'meteora-damm-v2',
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: 'meteora-damm',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'meteora-dlmm',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'orca',
};

/** DEX label for a pool owned by `owner`, when the program is a known AMM. */
export function dexLabelForPoolOwner(owner: string | undefined): string | undefined {
  const dex = owner ? POOL_PROGRAM_DEX[owner] : undefined;
  return dex ? normalizeDex('orbyt', dex).label : undefined;
}

/** Graduated tokens with a known migration pool but no destination DEX yet (visible Migrated cards first). */
export function poolDexTargets(
  items: ReadonlyMap<string, PulseItem>,
  visibleMigrated: readonly string[],
  settled: ReadonlySet<string>,
  cap: number,
): Array<{ mint: string; pool: string }> {
  const out: Array<{ mint: string; pool: string }> = [];
  const seen = new Set<string>();
  const consider = (item: PulseItem | undefined) => {
    if (out.length >= cap || !item || seen.has(item.mint)) return;
    seen.add(item.mint);
    const pool = item.launchpad.migratedPool;
    if (item.launchpad.stage !== 'graduated' || !pool || item.migratedDex || settled.has(pool)) return;
    out.push({ mint: item.mint, pool });
  };
  for (const mint of visibleMigrated) consider(items.get(mint));
  for (const item of items.values()) consider(item);
  return out;
}

/**
 * Owners from a `getMultipleAccounts` result (aligned with `pools`):
 * a string for an existing account, null for a missing one. Malformed
 * entries are left out so they can be retried.
 */
export function poolOwnersFromRpc(result: unknown, pools: readonly string[]): Record<string, string | null> {
  const value = isPlainObject(result) ? result.value : undefined;
  const out: Record<string, string | null> = {};
  if (!Array.isArray(value) || value.length !== pools.length) return out;
  pools.forEach((pool, i) => {
    const account: unknown = value[i];
    if (account === null) out[pool] = null;
    else if (isPlainObject(account) && typeof account.owner === 'string') out[pool] = account.owner;
  });
  return out;
}

/** On-chain reading: the migration pool is owned by a known AMM program. */
export function patchFromPoolOwner(mint: string, pool: string, owner: string, fetchedAt: number): PulsePatch | null {
  const label = dexLabelForPoolOwner(owner);
  if (!label) return null;
  return {
    mint,
    source: 'solana-rpc',
    freshness: 'realtime',
    at: fetchedAt,
    receivedAt: fetchedAt,
    updateOnly: true,
    stage: 'graduated',
    migratedPool: pool,
    migratedDex: label,
  };
}

/** Keyed server list token (Solana Tracker / Birdeye via /api/v1/pulse). */
export function patchFromServerToken(t: PulseToken, meta: PatchMeta): PulsePatch {
  const p = basePatch(t.mint, meta);
  if (t.symbol) p.symbol = t.symbol;
  if (t.name) p.name = t.name;
  if (t.image) p.image = t.image;
  if (t.uri) p.uri = t.uri;
  if (t.creator) p.creator = t.creator;
  if (isNum(t.createdAt)) p.createdAt = t.createdAt;
  if (isNum(t.devBuySol)) p.devBuySol = t.devBuySol;
  if (t.socials && hasSocials(t.socials)) p.socials = t.socials;
  const lp = t.launchpad;
  p.stage = lp.stage;
  if (lp.launchpad) p.launchpad = lp.launchpad;
  if (isNum(lp.progressPct)) {
    p.progressPct = lp.progressPct;
    p.progressSource = lp.progressSource ?? meta.source;
  }
  if (lp.stage === 'graduated') {
    if (isNum(lp.graduatedAt)) p.graduatedAt = lp.graduatedAt;
    if (lp.migratedPool) p.migratedPool = lp.migratedPool;
  }
  if (isNum(t.priceUsd)) p.priceUsd = t.priceUsd;
  if (isNum(t.marketCapUsd)) p.marketCapUsd = t.marketCapUsd;
  if (isNum(t.marketCapSol)) p.marketCapSol = t.marketCapSol;
  if (isNum(t.liquidityUsd)) p.liquidityUsd = t.liquidityUsd;
  if (isNum(t.volumeUsd)) p.volumeUsd = t.volumeUsd;
  if (t.txns && (isNum(t.txns.buys) || isNum(t.txns.sells))) p.txns = compactRecord({ buys: t.txns.buys, sells: t.txns.sells });
  if (isNum(t.holders)) p.holders = t.holders;
  if (t.risk && hasKeys(t.risk)) p.risk = compactRecord({ ...t.risk });
  return p;
}

// ---------------------------------------------------------------------------
// Verification of unconfirmed candidates
// ---------------------------------------------------------------------------

/**
 * Readings that must be confirmed before they may create a token:
 * - 'launch': PumpPortal pool 'bonk' creates (unverified schema; an existing
 *   token was once reported as a launch),
 * - 'migration': a new AMM pool whose token is not yet known to come from a
 *   launchpad.
 */
export interface PendingCandidate {
  kind: 'launch' | 'migration';
  patch: PulsePatch;
  addedAt: number;
  attempts: number;
}

export type VerifyOutcome = { status: 'confirmed'; patches: PulsePatch[] } | { status: 'rejected' } | { status: 'unknown' };

/** Confirm or reject a candidate against the token's Jupiter / keyed row. */
export function verifyCandidate(c: PendingCandidate, row: TokenRow | undefined, meta: PatchMeta, now: number): VerifyOutcome {
  if (!row) return { status: 'unknown' };
  const lp = row.token.launchpad;
  const rowPatch = patchFromTokenRow(row, meta);
  if (c.kind === 'launch') {
    const created = row.token.createdAt;
    const recent = isNum(created) && now - created <= NEW_PAIRS_WINDOW_MS && now - created >= -CLOCK_SKEW_MS;
    if (!lp?.launchpad || lp.stage === 'amm' || !recent) return { status: 'rejected' };
    return { status: 'confirmed', patches: [c.patch, rowPatch] };
  }
  if (!lp?.launchpad || lp.stage === 'amm' || lp.stage === 'unknown') return { status: 'rejected' };
  // Still bonding per the row: the provider may lag the migration, retry later.
  if (lp.stage !== 'graduated') return { status: 'unknown' };
  const samePool = !lp.migratedPool || lp.migratedPool === c.patch.migratedPool;
  if (!samePool) return { status: 'confirmed', patches: [rowPatch] };
  const graduation: PulsePatch = { ...c.patch, launchpad: lp.launchpad };
  if (isNum(lp.graduatedAt)) graduation.graduatedAt = lp.graduatedAt;
  return { status: 'confirmed', patches: [graduation, rowPatch] };
}

// ---------------------------------------------------------------------------
// Freshness and provider status
// ---------------------------------------------------------------------------

export type PulseFeedId =
  | 'jupRecent'
  | 'jupTrending'
  | 'geckoNew'
  | 'geckoPump'
  | 'curves'
  | 'poolDex'
  | 'jupRows'
  | 'jupUltra'
  | 'serverNew'
  | 'serverFinal'
  | 'serverMigrated';

export interface PulseFeedStatus {
  lastOkAt?: number;
  lastErrorAt?: number;
  error?: string;
  /** Transport / provider actually used, e.g. 'publicnode' or 'Solana Tracker'. */
  via?: string;
  /** Feed switched off (e.g. server route not configured). */
  disabled?: boolean;
}

export type PulseFeeds = Partial<Record<PulseFeedId, PulseFeedStatus>>;

/** Which polled feeds back each column (the PumpPortal stream is handled separately). */
export const COLUMN_BACKFILL: Readonly<Record<PulseColumn, readonly PulseFeedId[]>> = {
  new: ['jupRecent', 'geckoNew', 'serverNew'],
  final: ['geckoPump', 'jupUltra', 'jupTrending', 'serverFinal'],
  migrated: ['jupRows', 'jupTrending', 'geckoNew', 'serverMigrated'],
};

export function feedFailing(status: PulseFeedStatus | undefined): boolean {
  return !!status && !status.disabled && status.lastErrorAt !== undefined && (status.lastOkAt === undefined || status.lastErrorAt > status.lastOkAt);
}

export interface ColumnFreshness {
  updatedAt?: number;
  live: boolean;
  error?: string;
}

/**
 * LIVE only for stream-fed (New Pairs, Migrated: PumpPortal open and
 * delivering within 10 s) or on-chain realtime data (Final Stretch: a curve
 * read within 10 s). Otherwise the age of the newest successful backfill.
 */
export function columnFreshness(
  column: PulseColumn,
  input: { streamOpen: boolean; streamLastAt?: number; feeds: PulseFeeds; now: number },
): ColumnFreshness {
  const { feeds, now } = input;
  const liveAt = column === 'final' ? feeds.curves?.lastOkAt : input.streamOpen ? input.streamLastAt : undefined;
  if (liveAt !== undefined && now - liveAt <= LIVE_WINDOW_MS) return { updatedAt: liveAt, live: true };
  let backfillAt: number | undefined;
  const errors: string[] = [];
  let enabled = 0;
  for (const id of COLUMN_BACKFILL[column]) {
    const status = feeds[id];
    if (!status || status.disabled) continue;
    enabled++;
    if (status.lastOkAt !== undefined && (backfillAt === undefined || status.lastOkAt > backfillAt)) backfillAt = status.lastOkAt;
    if (feedFailing(status) && status.error) errors.push(status.error);
  }
  // The newest successful reading of any kind (a curve read 11 s ago beats a 50 s old pool list).
  const updatedAt = backfillAt === undefined ? liveAt : liveAt === undefined ? backfillAt : Math.max(backfillAt, liveAt);
  const liveDown = column === 'final' ? feedFailing(feeds.curves) : !input.streamOpen;
  const allFailing = enabled > 0 && errors.length === enabled && liveDown;
  return allFailing ? { updatedAt, live: false, error: errors.join(' · ') } : { updatedAt, live: false };
}

export type SourceState = 'ok' | 'error' | 'idle';

/**
 * Health of one source tag backed by one or more feeds: ok when any enabled
 * feed is currently succeeding, error when every reporting feed is failing,
 * idle when none has reported yet. Disabled feeds are ignored.
 */
export function sourceHealth(statuses: ReadonlyArray<PulseFeedStatus | undefined>): {
  state: SourceState;
  lastOkAt?: number;
  error?: string;
  via?: string;
} {
  const enabled = statuses.filter((s): s is PulseFeedStatus => !!s && !s.disabled && (s.lastOkAt !== undefined || s.lastErrorAt !== undefined));
  if (!enabled.length) return { state: 'idle' };
  let lastOkAt: number | undefined;
  let via: string | undefined;
  for (const s of enabled) {
    if (s.lastOkAt !== undefined && (lastOkAt === undefined || s.lastOkAt > lastOkAt)) {
      lastOkAt = s.lastOkAt;
      via = s.via;
    }
  }
  const failing = enabled.filter(feedFailing);
  const out: { state: SourceState; lastOkAt?: number; error?: string; via?: string } = {
    state: failing.length === enabled.length ? 'error' : 'ok',
  };
  if (lastOkAt !== undefined) out.lastOkAt = lastOkAt;
  if (via) out.via = via;
  const error = failing.map((s) => s.error).find(Boolean);
  if (error) out.error = error;
  return out;
}

/** Short, factual, user-facing error text (never URLs or keys). */
export function feedErrorText(error: unknown): string {
  if (isProviderError(error)) {
    const label = PROVIDER_LABELS[error.provider] ?? error.provider;
    switch (error.code) {
      case 'rate_limited': {
        const wait = isNum(error.retryAfterMs) && error.retryAfterMs > 0 ? `; retrying in ${Math.ceil(error.retryAfterMs / 1000)} s` : '; retrying';
        return `${label} is rate limiting this browser${wait}`;
      }
      case 'timeout':
        return `${label} timed out`;
      case 'network':
        return `${label} is unreachable`;
      case 'not_configured':
        return `${label} is not configured`;
      case 'malformed':
        return `${label} sent an unexpected response`;
      case 'http':
        return `${label} error${error.status ? ` (HTTP ${error.status})` : ''}`;
      case 'not_found':
        return `${label}: not found`;
      default:
        return `${label} unavailable`;
    }
  }
  if (error instanceof ChainError) {
    // A server route answering 501 (no keyed provider configured) is skipped silently.
    const failed = error.attempts.filter((a) => a.code !== 'not_configured');
    if (failed.length) {
      return failed.map((a) => `${PROVIDER_LABELS[a.provider] ?? a.provider} ${a.code === 'rate_limited' ? 'rate limited' : 'unavailable'}`).join(' · ');
    }
  }
  return 'Source unavailable';
}
