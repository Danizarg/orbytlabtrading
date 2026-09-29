'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ProviderId } from '@/lib/core/providers';
import { isSolanaAddress, LAMPORTS_PER_SOL, MINTS } from '@/lib/core/solana';
import type { TokenBalance } from '@/lib/core/types';
import { isAbortError } from '@/lib/net/errors';
import { loadPortfolio, retryDelayMs } from '@/lib/services/wallet';
import { POLL } from '../query';
import { browserRpc, jup, server } from '../sources';
import { walletKeys } from './usePortfolio';

/**
 * Balances of the connected wallet for the trade panel:
 * - SOL: the browser-allowed public RPC (getBalance, exact lamports), ORBYT's
 *   server portfolio route (server-side RPC) as the fallback;
 * - the token: the portfolio sources (ORBYT server RPC → Jupiter holdings),
 *   sharing the wallet page's cache.
 * Both refresh every 30 s, and `refresh()` re-reads them right after a trade
 * (plus once more a few seconds later, when RPC nodes and caches caught up).
 */

export const walletBalanceKeys = {
  sol: (address: string) => ['wallet', 'sol-balance', address] as const,
};

/** Second re-read after a trade: covers the portfolio route's 5 s server cache and RPC propagation. */
const SETTLE_REFRESH_MS = 8_000;

export interface SolBalanceReading {
  lamports: bigint;
  sol: number;
  source: ProviderId;
  fetchedAt: number;
}

export async function loadSolBalance(address: string, signal?: AbortSignal): Promise<SolBalanceReading> {
  try {
    const lamports = await browserRpc.getBalance(address, signal);
    return { lamports: BigInt(Math.round(lamports)), sol: lamports / LAMPORTS_PER_SOL, source: 'solana-rpc', fetchedAt: Date.now() };
  } catch (e) {
    if (isAbortError(e)) throw e;
    const portfolio = await server.portfolio.getPortfolio(address, signal);
    const sol = portfolio.data.sol;
    return { lamports: BigInt(Math.round(sol * LAMPORTS_PER_SOL)), sol, source: portfolio.source, fetchedAt: portfolio.fetchedAt };
  }
}

export interface TokenBalanceReading {
  /**
   * UI amount: 0 when the portfolio answered completely and the wallet holds
   * none of the token; undefined when the source skipped unreadable balances
   * (the token may be among them).
   */
  amount: number | undefined;
  decimals?: number;
  /** The wallet holds a positive balance of the token. */
  held: boolean;
  source: ProviderId;
  fetchedAt: number;
}

/** Portfolio notes that say some balances were left out (Jupiter holdings with unreadable accounts). */
const SKIPPED_NOTE = /could not be read/i;

/** The token's balance in a portfolio answer (token accounts are aggregated per mint by the sources). */
export function tokenBalanceFrom(
  tokens: readonly TokenBalance[],
  mint: string,
  notes?: readonly string[],
): Pick<TokenBalanceReading, 'amount' | 'decimals' | 'held'> {
  const hit = tokens.find((t) => t.mint === mint);
  if (hit && hit.amount > 0) return { amount: hit.amount, decimals: hit.decimals, held: true };
  const partial = notes?.some((n) => SKIPPED_NOTE.test(n)) ?? false;
  return { amount: partial ? undefined : 0, held: false };
}

export function useWalletBalances(address: string | null, mint: string) {
  const client = useQueryClient();
  const owner = address && isSolanaAddress(address) ? address : '';
  const enabled = owner.length > 0;

  const sol = useQuery({
    queryKey: walletBalanceKeys.sol(owner),
    queryFn: ({ signal }) => loadSolBalance(owner, signal),
    enabled,
    staleTime: 10_000,
    refetchInterval: POLL.indexed,
    retry: 1,
    retryDelay: retryDelayMs,
  });

  // Same key and loader as the wallet page (usePortfolio), so both share one cache entry.
  const portfolio = useQuery({
    queryKey: walletKeys.portfolio(owner),
    queryFn: ({ signal }) => loadPortfolio({ server: server.portfolio, jupiter: jup }, owner, signal),
    enabled,
    staleTime: 20_000,
    refetchInterval: POLL.indexed,
    retry: 2,
    retryDelay: retryDelayMs,
  });

  const portfolioData = portfolio.data;
  const token = useMemo<TokenBalanceReading | undefined>(() => {
    if (!portfolioData) return undefined;
    if (mint === MINTS.SOL) return undefined;
    return {
      ...tokenBalanceFrom(portfolioData.data.tokens, mint, portfolioData.notes),
      source: portfolioData.source,
      fetchedAt: portfolioData.fetchedAt,
    };
  }, [portfolioData, mint]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const refresh = useCallback(() => {
    if (!owner) return;
    const reread = () => {
      void client.invalidateQueries({ queryKey: walletBalanceKeys.sol(owner) });
      void client.invalidateQueries({ queryKey: walletKeys.portfolio(owner) });
    };
    reread();
    clearTimeout(timer.current);
    timer.current = setTimeout(reread, SETTLE_REFRESH_MS);
  }, [client, owner]);

  return {
    sol: enabled ? sol.data : undefined,
    solError: enabled ? (sol.error ?? undefined) : undefined,
    solPending: enabled && sol.isPending,
    token: enabled ? token : undefined,
    tokenError: enabled ? (portfolio.error ?? undefined) : undefined,
    tokenPending: enabled && portfolio.isPending,
    refresh,
  };
}
