'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';
import { isSolanaAddress } from '@/lib/core/solana';
import type { TokenIdentity } from '@/lib/core/types';
import { identityMints, loadPortfolio, priceHoldings, selectMintsToPrice, type PricedPortfolio } from '@/lib/services/wallet';
import { POLL } from '../query';
import { jup, server } from '../sources';
import { useSolPrice } from './useSolPrice';

/** Query keys shared by the wallet page and the tracker. */
export const walletKeys = {
  portfolio: (address: string) => ['wallet', 'portfolio', address] as const,
  prices: (mintKey: string) => ['wallet', 'prices', mintKey] as const,
  identities: (mintKey: string) => ['mint-identities', mintKey] as const,
  activity: (address: string) => ['wallet', 'activity', address] as const,
  activityHead: (address: string) => ['wallet', 'activity-head', address] as const,
  pnlPrices: (mintKey: string) => ['wallet', 'pnl-prices', mintKey] as const,
  trackerBackfill: (address: string) => ['tracker', 'backfill', address] as const,
};

const EMPTY_MINTS: readonly string[] = [];
const EMPTY_TOKENS: readonly never[] = [];
const EMPTY_PRICES: Readonly<Record<string, number>> = {};

// ---------------------------------------------------------------------------
// Token identities (symbol / name / logo / decimals), cached per browser session
// ---------------------------------------------------------------------------

/** A mint Jupiter does not list is retried after this long. */
const UNKNOWN_TTL_MS = 10 * 60_000;
const SWEEP_MS = 60_000;

interface IdentityHit {
  identity: TokenIdentity | null;
  at: number;
}

const cache = new Map<string, IdentityHit>();
/** Mints an in-flight lookup already covers (other hook instances wait for the result). */
const pending = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let sweeper: ReturnType<typeof setInterval> | undefined;

function bump(): void {
  version++;
  listeners.forEach((l) => l());
}

/** Forget "unknown" verdicts older than the TTL so they are looked up again (runs off the render path). */
function sweep(): void {
  const now = Date.now();
  let changed = false;
  for (const [mint, hit] of cache) {
    if (hit.identity === null && now - hit.at > UNKNOWN_TTL_MS) {
      cache.delete(mint);
      changed = true;
    }
  }
  if (changed) bump();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  sweeper ??= setInterval(sweep, SWEEP_MS);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && sweeper) {
      clearInterval(sweeper);
      sweeper = undefined;
    }
  };
}

const getVersion = () => version;
const getServerVersion = () => 0;

/** undefined = never looked up (or expired); null = looked up, unknown to Jupiter. */
function cached(mint: string): TokenIdentity | null | undefined {
  return cache.get(mint)?.identity;
}

async function lookup(mints: readonly string[], signal?: AbortSignal): Promise<number> {
  mints.forEach((m) => pending.add(m));
  try {
    const rows = await jup.getRows([...mints], signal);
    const now = Date.now();
    const found = new Set<string>();
    for (const row of rows.data) {
      const { mint, symbol, name, image, decimals } = row.token;
      const identity: TokenIdentity = { mint };
      if (symbol) identity.symbol = symbol;
      if (name) identity.name = name;
      if (image) identity.image = image;
      if (decimals !== undefined) identity.decimals = decimals;
      cache.set(mint, { identity, at: now });
      found.add(mint);
    }
    for (const m of mints) if (!found.has(m)) cache.set(m, { identity: null, at: now });
    return found.size;
  } finally {
    mints.forEach((m) => pending.delete(m));
    bump();
  }
}

export interface MintIdentities {
  byMint: Readonly<Record<string, TokenIdentity | undefined>>;
  /** Mints with a known identity. */
  known: ReadonlySet<string>;
  /** Every requested mint was looked up (found or not), or the lookup failed. */
  settled: boolean;
  error: unknown;
}

/**
 * Symbol, name, logo and decimals for arbitrary mints (Jupiter Tokens V2
 * search, 100 mints per call). Results are cached for the session and shared
 * by the wallet page and the tracker, so a mint is looked up once per browser
 * no matter how many panels show it. Unknown mints are remembered as unknown
 * for 10 minutes.
 */
export function useMintIdentities(mints: readonly string[]): MintIdentities {
  const v = useSyncExternalStore(subscribe, getVersion, getServerVersion);
  const unknown = useMemo(() => {
    return [...new Set(mints)].filter((m) => isSolanaAddress(m) && cached(m) === undefined && !pending.has(m)).sort();
    // `v` re-evaluates the cache after every completed lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mints, v]);
  const key = unknown.join(',');

  const query = useQuery({
    queryKey: walletKeys.identities(key),
    queryFn: ({ signal }) => lookup(unknown, signal),
    enabled: key.length > 0,
    staleTime: Infinity,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });

  return useMemo(() => {
    const byMint: Record<string, TokenIdentity | undefined> = {};
    const known = new Set<string>();
    let waiting = false;
    for (const m of mints) {
      const hit = cached(m);
      if (hit) {
        byMint[m] = hit;
        known.add(m);
      } else if (hit === undefined) {
        waiting = true;
      }
    }
    const settled = !waiting || (key.length > 0 && query.isError);
    return { byMint, known, settled, error: query.error };
    // `v` re-evaluates the cache after every completed lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mints, v, key, query.isError, query.error]);
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

export interface PortfolioView {
  query: ReturnType<typeof usePortfolioQuery>;
  /** Balances valued from real quotes; undefined until the first response. */
  portfolio: PricedPortfolio | undefined;
  prices: ReturnType<typeof usePricesQuery>;
  identities: MintIdentities;
  solPriceUsd: number | undefined;
  /** Holdings left unpriced because the browser pricing budget (150 mints) was exhausted. */
  skippedPricing: number;
  /** Browser pricing is still on its first attempt. */
  pricingPending: boolean;
}

function usePortfolioQuery(address: string) {
  return useQuery({
    queryKey: walletKeys.portfolio(address),
    queryFn: ({ signal }) => loadPortfolio({ server: server.portfolio, jupiter: jup }, address, signal),
    enabled: isSolanaAddress(address),
    refetchInterval: POLL.indexed,
    staleTime: 20_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });
}

function usePricesQuery(mints: readonly string[], enabled: boolean) {
  return useQuery({
    queryKey: walletKeys.prices(mints.join(',')),
    queryFn: ({ signal }) => jup.getPrices([...mints], signal),
    enabled: enabled && mints.length > 0,
    refetchInterval: POLL.indexed,
    staleTime: 20_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });
}

/**
 * Wallet holdings: server RPC route (always available) → keyless Jupiter
 * holdings; then priced in the browser from Jupiter Price V3 (at most 150
 * mints, known tokens first) and SOL from the shared SOL price. Values come
 * only from real quotes; unpriced holdings are counted, never zero-filled.
 * Refreshes every 30 s.
 */
export function usePortfolio(address: string): PortfolioView {
  const sol = useSolPrice();
  const query = usePortfolioQuery(address);
  const base = query.data?.data;
  const tokens = base?.tokens;

  const metaMints = useMemo(() => (tokens ? identityMints(tokens) : EMPTY_MINTS), [tokens]);
  const identities = useMintIdentities(metaMints);

  const selection = useMemo(
    () => selectMintsToPrice(tokens ?? EMPTY_TOKENS, identities.settled ? identities.known : undefined),
    [tokens, identities.settled, identities.known],
  );
  // Key on the joined list so a re-created array with the same mints does not refetch.
  const priceKey = selection.mints.join(',');
  const priceMints = useMemo(() => (priceKey ? priceKey.split(',') : EMPTY_MINTS), [priceKey]);
  const prices = usePricesQuery(priceMints, !selection.needsMetadata);

  const solPriceUsd = sol.data?.data.priceUsd;
  const portfolio = useMemo(
    () => (base ? priceHoldings(base, prices.data?.data ?? EMPTY_PRICES, solPriceUsd, identities.byMint) : undefined),
    [base, prices.data, solPriceUsd, identities.byMint],
  );

  return {
    query,
    portfolio,
    prices,
    identities,
    solPriceUsd,
    skippedPricing: selection.skipped,
    pricingPending: priceMints.length > 0 && prices.isPending,
  };
}
