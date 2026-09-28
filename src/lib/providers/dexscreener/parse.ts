/**
 * Pure parsing / normalization of DEX Screener pair objects.
 *
 * Verified payload facts (research 2026-09-28):
 * - `priceUsd` / `priceNative` are decimal STRINGS ("0.00000002954"); any key
 *   may be missing (priceUsd, marketCap, liquidity, info, labels, priceChange).
 * - `priceChange.{m5,h1,h6,h24}` are already percentages (-78.19 = -78.19%) and
 *   the object can be `{}` or hold only some windows.
 * - `volume.*` and `liquidity.usd` are USD; `pairCreatedAt` is Unix ms.
 * - Bonding-curve pairs (pumpfun, meteoradbc, bags) have NO `liquidity`.
 * - `info.socials` is `[{ type, url }]` and `info.websites` `[{ label, url }]`
 *   (the published docs schema `{ platform, handle }` is outdated).
 */

import { num, toMs } from '@/lib/core/chain';
import { normalizeDex, type DexIdentity } from '@/lib/core/dex';
import { MINTS } from '@/lib/core/solana';
import type { LaunchpadState, PoolInfo, Socials, StatWindow, TokenMarket, WindowStats } from '@/lib/core/types';
import { STAT_WINDOWS } from '@/lib/core/types';

export interface DsToken {
  address: string;
  name?: string;
  symbol?: string;
}

/** A DEX Screener pair after defensive parsing (all numbers finite or absent). */
export interface DsPair {
  /** Absent only if upstream omitted it; chain-scoped endpoints are Solana. */
  chainId?: string;
  pairAddress: string;
  /** Normalized venue (dexId + labels through `normalizeDex`). */
  venue: DexIdentity;
  url?: string;
  base: DsToken;
  quote?: Partial<DsToken>;
  priceNative?: number;
  priceUsd?: number;
  txns: Partial<Record<StatWindow, { buys?: number; sells?: number }>>;
  volume: Partial<Record<StatWindow, number>>;
  priceChange: Partial<Record<StatWindow, number>>;
  liquidityUsd?: number;
  fdvUsd?: number;
  marketCapUsd?: number;
  /** Pair creation (ms). */
  createdAt?: number;
  imageUrl?: string;
  socials: Socials;
}

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** Strictly positive number (prices, market caps): a 0 price is not a price. */
function pos(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && n > 0 ? n : undefined;
}

/** Non-negative number (liquidity, volume, counts). */
function nonNeg(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && n >= 0 ? n : undefined;
}

/** http(s) URL from untrusted third-party content, or undefined. */
export function safeUrl(v: unknown, httpsOnly = false): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    if (u.protocol === 'https:' || (!httpsOnly && u.protocol === 'http:')) return s;
  } catch {
    // not a URL
  }
  return undefined;
}

function parseToken(v: unknown): Partial<DsToken> | undefined {
  if (!isRecord(v)) return undefined;
  return { address: str(v.address), name: str(v.name), symbol: str(v.symbol) };
}

function parseSocials(info: Rec | undefined): Socials {
  const out: Socials = {};
  if (!info) return out;
  if (Array.isArray(info.websites)) {
    const sites = info.websites.filter(isRecord);
    const preferred = sites.find((w) => /website/i.test(str(w.label) ?? '') && safeUrl(w.url)) ?? sites.find((w) => safeUrl(w.url));
    const website = preferred ? safeUrl(preferred.url) : undefined;
    if (website) out.website = website;
  }
  if (Array.isArray(info.socials)) {
    for (const s of info.socials) {
      if (!isRecord(s)) continue;
      const url = safeUrl(s.url);
      if (!url) continue;
      const type = (str(s.type) ?? '').toLowerCase();
      if ((type === 'twitter' || type === 'x') && !out.twitter) out.twitter = url;
      else if (type === 'telegram' && !out.telegram) out.telegram = url;
      else if (type === 'discord' && !out.discord) out.discord = url;
    }
  }
  return out;
}

/**
 * Parse one upstream pair. Returns undefined for items missing the identity
 * fields (pairAddress, baseToken.address) instead of inventing them.
 */
export function parsePair(raw: unknown): DsPair | undefined {
  if (!isRecord(raw)) return undefined;
  const pairAddress = str(raw.pairAddress);
  const base = parseToken(raw.baseToken);
  if (!pairAddress || !base?.address) return undefined;

  const labels = Array.isArray(raw.labels) ? raw.labels.filter((l): l is string => typeof l === 'string') : [];
  const txnsRaw = isRecord(raw.txns) ? raw.txns : {};
  const volumeRaw = isRecord(raw.volume) ? raw.volume : {};
  const changeRaw = isRecord(raw.priceChange) ? raw.priceChange : {};
  const txns: DsPair['txns'] = {};
  const volume: DsPair['volume'] = {};
  const priceChange: DsPair['priceChange'] = {};
  for (const w of STAT_WINDOWS) {
    const t = txnsRaw[w];
    if (isRecord(t)) {
      const buys = nonNeg(t.buys);
      const sells = nonNeg(t.sells);
      if (buys !== undefined || sells !== undefined) txns[w] = { buys, sells };
    }
    const v = nonNeg(volumeRaw[w]);
    if (v !== undefined) volume[w] = v;
    const c = num(changeRaw[w]);
    if (c !== undefined) priceChange[w] = c;
  }
  const info = isRecord(raw.info) ? raw.info : undefined;
  const liquidity = isRecord(raw.liquidity) ? raw.liquidity : undefined;
  const quote = parseToken(raw.quoteToken);

  return {
    chainId: str(raw.chainId),
    pairAddress,
    venue: normalizeDex('dexscreener', str(raw.dexId), labels),
    url: safeUrl(raw.url, true),
    base: { address: base.address, name: base.name, symbol: base.symbol },
    quote,
    priceNative: pos(raw.priceNative),
    priceUsd: pos(raw.priceUsd),
    txns,
    volume,
    priceChange,
    liquidityUsd: nonNeg(liquidity?.usd),
    fdvUsd: pos(raw.fdv),
    marketCapUsd: pos(raw.marketCap),
    createdAt: toMs(raw.pairCreatedAt),
    imageUrl: safeUrl(info?.imageUrl, true),
    socials: parseSocials(info),
  };
}

/** Parse an array of pairs, dropping unusable items. */
export function parsePairs(items: readonly unknown[]): DsPair[] {
  const out: DsPair[] = [];
  for (const item of items) {
    const p = parsePair(item);
    if (p) out.push(p);
  }
  return out;
}

/** Drop undefined-valued keys so "omitted" really means absent. */
export function compact<T extends object>(obj: T): T {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

// ---------------------------------------------------------------------------
// Launch lifecycle
// ---------------------------------------------------------------------------

/**
 * Where each launchpad migrates on graduation (normalized dex ids). For these
 * launchpads ONLY such a pool can be the migration destination; any other AMM
 * pool is a side pool someone created (pump.fun never migrates to DLMM).
 * - pump.fun: PumpSwap (since 2025-03), Raydium AMM v4 before that.
 * - LaunchLab / letsbonk: Raydium CPMM or AMM v4 (creator's migrate type).
 * - Meteora DBC / bags (DBC-based): DAMM v2 or DAMM v1.
 */
const MIGRATION_VENUES: Record<string, readonly string[]> = {
  pumpfun: ['pumpswap', 'raydium'],
  launchlab: ['raydium-cpmm', 'raydium'],
  letsbonk: ['raydium-cpmm', 'raydium'],
  'meteora-dbc': ['meteora-damm-v2', 'meteora-damm'],
  bags: ['meteora-damm-v2', 'meteora-damm'],
};

/** A curve with zero trades in the last 5 min (both counts reported). */
function isQuiet(p: DsPair): boolean {
  const m5 = p.txns.m5;
  return m5?.buys === 0 && m5.sells === 0;
}

function byCreatedAsc(a: DsPair, b: DsPair): number {
  return (a.createdAt ?? Number.POSITIVE_INFINITY) - (b.createdAt ?? Number.POSITIVE_INFINITY);
}

export interface DerivedLaunch {
  state: LaunchpadState;
  /** Bonding-curve pairs that are frozen after graduation (stale prices). */
  frozenPairs: ReadonlySet<string>;
}

/**
 * Launch stage for `mint` from its DEX Screener pairs. Only pairs where the
 * mint is the BASE token count (token-pairs also lists pools quoting the mint).
 *
 * - bonding pair + AMM pair → `graduated` when an AMM pair sits at the
 *   launchpad's migration venue (e.g. pump.fun → PumpSwap). Any other AMM
 *   pool of a known launchpad is a side pool: the token is still `bonding`
 *   (even if its curve went quiet — dead curves keep side pools too).
 *   For launchpads without a known venue, a curve that stopped trading in the
 *   last 5 min next to an AMM pool is taken as graduated (a completed curve
 *   cannot trade).
 * - bonding pair only → `bonding` (DEX Screener exposes no curve progress).
 * - AMM pairs only → `amm`; no base pairs at all → `unknown`.
 */
export function deriveLaunch(mint: string, pairs: readonly DsPair[]): DerivedLaunch {
  const own = pairs.filter((p) => p.base.address === mint);
  const bonding = own.filter((p) => p.venue.isBondingCurve);
  const amm = own.filter((p) => !p.venue.isBondingCurve);
  const none: ReadonlySet<string> = new Set();
  if (!own.length) return { state: { stage: 'unknown' }, frozenPairs: none };
  if (!bonding.length) return { state: { stage: 'amm' }, frozenPairs: none };

  const curve = bonding[0]!;
  const launchpad = curve.venue.launchpad;
  const venues = MIGRATION_VENUES[curve.venue.dex];
  const candidates = venues ? amm.filter((p) => venues.includes(p.venue.dex)) : bonding.every(isQuiet) ? amm : [];
  if (!candidates.length) return { state: compact<LaunchpadState>({ stage: 'bonding', launchpad }), frozenPairs: none };

  // The migration pool pairs the token with the curve's own quote mint (SOL,
  // USD1, …); prefer those over e.g. a TOKEN/USDC pool at the same venue.
  const curveQuote = curve.quote?.address;
  const sameQuote = curveQuote ? candidates.filter((p) => p.quote?.address === curveQuote) : [];
  const destination = [...(sameQuote.length ? sameQuote : candidates)].sort(byCreatedAsc)[0]!;
  return {
    state: compact<LaunchpadState>({
      stage: 'graduated',
      launchpad,
      migratedPool: destination.pairAddress,
      // Approximate: DEX Screener has no migration timestamp; the destination
      // pool is created in the migration transaction, so its pairCreatedAt
      // (second precision) stands in for the graduation time.
      graduatedAt: destination.createdAt,
    }),
    frozenPairs: new Set(bonding.map((p) => p.pairAddress)),
  };
}

// ---------------------------------------------------------------------------
// Normalized models
// ---------------------------------------------------------------------------

/**
 * PoolInfo for a pair. `frozen` marks a graduated bonding curve: DEX Screener
 * keeps re-marking its final curve price in USD, so price / mc / fdv are
 * omitted rather than shown as a live market.
 */
export function toPoolInfo(p: DsPair, frozen = false): PoolInfo {
  const h24 = p.txns.h24;
  const live = !frozen;
  return compact<PoolInfo>({
    address: p.pairAddress,
    dex: p.venue.dex,
    dexLabel: p.venue.label,
    baseMint: p.base.address,
    quoteMint: p.quote?.address,
    quoteSymbol: p.quote?.symbol,
    priceUsd: live ? p.priceUsd : undefined,
    priceNative: live ? p.priceNative : undefined,
    liquidityUsd: p.liquidityUsd,
    volume24hUsd: p.volume.h24,
    marketCapUsd: live ? p.marketCapUsd : undefined,
    fdvUsd: live ? p.fdvUsd : undefined,
    createdAt: p.createdAt,
    txns24h: h24?.buys !== undefined && h24.sells !== undefined ? { buys: h24.buys, sells: h24.sells } : undefined,
    isBondingCurve: p.venue.isBondingCurve,
    url: p.url,
    source: 'dexscreener',
  });
}

/** Liquidity desc; pools without liquidity after; bonding curves last (by 24h volume). */
export function comparePools(a: PoolInfo, b: PoolInfo): number {
  const ab = a.isBondingCurve ? 1 : 0;
  const bb = b.isBondingCurve ? 1 : 0;
  if (ab !== bb) return ab - bb;
  const al = a.liquidityUsd ?? -1;
  const bl = b.liquidityUsd ?? -1;
  if (al !== bl) return bl - al;
  return (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1);
}

/** Token-level market from the token's main pair (the mint must be its base). */
export function toTokenMarket(p: DsPair, fetchedAt: number): TokenMarket {
  const stats: TokenMarket['stats'] = {};
  for (const w of STAT_WINDOWS) {
    const s = compact<WindowStats>({
      buys: p.txns[w]?.buys,
      sells: p.txns[w]?.sells,
      volumeUsd: p.volume[w],
      priceChangePct: p.priceChange[w],
    });
    if (Object.keys(s).length) stats[w] = s;
  }
  return compact<TokenMarket>({
    mint: p.base.address,
    priceUsd: p.priceUsd,
    priceSol: p.quote?.address === MINTS.SOL ? p.priceNative : undefined,
    marketCapUsd: p.marketCapUsd,
    fdvUsd: p.fdvUsd,
    liquidityUsd: p.liquidityUsd,
    stats,
    updatedAt: fetchedAt,
    source: 'dexscreener',
  });
}

/** Stage implied by a single main pair: only a bonding curve is conclusive. */
export function mainPairLaunch(p: DsPair): LaunchpadState | undefined {
  return p.venue.isBondingCurve ? compact<LaunchpadState>({ stage: 'bonding', launchpad: p.venue.launchpad }) : undefined;
}

export function hasSocials(s: Socials): boolean {
  return Object.keys(s).length > 0;
}
