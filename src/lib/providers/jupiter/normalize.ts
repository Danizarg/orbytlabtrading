/**
 * Pure mappers from Jupiter payloads (Tokens V2, Price V3, Ultra v1, Swap
 * v1/v2) to ORBYT models. No network access; isomorphic.
 *
 * Jupiter OMITS fields it cannot supply (they are never null), so every
 * mapper tests for presence and leaves unknown fields out of the result.
 */

import { num, toMs } from '@/lib/core/chain';
import { normalizeLaunchpadName } from '@/lib/core/dex';
import type { ProviderId, QuoteRequest } from '@/lib/core/providers';
import { MINTS, PROGRAMS } from '@/lib/core/solana';
import type {
  LaunchpadState,
  Portfolio,
  RiskFlag,
  RiskReport,
  SearchHit,
  Socials,
  StatWindow,
  SwapQuote,
  TokenBalance,
  TokenMarket,
  TokenMeta,
  TokenRow,
  WindowStats,
} from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';

export const JUPITER_ID = 'jupiter' satisfies ProviderId;

/** Router labels required by the Jupiter API licence (clause 2.3). */
export const JUPITER_ROUTERS = { metis: 'Metis', ultra: 'Jupiter Ultra' } as const;

type Json = Record<string, unknown>;

const SOL_DECIMALS = 9;

// ---------------------------------------------------------------------------
// Primitive readers
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Non-negative finite number (counts, supplies). */
function nonNeg(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

function decimalsOf(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && Number.isInteger(n) && n >= 0 && n <= 255 ? n : undefined;
}

function urlWith(value: unknown, protocols: readonly string[]): string | undefined {
  const s = str(value);
  if (!s) return undefined;
  try {
    return protocols.includes(new URL(s).protocol) ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Logos are untrusted third-party content: only https URLs are passed on. */
function httpsUrl(value: unknown): string | undefined {
  return urlWith(value, ['https:']);
}

/** Social links must be web URLs (rejects javascript:, data:, bare handles). */
function webUrl(value: unknown): string | undefined {
  return urlWith(value, ['https:', 'http:']);
}

/** Copy without undefined-valued keys, so absent data is truly absent. */
function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) if (v !== undefined) out[key] = v;
  return out as T;
}

function isNonEmpty(value: object): boolean {
  return Object.keys(value).length > 0;
}

function malformed(what: string): ProviderError {
  return new ProviderError(JUPITER_ID, 'malformed', `jupiter ${what}: unexpected response`);
}

/** Top-level array guard for Tokens V2 / Ultra search payloads. */
export function expectArray(payload: unknown, what: string): unknown[] {
  if (!Array.isArray(payload)) throw malformed(what);
  return payload;
}

/** Top-level object guard (Price V3, holdings, quotes). */
export function expectObject(payload: unknown, what: string): Json {
  if (!isRecord(payload) || typeof payload.error === 'string') throw malformed(what);
  return payload;
}

/**
 * Raw base-unit amount (string of digits, or a safe integer) → decimal-adjusted
 * number. Done on the digit string to avoid float division error.
 */
export function rawToUi(raw: unknown, decimals: number): number | undefined {
  if (!Number.isInteger(decimals) || decimals < 0) return undefined;
  let digits: string;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) digits = raw.trim();
  else if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) digits = String(raw);
  else return undefined;
  if (decimals === 0) return Number(digits);
  const padded = digits.padStart(decimals + 1, '0');
  const cut = padded.length - decimals;
  const n = Number(`${padded.slice(0, cut)}.${padded.slice(cut)}`);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// Tokens V2 token object ("MintInformation")
// ---------------------------------------------------------------------------

export function tokenId(token: unknown): string | undefined {
  return isRecord(token) ? str(token.id) : undefined;
}

const STAT_KEYS: Record<StatWindow, string> = { m5: 'stats5m', h1: 'stats1h', h6: 'stats6h', h24: 'stats24h' };

/** One Jupiter stats window. Volumes are USD; priceChange is already 0–100 scale. */
export function mapWindowStats(raw: unknown): WindowStats | undefined {
  if (!isRecord(raw)) return undefined;
  const buyVolumeUsd = nonNeg(raw.buyVolume);
  const sellVolumeUsd = nonNeg(raw.sellVolume);
  const stats = compact<WindowStats>({
    buys: nonNeg(raw.numBuys),
    sells: nonNeg(raw.numSells),
    traders: nonNeg(raw.numTraders),
    // Only a sum of two known halves is a known total.
    volumeUsd: buyVolumeUsd !== undefined && sellVolumeUsd !== undefined ? buyVolumeUsd + sellVolumeUsd : undefined,
    buyVolumeUsd,
    sellVolumeUsd,
    priceChangePct: num(raw.priceChange),
  });
  return isNonEmpty(stats) ? stats : undefined;
}

export function mapStats(token: Json): Partial<Record<StatWindow, WindowStats>> {
  const out: Partial<Record<StatWindow, WindowStats>> = {};
  for (const [window, key] of Object.entries(STAT_KEYS) as Array<[StatWindow, string]>) {
    const stats = mapWindowStats(token[key]);
    if (stats) out[window] = stats;
  }
  return out;
}

/**
 * Launch stage from Tokens V2. Graduation is signalled only by the presence of
 * graduatedPool / graduatedAt; Tokens V2 has NO bonding-curve progress (only
 * the deprecated Ultra search does), so progressPct is never set here.
 */
export function deriveLaunchpad(token: Json): LaunchpadState {
  const launchpad = normalizeLaunchpadName(str(token.launchpad) ?? str(token.metaLaunchpad));
  const migratedPool = str(token.graduatedPool);
  const graduatedAt = toMs(token.graduatedAt);
  if (migratedPool !== undefined || graduatedAt !== undefined) {
    return compact<LaunchpadState>({ stage: 'graduated', launchpad, migratedPool, graduatedAt });
  }
  if (launchpad) return { stage: 'bonding', launchpad };
  return { stage: 'amm' };
}

function tokenProgramOf(value: unknown): TokenMeta['tokenProgram'] {
  if (value === PROGRAMS.TOKEN) return 'spl-token';
  if (value === PROGRAMS.TOKEN_2022) return 'token-2022';
  return undefined;
}

function mapSocials(token: Json): Socials {
  return compact<Socials>({
    website: webUrl(token.website),
    twitter: webUrl(token.twitter),
    telegram: webUrl(token.telegram),
    discord: webUrl(token.discord),
  });
}

function mapTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
}

/** isVerified is absent for unverified tokens; the 'verified' tag is equivalent. */
function verifiedOf(token: Json): boolean | undefined {
  const flag = bool(token.isVerified);
  if (flag !== undefined) return flag;
  return mapTags(token.tags)?.includes('verified') ? true : undefined;
}

/** First pool creation (real launch time). Top-level createdAt is Jupiter's index date for legacy tokens. */
function createdAtOf(token: Json): number | undefined {
  return isRecord(token.firstPool) ? toMs(token.firstPool.createdAt) : undefined;
}

export function mapTokenMeta(token: unknown): TokenMeta | undefined {
  if (!isRecord(token)) return undefined;
  const mint = str(token.id);
  if (!mint) return undefined;
  return compact<TokenMeta>({
    mint,
    symbol: str(token.symbol),
    name: str(token.name),
    image: httpsUrl(token.icon),
    decimals: decimalsOf(token.decimals),
    tokenProgram: tokenProgramOf(token.tokenProgram),
    socials: mapSocials(token),
    creator: str(token.dev),
    createdAt: createdAtOf(token),
    totalSupply: nonNeg(token.totalSupply),
    circulatingSupply: nonNeg(token.circSupply),
    verified: verifiedOf(token),
    tags: mapTags(token.tags),
    launchpad: deriveLaunchpad(token),
  });
}

/** USD market snapshot. usdPrice/mcap/fdv/liquidity are absent for tokens with no priced trade yet. */
export function mapTokenMarket(token: unknown, fetchedAt: number): TokenMarket | undefined {
  if (!isRecord(token)) return undefined;
  const mint = str(token.id);
  if (!mint) return undefined;
  const price = num(token.usdPrice);
  return compact<TokenMarket>({
    mint,
    priceUsd: price !== undefined && price > 0 ? price : undefined,
    marketCapUsd: nonNeg(token.mcap),
    fdvUsd: nonNeg(token.fdv),
    liquidityUsd: nonNeg(token.liquidity),
    holders: nonNeg(token.holderCount),
    stats: mapStats(token),
    updatedAt: fetchedAt,
    source: JUPITER_ID,
  });
}

/**
 * Tokens V2 exposes mintAuthority / freezeAuthority only while the authority is
 * still set, so their presence is a definite "not disabled".
 */
function authorityDisabled(authority: unknown, auditFlag: unknown): boolean | undefined {
  if (str(authority)) return false;
  return bool(auditFlag);
}

export type JupiterAuditRisk = Partial<Omit<RiskReport, 'mint' | 'flags' | 'sources' | 'updatedAt'>>;

/** Tokens V2 audit block (all fields conditional; percentages 0–100). */
export function mapAuditRisk(token: Json): JupiterAuditRisk {
  const audit = isRecord(token.audit) ? token.audit : {};
  return compact<JupiterAuditRisk>({
    top10Pct: nonNeg(audit.topHoldersPercentage),
    devHoldingPct: nonNeg(audit.devBalancePercentage),
    mintAuthorityDisabled: authorityDisabled(token.mintAuthority, audit.mintAuthorityDisabled),
    freezeAuthorityDisabled: authorityDisabled(token.freezeAuthority, audit.freezeAuthorityDisabled),
    devLaunches: nonNeg(audit.devMints),
    organicScore: nonNeg(token.organicScore),
  });
}

export function mapTokenRow(token: unknown, fetchedAt: number, rank?: number): TokenRow | undefined {
  const meta = mapTokenMeta(token);
  const market = mapTokenMarket(token, fetchedAt);
  if (!meta || !market || !isRecord(token)) return undefined;
  const risk = mapAuditRisk(token);
  return compact<TokenRow>({
    token: compact<TokenRow['token']>({
      mint: meta.mint,
      symbol: meta.symbol,
      name: meta.name,
      image: meta.image,
      decimals: meta.decimals,
      createdAt: meta.createdAt,
      socials: isNonEmpty(meta.socials) ? meta.socials : undefined,
      launchpad: meta.launchpad,
      verified: meta.verified,
      creator: meta.creator,
    }),
    market,
    risk: isNonEmpty(risk) ? risk : undefined,
    rank,
  });
}

export function mapSearchHit(token: unknown): SearchHit | undefined {
  if (!isRecord(token)) return undefined;
  const meta = mapTokenMeta(token);
  const market = mapTokenMarket(token, 0);
  if (!meta || !market) return undefined;
  return compact<SearchHit>({
    mint: meta.mint,
    symbol: meta.symbol,
    name: meta.name,
    image: meta.image,
    priceUsd: market.priceUsd,
    marketCapUsd: market.marketCapUsd,
    liquidityUsd: market.liquidityUsd,
    volume24hUsd: market.stats.h24?.volumeUsd,
    verified: meta.verified,
    launchpad: meta.launchpad,
    source: JUPITER_ID,
  });
}

/**
 * Canonical mints of SOL and major USD stablecoins. The Tokens V2 category
 * endpoints return them (SOL/USDC ranked #1/#2 on toporganicscore) despite the
 * docs saying they are filtered.
 */
const DISCOVER_EXCLUDED_MINTS: ReadonlySet<string> = new Set([
  MINTS.SOL,
  MINTS.USDC,
  MINTS.USDT,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', // USD1
]);

const STABLE_TAGS: ReadonlySet<string> = new Set(['stable', 'stablecoin']);

/** SOL/WSOL and stablecoins are not "discoveries". */
export function isDiscoverExcluded(token: Json): boolean {
  const mint = str(token.id);
  if (mint && DISCOVER_EXCLUDED_MINTS.has(mint)) return true;
  return mapTags(token.tags)?.some((tag) => STABLE_TAGS.has(tag.toLowerCase())) ?? false;
}

// ---------------------------------------------------------------------------
// Ultra v1 search extras (deprecated endpoint; optional enrichment)
// ---------------------------------------------------------------------------

export interface JupiterUltraRisk {
  snipersPct?: number;
  insidersPct?: number;
  /** audit.bundlerStats.holdingPct: share currently held by bundlers. */
  bundlersPct?: number;
  botHoldersPct?: number;
  top10Pct?: number;
  devHoldingPct?: number;
}

export interface JupiterUltraInfo {
  /** Bonding-curve progress 0–100 (100 = graduated); absent for non-launchpad tokens. */
  progressPct?: number;
  risk: JupiterUltraRisk;
}

export function mapUltraInfo(token: unknown): JupiterUltraInfo | undefined {
  if (!isRecord(token) || !str(token.id)) return undefined;
  const audit = isRecord(token.audit) ? token.audit : {};
  const bundlers = isRecord(audit.bundlerStats) ? audit.bundlerStats : {};
  const curve = num(token.bondingCurve);
  return compact<JupiterUltraInfo>({
    progressPct: curve !== undefined ? Math.min(100, Math.max(0, curve)) : undefined,
    risk: compact<JupiterUltraRisk>({
      snipersPct: nonNeg(audit.sniperPct),
      insidersPct: nonNeg(audit.insiderPct),
      bundlersPct: nonNeg(bundlers.holdingPct),
      botHoldersPct: nonNeg(audit.botHoldersPercentage),
      top10Pct: nonNeg(audit.topHoldersPercentage),
      devHoldingPct: nonNeg(audit.devBalancePercentage),
    }),
  });
}

// ---------------------------------------------------------------------------
// Risk report
// ---------------------------------------------------------------------------

function riskFlags(token: Json, risk: JupiterAuditRisk, verified: boolean | undefined): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const audit = isRecord(token.audit) ? token.audit : {};
  // audit.isSus is present only when Jupiter flags the token.
  if (audit.isSus === true) {
    flags.push({ level: 'danger', label: 'Flagged suspicious', detail: 'Jupiter audit marks this token as suspicious', source: JUPITER_ID });
  }
  if (risk.mintAuthorityDisabled === false) {
    flags.push({ level: 'warn', label: 'Mint authority active', detail: 'Supply can still be increased', source: JUPITER_ID });
  } else if (risk.mintAuthorityDisabled === true) {
    flags.push({ level: 'good', label: 'Mint authority revoked', source: JUPITER_ID });
  }
  if (risk.freezeAuthorityDisabled === false) {
    flags.push({ level: 'warn', label: 'Freeze authority active', detail: 'Token accounts can be frozen', source: JUPITER_ID });
  } else if (risk.freezeAuthorityDisabled === true) {
    flags.push({ level: 'good', label: 'Freeze authority revoked', source: JUPITER_ID });
  }
  if (verified === true) flags.push({ level: 'good', label: 'Verified on Jupiter', source: JUPITER_ID });
  return flags;
}

/** Tokens V2 audit, with Ultra extras filling fields Tokens V2 lacks. */
export function buildRiskReport(token: Json, fetchedAt: number, ultra?: JupiterUltraInfo): RiskReport {
  const mint = str(token.id);
  if (!mint) throw malformed('tokens/v2/search');
  const audit = mapAuditRisk(token);
  const extras = ultra?.risk ?? {};
  const merged: JupiterAuditRisk = { ...extras, ...audit };
  return compact<RiskReport>({
    mint,
    ...merged,
    flags: riskFlags(token, audit, verifiedOf(token)),
    sources: [JUPITER_ID],
    updatedAt: fetchedAt,
  });
}

// ---------------------------------------------------------------------------
// Price V3
// ---------------------------------------------------------------------------

/** Price V3 entry → USD price; undefined when Jupiter has no reliable price. */
export function priceOf(entry: unknown): number | undefined {
  if (!isRecord(entry)) return undefined;
  const price = num(entry.usdPrice);
  return price !== undefined && price > 0 ? price : undefined;
}

// ---------------------------------------------------------------------------
// Ultra v1 holdings (deprecated)
// ---------------------------------------------------------------------------

export interface ParsedHoldings {
  portfolio: Portfolio;
  /** Mints skipped because their decimals/amount could not be read. */
  skipped: number;
}

/**
 * Holdings: top level is native SOL (amount in lamports); tokens[mint] is an
 * ARRAY of token accounts (a wallet may hold several per mint). No prices.
 */
export function parseHoldings(address: string, payload: unknown, fetchedAt: number): ParsedHoldings {
  const root = expectObject(payload, 'ultra/v1/holdings');
  // uiAmount is SOL; amount is a lamports string (9 decimals).
  const sol = nonNeg(root.uiAmount) ?? rawToUi(root.amount, SOL_DECIMALS);
  if (sol === undefined || !isRecord(root.tokens)) throw malformed('ultra/v1/holdings');

  const tokens: TokenBalance[] = [];
  let skipped = 0;
  for (const [mint, value] of Object.entries(root.tokens)) {
    const accounts = Array.isArray(value) ? value : [value];
    let amount = 0;
    let decimals: number | undefined;
    let tokenProgram: TokenBalance['tokenProgram'];
    let unreadable = false;
    for (const account of accounts) {
      if (!isRecord(account)) {
        unreadable = true;
        continue;
      }
      const d = decimalsOf(account.decimals);
      decimals ??= d;
      tokenProgram ??= tokenProgramOf(account.programId);
      const ui = nonNeg(account.uiAmount) ?? (d !== undefined ? rawToUi(account.amount, d) : undefined);
      if (ui === undefined) unreadable = true;
      else amount += ui;
    }
    // A partially readable balance would understate the holding: skip it instead.
    if (decimals === undefined || unreadable) {
      skipped++;
      continue;
    }
    if (amount <= 0) continue;
    tokens.push(compact<TokenBalance>({ mint, amount, decimals, tokenProgram }));
  }

  return {
    portfolio: { address, sol, tokens, pricedCount: 0, unpricedCount: tokens.length, updatedAt: fetchedAt },
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Quotes (read-only)
// ---------------------------------------------------------------------------

function routeLabels(plan: unknown): string[] {
  if (!Array.isArray(plan)) return [];
  const labels: string[] = [];
  for (const step of plan) {
    const label = isRecord(step) && isRecord(step.swapInfo) ? str(step.swapInfo.label) : undefined;
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

function quoteAmounts(root: Json, request: QuoteRequest, what: string): { inAmount: number; outAmount: number } {
  const inputMint = str(root.inputMint);
  const outputMint = str(root.outputMint);
  if ((inputMint && inputMint !== request.inputMint) || (outputMint && outputMint !== request.outputMint)) throw malformed(what);
  const inAmount = rawToUi(root.inAmount, request.inputDecimals);
  const outAmount = rawToUi(root.outAmount, request.outputDecimals);
  if (inAmount === undefined || outAmount === undefined) throw malformed(what);
  return { inAmount, outAmount };
}

/**
 * GET /swap/v1/quote (Metis). priceImpactPct is a decimal RATIO string
 * ("0.00695" = 0.695 %), reported as a non-negative cost; swapUsdValue is the
 * USD value of the input (a string).
 *
 * ORBYT convention for SwapQuote.priceImpactPct from Jupiter: percent points,
 * positive = the output is worth less than the input (cost).
 */
export function parseMetisQuote(payload: unknown, request: QuoteRequest, slippageBps: number, fetchedAt: number): SwapQuote {
  const root = expectObject(payload, 'swap/v1/quote');
  const { inAmount, outAmount } = quoteAmounts(root, request, 'swap/v1/quote');
  const ratio = num(root.priceImpactPct);
  const platformFee = isRecord(root.platformFee) ? root.platformFee : {};
  return compact<SwapQuote>({
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inAmount,
    outAmount,
    inUsd: nonNeg(root.swapUsdValue),
    priceImpactPct: ratio !== undefined ? ratio * 100 : undefined,
    route: routeLabels(root.routePlan),
    router: JUPITER_ROUTERS.metis,
    slippageBps: nonNeg(root.slippageBps) ?? slippageBps,
    feeBps: nonNeg(platformFee.feeBps),
    fetchedAt,
  });
}

/**
 * GET /swap/v2/order without a taker (Jupiter Ultra quote). priceImpact is in
 * signed percent points computed from USD values (negative = output worth
 * less), so it is negated to the positive-cost convention above. The
 * deprecated priceImpactPct ratio is ignored. Without a taker (and without an
 * explicit slippageBps) Jupiter reports slippageBps 0 = not yet determined.
 */
export function parseUltraOrder(payload: unknown, request: QuoteRequest, explicitSlippageBps: number | undefined, fetchedAt: number): SwapQuote {
  const root = expectObject(payload, 'swap/v2/order');
  const { inAmount, outAmount } = quoteAmounts(root, request, 'swap/v2/order');
  const impact = num(root.priceImpact);
  const platformFee = isRecord(root.platformFee) ? root.platformFee : {};
  return compact<SwapQuote>({
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inAmount,
    outAmount,
    inUsd: nonNeg(root.inUsdValue),
    outUsd: nonNeg(root.outUsdValue),
    priceImpactPct: impact !== undefined ? (impact === 0 ? 0 : -impact) : undefined,
    route: routeLabels(root.routePlan),
    router: JUPITER_ROUTERS.ultra,
    slippageBps: explicitSlippageBps !== undefined ? (nonNeg(root.slippageBps) ?? explicitSlippageBps) : undefined,
    feeBps: nonNeg(root.feeBps) ?? nonNeg(platformFee.feeBps),
    fetchedAt,
  });
}
