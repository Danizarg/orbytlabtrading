'use client';

import { useQuery } from '@tanstack/react-query';
import { useCapabilities } from '@/client/capabilities';
import { mergeTrades, newTradesSince } from '@/lib/analytics/trades';
import { runChain, type ChainAttempt } from '@/lib/core/chain';
import type { ProviderId } from '@/lib/core/providers';
import type { Freshness, Trade } from '@/lib/core/types';
import { chainWinner, pollForWinner } from '@/lib/services/token';
import { POLL } from '../query';
import { gecko, server } from '../sources';

/**
 * Accumulated trade feed for one pool. Sources (failover): ORBYT's trades
 * route when a keyed RPC / indexer backs it (polled every 3 s, freshness
 * realtime / fast), else GeckoTerminal pool trades (polled every 30 s,
 * 'indexed', ~30 s delayed). Each poll merges into the list already in the
 * query cache (deduplicated by signature, newest first, capped), so the feed
 * only grows while the page is open and never blanks when a refresh fails.
 * GeckoTerminal is only asked for pools an aggregator has indexed.
 */

export const TRADES_CAP = 300;

export const tradesKey = (mint: string, pool: string | undefined, serverTrades: boolean) => ['trades', mint, pool ?? '', serverTrades] as const;

export interface TradeFeed {
  trades: Trade[];
  /** Signatures that arrived with the latest poll (empty on the first snapshot: no flash for history). */
  fresh: ReadonlySet<string>;
  source: ProviderId;
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

export function useTrades(mint: string, pool: string | undefined, opts: { indexed?: boolean } = {}) {
  const { serverTrades } = useCapabilities();
  const indexed = opts.indexed ?? true;
  const key = tradesKey(mint, pool, serverTrades);
  const enabled = (!!pool && indexed) || serverTrades;
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal, client }) => loadTradeFeed({ mint, pool, indexed, serverTrades, previous: client.getQueryData<TradeFeed>(key) }, signal),
    enabled,
    refetchInterval: (q) => tradesPollInterval(q.state.data, serverTrades),
    staleTime: 2_000,
    // No placeholderData: a new key is a different pool, whose trades must never be shown as this one's.
    // Refresh failures keep the accumulated list (React Query keeps `data` on error).
    retry: 1,
  });
  return {
    feed: query.data,
    trades: query.data?.trades ?? EMPTY,
    /** Signatures new in the latest poll (row flash). */
    newSignatures: query.data?.fresh ?? NO_SIGNATURES,
    // React Query reports `null` when there is no error.
    error: query.error ?? undefined,
    isPending: query.isPending,
    isFetching: query.isFetching,
    enabled,
    query,
  };
}

const EMPTY: Trade[] = [];
const NO_SIGNATURES: ReadonlySet<string> = new Set();
