'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useCapabilities } from '@/client/capabilities';
import { mergeTrades, newTradesSince } from '@/lib/analytics/trades';
import { ChainError, runChain, type ChainAttempt } from '@/lib/core/chain';
import type { ProviderId } from '@/lib/core/providers';
import { isSolanaAddress } from '@/lib/core/solana';
import type { Freshness, Trade } from '@/lib/core/types';
import { feedRpcFromClient, sharedOnchainTradeFeed, type OnchainFeedSnapshot, type OnchainTradeFeed } from '@/lib/onchain/tradeFeed';
import { derivePumpCurveAddress } from '@/lib/providers/solana/pump';
import { chainWinner, pollForWinner } from '@/lib/services/token';
import { solanaWs } from '@/lib/streams/solana-ws';
import { POLL } from '../query';
import { browserRpc, gecko, server } from '../sources';

/**
 * Accumulated trade feed for one pool. Chain order:
 *
 * 1. ORBYT's trades route when a keyed RPC / indexer backs it
 *    (capabilities.serverTrades; polled every 3 s, realtime / fast).
 * 2. The on-chain feed (default without keys): publicnode RPC + its
 *    WebSocket straight from the browser — pump.fun curve trades decoded from
 *    the program logs as they land ('stream'), everything else fetched and
 *    derived from the transactions, reconciled every 8 s ('realtime'). Works
 *    for a pool seconds old, long before any indexer lists it
 *    (src/lib/onchain/tradeFeed.ts).
 * 3. GeckoTerminal pool trades (polled every 30 s, 'indexed', ~30 s delayed)
 *    when the on-chain feed cannot read anything and the pool is indexed.
 *
 * Polled sources merge into the list already in the query cache
 * (deduplicated by signature, newest first, capped), so the feed only grows
 * while the page is open and never blanks when a refresh fails.
 */

export const TRADES_CAP = 300;

export const tradesKey = (mint: string, pool: string | undefined, serverTrades: boolean) => ['trades', mint, pool ?? '', serverTrades] as const;

/** On-chain feed details for panels that label or extend it (chart history, LIVE). */
export interface OnchainFeedInfo {
  /** Account the feed reads: the pump.fun curve PDA or the AMM pool. */
  pool: string;
  pumpCurve: boolean;
  /** The listing reached the pool's first transaction. */
  exhausted: boolean;
  /** Every trade since the pool's first transaction is in the feed. */
  complete: boolean;
  /** Older pages are being fetched. */
  historyLoading: boolean;
  /** The history walk finished (possibly capped before the pool's first transaction). */
  historyDone: boolean;
  /** Signatures listed so far. */
  listed: number;
  /**
   * Successful transactions the feed listed but could not load within its RPC budget (a busy pool while the
   * WebSocket is silent), plus 1 when a listing window overflowed: > 0 means the trades held are a subset.
   */
  missed: number;
  /** Fetch older history, up to ~300 transactions, paced within the RPC budget (no-op when done or running). */
  loadHistory: () => void;
  /** Last trade pushed by the WebSocket (ms). */
  lastStreamAt?: number;
  ws: 'off' | 'connecting' | 'open';
}

export interface TradeFeed {
  trades: Trade[];
  /** Signatures that arrived with the latest poll (empty on the first snapshot: no flash for history). */
  fresh: ReadonlySet<string>;
  source: ProviderId;
  /** Providers that contributed (e.g. the Solana WebSocket next to the RPC). */
  contributors?: ProviderId[];
  freshness: Freshness;
  /** Upstream fetch time of the latest snapshot. */
  fetchedAt: number;
  /** Trades newer than this were not in the provider snapshot (volume-dedupe cursor for live candle ticks). */
  snapshotAt: number;
  /** The feed moves the chart tick by tick (stream / realtime / fast). LIVE labels use `isLiveFreshness`. */
  realtime: boolean;
  notes?: string[];
  attempts: ChainAttempt[];
  polls: number;
  /** Present when the trades come from the on-chain feed. */
  onchain?: OnchainFeedInfo;
  /**
   * On-chain feed only: exact SOL price per token of each trade (signature → SOL), on the basis of its `priceUsd`
   * (pump.fun: post-trade curve reserves), so SOL charts match the USD ones.
   */
  solPrices?: ReadonlyMap<string, number>;
}

/** Trade feeds that move the chart tick by tick (a keyed RPC / indexer, not a 30 s cache). */
export function isRealtimeFeed(freshness: Freshness): boolean {
  return freshness === 'stream' || freshness === 'realtime' || freshness === 'fast';
}

export async function loadTradeFeed(
  input: { mint: string; pool: string | undefined; indexed: boolean; serverTrades: boolean; previous: TradeFeed | undefined },
  signal?: AbortSignal,
): Promise<TradeFeed> {
  const { mint, pool, indexed, serverTrades, previous } = input;
  const result = await runChain<Trade[]>(
    'trades',
    [
      serverTrades && { id: 'orbyt', run: () => server.trades.getTrades({ mint, pool, limit: 100 }, signal) },
      !!pool && indexed && { id: 'geckoterminal', run: () => gecko.getTrades({ mint, pool, limit: TRADES_CAP }, signal) },
    ],
    { signal },
  );
  const trades = mergeTrades(previous?.trades ?? [], result.data, TRADES_CAP);
  const fresh = previous ? new Set(newTradesSince(previous.trades, trades).map((t) => t.signature)) : new Set<string>();
  return {
    trades,
    fresh,
    source: result.source,
    freshness: result.freshness,
    fetchedAt: result.fetchedAt,
    snapshotAt: result.fetchedAt,
    realtime: isRealtimeFeed(result.freshness),
    ...(result.notes?.length ? { notes: result.notes } : {}),
    attempts: result.attempts,
    polls: (previous?.polls ?? 0) + 1,
  };
}

/**
 * Poll at the winning chain step's cadence: ORBYT's route every 3 s, the
 * GeckoTerminal fallback every 30 s. `feed.source` names the upstream
 * provider behind the server route (e.g. 'helius'), so the winner comes from
 * the chain attempts. Before anything answered, retry at 5 s when the server
 * route exists, else at GeckoTerminal's cache age.
 */
export function tradesPollInterval(feed: TradeFeed | undefined, serverTrades: boolean): number {
  if (!feed) return serverTrades ? 5_000 : POLL.indexed;
  return pollForWinner(chainWinner(feed), POLL.realtime, POLL.indexed);
}

// ---------------------------------------------------------------------------
// On-chain feed
// ---------------------------------------------------------------------------

/** The on-chain attempt as a chain step result (its failure stays visible next to any fallback). */
export function onchainAttempt(snapshot: OnchainFeedSnapshot): ChainAttempt {
  const { status } = snapshot;
  return status.error ? { provider: 'solana-rpc', ok: false, error: `solana-rpc: ${status.error.replace(/^[a-z][a-z-]*:\s*/i, '')}`, code: status.errorCode } : { provider: 'solana-rpc', ok: true };
}

/** Snapshot of the on-chain feed → the TradeFeed shape panels consume. */
export function tradeFeedFromOnchain(snapshot: OnchainFeedSnapshot, info: OnchainFeedInfo): TradeFeed {
  const { status } = snapshot;
  const notes: string[] = [];
  if (status.skipped > 0) notes.push(`${status.skipped} transaction${status.skipped === 1 ? '' : 's'} could not be loaded and ${status.skipped === 1 ? 'was' : 'were'} skipped.`);
  if (status.dropped > 0) {
    notes.push(`Busy pool: ${status.dropped} listed transaction${status.dropped === 1 ? ' was' : 's were'} not loaded within the RPC budget; trades shown are a subset.`);
  } else if (status.unlisted) {
    notes.push('Busy pool: some transactions were never listed between two polls; trades shown are a subset.');
  }
  if (status.paused) notes.push('Paused while the tab is hidden.');
  const fetchedAt = snapshot.updatedAt ?? 0;
  return {
    trades: snapshot.trades as Trade[],
    fresh: snapshot.fresh,
    source: 'solana-rpc',
    // The WebSocket is credited only while it actually delivers trades (publicnode's log stream is best-effort).
    ...(snapshot.freshness === 'stream' ? { contributors: ['solana-ws' as ProviderId] } : {}),
    freshness: snapshot.freshness,
    fetchedAt,
    snapshotAt: fetchedAt,
    realtime: true,
    ...(notes.length ? { notes } : {}),
    attempts: [onchainAttempt(snapshot)],
    polls: status.polls,
    onchain: info,
    solPrices: snapshot.solPrices,
  };
}

/** publicnode JSON-RPC as the on-chain feed sees it (getSignatureStatuses through the raw call). */
const onchainRpc = feedRpcFromClient(browserRpc);

const noopSubscribe = () => () => {};
const noSnapshot = () => undefined;

/**
 * Subscribe to the tab-wide on-chain feed of `pool` (created on first use,
 * torn down a few seconds after the last subscriber left, so StrictMode
 * remounts reuse it). SOL price and supply updates re-price held trades.
 */
function useOnchainFeed(input: { mint: string; pool: string | undefined; pumpCurve: boolean; enabled: boolean; solUsd?: number; supply?: number }) {
  const { mint, pool, pumpCurve, enabled, solUsd, supply } = input;
  const feed = useMemo<OnchainTradeFeed | undefined>(
    () => (enabled && pool ? sharedOnchainTradeFeed({ mint, pool, isPumpCurve: pumpCurve, rpc: onchainRpc, ws: solanaWs }) : undefined),
    [enabled, mint, pool, pumpCurve],
  );
  const subscribe = useCallback((onChange: () => void) => (feed ? feed.subscribe(onChange) : noopSubscribe()), [feed]);
  const getSnapshot = useCallback(() => feed?.getSnapshot(), [feed]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, noSnapshot);
  useEffect(() => feed?.setSolPriceUsd(solUsd), [feed, solUsd]);
  useEffect(() => feed?.setSupply(supply), [feed, supply]);
  return { feed, snapshot };
}

export interface UseTradesOptions {
  /** The pool is listed by an aggregator (GeckoTerminal may be asked). Default true. */
  indexed?: boolean;
  /** `pool` is a live pump.fun bonding curve: trades decode from the program logs. */
  pumpCurve?: boolean;
  /** Live SOL/USD for USD values of SOL-quoted on-chain trades. */
  solUsd?: number;
  /** On-chain supply (UI units) for market cap at each trade. */
  supply?: number;
}

export function useTrades(mint: string, pool: string | undefined, opts: UseTradesOptions = {}) {
  const { serverTrades } = useCapabilities();
  const indexed = opts.indexed ?? true;
  const pumpCurve = opts.pumpCurve ?? false;
  const onchainWanted = !serverTrades && !!pool && isSolanaAddress(pool) && isSolanaAddress(mint);

  // The curve PDA (seeds ['bonding-curve', mint]) is authoritative for a pump.fun curve; the listed pair address is the fallback.
  const curvePda = useQuery({
    queryKey: ['pump-curve-pda', mint],
    queryFn: () => derivePumpCurveAddress(mint),
    enabled: onchainWanted && pumpCurve,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 0,
  });
  const feedPool = pumpCurve ? (curvePda.data ?? (curvePda.isError ? pool : undefined)) : pool;

  const { feed: onchainFeed, snapshot } = useOnchainFeed({
    mint,
    pool: feedPool,
    pumpCurve,
    enabled: onchainWanted,
    solUsd: opts.solUsd,
    supply: opts.supply,
  });
  const onchainFailed = !!snapshot && snapshot.status.failed && snapshot.trades.length === 0;

  // Server route (keyed) — or GeckoTerminal once the on-chain feed could not read anything.
  const polledEnabled = serverTrades || (onchainFailed && !!pool && indexed);
  const key = tradesKey(mint, pool, serverTrades);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal, client }) => loadTradeFeed({ mint, pool, indexed, serverTrades, previous: client.getQueryData<TradeFeed>(key) }, signal),
    enabled: polledEnabled,
    refetchInterval: (q) => tradesPollInterval(q.state.data, serverTrades),
    staleTime: 2_000,
    // No placeholderData: a new key is a different pool, whose trades must never be shown as this one's.
    // Refresh failures keep the accumulated list (React Query keeps `data` on error).
    retry: 1,
  });

  const status = snapshot?.status;
  const loadHistory = useCallback(() => void onchainFeed?.loadHistory(), [onchainFeed]);
  const info = useMemo<OnchainFeedInfo | undefined>(
    () =>
      onchainFeed && status
        ? {
            pool: onchainFeed.pool,
            pumpCurve: onchainFeed.isPumpCurve,
            exhausted: status.exhausted,
            complete: status.complete,
            historyLoading: status.history === 'loading',
            historyDone: status.history === 'done' || status.history === 'error',
            listed: status.listed,
            missed: status.missed + (status.unlisted ? 1 : 0),
            loadHistory,
            ...(status.lastStreamAt !== undefined ? { lastStreamAt: status.lastStreamAt } : {}),
            ws: status.ws,
          }
        : undefined,
    [onchainFeed, status, loadHistory],
  );
  const onchainTradeFeed = useMemo(() => (snapshot && info ? tradeFeedFromOnchain(snapshot, info) : undefined), [snapshot, info]);

  let feed: TradeFeed | undefined;
  let error: unknown;
  let isPending: boolean;
  if (serverTrades || !onchainWanted) {
    feed = query.data;
    error = query.error ?? undefined;
    isPending = polledEnabled ? query.isPending : false;
  } else if (onchainFailed && polledEnabled) {
    // GeckoTerminal fallback: its trades, with the on-chain failure kept in the attempts.
    const failure = snapshot ? onchainAttempt(snapshot) : undefined;
    feed = query.data && failure ? { ...query.data, attempts: [failure, ...query.data.attempts] } : query.data;
    const geckoAttempts = query.error instanceof ChainError ? query.error.attempts : [];
    error = query.error ? new ChainError('trades', failure ? [failure, ...geckoAttempts] : geckoAttempts) : undefined;
    isPending = query.isPending;
  } else {
    feed = onchainTradeFeed;
    error = onchainFailed && snapshot ? new ChainError('trades', [onchainAttempt(snapshot)]) : undefined;
    isPending = !onchainFailed && (!snapshot || (snapshot.trades.length === 0 && (snapshot.status.backfill === 'idle' || snapshot.status.backfill === 'loading')));
  }

  return {
    feed,
    trades: feed?.trades ?? EMPTY,
    /** Signatures new in the latest poll / stream batch (row flash). */
    newSignatures: feed?.fresh ?? NO_SIGNATURES,
    // React Query reports `null` when there is no error.
    error,
    isPending,
    isFetching: query.isFetching || status?.backfill === 'loading' || status?.history === 'loading',
    /** A trade source can run for this pool (on-chain feeds read any pool; the keyed route resolves one itself). */
    enabled: serverTrades || onchainWanted || (!!pool && indexed),
    query,
  };
}

const EMPTY: Trade[] = [];
const NO_SIGNATURES: ReadonlySet<string> = new Set();
