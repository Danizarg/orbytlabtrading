/**
 * Normalized ORBYT data models.
 *
 * Every provider adapter maps its upstream payload into these shapes, and the
 * UI consumes only these shapes, so providers can be swapped without touching
 * components.
 *
 * Conventions (apply everywhere unless a field says otherwise):
 * - Timestamps are milliseconds since epoch. The one exception is
 *   `Candle.time`, which is UNIX SECONDS (chart library convention).
 * - Token and SOL amounts are decimal-adjusted numbers (UI units), never raw
 *   base units or lamports.
 * - Percentages are on a 0–100 scale (12.5 means 12.5%).
 * - USD values are plain numbers in dollars.
 * - Optional fields are OMITTED when a provider cannot supply them reliably.
 *   Never fill a gap with 0 or an invented value; the UI renders "—".
 */

import type { ProviderId } from './providers';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * How fresh a piece of data is, by construction:
 * - `stream`: pushed to the browser by a WebSocket as it happened
 * - `realtime`: read directly from chain state / an uncached source (≲5 s)
 * - `fast`: provider-side cache of roughly 5–15 s
 * - `indexed`: aggregator/indexer data with ~30–60 s+ cache (never label LIVE)
 */
export type Freshness = 'stream' | 'realtime' | 'fast' | 'indexed';

export interface Sourced<T> {
  data: T;
  /** Provider that produced `data` (the primary one when merged). */
  source: ProviderId;
  /** Additional providers that contributed fields. */
  contributors?: ProviderId[];
  /** When the data was fetched from the upstream (ms). */
  fetchedAt: number;
  freshness: Freshness;
  /** Caveats to surface in the UI. */
  notes?: string[];
}

export type StatWindow = 'm5' | 'h1' | 'h6' | 'h24';
export const STAT_WINDOWS: readonly StatWindow[] = ['m5', 'h1', 'h6', 'h24'];

export type Interval = '1s' | '5s' | '15s' | '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export const INTERVALS: readonly Interval[] = ['1s', '5s', '15s', '1m', '5m', '15m', '1h', '4h', '1d'];
export const INTERVAL_SECONDS: Record<Interval, number> = {
  '1s': 1,
  '5s': 5,
  '15s': 15,
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
};

export interface Socials {
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * Launch lifecycle:
 * - `bonding`: still on a launchpad bonding curve (pump.fun, LaunchLab, DBC…)
 * - `graduated`: completed a launchpad curve and migrated to an AMM
 * - `amm`: trades on an AMM with no known launchpad history
 * - `unknown`: not determinable from available data
 */
export type LaunchStage = 'bonding' | 'graduated' | 'amm' | 'unknown';

export interface LaunchpadState {
  stage: LaunchStage;
  /** Launchpad display id, e.g. 'pump.fun', 'letsbonk', 'meteora-dbc', 'bags'. */
  launchpad?: string;
  /** Bonding-curve progress 0–100. Only set when reliably known. */
  progressPct?: number;
  /** Who reported progressPct ('solana-rpc' = decoded on-chain, exact). */
  progressSource?: ProviderId;
  /** When the curve completed / token graduated (ms). */
  graduatedAt?: number;
  /** Destination AMM pool after migration. */
  migratedPool?: string;
}

export interface TokenIdentity {
  mint: string;
  symbol?: string;
  name?: string;
  /** https URL of the logo (untrusted third-party content). */
  image?: string;
  decimals?: number;
}

export interface TokenMeta extends TokenIdentity {
  tokenProgram?: 'spl-token' | 'token-2022';
  socials: Socials;
  description?: string;
  /** Creator / dev wallet. */
  creator?: string;
  /** Token (or first pool) creation time (ms). */
  createdAt?: number;
  totalSupply?: number;
  circulatingSupply?: number;
  /** Verified by the reporting provider (e.g. Jupiter verified list). */
  verified?: boolean;
  tags?: string[];
  launchpad?: LaunchpadState;
}

export interface WindowStats {
  buys?: number;
  sells?: number;
  buyers?: number;
  sellers?: number;
  traders?: number;
  volumeUsd?: number;
  buyVolumeUsd?: number;
  sellVolumeUsd?: number;
  priceChangePct?: number;
}

export interface TokenMarket {
  mint: string;
  priceUsd?: number;
  /** Price in SOL (or the pool's native quote when noted). */
  priceSol?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  liquidityUsd?: number;
  holders?: number;
  stats: Partial<Record<StatWindow, WindowStats>>;
  /** When the upstream data was fetched (ms). */
  updatedAt: number;
  source: ProviderId;
}

export interface PoolInfo {
  address: string;
  /** Normalized DEX id: 'pumpfun' | 'pumpswap' | 'raydium' | 'raydium-cpmm' | 'raydium-clmm' | 'launchlab' | 'meteora-dlmm' | 'meteora-damm' | 'meteora-dbc' | 'orca' | … */
  dex: string;
  /** Human label, e.g. 'PumpSwap', 'Raydium CPMM'. */
  dexLabel: string;
  baseMint: string;
  quoteMint?: string;
  quoteSymbol?: string;
  priceUsd?: number;
  /** Price in quote units. */
  priceNative?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  createdAt?: number;
  txns24h?: { buys: number; sells: number };
  /** True for launchpad bonding-curve "pools". */
  isBondingCurve?: boolean;
  url?: string;
  source: ProviderId;
}

export type RiskLevel = 'info' | 'good' | 'warn' | 'danger';

export interface RiskFlag {
  level: RiskLevel;
  label: string;
  detail?: string;
  source: ProviderId;
}

export interface RiskReport {
  mint: string;
  top10Pct?: number;
  devHoldingPct?: number;
  insidersPct?: number;
  snipersPct?: number;
  bundlersPct?: number;
  botHoldersPct?: number;
  mintAuthorityDisabled?: boolean;
  freezeAuthorityDisabled?: boolean;
  /** Number of tokens the creator has launched. */
  devLaunches?: number;
  /** Provider organic-activity score (0–100). */
  organicScore?: number;
  /** Provider quality score, labelled with its source in the UI. */
  providerScore?: { value: number; max: number; label: string };
  flags: RiskFlag[];
  sources: ProviderId[];
  updatedAt: number;
}

/** A Discover / watchlist row. */
export interface TokenRow {
  token: TokenIdentity & {
    createdAt?: number;
    socials?: Socials;
    launchpad?: LaunchpadState;
    verified?: boolean;
    creator?: string;
  };
  market: TokenMarket;
  /** Main pool (most liquid / primary). */
  pool?: Pick<PoolInfo, 'address' | 'dex' | 'dexLabel' | 'quoteSymbol'>;
  risk?: Partial<Omit<RiskReport, 'mint' | 'flags' | 'sources' | 'updatedAt'>>;
  rank?: number;
}

/** Full token page snapshot. */
export interface TokenOverview {
  meta: TokenMeta;
  market?: TokenMarket;
  pools: PoolInfo[];
  /** Pool used for chart/trades (most liquid active pool). */
  primaryPool?: PoolInfo;
  risk?: RiskReport;
}

export interface SearchHit {
  mint: string;
  symbol?: string;
  name?: string;
  image?: string;
  priceUsd?: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  verified?: boolean;
  launchpad?: LaunchpadState;
  source: ProviderId;
}

// ---------------------------------------------------------------------------
// Trades, candles, holders
// ---------------------------------------------------------------------------

export interface Trade {
  signature: string;
  /** Block time (ms). */
  timestamp: number;
  side: 'buy' | 'sell';
  wallet?: string;
  tokenAmount?: number;
  /** Amount of the quote asset exchanged. */
  quoteAmount?: number;
  quoteSymbol?: string;
  /** SOL exchanged when the quote is SOL/WSOL. */
  solAmount?: number;
  usdValue?: number;
  /** Execution price per token in USD. */
  priceUsd?: number;
  /** Market cap at execution, when reliably computable. */
  marketCapUsd?: number;
  pool?: string;
  dex?: string;
  source: ProviderId;
}

export interface Candle {
  /** Bucket start, UNIX SECONDS. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Volume in USD when known. */
  volume?: number;
}

export interface CandleSeries {
  interval: Interval;
  /** Ascending by time, unique times. */
  candles: Candle[];
  pool?: string;
  /** True when candles were aggregated by ORBYT from real trades. */
  derivedFromTrades?: boolean;
  /** For derived series: number of trades used and covered time range (ms). */
  derivation?: { trades: number; from: number; to: number };
  /** Older history can be requested with `before`. */
  hasMore?: boolean;
}

export interface HolderEntry {
  /** Wallet owning the token account(s). */
  owner: string;
  tokenAccount?: string;
  amount: number;
  pctOfSupply?: number;
  /** Known label: 'Bonding curve', 'Pool', 'Dev', … */
  label?: string;
  isProgramAccount?: boolean;
}

export interface HolderSnapshot {
  mint: string;
  totalHolders?: number;
  supply?: number;
  top: HolderEntry[];
  distribution?: { top10Pct?: number; top11to20Pct?: number; top21to40Pct?: number; restPct?: number };
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Launch scanner (Pulse)
// ---------------------------------------------------------------------------

export type PulseColumn = 'new' | 'final' | 'migrated';

export interface PulseToken {
  mint: string;
  symbol?: string;
  name?: string;
  image?: string;
  /** Off-chain metadata URI (from the create event). */
  uri?: string;
  creator?: string;
  /** On-chain creation / first-pool time (ms), when known. */
  createdAt?: number;
  /** When ORBYT first observed this token in this session (ms). */
  detectedAt: number;
  launchpad: LaunchpadState;
  priceUsd?: number;
  marketCapUsd?: number;
  marketCapSol?: number;
  liquidityUsd?: number;
  volumeUsd?: number;
  txns?: { buys?: number; sells?: number };
  holders?: number;
  /** SOL the creator spent in the create transaction. */
  devBuySol?: number;
  socials?: Socials;
  risk?: Partial<Omit<RiskReport, 'mint' | 'flags' | 'sources' | 'updatedAt'>>;
  sources: ProviderId[];
  updatedAt: number;
}

/** Decoded pump.fun BondingCurve account (exact, on-chain). */
export interface BondingCurveState {
  mint: string;
  curve: string;
  complete: boolean;
  /** 0–100, clamped. */
  progressPct: number;
  virtualTokenReserves: number;
  virtualQuoteReserves: number;
  realTokenReserves: number;
  realQuoteReserves: number;
  /** Quote mint; WSOL for SOL-paired curves. */
  quoteMint: string;
  quoteDecimals: number;
  /** Price per token in quote units (virtual reserves). */
  priceQuote?: number;
  /** Market cap in quote units using the mint's actual supply. */
  marketCapQuote?: number;
  isMayhemMode?: boolean;
  creator?: string;
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

export type ActivityKind = 'buy' | 'sell' | 'swap' | 'transfer_in' | 'transfer_out' | 'sol_in' | 'sol_out' | 'other';

export interface ActivityLeg {
  mint: string;
  symbol?: string;
  /** Signed decimal-adjusted change for the wallet. */
  delta: number;
}

export interface WalletActivity {
  signature: string;
  timestamp: number;
  wallet: string;
  kind: ActivityKind;
  /** Main non-SOL token involved. */
  tokenMint?: string;
  tokenSymbol?: string;
  /** Absolute token amount moved. */
  tokenAmount?: number;
  /** Absolute SOL (native + WSOL) change excluding the network fee. */
  solAmount?: number;
  usdValue?: number;
  /** All balance changes for the wallet in this tx (for auditing). */
  legs: ActivityLeg[];
  counterparty?: string;
  /** Program / venue label, e.g. 'pump.fun', 'PumpSwap', 'Jupiter'. */
  program?: string;
  /** Network fee paid by the wallet in SOL (0 if another signer paid). */
  feeSol?: number;
  success: boolean;
  source: ProviderId;
}

export interface WalletActivityPage {
  items: WalletActivity[];
  /** Pass as `before` to fetch older activity; undefined when history is exhausted. */
  nextCursor?: string;
  /** Signatures returned by the index for this page (including failed/unparsed). */
  scanned: number;
}

export interface TokenBalance {
  mint: string;
  amount: number;
  decimals: number;
  symbol?: string;
  name?: string;
  image?: string;
  priceUsd?: number;
  valueUsd?: number;
  tokenProgram?: 'spl-token' | 'token-2022';
}

export interface Portfolio {
  address: string;
  sol: number;
  solPriceUsd?: number;
  tokens: TokenBalance[];
  /** Sum of SOL + priced tokens. Unpriced tokens are excluded and counted separately. */
  totalUsd?: number;
  pricedCount: number;
  unpricedCount: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// PnL (deterministic, FIFO, SOL-denominated)
// ---------------------------------------------------------------------------

export interface PnlLot {
  signature: string;
  timestamp: number;
  amount: number;
  /** SOL paid for the lot; undefined when acquired without a SOL leg (transfer in). */
  costSol?: number;
}

export interface PnlTokenResult {
  mint: string;
  symbol?: string;
  buys: number;
  sells: number;
  boughtAmount: number;
  soldAmount: number;
  costSol: number;
  proceedsSol: number;
  /** Realized PnL over sells whose full cost basis is known. */
  realizedSol: number;
  remainingAmount: number;
  remainingCostSol?: number;
  currentPriceSol?: number;
  unrealizedSol?: number;
  firstTradeAt: number;
  lastTradeAt: number;
  /** Average holding time of sold units (seconds), FIFO matched. */
  avgHoldSeconds?: number;
  /** False when sells exceeded known acquisitions or tokens arrived without a SOL cost. */
  costBasisComplete: boolean;
  /** Signatures used, for auditing. */
  signatures: string[];
}

export interface PnlReport {
  wallet: string;
  method: 'FIFO';
  quote: 'SOL';
  window: { from?: number; to?: number; transactionsAnalyzed: number; swapsCounted: number; historyComplete: boolean };
  tokens: PnlTokenResult[];
  totals: {
    realizedSol: number;
    unrealizedSol?: number;
    volumeSol: number;
    trades: number;
    winners: number;
    losers: number;
    winRatePct?: number;
    avgHoldSeconds?: number;
  };
  solPriceUsd?: number;
  caveats: string[];
}

// ---------------------------------------------------------------------------
// Quotes (read-only)
// ---------------------------------------------------------------------------

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: number;
  outAmount: number;
  inUsd?: number;
  outUsd?: number;
  priceImpactPct?: number;
  /** DEX labels along the route. */
  route: string[];
  /** Routing product label required by the provider's terms, e.g. 'Jupiter Ultra' or 'Metis'. */
  router: string;
  slippageBps?: number;
  feeBps?: number;
  fetchedAt: number;
}

export interface SolPrice {
  priceUsd: number;
  change24hPct?: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// On-chain mint info
// ---------------------------------------------------------------------------

export interface MintInfo {
  mint: string;
  decimals: number;
  supply: number;
  tokenProgram: 'spl-token' | 'token-2022';
  /** null = authority revoked (disabled). */
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Token-2022 metadata extension, when present. */
  metadata?: { name?: string; symbol?: string; uri?: string };
  fetchedAt: number;
}
