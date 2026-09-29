import type { ProviderId } from './providers';
import type { Freshness } from './types';

/**
 * Envelope returned by every ORBYT API route. `meta.sources` makes provider
 * provenance and failures visible to the UI (freshness badges, degraded
 * states) instead of silently hiding them.
 */
export interface SourceStatus {
  provider: ProviderId;
  ok: boolean;
  /** What this source contributed, e.g. "market", "metadata", "trades". */
  role?: string;
  /** Short, user-safe error summary when ok=false. */
  error?: string;
  /** Served from cache after the upstream failed. */
  stale?: boolean;
  /** When the upstream data was fetched (ms epoch). */
  fetchedAt?: number;
}

export interface ApiMeta {
  /** When this response was assembled (ms epoch). */
  generatedAt: number;
  /** Oldest upstream fetch time contributing to the payload (ms epoch). */
  dataAsOf?: number;
  /** Provider that produced the primary data. */
  primary?: ProviderId;
  freshness?: Freshness;
  sources: SourceStatus[];
  /** True when any part of the payload is served stale after an upstream failure. */
  stale: boolean;
  /** Human-readable caveats (e.g. "holder list requires HELIUS_API_KEY"). */
  notes?: string[];
}

export interface ApiEnvelope<T> {
  data: T;
  meta: ApiMeta;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
  meta: ApiMeta;
}

/** ORBYT API routes (all GET, JSON, `ApiEnvelope<T>`). */
export const API_ROUTES = {
  /** Provider configuration + health. data: HealthReport */
  health: '/api/v1/health',
  /** ?mints=a,b (≤100) → Record<mint, BondingCurveState> (on-chain, exact) */
  curves: '/api/v1/onchain/curves',
  /** → MintInfo */
  mint: (mint: string) => `/api/v1/onchain/mint/${mint}`,
  /** ?mint=&pool=&limit= → Trade[] (keyed RPC/indexers) */
  trades: '/api/v1/trades',
  /** ?mint=&pool=&interval=&before=&limit= → CandleSeries (keyed providers, then keyless GeckoTerminal 1m–1d) */
  candles: '/api/v1/candles',
  /** ?mint= → PoolInfo[] (DEX Screener + GeckoTerminal merged; keyless, CDN-cached 60 s) */
  pools: '/api/v1/pools',
  /** ?mint=&limit= → HolderSnapshot */
  holders: '/api/v1/holders',
  /** ?mint= → RiskReport */
  risk: '/api/v1/risk',
  /** ?column=new|final|migrated → PulseToken[] (keyed launchpad lists) */
  pulse: '/api/v1/pulse',
  /** ?list=&window=&limit= → TokenRow[] (keyed discovery) */
  discover: '/api/v1/discover',
  /** ?mints=a,b → TokenRow[] (keyed batch rows, then keyless Jupiter + DEX Screener) */
  tokens: '/api/v1/tokens',
  /** ?inputMint=&outputMint=&amountRaw=&inputDecimals=&outputDecimals=&slippageBps= → SwapQuote */
  quote: '/api/v1/quote',
  /** → Portfolio (balances; prices when a server price source is configured) */
  portfolio: (address: string) => `/api/v1/wallet/${address}/portfolio`,
  /** ?before=&limit= → WalletActivityPage */
  activity: (address: string) => `/api/v1/wallet/${address}/activity`,
  /** ?wallet= → WalletActivity | null (immutable; long CDN cache) */
  tx: (signature: string) => `/api/v1/tx/${signature}`,
} as const;
