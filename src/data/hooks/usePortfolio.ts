'use client';

import { keepPreviousData, useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';
import { chunk } from '@/lib/core/chain';
import type { ProviderId } from '@/lib/core/providers';
import { isSolanaAddress, MINTS } from '@/lib/core/solana';
import type { Sourced, TokenIdentity } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import { JUPITER_LIMITS } from '@/lib/providers/jupiter';
import {
  holdingPrices,
  identityMints,
  loadPortfolio,
  MAX_IDENTITY_MINTS,
  priceHoldings,
  retryDelayMs,
  selectMintsToPrice,
  type PricedPortfolio,
} from '@/lib/services/wallet';
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

/** A failed lookup is tried again after this long (the retries inside one fetch come first). */
const LOOKUP_RECOVER_MS = 60_000;

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
 * for 10 minutes. Longer lists are looked up progressively, one call of 100
 * at a time (the next batch starts when the previous one lands), so a long
 * history never bursts the browser's Jupiter budget.
 */
export function useMintIdentities(mints: readonly string[]): MintIdentities {
  const v = useSyncExternalStore(subscribe, getVersion, getServerVersion);
  const unknown = useMemo(() => {
    const out: string[] = [];
    for (const m of new Set(mints)) {
      if (isSolanaAddress(m) && cached(m) === undefined && !pending.has(m)) out.push(m);
      if (out.length >= MAX_IDENTITY_MINTS) break;
    }
    return out.sort();
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
    // A lookup that failed through its retries is tried again later instead of never.
    refetchInterval: (q) => (q.state.status === 'error' ? LOOKUP_RECOVER_MS : false),
    retry: 2,
    retryDelay: retryDelayMs,
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

/** Browser price quotes for the holdings, merged across Jupiter Price V3 batches of 50. */
export interface HoldingPricesView {
  /** USD price by mint; undefined until a batch has answered. Each batch keeps its last good quotes on a failed refresh. */
  data: Readonly<Record<string, number>> | undefined;
  source: ProviderId | undefined;
  /** Fetch time of the OLDEST batch on screen (the age of the price set as a whole). */
  fetchedAt: number | undefined;
  /** Some batch is still on its first attempt. */
  isPending: boolean;
  /** Some batch's latest attempt failed (its previous quotes, if any, stay on screen). */
  isError: boolean;
  error: unknown;
  batches: number;
  failedBatches: number;
}

export interface PortfolioView {
  query: ReturnType<typeof usePortfolioQuery>;
  /** Balances valued from real quotes; undefined until the first response. */
  portfolio: PricedPortfolio | undefined;
  prices: HoldingPricesView;
  identities: MintIdentities;
  solPriceUsd: number | undefined;
  /** Holdings left unpriced because the browser pricing budget (150 mints) was exhausted. */
  skippedPricing: number;
  /** Browser pricing is still on its first attempt. */
  pricingPending: boolean;
  /** USD price per priced holding, for other panels to reuse instead of asking Jupiter again. */
  priceMap: Readonly<Record<string, number>>;
  /** Mints this page already asked a price for (priced or not): other panels must not ask again. */
  attemptedMints: ReadonlySet<string>;
  /** Balances and their prices have answered (or failed): `priceMap` is as complete as it will get for now. */
  pricesSettled: boolean;
  /** When the prices in `priceMap` were fetched (oldest batch). */
  pricesUpdatedAt: number | undefined;
}

function usePortfolioQuery(address: string) {
  return useQuery({
    queryKey: walletKeys.portfolio(address),
    queryFn: ({ signal }) => loadPortfolio({ server: server.portfolio, jupiter: jup }, address, signal),
    enabled: isSolanaAddress(address),
    refetchInterval: POLL.indexed,
    staleTime: 20_000,
    // No placeholder: the key is the wallet, and another wallet's balances must never stand in.
    // A failed refresh still keeps the last good data (React Query keeps it on error).
    retry: 2,
    retryDelay: retryDelayMs,
  });
}

/**
 * Spacing between price batches. Jupiter allows 4 calls per 10 s per browser
 * and the page also spends calls on metadata and the SOL price, so batches
 * never fire together: batch i waits i × 3 s on every fetch, which also
 * keeps their 30 s refreshes apart.
 */
const PRICE_BATCH_SPACING_MS = 3_000;
const JUPITER_PRICE_BATCH = JUPITER_LIMITS.priceIds;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError('jupiter', 'aborted', 'jupiter: aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type PriceResult = UseQueryResult<Sourced<Record<string, number>>>;

function combinePrices(results: PriceResult[]): HoldingPricesView {
  let data: Record<string, number> | undefined;
  let source: ProviderId | undefined;
  let fetchedAt: number | undefined;
  let isPending = false;
  let failedBatches = 0;
  let error: unknown;
  for (const r of results) {
    if (r.isPending && r.fetchStatus !== 'idle') isPending = true;
    if (r.isError) {
      failedBatches++;
      error ??= r.error;
    }
    if (!r.data) continue;
    data = { ...data, ...r.data.data };
    source ??= r.data.source;
    fetchedAt = fetchedAt === undefined ? r.data.fetchedAt : Math.min(fetchedAt, r.data.fetchedAt);
  }
  return { data, source, fetchedAt, isPending, isError: failedBatches > 0, error, batches: results.length, failedBatches };
}

/** One query per batch of 50, so a failing batch retries alone and keeps its last quotes. */
function useHoldingPrices(mints: readonly string[], enabled: boolean): HoldingPricesView {
  const batches = useMemo(() => chunk(mints, JUPITER_PRICE_BATCH), [mints]);
  return useQueries({
    queries: batches.map((batch, i) => ({
      queryKey: walletKeys.prices(batch.join(',')),
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        await delay(i * PRICE_BATCH_SPACING_MS, signal);
        return jup.getPrices(batch, signal);
      },
      enabled,
      refetchInterval: POLL.indexed,
      staleTime: 20_000,
      // Same wallet, changed mint set: keep the previous quotes on screen until the new ones land.
      placeholderData: keepPreviousData,
      retry: 2,
      retryDelay: retryDelayMs,
    })),
    combine: combinePrices,
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
  // Every selected mint gets priced, so order does not matter: sorting keeps the 50-mint batches (and their
  // cache keys) stable when a balance refresh reorders the holdings. Key on the joined list so a re-created
  // array with the same mints does not refetch.
  const priceKey = [...selection.mints].sort().join(',');
  const priceMints = useMemo(() => (priceKey ? priceKey.split(',') : EMPTY_MINTS), [priceKey]);
  const prices = useHoldingPrices(priceMints, !selection.needsMetadata);

  const solPriceUsd = sol.data?.data.priceUsd;
  const portfolio = useMemo(
    () => (base ? priceHoldings(base, prices.data ?? EMPTY_PRICES, solPriceUsd, identities.byMint) : undefined),
    [base, prices.data, solPriceUsd, identities.byMint],
  );

  const priceMap = useMemo(() => holdingPrices(portfolio), [portfolio]);
  const pricingPending = priceMints.length > 0 && (selection.needsMetadata || prices.isPending);
  const pricingDone = !base || (!selection.needsMetadata && (priceMints.length === 0 || !prices.isPending));
  const pricesSettled = (base !== undefined || query.isError) && pricingDone;
  // Every holding this page asked Jupiter about (plus server-priced ones): another panel asking again would get the same answer.
  const attemptedMints = useMemo(() => {
    const out = new Set<string>(pricingDone ? priceMints : EMPTY_MINTS);
    for (const mint of Object.keys(priceMap)) out.add(mint);
    out.add(MINTS.SOL);
    return out;
  }, [pricingDone, priceMints, priceMap]);

  return {
    query,
    portfolio,
    prices,
    identities,
    solPriceUsd,
    skippedPricing: selection.skipped,
    pricingPending,
    priceMap,
    attemptedMints,
    pricesSettled,
    pricesUpdatedAt: prices.fetchedAt ?? query.data?.fetchedAt,
  };
}
