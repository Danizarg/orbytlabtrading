import { apiGet, ApiError, type QueryParams } from '@/client/api';
import { API_ROUTES, type ApiEnvelope } from '@/lib/core/api';
import { PUBLIC_ENDPOINTS, type Capabilities, type ConfiguredProviders } from '@/lib/config/capabilities';
import { ChainError, runChain, type ChainAttempt, type ChainResult, type ChainStep } from '@/lib/core/chain';
import type {
  BondingCurveProvider,
  CandlesQuery,
  ChartDataProvider,
  HolderProvider,
  LaunchpadProvider,
  LiquidityProvider,
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
  type PoolInfo,
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
import { describeError, isAbortError, isProviderError, ProviderError, type ProviderErrorCode } from '@/lib/net/errors';
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
 * 3. Keyless server fallbacks: routes that answer without any key, from the
 *    server's own per-IP quota, CDN-cached so one upstream call serves every
 *    visitor. Put them AFTER the direct browser step, so a visitor whose own
 *    GeckoTerminal / Jupiter quota is spent still gets data through ORBYT:
 *
 *    - `server.candlesKeyless` (ChartDataProvider, intervals 1m–1d):
 *      /api/v1/candles; keyed providers when configured, else GeckoTerminal
 *      OHLCV fetched by the server (s-maxage 30 s latest page, 600 s with
 *      `before`). Pass `pool` (the server otherwise resolves the most liquid
 *      pool from its cached pool list). Same shape as `gecko` for charts:
 *        [{ id: 'geckoterminal', run: () => gecko.getCandles(q, signal) },
 *         { id: 'orbyt', run: () => server.candlesKeyless.getCandles(q, signal) }]
 *    - `server.pools` (LiquidityProvider): /api/v1/pools?mint=, DEX Screener
 *      token-pairs + GeckoTerminal token pools merged by address (s-maxage 60).
 *    - `server.tokens` (TokenRowsProvider): /api/v1/tokens now also answers
 *      keyless (Jupiter + DEX Screener from the server, s-maxage 15), so it is
 *      a valid last step even when `capabilities.serverDiscover` is false.
 *
 *    `runWithServerFallback(label, directSteps, serverStep, opts)` runs the
 *    direct chain and asks the server step only when a direct source actually
 *    failed (rate limit, timeout, network, HTTP error), never when every source
 *    answered "no data" (the server would ask the same indexes). When the
 *    server fails too it throws instead of returning an empty direct answer,
 *    so a query keeps its last good data. The pools and tokens routes likewise
 *    answer "empty" only when every upstream answered (else 503 / stale).
 *    Capabilities advertise these routes as always present:
 *    `serverCandlesKeyless`, `serverPools`, `serverTokensKeyless`.
 *
 *    Server results carry `stale: true` (see `isServerStale`) when the route
 *    served its last good response after an upstream failure: show "Delayed".
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

/** A server-proxied result; `stale` when the route served its last good response after an upstream failure. */
export type ServerSourced<T> = Sourced<T> & { stale?: true };

/** True for a server result served stale after an upstream failure (show it with a "Delayed" badge). */
export function isServerStale(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { stale?: unknown }).stale === true;
}

export function fromEnvelope<T>(envelope: ApiEnvelope<T>): ServerSourced<T> {
  const { meta } = envelope;
  const contributors = meta.sources.filter((s) => s.ok && s.provider !== meta.primary).map((s) => s.provider);
  return {
    data: envelope.data,
    source: meta.primary ?? 'orbyt',
    ...(contributors.length ? { contributors } : {}),
    fetchedAt: meta.dataAsOf ?? meta.generatedAt,
    freshness: meta.freshness ?? 'fast',
    ...(meta.notes?.length ? { notes: meta.notes } : {}),
    ...(meta.stale ? { stale: true as const } : {}),
  };
}

/** GET an ORBYT route and convert it to Sourced<T>; failures become ProviderError('orbyt', …). */
export async function proxy<T>(path: string, params?: QueryParams, signal?: AbortSignal): Promise<ServerSourced<T>> {
  try {
    return fromEnvelope(await apiGet<T>(path, params, { signal }));
  } catch (e) {
    if (e instanceof ApiError) throw new ProviderError('orbyt', codeForStatus(e.status), e.message, { status: e.status });
    if (e instanceof DOMException && e.name === 'AbortError') throw new ProviderError('orbyt', 'aborted', 'orbyt: aborted');
    throw e;
  }
}

function candlesProxy(q: CandlesQuery, signal?: AbortSignal): Promise<ServerSourced<CandleSeries>> {
  return proxy<CandleSeries>(API_ROUTES.candles, { mint: q.mint, pool: q.pool, interval: q.interval, before: q.before, limit: q.limit }, signal);
}

/**
 * A browser attempt worth retrying through ORBYT's server: a real failure
 * (rate limit, timeout, network, HTTP error, malformed payload), not an
 * answer ("no data", "not found") or a capability gap.
 */
export function isRetryableAttempt(attempt: ChainAttempt): boolean {
  if (attempt.ok) return false;
  return attempt.code !== 'empty' && attempt.code !== 'not_found' && attempt.code !== 'not_configured' && attempt.code !== 'unsupported';
}

/**
 * Direct browser chain first, then one ORBYT server step as the last resort.
 * The server step runs when a direct source failed (see isRetryableAttempt)
 * or when no direct source could run at all; if every direct source answered
 * "no data" it is skipped, because the server would ask the same indexes.
 * Attempts keep their order, so `chainWinner` names 'orbyt' when the server
 * answered. Semantics otherwise match runChain (accept / honest empty answer),
 * except that an empty direct answer is never returned when a direct source
 * failed and the server retry failed too: that is unknown, not empty, so it
 * throws (stale-while-error: the caller's query keeps its last good data).
 */
export async function runWithServerFallback<T>(
  label: string,
  direct: Array<ChainStep<T> | false | null | undefined>,
  fallback: ChainStep<T> | false | null | undefined,
  opts: { accept?: (result: Sourced<T>) => boolean; signal?: AbortSignal } = {},
): Promise<ChainResult<T>> {
  let first: ChainResult<T> | undefined;
  let failure: ChainError | undefined;
  try {
    first = await runChain(label, direct, opts);
  } catch (error) {
    if (!(error instanceof ChainError)) throw error;
    failure = error;
  }
  if (first && (!opts.accept || opts.accept(first))) return first;
  const attempts = [...(first?.attempts ?? failure?.attempts ?? [])];
  const worthIt = attempts.length === 0 || attempts.some(isRetryableAttempt);
  if (!fallback || fallback.skip || !worthIt) {
    if (first) return first;
    throw failure ?? new ChainError(label, attempts);
  }
  if (opts.signal?.aborted) throw new ProviderError(fallback.id, 'aborted', `${label}: aborted`);
  try {
    const result = await fallback.run();
    if (!opts.accept || opts.accept(result)) return { ...result, attempts: [...attempts, { provider: fallback.id, ok: true }] };
    attempts.push({ provider: fallback.id, ok: false, error: `${fallback.id}: no usable data`, code: 'empty' });
    // Like runChain: an honest (e.g. empty) answer beats an error when nothing usable exists.
    return first ? { ...first, attempts } : { ...result, attempts };
  } catch (error) {
    if (isAbortError(error)) throw error;
    attempts.push({ provider: fallback.id, ok: false, error: describeError(error), code: isProviderError(error) ? error.code : undefined });
  }
  // A direct source failed and the server retry failed too: an empty direct answer is not the truth
  // here (the failed source may list data), so throw and let React Query keep the last good data.
  throw new ChainError(label, attempts);
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
    getCandles: (q, signal) => candlesProxy(q, signal),
  } satisfies ChartDataProvider,

  /**
   * Keyless server candles (capabilities.serverCandlesKeyless, always true):
   * the same route, limited to the intervals GeckoTerminal serves keyless.
   * Keyed providers still answer first when configured.
   */
  candlesKeyless: {
    id: 'orbyt',
    intervals: gecko.intervals,
    getCandles: (q, signal) => candlesProxy(q, signal),
  } satisfies ChartDataProvider,

  /** DEX Screener + GeckoTerminal pools merged by the server (capabilities.serverPools, always true). */
  pools: {
    id: 'orbyt',
    getPools: (mint, signal) => proxy<PoolInfo[]>(API_ROUTES.pools, { mint }, signal),
  } satisfies LiquidityProvider,

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
