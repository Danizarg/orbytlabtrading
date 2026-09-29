'use client';

import { keepPreviousData, queryOptions, useQuery, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useCapabilities } from '@/client/capabilities';
import type { Capabilities } from '@/lib/config/capabilities';
import { runChain, type ChainAttempt, type ChainResult } from '@/lib/core/chain';
import type { ProviderId } from '@/lib/core/providers';
import type { BondingCurveState, Freshness, LaunchpadState, MintInfo, PoolInfo, TokenMarket, TokenMeta, TokenRow } from '@/lib/core/types';
import { isProviderError } from '@/lib/net/errors';
import type { GeckoTokenInfo } from '@/lib/providers/geckoterminal';
import { chainWinner, isPumpCandidate, mergeLaunchpad, mergeOverview, pollForWinner } from '@/lib/services/token';
import { POLL } from '../query';
import { dex, gecko, jup, server } from '../sources';
import { useBondingCurve } from './useBondingCurve';
import { mintInfoOptions, useMintInfo } from './useMintInfo';
import { poolsOptions, usePools } from './usePools';
import { useSolPrice } from './useSolPrice';

/**
 * Token page snapshot: identity + market row (server tokens proxy when a
 * keyed discovery provider exists → Jupiter → GeckoTerminal → DEX Screener),
 * GeckoTerminal token info (socials, description, holder summary, risk),
 * the on-chain mint account, the decoded pump.fun curve and the pool list.
 * Every request starts in parallel; nothing waits for another response.
 *
 * Keyless budget on this page: the row polls Jupiter every 15 s (30 s when a
 * browser-indexed source answered), token info costs one GeckoTerminal call
 * per two minutes (cached 5 min by the transport), pools one DEX Screener
 * call per minute.
 */

export const tokenRowKey = (mint: string, serverDiscover: boolean) => ['token-row', mint, serverDiscover] as const;
export const tokenInfoKey = (mint: string) => ['token-info', mint] as const;

/** The token's row, or `undefined` when every source answered but none lists the mint. */
export async function loadTokenRow(mint: string, serverDiscover: boolean, signal?: AbortSignal): Promise<ChainResult<TokenRow | undefined>> {
  const result = await runChain<TokenRow[]>(
    'token',
    [
      serverDiscover && { id: 'orbyt', run: () => server.tokens.getRows([mint], signal) },
      { id: 'jupiter', run: () => jup.getRows([mint], signal) },
      { id: 'geckoterminal', run: () => gecko.getRows([mint], signal) },
      { id: 'dexscreener', run: () => dex.getRows([mint], signal) },
    ],
    { accept: (r) => r.data.some((row) => row.token.mint === mint), signal },
  );
  return { ...result, data: result.data.find((row) => row.token.mint === mint) };
}

export function tokenRowOptions(mint: string, serverDiscover: boolean) {
  return queryOptions({
    queryKey: tokenRowKey(mint, serverDiscover),
    queryFn: ({ signal }) => loadTokenRow(mint, serverDiscover, signal),
    staleTime: 5_000,
    refetchInterval: (query) => pollForWinner(chainWinner(query.state.data), 15_000, POLL.indexed),
    placeholderData: keepPreviousData,
    retry: 1,
  });
}

export function tokenInfoOptions(mint: string) {
  return queryOptions({
    queryKey: tokenInfoKey(mint),
    queryFn: ({ signal }) => gecko.getTokenInfo(mint, signal),
    staleTime: 60_000,
    refetchInterval: 120_000,
    placeholderData: keepPreviousData,
    retry: (count, error) => !(isProviderError(error) && error.code === 'not_found') && count < 1,
  });
}

/** GeckoTerminal tokens/{mint}/info: one request shared by the overview, risk and holders panels. */
export function useTokenInfo(mint: string) {
  return useQuery(tokenInfoOptions(mint));
}

/**
 * Warm the token page caches from a Discover / Pulse row hover. Costs one
 * Jupiter call (rows) and one DEX Screener call (pools); GeckoTerminal info is
 * deliberately not prefetched (8 calls/min budget).
 */
export function prefetchTokenPage(client: QueryClient, mint: string, capabilities: Pick<Capabilities, 'serverDiscover'>): void {
  void client.prefetchQuery(tokenRowOptions(mint, capabilities.serverDiscover));
  void client.prefetchQuery(poolsOptions(mint));
  void client.prefetchQuery(mintInfoOptions(mint));
}

export interface TokenOverviewState {
  mint: string;
  meta: TokenMeta;
  market?: TokenMarket;
  /** Current supply (UI units) from the on-chain mint account. */
  supply?: number;
  launchpad?: LaunchpadState;
  mintInfo?: MintInfo;
  /** Decoded pump.fun curve; `null` once checked and absent; `undefined` while unknown / not a candidate. */
  curve?: BondingCurveState | null;
  curveFetchedAt?: number;
  isBonding: boolean;
  pools: PoolInfo[];
  primaryPool?: PoolInfo;
  frozenPools: ReadonlySet<string>;
  poolOverridden: boolean;
  /** true: a market source lists the mint; false: every source answered and none does; undefined: still loading. */
  listed?: boolean;
  /** The mint account exists on-chain (undefined while loading). */
  isMint?: boolean;
  info?: GeckoTokenInfo;
  source?: ProviderId;
  freshness?: Freshness;
  fetchedAt?: number;
  attempts: ChainAttempt[];
  error: unknown;
  isPending: boolean;
  solUsd?: number;
  queries: {
    row: UseQueryResult<ChainResult<TokenRow | undefined>>;
    info: ReturnType<typeof useTokenInfo>;
    mintInfo: ReturnType<typeof useMintInfo>;
    curve: ReturnType<typeof useBondingCurve>;
    pools: ReturnType<typeof usePools>['query'];
  };
}

export function useTokenOverview(mint: string, opts: { pool?: string } = {}): TokenOverviewState {
  const { serverDiscover } = useCapabilities();
  const row = useQuery(tokenRowOptions(mint, serverDiscover));
  const info = useTokenInfo(mint);
  const mintInfo = useMintInfo(mint);
  const solPrice = useSolPrice();
  const solUsd = solPrice.data?.data.priceUsd;

  const rowData = row.data?.data;
  const infoData = info.data?.data;
  const providerLaunchpad = useMemo(() => mergeLaunchpad(rowData?.token.launchpad, infoData?.meta.launchpad), [rowData, infoData]);

  // The curve read only starts for pump.fun candidates (launchpad, pool dex or the vanity "pump" suffix).
  const poolsFirst = useQuery({ ...poolsOptions(mint), notifyOnChangeProps: ['data'] });
  const pumpCandidate = isPumpCandidate(mint, providerLaunchpad, poolsFirst.data?.data);
  const curveQuery = useBondingCurve(mint, pumpCandidate);
  const curve = pumpCandidate ? curveQuery.data?.data : undefined;

  const pools = usePools(mint, { stage: providerLaunchpad?.stage, curve, solUsd, override: opts.pool });

  const view = useMemo(
    () =>
      mergeOverview({
        mint,
        row: rowData,
        info: infoData?.meta,
        infoHolders: infoData?.holders.totalHolders,
        mintInfo: mintInfo.data?.data,
        curve: curve ?? undefined,
      }),
    [mint, rowData, infoData, mintInfo.data, curve],
  );

  const launchpad = view.meta.launchpad;
  const isBonding = curve ? !curve.complete : launchpad?.stage === 'bonding';
  const listed = row.data ? rowData !== undefined : row.isError ? false : undefined;
  const isMint = mintInfo.data ? true : mintInfo.isError ? false : undefined;

  return {
    mint,
    meta: view.meta,
    market: view.market,
    supply: view.supply,
    launchpad,
    mintInfo: mintInfo.data?.data,
    curve,
    curveFetchedAt: curveQuery.data?.fetchedAt,
    isBonding,
    pools: pools.pools,
    primaryPool: pools.primary,
    frozenPools: pools.frozen,
    poolOverridden: pools.overridden,
    listed,
    isMint,
    info: infoData,
    source: row.data?.source,
    freshness: row.data?.freshness,
    fetchedAt: row.data?.fetchedAt,
    attempts: row.data?.attempts ?? [],
    error: row.error,
    isPending: row.isPending && info.isPending && mintInfo.isPending,
    solUsd,
    queries: { row, info, mintInfo, curve: curveQuery, pools: pools.query },
  };
}
