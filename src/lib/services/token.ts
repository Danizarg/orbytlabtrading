/**
 * Token page (/trade/[mint]) composition logic. Pure functions shared by the
 * trade data hooks and components, unit tested in token.test.ts.
 *
 * Nothing here invents a value: every derived number is a direct computation
 * from real inputs (price × supply, constant-product reserves, decimal
 * scaling) and is undefined when an input is missing.
 */

import { ChainError, fillMissing, type ChainAttempt } from '@/lib/core/chain';
import { PROVIDER_LABELS, type ProviderId, type QuoteRequest } from '@/lib/core/providers';
import { isSolanaAddress, MINTS, STABLE_MINTS } from '@/lib/core/solana';
import type {
  BondingCurveState,
  Candle,
  Freshness,
  Interval,
  LaunchpadState,
  LaunchStage,
  MintInfo,
  PoolInfo,
  RiskFlag,
  RiskLevel,
  RiskReport,
  Socials,
  SwapQuote,
  TokenMarket,
  TokenMeta,
  TokenRow,
  Trade,
} from '@/lib/core/types';
import { applyLiveTick, type LiveTick, type LiveTickOptions } from '@/lib/analytics/candles';
import { tradeUsdValue } from '@/lib/analytics/trades';
import { describeError } from '@/lib/net/errors';

const isPos = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

/**
 * Venues a launchpad curve migrates to. A curve pool next to one of these is
 * the frozen pre-migration pair (its price stopped at graduation).
 */
const MIGRATION_VENUES: Readonly<Record<string, readonly string[]>> = {
  pumpfun: ['pumpswap', 'raydium', 'raydium-cpmm'],
  launchlab: ['raydium-cpmm', 'raydium'],
  letsbonk: ['raydium-cpmm', 'raydium'],
  'meteora-dbc': ['meteora-damm-v2', 'meteora-damm'],
  bags: ['meteora-damm-v2', 'meteora-damm'],
};

export interface PoolContext {
  /** Launch stage reported by providers (Jupiter / GeckoTerminal). */
  stage?: LaunchStage;
  /** pump.fun curve `complete` flag decoded on-chain (authoritative when known). */
  curveComplete?: boolean;
  /** ?pool= selection from the Pools tab. */
  override?: string | null;
}

export interface PoolSelection {
  /** Pools where the token is the base asset (all pools when none are), most liquid first. */
  pools: PoolInfo[];
  /** Pool used for the chart and trades. */
  primary?: PoolInfo;
  /** Graduated bonding-curve pairs (price frozen at migration). */
  frozen: ReadonlySet<string>;
  /** True when `primary` is the ?pool= selection. */
  overridden: boolean;
}

/** Liquidity desc, then 24h volume desc; pools without a figure sort last. */
export function comparePoolsByLiquidity(a: PoolInfo, b: PoolInfo): number {
  const al = a.liquidityUsd ?? -1;
  const bl = b.liquidityUsd ?? -1;
  if (al !== bl) return bl - al;
  return (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1);
}

function isFrozenCurve(curve: PoolInfo, amms: readonly PoolInfo[], ctx: PoolContext): boolean {
  // The decoded pump.fun curve account is the ground truth.
  if (curve.dex === 'pumpfun' && ctx.curveComplete !== undefined) return ctx.curveComplete;
  if (ctx.stage === 'graduated') return true;
  // DEX Screener omits the price of a curve it has seen migrate.
  if (amms.length > 0 && curve.source === 'dexscreener' && curve.priceUsd === undefined) return true;
  if (ctx.stage === 'bonding') return false;
  const venues = MIGRATION_VENUES[curve.dex];
  return venues ? amms.some((p) => venues.includes(p.dex)) : false;
}

/** Addresses of bonding-curve pools whose price is frozen because the token graduated. */
export function frozenPools(pools: readonly PoolInfo[], ctx: PoolContext = {}): Set<string> {
  const amms = pools.filter((p) => !p.isBondingCurve);
  const frozen = new Set<string>();
  for (const pool of pools) {
    if (pool.isBondingCurve && isFrozenCurve(pool, amms, ctx)) frozen.add(pool.address);
  }
  return frozen;
}

/**
 * Pool that drives the chart and the trade feed:
 * - the ?pool= selection when it is a known, non-frozen pool;
 * - while the token is on its bonding curve, the curve itself;
 * - otherwise the most liquid active AMM pool (frozen curves excluded).
 * Pools where the token is only the quote asset are used only when no pool
 * lists it as the base.
 */
export function selectPrimaryPool(mint: string, pools: readonly PoolInfo[], ctx: PoolContext = {}): PoolSelection {
  const byAddress = new Map<string, PoolInfo>();
  for (const pool of pools) if (!byAddress.has(pool.address)) byAddress.set(pool.address, pool);
  const unique = [...byAddress.values()];
  const own = unique.filter((p) => p.baseMint === mint);
  const list = (own.length ? own : unique).sort(comparePoolsByLiquidity);
  const frozen = frozenPools(list, ctx);
  const active = list.filter((p) => !frozen.has(p.address));

  const override = ctx.override && isSolanaAddress(ctx.override) ? active.find((p) => p.address === ctx.override) : undefined;
  if (override) return { pools: list, primary: override, frozen, overridden: true };

  const bonding = ctx.curveComplete === false || (ctx.curveComplete === undefined && ctx.stage === 'bonding');
  const curve = bonding ? active.find((p) => p.isBondingCurve) : undefined;
  const primary = curve ?? active.find((p) => !p.isBondingCurve) ?? active[0];
  return { pools: list, primary, frozen, overridden: false };
}

// ---------------------------------------------------------------------------
// Overview merge
// ---------------------------------------------------------------------------

/**
 * Launch state from two providers. Graduation is one-way, so a 'graduated'
 * report wins over a stale 'bonding' one; an 'amm'/'unknown' primary defers to
 * a secondary that knows the launchpad.
 */
export function mergeLaunchpad(primary: LaunchpadState | undefined, secondary: LaunchpadState | undefined): LaunchpadState | undefined {
  if (!secondary || secondary.stage === 'unknown') return primary;
  if (!primary || primary.stage === 'amm' || primary.stage === 'unknown') {
    return secondary.stage === 'amm' ? (primary ?? secondary) : fillMissing(secondary, { launchpad: primary?.launchpad });
  }
  if (primary.stage === 'bonding' && secondary.stage === 'graduated') return fillMissing(secondary, { launchpad: primary.launchpad });
  if (primary.stage === secondary.stage) return fillMissing(primary, secondary);
  return primary;
}

/** On-chain pump.fun curve state overrides provider-reported stage and progress. */
export function applyCurve(launchpad: LaunchpadState | undefined, curve: BondingCurveState | undefined): LaunchpadState | undefined {
  if (!curve) return launchpad;
  return {
    ...launchpad,
    stage: curve.complete ? 'graduated' : 'bonding',
    launchpad: launchpad?.launchpad ?? 'pump.fun',
    progressPct: curve.complete ? 100 : curve.progressPct,
    progressSource: 'solana-rpc',
  };
}

export interface OverviewInput {
  mint: string;
  /** Row from the winning market provider (server proxy, Jupiter, GeckoTerminal or DEX Screener). */
  row?: TokenRow;
  /** GeckoTerminal token info metadata (socials, description, launchpad details). */
  info?: TokenMeta;
  /** GeckoTerminal holder count (token-level). */
  infoHolders?: number;
  /** On-chain mint account. */
  mintInfo?: MintInfo;
  /** Decoded pump.fun curve. */
  curve?: BondingCurveState;
}

export interface OverviewView {
  meta: TokenMeta;
  market?: TokenMarket;
  /** Current supply (UI units) from the on-chain mint account. */
  supply?: number;
}

/**
 * Merge precedence (each step only fills gaps, never overwrites):
 * 1. the market row's identity (Jupiter primary, or whichever provider answered);
 * 2. GeckoTerminal token info for socials (per field), description, creator, tags;
 * 3. the on-chain mint for decimals and token program (the chain wins for
 *    these), and Token-2022 metadata name/symbol as a last resort;
 * 4. the decoded curve for launch stage and progress.
 */
export function mergeOverview(input: OverviewInput): OverviewView {
  const { mint, row, info, mintInfo, curve } = input;
  const t = row?.token;
  let meta: TokenMeta = {
    mint,
    socials: fillMissing<Socials>({ ...(t?.socials ?? {}) }, info?.socials),
  };
  meta = fillMissing(meta, {
    symbol: t?.symbol,
    name: t?.name,
    image: t?.image,
    decimals: t?.decimals,
    creator: t?.creator,
    createdAt: t?.createdAt,
    verified: t?.verified,
  });
  meta = fillMissing(meta, {
    symbol: info?.symbol,
    name: info?.name,
    image: info?.image,
    description: info?.description,
    creator: info?.creator,
    createdAt: info?.createdAt,
    tags: info?.tags,
    totalSupply: info?.totalSupply,
    circulatingSupply: info?.circulatingSupply,
  });
  if (mintInfo) {
    meta = { ...meta, decimals: mintInfo.decimals, tokenProgram: mintInfo.tokenProgram };
    meta = fillMissing(meta, { symbol: mintInfo.metadata?.symbol, name: mintInfo.metadata?.name });
  }
  const launchpad = applyCurve(mergeLaunchpad(t?.launchpad, info?.launchpad), curve);
  if (launchpad) meta = { ...meta, launchpad };

  const market = row?.market ? fillMissing(row.market, { holders: input.infoHolders }) : undefined;
  const supply = mintInfo && Number.isFinite(mintInfo.supply) && mintInfo.supply > 0 ? mintInfo.supply : undefined;
  return { meta, ...(market ? { market } : {}), ...(supply !== undefined ? { supply } : {}) };
}

/** pump.fun candidates worth one on-chain curve read: pump.fun launchpad, a pump.fun pool or the vanity "pump" mint suffix. */
export function isPumpCandidate(mint: string, launchpad?: LaunchpadState, pools?: readonly PoolInfo[]): boolean {
  if (launchpad?.launchpad === 'pump.fun') return true;
  if (pools?.some((p) => p.dex === 'pumpfun')) return true;
  return mint.endsWith('pump');
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

const SEVERITY: Record<RiskLevel, number> = { danger: 3, warn: 2, info: 1, good: 0 };

/**
 * Merge risk reports in precedence order (first = most trusted): scalar
 * fields fill gaps only, flags are unioned by label (the most severe copy
 * wins), sources are unioned.
 */
export function mergeRiskReports(mint: string, reports: ReadonlyArray<RiskReport | undefined>): RiskReport | undefined {
  const list = reports.filter((r): r is RiskReport => r !== undefined);
  if (!list.length) return undefined;
  let merged: RiskReport = { mint, flags: [], sources: [], updatedAt: 0 };
  const flags = new Map<string, RiskFlag>();
  const sources: ProviderId[] = [];
  for (const report of list) {
    const { flags: reportFlags, sources: reportSources, updatedAt, mint: _mint, ...fields } = report;
    merged = fillMissing(merged, fields);
    merged.updatedAt = Math.max(merged.updatedAt, Number.isFinite(updatedAt) ? updatedAt : 0);
    for (const s of reportSources) if (!sources.includes(s)) sources.push(s);
    for (const flag of reportFlags) {
      const key = flag.label.trim().toLowerCase();
      const prev = flags.get(key);
      if (!prev || SEVERITY[flag.level] > SEVERITY[prev.level]) flags.set(key, flag);
    }
  }
  return { ...merged, sources, flags: [...flags.values()].sort((a, b) => SEVERITY[b.level] - SEVERITY[a.level]) };
}

/**
 * Mint / freeze authority from the on-chain mint account (authoritative):
 * a null authority is revoked.
 */
export function applyOnchainAuthorities(mint: string, risk: RiskReport | undefined, mintInfo: MintInfo | undefined): RiskReport | undefined {
  if (!mintInfo) return risk;
  const base: RiskReport = risk ?? { mint, flags: [], sources: [], updatedAt: mintInfo.fetchedAt };
  return {
    ...base,
    mintAuthorityDisabled: mintInfo.mintAuthority === null,
    freezeAuthorityDisabled: mintInfo.freezeAuthority === null,
    sources: base.sources.includes('solana-rpc') ? base.sources : [...base.sources, 'solana-rpc'],
  };
}

const AUTHORITY_FLAG = /\b(mint|freeze)\s+authority\b/i;

/** Flags for the audit list; authority flags are shown as dedicated rows (from chain when known). */
export function displayFlags(risk: RiskReport | undefined): RiskFlag[] {
  return (risk?.flags ?? []).filter((f) => !AUTHORITY_FLAG.test(f.label));
}

export type RiskMetricKey = 'top10' | 'dev' | 'snipers' | 'insiders' | 'bundlers' | 'bots';

/** Brief thresholds: top10 > 30 warn, > 50 danger; dev > 10 warn; snipers / insiders / bundlers / bots > 20 warn. */
export function riskTone(metric: RiskMetricKey, pct: number | undefined): 'ok' | 'warn' | 'danger' | 'unknown' {
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

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

/** Market cap at execution: the provider's figure, else execution price × current supply. */
export function marketCapAtTrade(trade: Trade, supply: number | undefined): number | undefined {
  if (isPos(trade.marketCapUsd)) return trade.marketCapUsd;
  if (isPos(trade.priceUsd) && isPos(supply)) return trade.priceUsd * supply;
  return undefined;
}

export type TradeSideFilter = 'all' | 'buy' | 'sell';

export interface TradeFilter {
  side: TradeSideFilter;
  /** Minimum USD value; trades without a USD value are hidden when > 0. */
  minUsd: number;
}

export function filterTrades(trades: readonly Trade[], filter: TradeFilter): Trade[] {
  const min = Number.isFinite(filter.minUsd) && filter.minUsd > 0 ? filter.minUsd : 0;
  if (filter.side === 'all' && min === 0) return trades as Trade[];
  return trades.filter((t) => {
    if (filter.side !== 'all' && t.side !== filter.side) return false;
    if (min === 0) return true;
    const usd = tradeUsdValue(t);
    return usd !== undefined && usd >= min;
  });
}

/** Parse a "min USD" text field; empty / invalid → 0 (no filter). */
export function parseMinUsd(value: string): number {
  const n = Number(value.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// Swap quotes
// ---------------------------------------------------------------------------

export const SOL_DECIMALS = 9;
export type QuoteSide = 'buy' | 'sell';

const AMOUNT_RE = /^\d*(?:\.\d*)?$/;

/**
 * Decimal UI amount (string) → raw integer base units (string), with exact
 * string arithmetic (no float rounding). Extra fraction digits beyond
 * `decimals` are truncated. Undefined for invalid, negative or zero amounts.
 */
export function toRawAmount(input: string, decimals: number): string | undefined {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) return undefined;
  const text = input.trim().replace(/,/g, '.');
  if (!text || text === '.' || text.length > 64 || !AMOUNT_RE.test(text)) return undefined;
  const [whole = '', frac = ''] = text.split('.');
  const raw = `${whole}${frac.padEnd(decimals, '0').slice(0, decimals)}`.replace(/^0+/, '');
  return raw.length ? raw : undefined;
}

/**
 * Quote request for the swap preview:
 * - buy: SOL → token, amountRaw = SOL × 10^9;
 * - sell: token → SOL, amountRaw = amount × 10^decimals.
 * Needs the token's decimals either way (the output or input side).
 */
export function buildQuoteRequest(input: {
  side: QuoteSide;
  mint: string;
  amount: string;
  tokenDecimals: number | undefined;
  slippageBps?: number;
}): QuoteRequest | undefined {
  const { side, mint, tokenDecimals } = input;
  if (tokenDecimals === undefined || !Number.isInteger(tokenDecimals) || mint === MINTS.SOL) return undefined;
  const inputDecimals = side === 'buy' ? SOL_DECIMALS : tokenDecimals;
  const amountRaw = toRawAmount(input.amount, inputDecimals);
  if (!amountRaw) return undefined;
  const request: QuoteRequest = {
    inputMint: side === 'buy' ? MINTS.SOL : mint,
    outputMint: side === 'buy' ? mint : MINTS.SOL,
    amountRaw,
    inputDecimals,
    outputDecimals: side === 'buy' ? tokenDecimals : SOL_DECIMALS,
  };
  if (input.slippageBps !== undefined) request.slippageBps = input.slippageBps;
  return request;
}

/**
 * A quote may stand in (dimmed) while a new amount is quoted only for the
 * same pair direction: a buy quote never stands in for a sell.
 */
export function quoteMatchesRequest(
  quote: Pick<SwapQuote, 'inputMint' | 'outputMint'> | undefined,
  request: Pick<QuoteRequest, 'inputMint' | 'outputMint'> | undefined,
): boolean {
  return !!quote && !!request && quote.inputMint === request.inputMint && quote.outputMint === request.outputMint;
}

/**
 * jup.ag swap link with the pair preselected. Verified in a browser on
 * 2026-09-29: `/swap?sell=<mint>&buy=<mint>` preloads both sides; an `amount`
 * parameter is ignored, and slippage / priority fee are set inside Jupiter.
 */
export function jupiterSwapUrl(mint: string, side: QuoteSide): string {
  const [sell, buy] = side === 'buy' ? [MINTS.SOL, mint] : [mint, MINTS.SOL];
  return `https://jup.ag/swap?sell=${sell}&buy=${buy}`;
}

/** Fallback token page on jup.ag. */
export function jupiterTokenUrl(mint: string): string {
  return `https://jup.ag/tokens/${mint}`;
}

// ---------------------------------------------------------------------------
// Trade panel (quotes are previews; execution happens on Jupiter)
// ---------------------------------------------------------------------------

export const SOL_PRESETS: readonly number[] = [0.1, 0.5, 1, 5];
export const SELL_PCT_PRESETS: readonly number[] = [25, 50, 75, 100];
export const SLIPPAGE_PRESETS_BPS: readonly number[] = [100, 500, 1_000, 2_000];
export const DEFAULT_SLIPPAGE_BPS = 1_000;
/** 0.01 % … 50 %. */
export const MIN_SLIPPAGE_BPS = 1;
export const MAX_SLIPPAGE_BPS = 5_000;

/** Keep an amount field numeric: digits and at most one decimal point (a comma counts as a point). */
export function sanitizeAmountInput(raw: string): string {
  let out = '';
  let dot = false;
  for (const ch of raw.replace(/,/g, '.')) {
    if (ch >= '0' && ch <= '9') out += ch;
    else if (ch === '.' && !dot) {
      out += ch;
      dot = true;
    }
  }
  return out.slice(0, 24);
}

/** Positive finite number from an amount field; undefined otherwise. */
export function parseAmount(input: string): number | undefined {
  const n = Number(input.trim().replace(/,/g, '.'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Slippage percent text ("0.5", "10") → basis points, clamped to 0.01–50 %; undefined when not a number. */
export function parseSlippagePct(input: string): number | undefined {
  const pct = Number(input.trim().replace(/[%\s]/g, '').replace(/,/g, '.'));
  if (!Number.isFinite(pct) || pct <= 0) return undefined;
  return Math.min(MAX_SLIPPAGE_BPS, Math.max(MIN_SLIPPAGE_BPS, Math.round(pct * 100)));
}

export function formatSlippage(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(pct < 1 ? 2 : 1).replace(/0$/, '')}%`;
}

/** SOL per token implied by a quote (buy: SOL in / tokens out; sell: SOL out / tokens in). */
export function quoteRate(quote: Pick<SwapQuote, 'inAmount' | 'outAmount'>, side: QuoteSide): number | undefined {
  const sol = side === 'buy' ? quote.inAmount : quote.outAmount;
  const tokens = side === 'buy' ? quote.outAmount : quote.inAmount;
  if (!isPos(sol) || !isPos(tokens)) return undefined;
  const rate = sol / tokens;
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

/** Price impact severity: > 5 % warn, > 15 % danger. */
export function priceImpactTone(pct: number | undefined): 'ok' | 'warn' | 'danger' | 'unknown' {
  if (pct === undefined || !Number.isFinite(pct)) return 'unknown';
  const abs = Math.abs(pct);
  return abs > 15 ? 'danger' : abs > 5 ? 'warn' : 'ok';
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** /trade/[mint], optionally pinned to a pool (Pools tab selection). */
export function tokenTradeHref(mint: string, pool?: string): string {
  return pool && isSolanaAddress(pool) ? `/trade/${mint}?pool=${pool}` : `/trade/${mint}`;
}

export interface ExplorerLink {
  id: 'solscan' | 'geckoterminal' | 'dexscreener' | 'jupiter' | 'pumpfun';
  label: string;
  href: string;
}

/** External pages for a token; the launchpad link only for pump.fun tokens. */
export function explorerLinks(mint: string, opts: { pool?: string; launchpad?: string } = {}): ExplorerLink[] {
  const links: ExplorerLink[] = [
    { id: 'solscan', label: 'Solscan', href: `https://solscan.io/token/${mint}` },
    {
      id: 'geckoterminal',
      label: 'GeckoTerminal',
      href: opts.pool && isSolanaAddress(opts.pool) ? `https://www.geckoterminal.com/solana/pools/${opts.pool}` : `https://www.geckoterminal.com/solana/tokens/${mint}`,
    },
    { id: 'dexscreener', label: 'DEX Screener', href: `https://dexscreener.com/solana/${mint}` },
    { id: 'jupiter', label: 'Jupiter', href: jupiterTokenUrl(mint) },
  ];
  if (opts.launchpad?.toLowerCase().includes('pump')) links.push({ id: 'pumpfun', label: 'pump.fun', href: `https://pump.fun/coin/${mint}` });
  return links;
}

/** Only http(s) URLs from token metadata are rendered as links. */
export function safeHttpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Bonding curve
// ---------------------------------------------------------------------------

const QUOTE_SYMBOLS: Readonly<Record<string, string>> = {
  [MINTS.SOL]: 'SOL',
  [MINTS.USDC]: 'USDC',
  [MINTS.USDT]: 'USDT',
};

export function curveQuoteSymbol(curve: Pick<BondingCurveState, 'quoteMint'>): string | undefined {
  return QUOTE_SYMBOLS[curve.quoteMint];
}

/**
 * Quote needed to buy out the curve's remaining real tokens, before fees.
 * Constant product on virtual reserves: k = vQ · vT; after buying realT
 * tokens the token reserve is vT − realT, so quote in = k / (vT − realT) − vQ.
 * Undefined for a complete / zeroed curve or inconsistent reserves.
 */
export function quoteToGraduation(curve: BondingCurveState): number | undefined {
  if (curve.complete) return undefined;
  const vQ = curve.virtualQuoteReserves;
  const vT = curve.virtualTokenReserves;
  const realT = curve.realTokenReserves;
  if (!isPos(vQ) || !isPos(vT) || !Number.isFinite(realT) || realT < 0 || vT <= realT) return undefined;
  const need = (vQ * vT) / (vT - realT) - vQ;
  return Number.isFinite(need) && need >= 0 ? need : undefined;
}

/** USD value of one unit of the curve's quote asset (SOL via the SOL price; stablecoins 1). */
export function curveQuoteUsd(curve: Pick<BondingCurveState, 'quoteMint'>, solUsd: number | undefined): number | undefined {
  if (curve.quoteMint === MINTS.SOL) return isPos(solUsd) ? solUsd : undefined;
  if (curve.quoteMint === MINTS.USDC || curve.quoteMint === MINTS.USDT) return 1;
  return undefined;
}

export function curvePriceUsd(curve: BondingCurveState, solUsd: number | undefined): number | undefined {
  const unit = curveQuoteUsd(curve, solUsd);
  return unit !== undefined && isPos(curve.priceQuote) ? curve.priceQuote * unit : undefined;
}

export function curveMarketCapUsd(curve: BondingCurveState, solUsd: number | undefined): number | undefined {
  const unit = curveQuoteUsd(curve, solUsd);
  return unit !== undefined && isPos(curve.marketCapQuote) ? curve.marketCapQuote * unit : undefined;
}

/**
 * Listed by an aggregator (DEX Screener / GeckoTerminal / keyed provider).
 * A curve decoded on-chain but not yet indexed has no OHLCV or trade history
 * upstream, so GeckoTerminal is not asked for it (it would only 404 and spend
 * the 8 calls/min budget).
 */
export function isIndexedPool(pool: Pick<PoolInfo, 'source'> | undefined): boolean {
  return pool !== undefined && pool.source !== 'solana-rpc';
}

/**
 * The pump.fun curve account as a pool for tokens no aggregator has indexed
 * yet (the curve IS the venue; DEX Screener and GeckoTerminal use the same
 * address once they list it). Every figure is decoded on-chain: liquidity is
 * the quote actually deposited in the curve (real reserves).
 */
export function poolFromCurve(curve: BondingCurveState, solUsd: number | undefined): PoolInfo {
  const pool: PoolInfo = {
    address: curve.curve,
    dex: 'pumpfun',
    dexLabel: 'Pump.fun',
    baseMint: curve.mint,
    quoteMint: curve.quoteMint,
    isBondingCurve: true,
    source: 'solana-rpc',
  };
  const quoteSymbol = curveQuoteSymbol(curve);
  if (quoteSymbol) pool.quoteSymbol = quoteSymbol;
  if (isPos(curve.priceQuote)) pool.priceNative = curve.priceQuote;
  const priceUsd = curvePriceUsd(curve, solUsd);
  if (priceUsd !== undefined) pool.priceUsd = priceUsd;
  const marketCapUsd = curveMarketCapUsd(curve, solUsd);
  if (marketCapUsd !== undefined) pool.marketCapUsd = marketCapUsd;
  const unit = curveQuoteUsd(curve, solUsd);
  if (unit !== undefined && isPos(curve.realQuoteReserves)) pool.liquidityUsd = curve.realQuoteReserves * unit;
  return pool;
}

// ---------------------------------------------------------------------------
// Chart intervals
// ---------------------------------------------------------------------------

export const SECOND_INTERVALS: readonly Interval[] = ['1s', '5s', '15s'];
export const MINUTE_INTERVALS: readonly Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
export const INTERVAL_LABELS: Record<Interval, string> = {
  '1s': '1s',
  '5s': '5s',
  '15s': '15s',
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1D',
};

/** Where an interval's candles come from: a keyed server source, GeckoTerminal, or ORBYT aggregation of real trades. */
export type CandleSourceKind = 'server' | 'gecko' | 'trades';

export interface IntervalOption {
  interval: Interval;
  kind?: CandleSourceKind;
  available: boolean;
  /** Tooltip text. */
  reason: string;
}

export function intervalOptions(input: {
  serverCandles: boolean;
  serverSecondIntervals: readonly Interval[];
  geckoIntervals: readonly Interval[];
  /** false once pools are known to be empty; undefined while loading. */
  hasPool?: boolean;
  /** A trade feed exists to aggregate from. */
  hasTradeFeed: boolean;
}): IntervalOption[] {
  const server = new Set<Interval>(input.serverCandles ? [...MINUTE_INTERVALS, ...input.serverSecondIntervals] : []);
  return [...SECOND_INTERVALS, ...MINUTE_INTERVALS].map((interval) => {
    if (server.has(interval)) return { interval, kind: 'server', available: true, reason: 'Native candles from a keyed provider (ORBYT API)' };
    if (input.geckoIntervals.includes(interval)) {
      return input.hasPool === false
        ? { interval, available: false, reason: 'No indexed pool to chart yet' }
        : { interval, kind: 'gecko', available: true, reason: 'GeckoTerminal OHLCV' };
    }
    if (SECOND_INTERVALS.includes(interval)) {
      return input.hasTradeFeed
        ? { interval, kind: 'trades', available: true, reason: `No native ${interval} source; built by ORBYT from real trades` }
        : { interval, available: false, reason: `${interval} candles need a trade feed for this token` };
    }
    return { interval, available: false, reason: `${interval} candles are not available` };
  });
}

// ---------------------------------------------------------------------------
// Chart currency (USD / SOL)
// ---------------------------------------------------------------------------

export type ChartCurrency = 'usd' | 'sol';

/** The pool is quoted in SOL (WSOL), so SOL-denominated candles are native to it. */
export function isSolQuoted(pool: Pick<PoolInfo, 'quoteMint' | 'quoteSymbol'> | undefined): boolean {
  if (!pool) return false;
  if (pool.quoteMint) return pool.quoteMint === MINTS.SOL;
  const symbol = pool.quoteSymbol?.toUpperCase();
  return symbol === 'SOL' || symbol === 'WSOL';
}

/**
 * The pool's quote asset when trades on it need that asset's own USD price to
 * be valued: neither SOL (SOL/USD) nor a USD stablecoin (e.g. a StonkFun pool
 * quoted in GLDx).
 */
export function otherQuoteMint(pool: Pick<PoolInfo, 'quoteMint'> | undefined): string | undefined {
  const mint = pool?.quoteMint;
  return mint && mint !== MINTS.SOL && !STABLE_MINTS.has(mint) ? mint : undefined;
}

/**
 * USD price of a pool's quote asset implied by the pool's own prices (one
 * provider snapshot): USD per token / quote per token.
 */
export function impliedQuoteUsd(pool: Pick<PoolInfo, 'priceUsd' | 'priceNative'> | undefined): number | undefined {
  if (!pool || !isPos(pool.priceUsd) || !isPos(pool.priceNative)) return undefined;
  const price = pool.priceUsd / pool.priceNative;
  return isPos(price) ? price : undefined;
}

export interface CurrencyOption {
  available: boolean;
  /** Tooltip text. */
  reason: string;
}

/**
 * Whether the chart can show SOL candles for the active source. SOL prices
 * are never converted from USD bars with today's SOL price (that would
 * misstate history): they come from GeckoTerminal's quote-token OHLCV of the
 * SOL pool, or from each trade's own SOL and token amounts.
 */
export function chartCurrencyOption(input: {
  quoteIsSol: boolean;
  kind: CandleSourceKind | undefined;
  interval: Interval;
  geckoIntervals: readonly Interval[];
}): CurrencyOption {
  if (!input.quoteIsSol) return { available: false, reason: 'The charted pool is not quoted in SOL' };
  if (input.kind === 'trades') return { available: true, reason: 'Price per token in SOL from each trade’s SOL and token amounts' };
  if ((input.kind === 'gecko' || input.kind === 'server') && input.geckoIntervals.includes(input.interval)) {
    return { available: true, reason: 'GeckoTerminal OHLCV in the pool’s quote token (SOL)' };
  }
  return { available: false, reason: `SOL candles are not available for ${INTERVAL_LABELS[input.interval]}` };
}

/**
 * Trades re-priced in SOL for SOL charts: price = SOL exchanged / tokens
 * exchanged (exact per trade). `usdValue` carries the SOL amount so that
 * aggregated volume is in SOL, like GeckoTerminal's quote-token OHLCV. Trades
 * without both legs are dropped rather than estimated.
 */
export function solPricedTrades(trades: readonly Trade[]): Trade[] {
  const out: Trade[] = [];
  for (const t of trades) {
    if (!isPos(t.solAmount) || !isPos(t.tokenAmount)) continue;
    const price = t.solAmount / t.tokenAmount;
    if (!Number.isFinite(price) || price <= 0) continue;
    // Market cap is a USD figure; it has no meaning on a SOL-priced copy.
    const { marketCapUsd: _mc, ...rest } = t;
    out.push({ ...rest, priceUsd: price, usdValue: t.solAmount });
  }
  return out;
}

/** GeckoTerminal OHLCV parameters for the keyless intervals. */
export const GECKO_OHLCV: Partial<Record<Interval, { timeframe: 'minute' | 'hour' | 'day'; aggregate: number }>> = {
  '1m': { timeframe: 'minute', aggregate: 1 },
  '5m': { timeframe: 'minute', aggregate: 5 },
  '15m': { timeframe: 'minute', aggregate: 15 },
  '1h': { timeframe: 'hour', aggregate: 1 },
  '4h': { timeframe: 'hour', aggregate: 4 },
  '1d': { timeframe: 'day', aggregate: 1 },
};

/**
 * Pool OHLCV path priced in the pool's quote token for `mint`. Verified live
 * on 2026-09-29 (Bonk/SOL): `currency=token&token=<mint>` returns OHLC in SOL
 * per token and volume in SOL (volume × SOL/USD matched the USD series).
 */
export function geckoQuoteOhlcvPath(input: { pool: string; mint: string; interval: Interval; limit: number; before?: number }): string | undefined {
  const params = GECKO_OHLCV[input.interval];
  if (!params || !isSolanaAddress(input.pool) || !isSolanaAddress(input.mint)) return undefined;
  const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit)));
  let path = `/networks/solana/pools/${input.pool}/ohlcv/${params.timeframe}?aggregate=${params.aggregate}&limit=${limit}&currency=token&token=${input.mint}`;
  if (input.before !== undefined && Number.isFinite(input.before) && input.before > 0) path += `&before_timestamp=${Math.floor(input.before)}`;
  return path;
}

/** A current USD price observation expressed in SOL with the current SOL/USD price (both live). */
export function usdToSol(priceUsd: number | undefined, solUsd: number | undefined): number | undefined {
  if (!isPos(priceUsd) || !isPos(solUsd)) return undefined;
  const v = priceUsd / solUsd;
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Apply real price observations / trades to candles (ticks older than the last bar are ignored). */
export function applyTicks(candles: Candle[], ticks: readonly LiveTick[], intervalSec: number, opts?: LiveTickOptions): Candle[] {
  let out = candles;
  for (const tick of ticks) out = applyLiveTick(out, tick, intervalSec, opts).candles;
  return out;
}

/**
 * Live ticks from a real-time trade feed for a series whose last bar starts at
 * `lastBarSec`: trades in or after that bucket, oldest first. Volume is only
 * added for trades newer than the series snapshot (`volumeAfterMs`) so trades
 * the provider already counted are not added twice.
 */
export function tradeTicks(trades: readonly Trade[], lastBarSec: number, volumeAfterMs: number): LiveTick[] {
  const ticks: Array<LiveTick & { ts: number; sig: string }> = [];
  for (const t of trades) {
    if (!isPos(t.priceUsd) || !Number.isFinite(t.timestamp)) continue;
    const timeSec = Math.floor(t.timestamp / 1000);
    if (timeSec < lastBarSec) continue;
    const usd = t.timestamp > volumeAfterMs ? tradeUsdValue(t) : undefined;
    ticks.push({ timeSec, price: t.priceUsd, ...(usd !== undefined ? { volumeUsd: usd } : {}), ts: t.timestamp, sig: t.signature });
  }
  ticks.sort((a, b) => a.ts - b.ts || (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0));
  return ticks.map(({ timeSec, price, volumeUsd }) => (volumeUsd !== undefined ? { timeSec, price, volumeUsd } : { timeSec, price }));
}

// ---------------------------------------------------------------------------
// Errors and provenance
// ---------------------------------------------------------------------------

export function providerLabel(provider: ProviderId | undefined): string {
  if (!provider) return '—';
  return provider === 'orbyt' ? 'ORBYT API' : PROVIDER_LABELS[provider];
}

/** Provider whose chain step answered ('orbyt' when the server route did). */
export function chainWinner(result: { attempts: readonly ChainAttempt[] } | undefined): ProviderId | undefined {
  return result?.attempts.find((a) => a.ok)?.provider;
}

/**
 * Poll cadence by the chain step that answered: ORBYT's keyed server route or
 * Jupiter at the fast cadence; browser-indexed sources (GeckoTerminal, DEX
 * Screener) at their cache age; and nothing faster while no source lists the
 * data (an unlisted token would otherwise walk the whole chain, GeckoTerminal
 * included, every few seconds).
 *
 * Use the chain winner (`chainWinner`), not `Sourced.source`: a server-proxy
 * result carries the upstream provider (e.g. 'helius') as its source.
 */
export function pollForWinner(winner: ProviderId | undefined, fast: number, indexed: number): number {
  return winner === 'orbyt' || winner === 'jupiter' ? fast : indexed;
}

/** LIVE is reserved for stream-fed or on-chain realtime data; polled REST ('fast') and indexed data show their age. */
export function isLiveFreshness(freshness: Freshness | undefined): boolean {
  return freshness === 'stream' || freshness === 'realtime';
}

/** Failed attempts worth showing (a 501 "not configured" server route is skipped silently). */
export function visibleFailures(attempts: readonly ChainAttempt[] | undefined): ChainAttempt[] {
  return (attempts ?? []).filter((a) => !a.ok && a.code !== 'not_configured');
}

/** "Jupiter: rate limited" (error strings start with the provider id). */
export function describeAttempt(attempt: ChainAttempt): string {
  const detail = attempt.code === 'empty' ? 'no data' : (attempt.error ?? 'failed').replace(/^[a-z][a-z-]*:\s*/i, '');
  return `${providerLabel(attempt.provider)}: ${detail}`;
}

/**
 * Every source answered "not found": a definitive absence. Timeouts, rate
 * limits and network errors are not, so they never turn into "not listed" /
 * "not a token mint" claims.
 */
export function isDefinitelyAbsent(error: unknown): boolean {
  return error instanceof ChainError && error.allNotFound;
}

/** User-facing lines for a failed load, one per provider tried. */
export function errorLines(error: unknown): string[] {
  if (error instanceof ChainError) {
    const lines = visibleFailures(error.attempts).map(describeAttempt);
    if (lines.length) return lines;
    if (error.allNotConfigured) return ['No configured source for this data'];
  }
  return [describeError(error)];
}

const GECKO_IDS: ReadonlySet<ProviderId> = new Set<ProviderId>(['geckoterminal', 'coingecko']);

export function isGecko(provider: ProviderId | undefined): boolean {
  return provider !== undefined && GECKO_IDS.has(provider);
}

/** Validated ?pool= search param. */
export function parsePoolParam(value: string | string[] | null | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  const t = v?.trim();
  return t && isSolanaAddress(t) ? t : undefined;
}
