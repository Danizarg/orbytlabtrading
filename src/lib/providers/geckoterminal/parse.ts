/**
 * Pure parsers for GeckoTerminal / CoinGecko on-chain (JSON:API) payloads.
 *
 * Upstream quirks handled here (live-verified 2026-09-28):
 * - Every number is a string with arbitrary precision ("0.00000002954…").
 * - Resource ids are network-prefixed ('solana_<address>'); attributes.address is bare.
 * - `market_cap_usd` is null for most memecoins and sometimes "0.0" next to a
 *   multi-million FDV, so non-positive caps are treated as unknown.
 * - wSOL's fdv/market cap is the wrapped supply (~1.4B), not SOL's market cap,
 *   so both are omitted for the WSOL mint.
 * - `mint_authority` / `freeze_authority` are the strings 'yes' | 'no'.
 * - `twitter_handle` can be junk such as 'user/status/<id>'.
 * - OHLCV rows are [unixSeconds, o, h, l, c, volumeUsd], newest first.
 */

import { num, toMs } from '@/lib/core/chain';
import { normalizeDex, type DexIdentity } from '@/lib/core/dex';
import type { ProviderId } from '@/lib/core/providers';
import { isSignature, isSolanaAddress, MINTS } from '@/lib/core/solana';
import {
  STAT_WINDOWS,
  type Candle,
  type HolderSnapshot,
  type LaunchpadState,
  type PoolInfo,
  type RiskFlag,
  type RiskReport,
  type SearchHit,
  type Socials,
  type StatWindow,
  type TokenIdentity,
  type TokenMarket,
  type TokenMeta,
  type TokenRow,
  type Trade,
  type WindowStats,
} from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';

/** Provider ids this adapter reports as: keyless host vs keyed CoinGecko hosts. */
export type GeckoProviderId = Extract<ProviderId, 'geckoterminal' | 'coingecko'>;

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

export function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rec(value: unknown): Rec | undefined {
  return isRecord(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  return s ? s : undefined;
}

/** Strictly positive number (prices, FDV, market cap). */
export function pos(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && n > 0 ? n : undefined;
}

/** Non-negative number (liquidity, volume, percentages of supply). */
export function nonNeg(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

function count(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && n >= 0 && Number.isInteger(n) ? n : undefined;
}

/** Drop keys whose value is undefined so omitted fields are truly absent. */
export function clean<T extends object>(obj: T): T {
  for (const key of Object.keys(obj) as Array<keyof T>) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

/** https URL (untrusted third-party content: only https is rendered). */
export function httpsUrl(value: unknown): string | undefined {
  const s = str(value);
  if (!s || !s.startsWith('https://')) return undefined;
  try {
    return new URL(s).protocol === 'https:' ? s : undefined;
  } catch {
    return undefined;
  }
}

/** http(s) URL for project websites (some projects still serve plain http). */
function webUrl(value: unknown): string | undefined {
  const s = str(value);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? s : undefined;
  } catch {
    return undefined;
  }
}

const TWITTER_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const TELEGRAM_HANDLE = /^[A-Za-z0-9_]{1,64}$/;

/** GeckoTerminal twitter_handle → x.com URL; junk such as 'user/status/123' is dropped. */
export function twitterUrl(value: unknown): string | undefined {
  const handle = str(value)?.replace(/^@/, '');
  return handle && TWITTER_HANDLE.test(handle) ? `https://x.com/${handle}` : undefined;
}

export function telegramUrl(value: unknown): string | undefined {
  const handle = str(value)?.replace(/^@/, '');
  return handle && TELEGRAM_HANDLE.test(handle) ? `https://t.me/${handle}` : undefined;
}

const KNOWN_QUOTE_SYMBOLS: Record<string, string> = {
  [MINTS.SOL]: 'SOL',
  [MINTS.USDC]: 'USDC',
  [MINTS.USDT]: 'USDT',
};

// ---------------------------------------------------------------------------
// JSON:API envelope
// ---------------------------------------------------------------------------

export interface JsonApiResource {
  id: string;
  type: string;
  attributes: Rec;
  relationships: Rec;
}

export interface JsonApiList {
  data: JsonApiResource[];
  included: Map<string, JsonApiResource>;
}

export interface JsonApiSingle {
  data: JsonApiResource;
  included: Map<string, JsonApiResource>;
}

function toResource(value: unknown): JsonApiResource | undefined {
  const r = rec(value);
  const id = str(r?.id);
  const type = str(r?.type);
  if (!r || !id || !type) return undefined;
  return { id, type, attributes: rec(r.attributes) ?? {}, relationships: rec(r.relationships) ?? {} };
}

const includedKey = (type: string, id: string) => `${type}:${id}`;

function indexIncluded(value: unknown): Map<string, JsonApiResource> {
  const map = new Map<string, JsonApiResource>();
  if (!Array.isArray(value)) return map;
  for (const item of value) {
    const r = toResource(item);
    if (r) map.set(includedKey(r.type, r.id), r);
  }
  return map;
}

function malformed(provider: GeckoProviderId, label: string): ProviderError {
  return new ProviderError(provider, 'malformed', `${label}: unexpected response`);
}

/** `{ data: [...], included?: [...] }`; malformed items are skipped, a wrong envelope throws. */
export function parseList(provider: GeckoProviderId, payload: unknown, label: string): JsonApiList {
  const body = rec(payload);
  if (!body || !Array.isArray(body.data)) throw malformed(provider, label);
  const data: JsonApiResource[] = [];
  for (const item of body.data) {
    const r = toResource(item);
    if (r) data.push(r);
  }
  return { data, included: indexIncluded(body.included) };
}

/** `{ data: {...}, included?: [...] }`. */
export function parseSingle(provider: GeckoProviderId, payload: unknown, label: string): JsonApiSingle {
  const body = rec(payload);
  const data = toResource(body?.data);
  if (!body || !data) throw malformed(provider, label);
  return { data, included: indexIncluded(body.included) };
}

/** 'solana_<address>' → '<address>'; ids for other networks yield undefined. */
export function solanaId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  if (id.startsWith('solana_')) return id.slice('solana_'.length) || undefined;
  return isSolanaAddress(id) ? id : undefined;
}

function relationshipData(res: JsonApiResource, name: string): unknown {
  return rec(res.relationships[name])?.data;
}

/** Id of a to-one relationship (raw, still prefixed). */
export function relationshipId(res: JsonApiResource, name: string): string | undefined {
  return str(rec(relationshipData(res, name))?.id);
}

/** Ids of a to-many relationship (raw, still prefixed). */
export function relationshipIds(res: JsonApiResource, name: string): string[] {
  const data = relationshipData(res, name);
  if (!Array.isArray(data)) return [];
  return data.map((d) => str(rec(d)?.id)).filter((id): id is string => id !== undefined);
}

function resourceAddress(res: JsonApiResource): string | undefined {
  const attr = str(res.attributes.address);
  if (attr && isSolanaAddress(attr)) return attr;
  const fromId = solanaId(res.id);
  return fromId && isSolanaAddress(fromId) ? fromId : undefined;
}

// ---------------------------------------------------------------------------
// Tokens, DEX identity, launchpads
// ---------------------------------------------------------------------------

/** Identity from a token resource (included token or token endpoint). */
export function tokenIdentity(res: JsonApiResource): TokenIdentity | undefined {
  const mint = resourceAddress(res);
  if (!mint) return undefined;
  const a = res.attributes;
  const image = rec(a.image);
  return clean({
    mint,
    symbol: str(a.symbol),
    name: str(a.name),
    image: httpsUrl(image?.large) ?? httpsUrl(image?.small) ?? httpsUrl(image?.thumb) ?? httpsUrl(a.image_url),
    decimals: count(a.decimals),
  });
}

function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

/**
 * Normalized DEX identity. Unknown GeckoTerminal ids get the included dex
 * name ('Saros AMM') instead of the generic title-cased id.
 */
export function dexIdentity(rawId: string | undefined, included?: Map<string, JsonApiResource>): DexIdentity {
  const identity = normalizeDex('geckoterminal', rawId);
  if (!rawId || identity.label !== titleCase(identity.dex)) return identity;
  const name = included ? str(included.get(includedKey('dex', rawId))?.attributes.name) : undefined;
  return name ? { ...identity, label: name } : identity;
}

/**
 * GeckoTerminal `launchpad_details` → LaunchpadState. The graduation
 * percentage is coarse and can lag the on-chain curve (0.0 vs 0.56% observed),
 * so decoded bonding-curve state should win when available.
 */
export function launchpadFromDetails(details: unknown, launchpad: string | undefined): LaunchpadState | undefined {
  const d = rec(details);
  if (!d) return undefined;
  const completed = d.completed === true;
  const pct = num(d.graduation_percentage);
  return clean<LaunchpadState>({
    stage: completed ? 'graduated' : 'bonding',
    launchpad,
    progressPct: pct === undefined ? undefined : Math.min(100, Math.max(0, pct)),
    progressSource: pct === undefined ? undefined : 'geckoterminal',
    graduatedAt: completed ? toMs(d.completed_at) : undefined,
    migratedPool: isSolanaAddress(d.migrated_destination_pool_address) ? d.migrated_destination_pool_address : undefined,
  });
}

/** Launchpad display name from token-info category ids ('pump-fun' → 'pump.fun'). */
function launchpadFromCategories(ids: unknown): string | undefined {
  if (!Array.isArray(ids)) return undefined;
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const identity = normalizeDex('geckoterminal', id);
    if (identity.isBondingCurve && identity.launchpad) return identity.launchpad;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

/** PoolInfo plus the identities GeckoTerminal includes (Pulse backfill needs symbol/name/image). */
export interface GeckoPoolInfo extends PoolInfo {
  baseToken?: TokenIdentity;
  quoteToken?: TokenIdentity;
  /** Set for bonding-curve venues; list endpoints carry no progress (use pools/multi). */
  launchpad?: LaunchpadState;
}

interface ParsedPool {
  address: string;
  baseMint: string;
  quoteMint?: string;
  dex: DexIdentity;
  base?: TokenIdentity;
  quote?: TokenIdentity;
  quoteSymbol?: string;
  attrs: Rec;
}

/** 'BASE / QUOTE' → ['BASE', 'QUOTE'] (only when unambiguous). */
function splitPoolName(name: unknown): [string, string] | undefined {
  const s = str(name);
  if (!s) return undefined;
  const parts = s.split(' / ');
  const [base, quote] = parts;
  return parts.length === 2 && base && quote ? [base.trim(), quote.trim()] : undefined;
}

function includedToken(included: Map<string, JsonApiResource>, id: string | undefined): TokenIdentity | undefined {
  if (!id) return undefined;
  const res = included.get(includedKey('token', id));
  return res ? tokenIdentity(res) : undefined;
}

function parsePool(res: JsonApiResource, included: Map<string, JsonApiResource>): ParsedPool | undefined {
  if (res.type !== 'pool') return undefined;
  const address = resourceAddress(res);
  const baseId = relationshipId(res, 'base_token');
  const quoteId = relationshipId(res, 'quote_token');
  const baseMint = solanaId(baseId);
  if (!address || !baseMint) return undefined;
  const quoteMint = solanaId(quoteId);
  const names = splitPoolName(res.attributes.name) ?? splitPoolName(res.attributes.pool_name);
  const base = includedToken(included, baseId);
  const quote = includedToken(included, quoteId);
  return {
    address,
    baseMint,
    quoteMint,
    dex: dexIdentity(relationshipId(res, 'dex'), included),
    base: base ?? (names ? { mint: baseMint, symbol: names[0] } : undefined),
    quote: quote ?? (names && quoteMint ? { mint: quoteMint, symbol: names[1] } : undefined),
    quoteSymbol: (quoteMint ? KNOWN_QUOTE_SYMBOLS[quoteMint] : undefined) ?? quote?.symbol ?? names?.[1],
    attrs: res.attributes,
  };
}

function windowStats(attrs: Rec, opts: { priceChangeOnly?: boolean } = {}): Partial<Record<StatWindow, WindowStats>> {
  const volume = rec(attrs.volume_usd);
  const txns = rec(attrs.transactions);
  const change = rec(attrs.price_change_percentage);
  const out: Partial<Record<StatWindow, WindowStats>> = {};
  for (const w of STAT_WINDOWS) {
    const t = rec(txns?.[w]);
    const stats = clean<WindowStats>(
      opts.priceChangeOnly
        ? { priceChangePct: num(change?.[w]) }
        : {
            buys: count(t?.buys),
            sells: count(t?.sells),
            buyers: count(t?.buyers),
            sellers: count(t?.sellers),
            volumeUsd: nonNeg(volume?.[w]),
            priceChangePct: num(change?.[w]),
          },
    );
    if (Object.keys(stats).length) out[w] = stats;
  }
  return out;
}

const isWsol = (mint: string | undefined) => mint === MINTS.SOL;

function poolMarket(p: ParsedPool, source: GeckoProviderId, fetchedAt: number): TokenMarket {
  const a = p.attrs;
  const wsolBase = isWsol(p.baseMint);
  return clean<TokenMarket>({
    mint: p.baseMint,
    priceUsd: pos(a.base_token_price_usd),
    // Only when the pool is quoted in WSOL, so "native" is unambiguously SOL.
    priceSol: isWsol(p.quoteMint) ? pos(a.base_token_price_native_currency) : undefined,
    fdvUsd: wsolBase ? undefined : pos(a.fdv_usd),
    marketCapUsd: wsolBase ? undefined : pos(a.market_cap_usd),
    liquidityUsd: nonNeg(a.reserve_in_usd),
    stats: windowStats(a),
    updatedAt: fetchedAt,
    source,
  });
}

function bondingLaunchpad(dex: DexIdentity): LaunchpadState | undefined {
  return dex.isBondingCurve ? clean<LaunchpadState>({ stage: 'bonding', launchpad: dex.launchpad }) : undefined;
}

export function poolInfoFromResource(
  res: JsonApiResource,
  included: Map<string, JsonApiResource>,
  source: GeckoProviderId,
): GeckoPoolInfo | undefined {
  const p = parsePool(res, included);
  if (!p) return undefined;
  const a = p.attrs;
  const tx = rec(rec(a.transactions)?.h24);
  const buys = count(tx?.buys);
  const sells = count(tx?.sells);
  const wsolBase = isWsol(p.baseMint);
  return clean<GeckoPoolInfo>({
    address: p.address,
    dex: p.dex.dex,
    dexLabel: p.dex.label,
    baseMint: p.baseMint,
    quoteMint: p.quoteMint,
    quoteSymbol: p.quoteSymbol,
    priceUsd: pos(a.base_token_price_usd),
    priceNative: pos(a.base_token_price_quote_token),
    liquidityUsd: nonNeg(a.reserve_in_usd),
    volume24hUsd: nonNeg(rec(a.volume_usd)?.h24),
    marketCapUsd: wsolBase ? undefined : pos(a.market_cap_usd),
    fdvUsd: wsolBase ? undefined : pos(a.fdv_usd),
    createdAt: toMs(a.pool_created_at),
    txns24h: buys !== undefined && sells !== undefined ? { buys, sells } : undefined,
    isBondingCurve: p.dex.isBondingCurve,
    url: `https://www.geckoterminal.com/solana/pools/${p.address}`,
    source,
    baseToken: p.base,
    quoteToken: p.quote,
    launchpad: bondingLaunchpad(p.dex),
  });
}

/** Discover row for the pool's BASE token (pool-level stats, pair age as createdAt). */
export function rowFromPool(
  res: JsonApiResource,
  included: Map<string, JsonApiResource>,
  source: GeckoProviderId,
  fetchedAt: number,
): TokenRow | undefined {
  const p = parsePool(res, included);
  if (!p) return undefined;
  return {
    token: clean({
      ...(p.base ?? { mint: p.baseMint }),
      mint: p.baseMint,
      createdAt: toMs(p.attrs.pool_created_at),
      launchpad: bondingLaunchpad(p.dex),
    }),
    market: poolMarket(p, source, fetchedAt),
    pool: clean({ address: p.address, dex: p.dex.dex, dexLabel: p.dex.label, quoteSymbol: p.quoteSymbol }),
  };
}

export function searchHitFromPool(
  res: JsonApiResource,
  included: Map<string, JsonApiResource>,
  source: GeckoProviderId,
): SearchHit | undefined {
  const p = parsePool(res, included);
  if (!p) return undefined;
  const a = p.attrs;
  return clean<SearchHit>({
    mint: p.baseMint,
    symbol: p.base?.symbol,
    name: p.base?.name,
    image: p.base?.image,
    priceUsd: pos(a.base_token_price_usd),
    marketCapUsd: isWsol(p.baseMint) ? undefined : pos(a.market_cap_usd),
    liquidityUsd: nonNeg(a.reserve_in_usd),
    volume24hUsd: nonNeg(rec(a.volume_usd)?.h24),
    launchpad: bondingLaunchpad(p.dex),
    source,
  });
}

/** pools/multi item → base mint + launchpad state (undefined when the pool is not a launchpad pool). */
export function launchpadStateFromPool(res: JsonApiResource): { pool: string; mint: string; launchpad: LaunchpadState } | undefined {
  if (res.type !== 'pool') return undefined;
  const pool = resourceAddress(res);
  const mint = solanaId(relationshipId(res, 'base_token'));
  if (!pool || !mint) return undefined;
  const dex = normalizeDex('geckoterminal', relationshipId(res, 'dex'));
  const launchpad = launchpadFromDetails(res.attributes.launchpad_details, dex.launchpad) ?? bondingLaunchpad(dex);
  return launchpad ? { pool, mint, launchpad } : undefined;
}

// ---------------------------------------------------------------------------
// Token endpoints (tokens/multi, token info)
// ---------------------------------------------------------------------------

interface TopPool {
  parsed: ParsedPool;
  /** Our token is the pool's base (pool-level price fields then describe our token). */
  isBase: boolean;
}

function topPool(res: JsonApiResource, included: Map<string, JsonApiResource>, mint: string): TopPool | undefined {
  for (const id of relationshipIds(res, 'top_pools')) {
    const poolRes = included.get(includedKey('pool', id));
    const parsed = poolRes ? parsePool(poolRes, included) : undefined;
    if (parsed) return { parsed, isBase: parsed.baseMint === mint };
  }
  return undefined;
}

/**
 * tokens/multi item → TokenMarket. Token-level: price, FDV, market cap, total
 * reserve across pools, 24h volume. Price change and SOL price come from the
 * top pool only when our token is that pool's base (GT prices tokens from it).
 */
export function marketFromToken(
  res: JsonApiResource,
  included: Map<string, JsonApiResource>,
  source: GeckoProviderId,
  fetchedAt: number,
): TokenMarket | undefined {
  const mint = resourceAddress(res);
  if (res.type !== 'token' || !mint) return undefined;
  const a = res.attributes;
  const top = topPool(res, included, mint);
  const topAttrs = top?.isBase ? top.parsed.attrs : undefined;
  const stats: Partial<Record<StatWindow, WindowStats>> = rec(a.price_change_percentage)
    ? windowStats({ price_change_percentage: a.price_change_percentage }, { priceChangeOnly: true })
    : topAttrs
      ? windowStats(topAttrs, { priceChangeOnly: true })
      : {};
  const volume24h = nonNeg(rec(a.volume_usd)?.h24);
  if (volume24h !== undefined) stats.h24 = { ...stats.h24, volumeUsd: volume24h };
  const wsol = isWsol(mint);
  return clean<TokenMarket>({
    mint,
    priceUsd: pos(a.price_usd),
    priceSol: topAttrs && isWsol(top?.parsed.quoteMint) ? pos(topAttrs.base_token_price_native_currency) : undefined,
    fdvUsd: wsol ? undefined : pos(a.fdv_usd),
    marketCapUsd: wsol ? undefined : pos(a.market_cap_usd),
    liquidityUsd: nonNeg(a.total_reserve_in_usd),
    stats,
    updatedAt: fetchedAt,
    source,
  });
}

/** tokens/multi item → TokenRow (row pool = GT's top pool; createdAt = that pool's age). */
export function rowFromToken(
  res: JsonApiResource,
  included: Map<string, JsonApiResource>,
  source: GeckoProviderId,
  fetchedAt: number,
): TokenRow | undefined {
  const identity = tokenIdentity(res);
  const market = marketFromToken(res, included, source, fetchedAt);
  if (!identity || !market) return undefined;
  const top = topPool(res, included, identity.mint);
  // The launchpad name is only known while the top pool is the token's own bonding curve.
  const curve = top?.isBase && top.parsed.dex.isBondingCurve ? top.parsed.dex : undefined;
  return clean<TokenRow>({
    token: clean({
      ...identity,
      createdAt: top ? toMs(top.parsed.attrs.pool_created_at) : undefined,
      launchpad:
        launchpadFromDetails(res.attributes.launchpad_details, curve?.launchpad) ?? (curve ? bondingLaunchpad(curve) : undefined),
    }),
    market,
    pool: top
      ? clean({ address: top.parsed.address, dex: top.parsed.dex.dex, dexLabel: top.parsed.dex.label, quoteSymbol: top.parsed.quoteSymbol })
      : undefined,
  });
}

/** tokens/multi item → TokenMeta (no socials on this endpoint). */
export function metaFromToken(res: JsonApiResource): TokenMeta | undefined {
  const identity = tokenIdentity(res);
  if (res.type !== 'token' || !identity) return undefined;
  return clean<TokenMeta>({
    ...identity,
    socials: {},
    totalSupply: nonNeg(res.attributes.normalized_total_supply),
    launchpad: launchpadFromDetails(res.attributes.launchpad_details, undefined),
  });
}

export interface GeckoTokenInfo {
  meta: TokenMeta;
  risk: RiskReport;
  holders: HolderSnapshot;
}

/** 'yes' → false (authority active), 'no' → true (revoked), anything else → unknown. */
function authorityDisabled(value: unknown): boolean | undefined {
  if (value === 'no') return true;
  if (value === 'yes') return false;
  return undefined;
}

function pctLabel(n: number): string {
  return `${n.toFixed(n >= 10 ? 1 : 2)}%`;
}

/** tokens/{mint}/info → metadata, risk and holder summary (one request serves all three). */
export function parseTokenInfo(res: JsonApiResource, source: GeckoProviderId, fetchedAt: number): GeckoTokenInfo | undefined {
  const identity = tokenIdentity(res);
  if (res.type !== 'token' || !identity) return undefined;
  const a = res.attributes;
  const mint = identity.mint;

  const websites = Array.isArray(a.websites) ? a.websites : [];
  const socials = clean<Socials>({
    website: webUrl(websites[0]),
    twitter: twitterUrl(a.twitter_handle),
    telegram: telegramUrl(a.telegram_handle),
    discord: httpsUrl(a.discord_url),
  });
  const categories = Array.isArray(a.categories)
    ? a.categories.map((c) => str(c)).filter((c): c is string => c !== undefined)
    : [];
  const meta = clean<TokenMeta>({
    ...identity,
    socials,
    description: str(a.description),
    creator: isSolanaAddress(a.developer_address) ? a.developer_address : undefined,
    verified: typeof a.gt_verified === 'boolean' ? a.gt_verified : undefined,
    tags: categories.length ? categories : undefined,
    launchpad: launchpadFromDetails(a.launchpad_details, launchpadFromCategories(a.gt_category_ids)),
  });

  const holdersRec = rec(a.holders);
  const dist = rec(holdersRec?.distribution_percentage);
  const distribution = dist
    ? clean({
        top10Pct: nonNeg(dist.top_10),
        top11to20Pct: nonNeg(dist['11_20']),
        top21to40Pct: nonNeg(dist['21_40']),
        restPct: nonNeg(dist.rest),
      })
    : undefined;
  const holders = clean<HolderSnapshot>({
    mint,
    totalHolders: count(holdersRec?.count),
    top: [],
    distribution: distribution && Object.keys(distribution).length ? distribution : undefined,
    updatedAt: toMs(holdersRec?.last_updated) ?? fetchedAt,
  });

  const mintAuthorityDisabled = authorityDisabled(a.mint_authority);
  const freezeAuthorityDisabled = authorityDisabled(a.freeze_authority);
  const top10Pct = distribution?.top10Pct;
  const devHoldingPct = nonNeg(a.developer_holding_percentage);
  const gtScore = num(a.gt_score);
  // is_honeypot is always 'unknown' on Solana: never turned into a flag.
  const flags: RiskFlag[] = [];
  if (mintAuthorityDisabled === false) {
    flags.push({ level: 'danger', label: 'Mint authority enabled', detail: 'New tokens can still be minted', source });
  }
  if (freezeAuthorityDisabled === false) {
    flags.push({ level: 'danger', label: 'Freeze authority enabled', detail: 'Token accounts can be frozen', source });
  }
  if (top10Pct !== undefined && top10Pct > 50) {
    flags.push({ level: 'warn', label: `Top 10 holders own ${pctLabel(top10Pct)}`, source });
  }
  if (devHoldingPct !== undefined && devHoldingPct > 10) {
    flags.push({ level: 'warn', label: `Developer holds ${pctLabel(devHoldingPct)}`, source });
  }
  const risk = clean<RiskReport>({
    mint,
    top10Pct,
    devHoldingPct,
    mintAuthorityDisabled,
    freezeAuthorityDisabled,
    providerScore: gtScore !== undefined && gtScore >= 0 ? { value: gtScore, max: 100, label: 'GT Score' } : undefined,
    flags,
    sources: [source],
    updatedAt: fetchedAt,
  });

  return { meta, risk, holders };
}

// ---------------------------------------------------------------------------
// OHLCV
// ---------------------------------------------------------------------------

/**
 * `data.attributes.ohlcv_list` (newest first) → ascending, unique-time candles.
 * Rows with non-finite / non-positive prices or high < low are dropped.
 * `rows` is the raw upstream row count (for hasMore).
 */
export function parseOhlcv(provider: GeckoProviderId, payload: unknown, label: string): { candles: Candle[]; rows: number } {
  const list = rec(rec(rec(payload)?.data)?.attributes)?.ohlcv_list;
  if (!Array.isArray(list)) throw malformed(provider, label);
  const byTime = new Map<number, Candle>();
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const t = num(row[0]);
    const open = pos(row[1]);
    const high = pos(row[2]);
    const low = pos(row[3]);
    const close = pos(row[4]);
    if (t === undefined || t <= 0 || open === undefined || high === undefined || low === undefined || close === undefined) continue;
    if (high < low) continue;
    // Seconds per the API; tolerate milliseconds defensively.
    const time = Math.floor(t >= 1e12 ? t / 1000 : t);
    if (byTime.has(time)) continue; // newest-first: keep the first (latest) copy
    byTime.set(time, clean<Candle>({ time, open, high, low, close, volume: nonNeg(row[5]) }));
  }
  return { candles: [...byTime.values()].sort((x, y) => x.time - y.time), rows: list.length };
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

/**
 * Pool trade → Trade for `mint`. `kind` is relative to the `token` query
 * param (we pass our mint); amounts are decimal-adjusted strings. Trades that
 * do not involve `mint` or lack a signature/time are dropped.
 */
export function tradeFromResource(res: JsonApiResource, mint: string, pool: string, source: GeckoProviderId): Trade | undefined {
  if (res.type !== 'trade') return undefined;
  const a = res.attributes;
  const signature = str(a.tx_hash);
  const timestamp = toMs(a.block_timestamp);
  if (!signature || !isSignature(signature) || timestamp === undefined) return undefined;
  const from = str(a.from_token_address);
  const to = str(a.to_token_address);
  const ours = to === mint ? 'to' : from === mint ? 'from' : undefined;
  if (!ours) return undefined;
  const side: Trade['side'] = a.kind === 'buy' || a.kind === 'sell' ? a.kind : ours === 'to' ? 'buy' : 'sell';
  const otherMint = ours === 'to' ? from : to;
  const otherAmount = pos(ours === 'to' ? a.from_token_amount : a.to_token_amount);
  const solQuote = isWsol(otherMint);
  return clean<Trade>({
    signature,
    timestamp,
    side,
    wallet: str(a.tx_from_address),
    tokenAmount: pos(ours === 'to' ? a.to_token_amount : a.from_token_amount),
    solAmount: solQuote ? otherAmount : undefined,
    quoteAmount: solQuote ? undefined : otherAmount,
    quoteSymbol: otherMint ? KNOWN_QUOTE_SYMBOLS[otherMint] : undefined,
    usdValue: nonNeg(a.volume_in_usd),
    priceUsd: pos(ours === 'to' ? a.price_to_in_usd : a.price_from_in_usd),
    pool,
    source,
  });
}
