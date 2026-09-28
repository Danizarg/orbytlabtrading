import { apiGet, ApiError, type QueryParams } from '@/client/api';
import { API_ROUTES, type ApiEnvelope } from '@/lib/core/api';
import { PUBLIC_ENDPOINTS, type Capabilities, type ConfiguredProviders } from '@/lib/config/capabilities';
import type {
  BondingCurveProvider,
  ChartDataProvider,
  HolderProvider,
  LaunchpadProvider,
  PortfolioProvider,
  TokenDiscoveryProvider,
  TokenRiskProvider,
  TokenRowsProvider,
  TradingProvider,
  TransactionProvider,
  WalletActivityProvider,
} from '@/lib/core/providers';
import {
  INTERVALS,
  type BondingCurveState,
  type CandleSeries,
  type HolderSnapshot,
  type MintInfo,
  type Portfolio,
  type PulseToken,
  type RiskReport,
  type Sourced,
  type SwapQuote,
  type TokenRow,
  type Trade,
  type WalletActivity,
  type WalletActivityPage,
} from '@/lib/core/types';
import { browserFetcher } from '@/lib/net/browser';
import { ProviderError, type ProviderErrorCode } from '@/lib/net/errors';
import { createDexScreener } from '@/lib/providers/dexscreener';
import { createGeckoTerminal } from '@/lib/providers/geckoterminal';
import { createJupiter } from '@/lib/providers/jupiter';
import { createPumpCurveProvider, createRpcClient } from '@/lib/providers/solana';

/**
 * Data sources available to client components.
 *
 * 1. Keyless public APIs called directly from the browser (each visitor spends
 *    their own per-IP quota; the browser transport enforces budgets).
 * 2. Server proxies: the same provider interfaces implemented over ORBYT's
 *    /api/v1 routes, which hold API keys and reach endpoints browsers cannot
 *    (the public Solana RPC rejects browser origins). A route with no keyed
 *    provider configured answers 501 → ProviderError('not_configured'), which
 *    runChain records and skips.
 */

// ---------------------------------------------------------------------------
// Keyless browser adapters
// ---------------------------------------------------------------------------

export const gecko = createGeckoTerminal({ fetcher: browserFetcher });
export const dex = createDexScreener({ fetcher: browserFetcher });
export const jup = createJupiter({ fetcher: browserFetcher });

/** publicnode JSON-RPC (browser-allowed) for light on-chain reads such as bonding curves. */
export const browserRpc = createRpcClient({
  url: PUBLIC_ENDPOINTS.solanaRpc,
  fetcher: browserFetcher,
  provider: 'solana-rpc',
  label: 'browser-rpc',
});
export const browserCurves: BondingCurveProvider = createPumpCurveProvider({ rpc: browserRpc });

// ---------------------------------------------------------------------------
// Server proxies
// ---------------------------------------------------------------------------

function codeForStatus(status: number): ProviderErrorCode {
  if (status === 501) return 'not_configured';
  if (status === 404) return 'not_found';
  if (status === 429 || status === 503) return 'rate_limited';
  if (status === 400) return 'unsupported';
  if (status === 0) return 'network';
  return 'http';
}

export function fromEnvelope<T>(envelope: ApiEnvelope<T>): Sourced<T> {
  const { meta } = envelope;
  const contributors = meta.sources.filter((s) => s.ok && s.provider !== meta.primary).map((s) => s.provider);
  return {
    data: envelope.data,
    source: meta.primary ?? 'orbyt',
    ...(contributors.length ? { contributors } : {}),
    fetchedAt: meta.dataAsOf ?? meta.generatedAt,
    freshness: meta.freshness ?? 'fast',
    ...(meta.notes?.length ? { notes: meta.notes } : {}),
  };
}

/** GET an ORBYT route and convert it to Sourced<T>; failures become ProviderError('orbyt', …). */
export async function proxy<T>(path: string, params?: QueryParams, signal?: AbortSignal): Promise<Sourced<T>> {
  try {
    return fromEnvelope(await apiGet<T>(path, params, { signal }));
  } catch (e) {
    if (e instanceof ApiError) throw new ProviderError('orbyt', codeForStatus(e.status), e.message, { status: e.status });
    if (e instanceof DOMException && e.name === 'AbortError') throw new ProviderError('orbyt', 'aborted', 'orbyt: aborted');
    throw e;
  }
}

export interface ServerProviderHealth {
  provider: string;
  lastOkAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  coolingDownUntil?: number;
  okCount: number;
  errorCount: number;
}

export interface HealthReport {
  configured: ConfiguredProviders;
  rpc: 'custom' | 'helius' | 'public';
  capabilities: Capabilities;
  providers: ServerProviderHealth[];
}

export const server = {
  trades: {
    id: 'orbyt',
    getTrades: (q, signal) => proxy<Trade[]>(API_ROUTES.trades, { mint: q.mint, pool: q.pool, limit: q.limit }, signal),
  } satisfies TransactionProvider,

  candles: {
    id: 'orbyt',
    // The route serves whatever the configured keyed providers support; callers
    // must consult capabilities before asking for an interval.
    intervals: INTERVALS,
    getCandles: (q, signal) =>
      proxy<CandleSeries>(API_ROUTES.candles, { mint: q.mint, pool: q.pool, interval: q.interval, before: q.before, limit: q.limit }, signal),
  } satisfies ChartDataProvider,

  holders: {
    id: 'orbyt',
    getHolders: (mint, limit, signal) => proxy<HolderSnapshot>(API_ROUTES.holders, { mint, limit }, signal),
  } satisfies HolderProvider,

  risk: {
    id: 'orbyt',
    getRisk: (mint, signal) => proxy<RiskReport>(API_ROUTES.risk, { mint }, signal),
  } satisfies TokenRiskProvider,

  pulse: {
    id: 'orbyt',
    getPulse: (column, signal) => proxy<PulseToken[]>(API_ROUTES.pulse, { column }, signal),
  } satisfies LaunchpadProvider,

  discover: {
    id: 'orbyt',
    discover: (q, signal) => proxy<TokenRow[]>(API_ROUTES.discover, { list: q.list, window: q.window, limit: q.limit }, signal),
  } satisfies TokenDiscoveryProvider,

  tokens: {
    id: 'orbyt',
    getRows: (mints, signal) => proxy<TokenRow[]>(API_ROUTES.tokens, { mints }, signal),
  } satisfies TokenRowsProvider,

  quote: {
    id: 'orbyt',
    getQuote: (r, signal) =>
      proxy<SwapQuote>(
        API_ROUTES.quote,
        {
          inputMint: r.inputMint,
          outputMint: r.outputMint,
          amountRaw: r.amountRaw,
          inputDecimals: r.inputDecimals,
          outputDecimals: r.outputDecimals,
          slippageBps: r.slippageBps,
        },
        signal,
      ),
  } satisfies TradingProvider,

  portfolio: {
    id: 'orbyt',
    getPortfolio: (address, signal) => proxy<Portfolio>(API_ROUTES.portfolio(address), undefined, signal),
  } satisfies PortfolioProvider,

  activity: {
    id: 'orbyt',
    getActivity: (address, opts, signal) =>
      proxy<WalletActivityPage>(API_ROUTES.activity(address), { before: opts.before, limit: opts.limit }, signal),
    getTransaction: (signature, wallet, signal) => proxy<WalletActivity | null>(API_ROUTES.tx(signature), { wallet }, signal),
  } satisfies WalletActivityProvider,

  curves: {
    id: 'orbyt',
    getCurves: (mints, signal) => proxy<Record<string, BondingCurveState>>(API_ROUTES.curves, { mints }, signal),
  } satisfies BondingCurveProvider,

  mint: (mint: string, signal?: AbortSignal) => proxy<MintInfo>(API_ROUTES.mint(mint), undefined, signal),

  health: (signal?: AbortSignal) => proxy<HealthReport>(API_ROUTES.health, undefined, signal),
};
