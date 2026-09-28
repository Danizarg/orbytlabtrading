import 'server-only';

/**
 * Pure parsers for Solana Tracker Data API payloads (docs.solanatracker.io,
 * verified 2026-09-28).
 *
 * Unit quirks handled here:
 * - `token.creation.created_time` is UNIX SECONDS, while `pools[].createdAt`,
 *   `pools[].lastUpdated`, `trades[].time` and `bundleTime` are MILLISECONDS
 *   (`toMs` accepts both).
 * - Chart candles live under the misspelled key `oclhv`; the official guide
 *   iterates the response as a bare array, so both shapes are accepted. The
 *   unit of `time` is undocumented (the guide multiplies it by 1000 → seconds);
 *   millisecond values are detected and converted.
 * - All risk percentages (`top10`, `*.totalPercentage`, `dev.percentage`) are 0–100.
 * - `volumeSol` on trades is a SOL-denominated valuation, not necessarily the
 *   SOL leg of the swap (USDC pools report it too), so it is not mapped.
 */

import { num, toMs } from '@/lib/core/chain';
import { normalizeDex, normalizeLaunchpadName } from '@/lib/core/dex';
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

function address(value: unknown): string | undefined {
  return isSolanaAddress(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

/** Solana Tracker `market` / `program` → ORBYT normalized DEX id. */
const MARKET_TO_DEX: Record<string, string> = {
  pumpfun: 'pumpfun',
  'pumpfun-amm': 'pumpswap',
  raydium: 'raydium',
  'raydium-cpmm': 'raydium-cpmm',
  'raydium-clmm': 'raydium-clmm',
  'raydium-launchpad': 'launchlab',
  'meteora-curve': 'meteora-dbc',
  'meteora-dlmm': 'meteora-dlmm',
  'meteora-dyn': 'meteora-damm',
  'meteora-dyn-v2': 'meteora-damm-v2',
  moonshot: 'moonshot',
  boop: 'boop',
  heaven: 'heaven',
  orca: 'orca',
};

export function stDex(market: unknown): string | undefined {
  const raw = text(market)?.toLowerCase();
  if (!raw) return undefined;
  return MARKET_TO_DEX[raw] ?? raw;
}

function isCurvePool(pool: Rec): boolean {
  const dex = stDex(pool.market);
  return (dex !== undefined && normalizeDex('orbyt', dex).isBondingCurve) || num(pool.curvePercentage) !== undefined || !!rec(pool.launchpad);
}

/** Launchpad display name of a curve pool: its `launchpad.name` (e.g. letsbonk.fun) or the market's launchpad. */
function launchpadName(pool: Rec | undefined): string | undefined {
  if (!pool) return undefined;
  const named = normalizeLaunchpadName(text(rec(pool.launchpad)?.name));
  if (named) return named;
  const dex = stDex(pool.market);
  return dex ? normalizeDex('orbyt', dex).launchpad : undefined;
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

/** `{ oclhv: [...] }` or a bare array → ascending, time-unique candles (UNIX seconds). */
export function parseCandles(body: unknown): Candle[] | undefined {
  const r = rec(body);
  const list: unknown = Array.isArray(body) ? body : (r?.oclhv ?? r?.ohlcv);
  if (!Array.isArray(list)) return undefined;
  const byTime = new Map<number, Candle>();
  for (const item of list) {
    const c = rec(item);
    if (!c) continue;
    const ms = toMs(c.time);
    const open = num(c.open);
    const high = num(c.high);
    const low = num(c.low);
    const close = num(c.close);
    if (ms === undefined || open === undefined || high === undefined || low === undefined || close === undefined) continue;
    const candle: Candle = { time: Math.floor(ms / 1000), open, high, low, close };
    const volume = nonNegative(c.volume);
    if (volume !== undefined) candle.volume = volume;
    byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

/** `{ trades: [...] }` (or a bare array) → trade rows. */
export function tradeRows(body: unknown): unknown[] | undefined {
  if (Array.isArray(body)) return body;
  const trades = rec(body)?.trades;
  return Array.isArray(trades) ? trades : undefined;
}

export function parseTrade(item: unknown, pool?: string): Trade | undefined {
  const r = rec(item);
  if (!r) return undefined;
  const signature = text(r.tx);
  const timestamp = toMs(r.time);
  const type = text(r.type)?.toLowerCase();
  // Liquidity rows (add_liquidity / remove_liquidity) are not trades.
  if (!signature || timestamp === undefined || (type !== 'buy' && type !== 'sell')) return undefined;
  const pools = Array.isArray(r.pools) ? r.pools : [];
  return defined<Trade>({
    signature,
    timestamp,
    side: type,
    wallet: address(r.wallet),
    tokenAmount: positive(r.amount),
    usdValue: nonNegative(r.volume),
    priceUsd: positive(r.priceUsd),
    pool: pool ?? address(pools[0]),
    dex: stDex(r.program),
    source: 'solanatracker',
  });
}

// ---------------------------------------------------------------------------
// Holders
// ---------------------------------------------------------------------------

/**
 * `/tokens/{mint}/holders` → `{ total, accounts: [{ wallet, amount, percentage }] }`;
 * `/tokens/{mint}/holders/top` → bare `[{ address, amount, percentage }]`. Both accepted.
 */
export function parseHolders(
  body: unknown,
  mint: string,
  limit: number,
  fetchedAt: number,
  isProgram: (owner: string) => boolean | undefined,
): HolderSnapshot | undefined {
  const r = rec(body);
  const rows: unknown = Array.isArray(body) ? body : r?.accounts;
  if (!Array.isArray(rows)) return undefined;
  const entries: HolderEntry[] = [];
  for (const row of rows) {
    const h = rec(row);
    const owner = address(h?.wallet) ?? address(h?.address);
    const amount = positive(h?.amount);
    if (!h || !owner || amount === undefined) continue;
    const entry: HolderEntry = { owner, amount };
    const tokenAccount = address(h.account);
    if (tokenAccount) entry.tokenAccount = tokenAccount;
    // The docs' own example shows percentages above 100: out-of-range values are dropped, not clamped.
    const pct = percent(h.percentage);
    if (pct !== undefined) entry.pctOfSupply = pct;
    const program = isProgram(owner);
    if (program !== undefined) entry.isProgramAccount = program;
    entries.push(entry);
  }
  const snapshot: HolderSnapshot = { mint, top: entries.slice(0, limit), updatedAt: fetchedAt };
  const total = count(r?.total);
  if (total !== undefined) snapshot.totalHolders = total;
  const top10 = entries.slice(0, 10);
  if (top10.length && top10.every((e) => e.pctOfSupply !== undefined)) {
    snapshot.distribution = { top10Pct: top10.reduce((sum, e) => sum + (e.pctOfSupply ?? 0), 0) };
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

export type RiskFields = Partial<Omit<RiskReport, 'mint' | 'flags' | 'sources' | 'updatedAt'>>;

export const SOLANATRACKER_SCORE_LABEL = 'Risk score (higher = riskier)';

/** `risk` object + primary pool `security` → numeric risk fields. */
export function parseRiskFields(risk: Rec | undefined, security: Rec | undefined): RiskFields {
  const score = num(risk?.score);
  const fields = defined<RiskFields>({
    top10Pct: percent(risk?.top10),
    devHoldingPct: percent(rec(risk?.dev)?.percentage),
    insidersPct: percent(rec(risk?.insiders)?.totalPercentage),
    snipersPct: percent(rec(risk?.snipers)?.totalPercentage),
    // Often omitted from token info; /tokens/{mint}/bundlers has the full list.
    bundlersPct: percent(rec(risk?.bundlers)?.totalPercentage),
    providerScore: score !== undefined && score >= 0 && score <= 10 ? { value: score, max: 10, label: SOLANATRACKER_SCORE_LABEL } : undefined,
  });
  // null = authority revoked; a string = still set; missing key = unknown.
  if (security && 'mintAuthority' in security) fields.mintAuthorityDisabled = security.mintAuthority === null;
  if (security && 'freezeAuthority' in security) fields.freezeAuthorityDisabled = security.freezeAuthority === null;
  return fields;
}

function flagLevel(level: unknown): RiskFlag['level'] {
  const v = text(level)?.toLowerCase();
  if (v === 'danger' || v === 'critical' || v === 'high') return 'danger';
  if (v === 'warning' || v === 'warn' || v === 'medium') return 'warn';
  return 'info';
}

export function parseRiskFlags(risk: Rec | undefined): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (!risk) return flags;
  if (risk.rugged === true) flags.push({ level: 'danger', label: 'Marked as rugged', source: 'solanatracker' });
  if (Array.isArray(risk.risks)) {
    for (const item of risk.risks) {
      // Documented both as plain strings and as { name, description, level, score } objects.
      if (typeof item === 'string') {
        const label = text(item);
        if (label) flags.push({ level: 'info', label, source: 'solanatracker' });
        continue;
      }
      const r = rec(item);
      const label = text(r?.name);
      if (!r || !label) continue;
      flags.push(defined<RiskFlag>({ level: flagLevel(r.level), label, detail: text(r.description), source: 'solanatracker' }));
    }
  }
  if (risk.jupiterVerified === true) flags.push({ level: 'good', label: 'Jupiter verified', source: 'solanatracker' });
  return flags;
}

function pools(info: Rec): Rec[] {
  return Array.isArray(info.pools) ? info.pools.map(rec).filter((p): p is Rec => !!p) : [];
}

/** GET /tokens/{mint} → RiskReport (primary pool = pools[0]). */
export function parseRiskReport(info: Rec, mint: string, fetchedAt: number): RiskReport {
  const risk = rec(info.risk);
  const primary = pools(info)[0];
  return {
    mint,
    ...parseRiskFields(risk, rec(primary?.security)),
    flags: parseRiskFlags(risk),
    sources: ['solanatracker'],
    updatedAt: fetchedAt,
  };
}

// ---------------------------------------------------------------------------
// Pulse (/tokens/multi/all)
// ---------------------------------------------------------------------------

export const PULSE_KEYS: Record<PulseColumn, 'latest' | 'graduating' | 'graduated'> = {
  new: 'latest',
  final: 'graduating',
  migrated: 'graduated',
};

function socialsOf(token: Rec): Socials | undefined {
  const strict = rec(token.strictSocials);
  const pick = (key: keyof Socials) => httpsUrl(strict?.[key]) ?? httpsUrl(token[key]);
  const socials = defined<Socials>({ website: pick('website'), twitter: pick('twitter'), telegram: pick('telegram'), discord: pick('discord') });
  return Object.keys(socials).length ? socials : undefined;
}

function launchStateOf(poolList: Rec[], column: PulseColumn): LaunchpadState {
  const primary = poolList[0];
  const curve = poolList.find(isCurvePool);
  const curvePct = percent(curve?.curvePercentage);
  let stage: LaunchpadState['stage'];
  if (column === 'migrated') stage = 'graduated';
  else if (curve) stage = (curvePct !== undefined && curvePct >= 100) || (primary && !isCurvePool(primary)) ? 'graduated' : 'bonding';
  else stage = primary && stDex(primary.market) ? 'amm' : 'unknown';

  const migrated = stage === 'graduated' && primary && !isCurvePool(primary) ? primary : undefined;
  // A PumpSwap pool in the graduated list is pump.fun's migration destination.
  const inferred = stage === 'graduated' && !curve && stDex(primary?.market) === 'pumpswap' ? 'pump.fun' : undefined;
  return defined<LaunchpadState>({
    stage,
    launchpad: launchpadName(curve) ?? inferred,
    progressPct: stage === 'bonding' ? curvePct : undefined,
    progressSource: stage === 'bonding' && curvePct !== undefined ? 'solanatracker' : undefined,
    migratedPool: address(migrated?.poolId),
  });
}

export function parsePulseToken(item: unknown, column: PulseColumn, fetchedAt: number): PulseToken | undefined {
  const info = rec(item);
  const token = rec(info?.token);
  const mint = address(token?.mint);
  if (!info || !token || !mint) return undefined;
  const poolList = pools(info);
  const primary = poolList[0];
  const curve = poolList.find(isCurvePool);
  const creation = rec(token.creation);
  const txns = rec(primary?.txns);
  const buys = count(txns?.buys);
  const sells = count(txns?.sells);
  const risk = defined(parseRiskFields(rec(info.risk), rec(primary?.security)));

  return defined<PulseToken>({
    mint,
    symbol: text(token.symbol),
    name: text(token.name),
    image: httpsUrl(token.image),
    uri: text(token.uri),
    creator: address(creation?.creator) ?? address(curve?.deployer),
    // created_time is SECONDS; pool createdAt is MILLISECONDS.
    createdAt: toMs(creation?.created_time) ?? toMs(curve?.createdAt ?? primary?.createdAt),
    detectedAt: fetchedAt,
    launchpad: launchStateOf(poolList, column),
    priceUsd: positive(rec(primary?.price)?.usd),
    marketCapUsd: positive(rec(primary?.marketCap)?.usd),
    marketCapSol: primary?.quoteToken === MINTS.SOL ? positive(rec(primary.marketCap)?.quote) : undefined,
    liquidityUsd: nonNegative(rec(primary?.liquidity)?.usd),
    volumeUsd: nonNegative(txns?.volume24h) ?? nonNegative(txns?.volume),
    txns: buys !== undefined || sells !== undefined ? defined({ buys, sells }) : undefined,
    holders: count(info.holders),
    socials: socialsOf(token),
    risk: Object.keys(risk).length ? risk : undefined,
    sources: ['solanatracker'],
    updatedAt: fetchedAt,
  });
}
