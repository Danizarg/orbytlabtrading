'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCapabilities } from '@/client/capabilities';
import { mergeTrades, newTradesSince } from '@/lib/analytics/trades';
import { runChain, type ChainAttempt } from '@/lib/core/chain';
import type { ProviderId } from '@/lib/core/providers';
import type { Freshness, Trade } from '@/lib/core/types';
import { POLL } from '../query';
import { gecko, server } from '../sources';

/**
 * Accumulated trade feed for one pool. Sources (failover): ORBYT's trades
 * route when a keyed RPC / indexer backs it (polled every 3 s, freshness
 * realtime / fast), else GeckoTerminal pool trades (polled every 30 s,
 * 'indexed', ~30 s delayed). Each poll merges into the list already in the
 * query cache (deduplicated by signature, newest first, capped), so the feed
 * only grows while the page is open and never blanks when a refresh fails.
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
  input: { mint: string; pool: string | undefined; serverTrades: boolean; previous: TradeFeed | undefined },
  signal?: AbortSignal,
): Promise<TradeFeed> {
  const { mint, pool, serverTrades, previous } = input;
  const result = await runChain<Trade[]>(
    'trades',
    [
      serverTrades && { id: 'orbyt', run: () => server.trades.getTrades({ mint, pool, limit: 100 }, signal) },
      !!pool && { id: 'geckoterminal', run: () => gecko.getTrades({ mint, pool, limit: TRADES_CAP }, signal) },
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

/** Poll at the winning source's cadence; while nothing has answered, retry at the fastest configured cadence. */
export function tradesPollInterval(feed: TradeFeed | undefined, serverTrades: boolean): number {
  if (!feed) return serverTrades ? 5_000 : POLL.indexed;
  return feed.source === 'orbyt' && feed.realtime ? POLL.realtime : POLL.indexed;
}

export function useTrades(mint: string, pool: string | undefined) {
  const { serverTrades } = useCapabilities();
  const key = tradesKey(mint, pool, serverTrades);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal, client }) => loadTradeFeed({ mint, pool, serverTrades, previous: client.getQueryData<TradeFeed>(key) }, signal),
    enabled: !!pool || serverTrades,
    refetchInterval: (q) => tradesPollInterval(q.state.data, serverTrades),
    staleTime: 2_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });
  return {
    feed: query.data,
    trades: query.data?.trades ?? EMPTY,
    error: query.error,
    isPending: query.isPending,
    isFetching: query.isFetching,
    enabled: !!pool || serverTrades,
    query,
  };
}

const EMPTY: Trade[] = [];
