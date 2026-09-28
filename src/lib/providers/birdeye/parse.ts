import 'server-only';

/**
 * Pure parsers for Birdeye Data API payloads (the `data` member of the
 * `{ success, data }` envelope).
 *
 * Birdeye quirks handled here (from data.birdeye.so/docs, 2026-09-28):
 * - v3 endpoints are snake_case (unix_time, v_usd, block_unix_time); v1 is camelCase.
 * - token_security `top10UserPercent` / `top10HolderPercent` / `creatorPercentage` are
 *   FRACTIONS (0.304 = 30.4%; the schema allows numeric strings), while v3 holder
 *   `top10HoldPercent` and holder-profile `percent_of_supply` are 0–100.
 * - v3 trade `side` is relative to the requested token; the sign of that token's
 *   `ui_change_amount` is used first. v3 `volume` is in requested-token units.
 * - Trade legs carry raw `amount` (string) and decimal-adjusted `ui_amount`.
 */

import { num, toMs } from '@/lib/core/chain';
import { normalizeDex } from '@/lib/core/dex';
import { isSolanaAddress, MINTS } from '@/lib/core/solana';
import type {
  Candle,
  HolderEntry,
  HolderSnapshot,
  LaunchpadState,
  PulseColumn,
  PulseToken,
  RiskFlag,
  RiskReport,
  Socials,
  Trade,
} from '@/lib/core/types';

export type Rec = Record<string, unknown>;

export function rec(value: unknown): Rec | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;
}

export function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t ? t : undefined;
}

export function httpsUrl(value: unknown): string | undefined {
  const t = text(value);
  if (!t) return undefined;
  try {
    return new URL(t).protocol === 'https:' ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Drop keys whose value is undefined (the data contract omits unknown fields). */
export function defined<T extends object>(value: T): T {
  const out: Rec = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** A 0–100 percentage, or undefined when absent / out of range. */
export function percent(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && n >= 0 && n <= 100 ? n : undefined;
}

/** A 0–1 fraction converted to a 0–100 percentage. */
export function fractionToPercent(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && n >= 0 && n <= 1 ? n * 100 : undefined;
}

function positive(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && n > 0 ? n : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

function count(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && n >= 0 ? Math.round(n) : undefined;
}

// ---------------------------------------------------------------------------
// Venues
// ---------------------------------------------------------------------------

/** Birdeye `source` (trades / meme list) → ORBYT normalized DEX id. */
const SOURCE_TO_DEX: Record<string, string> = {
  pump_dot_fun: 'pumpfun',
  pump_amm: 'pumpswap',
  raydium: 'raydium',
  raydium_cp: 'raydium-cpmm',
  raydium_clamm: 'raydium-clmm',
  raydium_launchlab: 'launchlab',
  meteora_dlmm: 'meteora-dlmm',
  meteora_dynamic_bonding_curve: 'meteora-dbc',
  // Meteora's DBC program is named "virtual curve" in its IDL.
  meteora_virtual_curve: 'meteora-dbc',
  orca: 'orca',
  whirlpool: 'orca',
  fluxbeam: 'fluxbeam',
  moonshot: 'moonshot',
};

export function birdeyeDex(source: unknown): string | undefined {
  const raw = text(source)?.toLowerCase();
  if (!raw) return undefined;
  return SOURCE_TO_DEX[raw] ?? raw.replace(/_/g, '-');
}

/** Birdeye meme `source` → launchpad display name (only for known launchpads). */
export function birdeyeLaunchpad(source: unknown): string | undefined {
  const raw = text(source)?.toLowerCase();
  if (!raw) return undefined;
  const dex = SOURCE_TO_DEX[raw];
  if (dex) {
    const identity = normalizeDex('orbyt', dex);
    if (identity.launchpad) return identity.launchpad;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// OHLCV v3
// ---------------------------------------------------------------------------

export interface ParsedCandles {
  candles: Candle[];
  /** Distinct `currency` values reported by the items (lower-case). */
  currencies: string[];
}

/**
 * v3 OHLCV items → ascending, time-unique candles. Items without finite OHLC
 * or time are dropped; `v_usd` becomes the USD volume.
 */
export function parseOhlcvItems(items: unknown): ParsedCandles | undefined {
  if (!Array.isArray(items)) return undefined;
  const byTime = new Map<number, Candle>();
  const currencies = new Set<string>();
  for (const item of items) {
    const r = rec(item);
    if (!r) continue;
    const time = num(r.unix_time);
    const open = num(r.o);
    const high = num(r.h);
    const low = num(r.l);
    const close = num(r.c);
    if (time === undefined || time <= 0 || open === undefined || high === undefined || low === undefined || close === undefined) continue;
    const candle: Candle = { time: Math.floor(time), open, high, low, close };
    const volume = nonNegative(r.v_usd);
    if (volume !== undefined) candle.volume = volume;
    byTime.set(candle.time, candle);
    const currency = text(r.currency)?.toLowerCase();
    if (currency) currencies.add(currency);
  }
  return { candles: [...byTime.values()].sort((a, b) => a.time - b.time), currencies: [...currencies] };
}

// ---------------------------------------------------------------------------
// Trades v3
// ---------------------------------------------------------------------------

function sideOf(value: unknown): Trade['side'] | undefined {
  const v = text(value)?.toLowerCase();
  return v === 'buy' || v === 'sell' ? v : undefined;
}

/**
 * v3 token trade → Trade from the perspective of `mint`.
 *
 * The side is derived from the sign of the token leg's `ui_change_amount`
 * (positive = the owner received the token = buy). Birdeye's own `side` is
 * only a fallback: in the documented examples it is relative to the queried
 * address, which is not always the leg we care about.
 */
export function parseTrade(item: unknown, mint: string): Trade | undefined {
  const r = rec(item);
  if (!r) return undefined;
  const signature = text(r.tx_hash);
  const timestamp = toMs(r.block_unix_time);
  if (!signature || timestamp === undefined) return undefined;
  const txType = text(r.tx_type)?.toLowerCase();
  if (txType === 'add' || txType === 'remove') return undefined;

  const legs = [r.from, r.to, r.base, r.quote].map(rec).filter((l): l is Rec => !!l);
  const tokenLeg = legs.find((l) => l.address === mint);
  // Legs present but none is the requested token: not a trade of this token.
  if (legs.length && !tokenLeg) return undefined;
  const quoteLeg = legs.find((l) => l !== tokenLeg && typeof l.address === 'string' && l.address !== mint);

  const change = num(tokenLeg?.ui_change_amount);
  const side: Trade['side'] | undefined =
    change !== undefined && change !== 0 ? (change > 0 ? 'buy' : 'sell') : (sideOf(r.side) ?? sideOf(r.tx_type));
  if (!side) return undefined;

  const tokenAmountRaw = num(tokenLeg?.ui_amount) ?? change ?? (tokenLeg ? undefined : num(r.volume));
  const tokenAmount = tokenAmountRaw !== undefined && tokenAmountRaw !== 0 ? Math.abs(tokenAmountRaw) : undefined;
  const quoteRaw = num(quoteLeg?.ui_amount) ?? num(quoteLeg?.ui_change_amount);
  const quoteAmount = quoteRaw !== undefined && quoteRaw !== 0 ? Math.abs(quoteRaw) : undefined;
  const usdValue = nonNegative(r.volume_usd);
  const owner = r.owner;
  const legPrice = positive(tokenLeg?.price);
  const priceUsd = legPrice ?? (usdValue !== undefined && usdValue > 0 && tokenAmount ? usdValue / tokenAmount : undefined);

  return defined<Trade>({
    signature,
    timestamp,
    side,
    wallet: isSolanaAddress(owner) ? owner : undefined,
    tokenAmount,
    quoteAmount,
    quoteSymbol: text(quoteLeg?.symbol),
    solAmount: quoteLeg?.address === MINTS.SOL ? quoteAmount : undefined,
    usdValue,
    priceUsd,
    pool: text(r.pool_id) ?? text(r.address),
    dex: birdeyeDex(r.source),
    source: 'birdeye',
  });
}

// ---------------------------------------------------------------------------
// Holders v3
// ---------------------------------------------------------------------------

type OwnerLabel = (owner: string) => string | undefined;

export function parseHolderItems(items: unknown, isProgram: (owner: string) => boolean | undefined, labelOf?: OwnerLabel): HolderEntry[] | undefined {
  if (!Array.isArray(items)) return undefined;
  const out: HolderEntry[] = [];
  for (const item of items) {
    const r = rec(item);
    const owner = r?.owner;
    const amount = num(r?.ui_amount);
    if (!r || !isSolanaAddress(owner) || amount === undefined || amount <= 0) continue;
    const entry: HolderEntry = { owner, amount };
    const tokenAccount = r.token_account;
    if (isSolanaAddress(tokenAccount)) entry.tokenAccount = tokenAccount;
    const label = labelOf?.(owner);
    if (label) entry.label = label;
    const program = isProgram(owner);
    if (program !== undefined) entry.isProgramAccount = program;
    out.push(entry);
  }
  return out;
}

export function parseHolderSnapshot(
  data: Rec,
  mint: string,
  limit: number,
  fetchedAt: number,
  isProgram: (owner: string) => boolean | undefined,
  labelOf?: OwnerLabel,
): HolderSnapshot | undefined {
  const top = parseHolderItems(data.items, isProgram, labelOf);
  if (!top) return undefined;
  const snapshot: HolderSnapshot = { mint, top: top.slice(0, limit), updatedAt: fetchedAt };
  const holders = count(data.holder);
  if (holders !== undefined) snapshot.totalHolders = holders;
  const top10 = percent(data.top10HoldPercent);
  if (top10 !== undefined) snapshot.distribution = { top10Pct: top10 };
  return snapshot;
}

// ---------------------------------------------------------------------------
// Risk: token_security + holder-profile
// ---------------------------------------------------------------------------

export type RiskFields = Partial<Omit<RiskReport, 'mint' | 'flags' | 'sources' | 'updatedAt'>>;

export function parseSecurity(data: Rec): { fields: RiskFields; flags: RiskFlag[] } {
  const fields: RiskFields = defined<RiskFields>({
    // Wallet-level ("top 10 unique users", related accounts deduplicated) before per-account.
    top10Pct: fractionToPercent(data.top10UserPercent) ?? fractionToPercent(data.top10HolderPercent),
    devHoldingPct: fractionToPercent(data.creatorPercentage),
  });
  const flags: RiskFlag[] = [];
  const flag = (level: RiskFlag['level'], label: string, detail?: string) =>
    flags.push(defined<RiskFlag>({ level, label, detail, source: 'birdeye' }));

  // Freeze authority: an address or freezeable=true means enabled; freezeable=false means disabled.
  const freezeAuthority = text(data.freezeAuthority);
  if (freezeAuthority || data.freezeable === true) {
    fields.freezeAuthorityDisabled = false;
    flag('danger', 'Freeze authority enabled', freezeAuthority);
  } else if (data.freezeable === false) {
    fields.freezeAuthorityDisabled = true;
  }
  if (data.mutableMetadata === true) flag('warn', 'Mutable metadata');
  if (data.transferFeeEnable === true) flag('warn', 'Transfer fee enabled');
  if (data.nonTransferable === true) flag('danger', 'Non-transferable token');
  if (data.fakeToken === true) flag('danger', 'Flagged as a possible fake token');
  if (data.jupStrictList === true) flag('good', 'On Jupiter strict list');
  return { fields, flags };
}

/** holder-profile tags (percent_of_supply is 0–100; zeroed tags are real zeros). */
export function parseHolderProfile(data: Rec): RiskFields {
  const tags = Array.isArray(data.tags) ? data.tags.map(rec).filter((t): t is Rec => !!t) : [];
  const tagPct = (name: string) => percent(tags.find((t) => text(t.tag)?.toLowerCase() === name)?.percent_of_supply);
  return defined<RiskFields>({
    snipersPct: tagPct('sniper'),
    bundlersPct: tagPct('bundler'),
    insidersPct: tagPct('insider'),
    devHoldingPct: tagPct('dev'),
    top10Pct: percent(rec(rec(data.token)?.top10_holder)?.percent_of_supply),
  });
}

// ---------------------------------------------------------------------------
// Meme list (Pulse)
// ---------------------------------------------------------------------------

function socialsOf(extensions: unknown): Socials | undefined {
  const ext = rec(extensions);
  if (!ext) return undefined;
  const socials = defined<Socials>({
    website: httpsUrl(ext.website),
    twitter: httpsUrl(ext.twitter),
    telegram: httpsUrl(ext.telegram),
    discord: httpsUrl(ext.discord),
  });
  return Object.keys(socials).length ? socials : undefined;
}

export function parseMemeItem(item: unknown, column: PulseColumn, fetchedAt: number): PulseToken | undefined {
  const r = rec(item);
  const info = rec(r?.meme_info);
  const mint = r?.address;
  if (!r || !isSolanaAddress(mint)) return undefined;

  const graduated = info?.graduated === true || (info?.graduated === undefined && column === 'migrated');
  const progress = percent(info?.progress_percent);
  const launchpad: LaunchpadState = defined<LaunchpadState>({
    stage: graduated ? 'graduated' : 'bonding',
    launchpad: birdeyeLaunchpad(info?.source),
    progressPct: graduated ? undefined : progress,
    progressSource: !graduated && progress !== undefined ? 'birdeye' : undefined,
    graduatedAt: graduated ? toMs(info?.graduated_time) : undefined,
  });

  const creator = info?.creator;
  const buys = count(r.buy_24h);
  const sells = count(r.sell_24h);
  return defined<PulseToken>({
    mint,
    symbol: text(r.symbol),
    name: text(r.name),
    image: httpsUrl(r.logo_uri),
    creator: isSolanaAddress(creator) ? creator : undefined,
    createdAt: toMs(info?.creation_time) ?? toMs(rec(info?.created_at)?.block_time),
    detectedAt: fetchedAt,
    launchpad,
    priceUsd: positive(r.price),
    marketCapUsd: positive(r.market_cap),
    liquidityUsd: nonNegative(r.liquidity),
    volumeUsd: nonNegative(r.volume_24h_usd),
    txns: buys !== undefined || sells !== undefined ? defined({ buys, sells }) : undefined,
    holders: count(r.holder),
    socials: socialsOf(r.extensions),
    sources: ['birdeye'],
    updatedAt: fetchedAt,
  });
}
