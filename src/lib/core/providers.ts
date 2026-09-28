/**
 * Provider interfaces.
 *
 * ORBYT never binds the UI to one vendor. Each capability below has one or
 * more implementations (adapters) and the data layer composes them into
 * failover chains. An implementation may run:
 *  - in the browser, against keyless public APIs (each user's own IP quota), or
 *  - on the server (Next.js route handlers), for keyed providers and for
 *    endpoints browsers cannot reach (the public Solana RPC blocks browsers).
 *
 * All methods resolve to `Sourced<T>` so freshness and provenance travel with
 * the data, and reject with a ProviderError-like error on failure. None of them
 * may return fabricated values; unknown fields are omitted.
 */

import type {
  BondingCurveState,
  CandleSeries,
  HolderSnapshot,
  Interval,
  PoolInfo,
  Portfolio,
  PulseColumn,
  PulseToken,
  RiskReport,
  SearchHit,
  Sourced,
  SolPrice,
  SwapQuote,
  TokenMarket,
  TokenMeta,
  TokenRow,
  Trade,
  WalletActivity,
  WalletActivityPage,
} from './types';

export const PROVIDER_IDS = [
  'geckoterminal',
  'coingecko',
  'dexscreener',
  'jupiter',
  'pumpportal',
  'solana-rpc',
  'solana-ws',
  'helius',
  'birdeye',
  'solanatracker',
  'orbyt',
] as const;

/** `orbyt` = ORBYT's own server routes / derived computations. */
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  geckoterminal: 'GeckoTerminal',
  coingecko: 'CoinGecko',
  dexscreener: 'DEX Screener',
  jupiter: 'Jupiter',
  pumpportal: 'PumpPortal',
  'solana-rpc': 'Solana RPC',
  'solana-ws': 'Solana WebSocket',
  helius: 'Helius',
  birdeye: 'Birdeye',
  solanatracker: 'Solana Tracker',
  orbyt: 'ORBYT',
};

// ---------------------------------------------------------------------------
// Capability interfaces
// ---------------------------------------------------------------------------

export type DiscoverList = 'trending' | 'top' | 'organic' | 'new';
export type DiscoverWindow = '5m' | '1h' | '6h' | '24h';

export interface DiscoverQuery {
  list: DiscoverList;
  window: DiscoverWindow;
  limit?: number;
}

export interface TokenDiscoveryProvider {
  readonly id: ProviderId;
  discover(query: DiscoverQuery, signal?: AbortSignal): Promise<Sourced<TokenRow[]>>;
}

export interface TokenSearchProvider {
  readonly id: ProviderId;
  search(query: string, signal?: AbortSignal): Promise<Sourced<SearchHit[]>>;
}

export interface TokenMetadataProvider {
  readonly id: ProviderId;
  /** Batch metadata lookup; missing mints are simply absent from the record. */
  getMetadata(mints: string[], signal?: AbortSignal): Promise<Sourced<Record<string, TokenMeta>>>;
}

export interface MarketDataProvider {
  readonly id: ProviderId;
  /** Batch market snapshot; missing mints are absent (never zero-filled). */
  getMarkets(mints: string[], signal?: AbortSignal): Promise<Sourced<Record<string, TokenMarket>>>;
}

/** Token rows (metadata + market) for arbitrary mints, e.g. watchlist refresh. */
export interface TokenRowsProvider {
  readonly id: ProviderId;
  getRows(mints: string[], signal?: AbortSignal): Promise<Sourced<TokenRow[]>>;
}

export interface PriceProvider {
  readonly id: ProviderId;
  /** USD prices; mints the provider cannot price reliably are absent. */
  getPrices(mints: string[], signal?: AbortSignal): Promise<Sourced<Record<string, number>>>;
  getSolPrice?(signal?: AbortSignal): Promise<Sourced<SolPrice>>;
}

/** Pools / pairs for a token (liquidity, DEX, pair info). */
export interface LiquidityProvider {
  readonly id: ProviderId;
  getPools(mint: string, signal?: AbortSignal): Promise<Sourced<PoolInfo[]>>;
}

export interface TradesQuery {
  mint: string;
  /** Pool to read trades from; providers that aggregate across pools may ignore it. */
  pool?: string;
  limit?: number;
  /** Only trades strictly newer than this signature/time when supported. */
  since?: number;
}

export interface TransactionProvider {
  readonly id: ProviderId;
  getTrades(query: TradesQuery, signal?: AbortSignal): Promise<Sourced<Trade[]>>;
}

export interface CandlesQuery {
  mint: string;
  pool?: string;
  interval: Interval;
  /** Return candles strictly before this UNIX-second time (pagination). */
  before?: number;
  limit?: number;
}

export interface ChartDataProvider {
  readonly id: ProviderId;
  /** Intervals this provider can serve natively (no fabrication of unsupported ones). */
  readonly intervals: readonly Interval[];
  getCandles(query: CandlesQuery, signal?: AbortSignal): Promise<Sourced<CandleSeries>>;
}

export interface HolderProvider {
  readonly id: ProviderId;
  getHolders(mint: string, limit?: number, signal?: AbortSignal): Promise<Sourced<HolderSnapshot>>;
}

export interface TokenRiskProvider {
  readonly id: ProviderId;
  getRisk(mint: string, signal?: AbortSignal): Promise<Sourced<RiskReport>>;
}

/** Launchpad lists for Pulse backfill (streams provide real-time additions). */
export interface LaunchpadProvider {
  readonly id: ProviderId;
  getPulse(column: PulseColumn, signal?: AbortSignal): Promise<Sourced<PulseToken[]>>;
}

export interface BondingCurveProvider {
  readonly id: ProviderId;
  getCurves(mints: string[], signal?: AbortSignal): Promise<Sourced<Record<string, BondingCurveState>>>;
}

export interface WalletActivityProvider {
  readonly id: ProviderId;
  getActivity(address: string, opts: { before?: string; limit?: number }, signal?: AbortSignal): Promise<Sourced<WalletActivityPage>>;
  /** Parse a single transaction for a wallet (used by live subscriptions). */
  getTransaction?(signature: string, wallet: string, signal?: AbortSignal): Promise<Sourced<WalletActivity | null>>;
}

export interface PortfolioProvider {
  readonly id: ProviderId;
  getPortfolio(address: string, signal?: AbortSignal): Promise<Sourced<Portfolio>>;
}

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  /** Raw integer amount in the input mint's base units, as a string. */
  amountRaw: string;
  inputDecimals: number;
  outputDecimals: number;
  slippageBps?: number;
}

/**
 * Read-only quoting. ORBYT does not sign, send or custody anything; the UI
 * links out to the routing provider to execute.
 */
export interface TradingProvider {
  readonly id: ProviderId;
  getQuote(request: QuoteRequest, signal?: AbortSignal): Promise<Sourced<SwapQuote>>;
}
