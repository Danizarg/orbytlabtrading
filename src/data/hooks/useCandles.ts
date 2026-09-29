'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useCapabilities } from '@/client/capabilities';
import { candleSeriesFromTrades, mergeCandles, sanitizeCandles, type LiveTick } from '@/lib/analytics/candles';
import { ChainError, runChain, type ChainAttempt, type ChainResult } from '@/lib/core/chain';
import type { ProviderId } from '@/lib/core/providers';
import { INTERVAL_SECONDS, type Candle, type CandleSeries, type Freshness, type Interval, type Trade } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import { applyTicks, intervalOptions, isGecko, tradeTicks, type CandleSourceKind, type IntervalOption } from '@/lib/services/token';
import { POLL } from '../query';
import { gecko, jup, server } from '../sources';

/**
 * Chart data for one pool and interval.
 *
 * - Native candles: ORBYT's candles route (keyed Birdeye / Solana Tracker /
 *   CoinGecko) for the intervals it serves, else GeckoTerminal OHLCV
 *   (1m–1d). Refreshed every 15 s (server) / 60 s (GeckoTerminal). Older
 *   history is paged on demand (`before` = first candle) into the query cache.
 * - Sub-minute intervals without a native source are aggregated by ORBYT from
 *   the real trade feed (`derivedFromTrades`, with provenance). Never synthetic.
 * - Live ticks move the last bar with real prices only: each realtime trade,
 *   the on-chain bonding-curve price, or Jupiter's price every 10 s.
 */

export const CANDLES_LIMIT = 300;
export const HISTORY_THROTTLE_MS = 1_500;

type NativeKind = 'server' | 'gecko';

export const candlesKey = (mint: string, pool: string | undefined, interval: Interval, kind: string) =>
  ['candles', mint, pool ?? '', interval, kind] as const;
export const candleHistoryKey = (mint: string, pool: string | undefined, interval: Interval, kind: string) =>
  ['candles-history', mint, pool ?? '', interval, kind] as const;
export const priceTickKey = (mint: string) => ['price-tick', mint] as const;

export interface HistoryPages {
  candles: Candle[];
  hasMore: boolean;
}

export function loadNativeCandles(
  input: { mint: string; pool: string | undefined; interval: Interval; kind: NativeKind; before?: number },
  signal?: AbortSignal,
): Promise<ChainResult<CandleSeries>> {
  const { mint, pool, interval, kind, before } = input;
  const query = { mint, pool, interval, before, limit: CANDLES_LIMIT };
  return runChain<CandleSeries>(
    'candles',
    [
      kind === 'server' && { id: 'orbyt', run: () => server.candles.getCandles(query, signal) },
      gecko.intervals.includes(interval) && { id: 'geckoterminal', run: () => gecko.getCandles(query, signal) },
    ],
    { signal },
  );
}

/** Jupiter Price V3 observation for a live tick when no realtime trade feed or curve exists. */
export function usePriceTick(mint: string, enabled: boolean) {
  return useQuery({
    queryKey: priceTickKey(mint),
    queryFn: async ({ signal }) => {
      const result = await jup.getPrices([mint], signal);
      const price = result.data[mint];
      if (price === undefined) throw new ProviderError('jupiter', 'not_found', 'jupiter: no price for this mint');
      return { price, at: result.fetchedAt };
    },
    enabled,
    refetchInterval: POLL.fast,
    staleTime: 5_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });
}

export interface CandlesInput {
  mint: string;
  pool: string | undefined;
  /** false once the pool list is known to be empty; undefined while loading. */
  hasPool: boolean | undefined;
  interval: Interval;
  /** Accumulated trade feed (derived intervals and realtime ticks). */
  trades: readonly Trade[];
  tradesEnabled: boolean;
  tradesRealtime: boolean;
  tradesFreshness?: Freshness;
  tradesFetchedAt?: number;
  /** On-chain bonding-curve price (USD) with its read time (UNIX seconds). */
  curveTick?: LiveTick;
  enabled?: boolean;
}

export interface CandleFeed {
  candles: Candle[];
  options: IntervalOption[];
  kind?: CandleSourceKind;
  available: boolean;
  reason: string;
  source?: ProviderId;
  freshness?: Freshness;
  fetchedAt?: number;
  pool?: string;
  derivation?: { trades: number; from: number; to: number };
  liveSource?: 'trades' | 'curve' | 'price';
  isPending: boolean;
  error: unknown;
  attempts: ChainAttempt[];
  notes: string[];
  loadOlder: () => void;
  hasMore: boolean;
  loadingOlder: boolean;
  intervalSec: number;
}

export function useCandles(input: CandlesInput): CandleFeed {
  const { mint, pool, hasPool, interval, trades, tradesEnabled, tradesRealtime, curveTick } = input;
  const enabled = input.enabled ?? true;
  const { serverCandles, serverSecondIntervals } = useCapabilities();
  const client = useQueryClient();

  const options = useMemo(
    () => intervalOptions({ serverCandles, serverSecondIntervals, geckoIntervals: gecko.intervals, hasPool, hasTradeFeed: tradesEnabled }),
    [serverCandles, serverSecondIntervals, hasPool, tradesEnabled],
  );
  const option = options.find((o) => o.interval === interval);
  const kind = option?.available ? option.kind : undefined;
  const nativeKind: NativeKind | undefined = kind === 'server' || kind === 'gecko' ? kind : undefined;
  // GeckoTerminal needs the pool address (it would spend a call finding one); the server route resolves it itself.
  const nativeEnabled = enabled && nativeKind !== undefined && (pool !== undefined || nativeKind === 'server');

  const keyKind = kind ?? 'none';
  const historyKey = useMemo(() => candleHistoryKey(mint, pool, interval, keyKind), [mint, pool, interval, keyKind]);

  const latest = useQuery({
    queryKey: candlesKey(mint, pool, interval, keyKind),
    queryFn: ({ signal }) => loadNativeCandles({ mint, pool, interval, kind: nativeKind ?? 'gecko' }, signal),
    enabled: nativeEnabled,
    refetchInterval: (query) => (query.state.data?.source === 'orbyt' ? 15_000 : POLL.slow),
    staleTime: 10_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });

  // Older pages accumulate in the cache (loadOlder writes them); the query itself only seeds the shape.
  const history = useQuery<HistoryPages>({
    queryKey: historyKey,
    queryFn: () => ({ candles: [], hasMore: true }),
    enabled: nativeEnabled,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  });

  const [loadingOlder, setLoadingOlder] = useState(false);
  const inFlight = useRef(false);
  const lastLoad = useRef(0);

  const historyCandles = history.data?.candles;
  const latestCandles = latest.data?.data.candles;
  const nativeCandles = useMemo(() => sanitizeCandles(mergeCandles(historyCandles ?? [], latestCandles ?? [])), [historyCandles, latestCandles]);
  const hasMore = nativeKind !== undefined && (history.data?.hasMore ?? true) && latest.data?.data.hasMore !== false;
  const firstTime = nativeCandles[0]?.time;

  const loadOlder = useCallback(() => {
    if (!nativeEnabled || !nativeKind || firstTime === undefined || !hasMore || inFlight.current) return;
    const now = Date.now();
    if (now - lastLoad.current < HISTORY_THROTTLE_MS) return;
    lastLoad.current = now;
    inFlight.current = true;
    setLoadingOlder(true);
    loadNativeCandles({ mint, pool, interval, kind: nativeKind, before: firstTime })
      .then((page) => {
        client.setQueryData<HistoryPages>(historyKey, (prev) => ({
          candles: mergeCandles(page.data.candles, prev?.candles ?? []),
          hasMore: page.data.candles.length > 0 && page.data.hasMore !== false,
        }));
      })
      .catch(() => {
        // Keep what is on screen; the next scroll past the left edge retries after the throttle.
      })
      .finally(() => {
        inFlight.current = false;
        setLoadingOlder(false);
      });
  }, [nativeEnabled, nativeKind, firstTime, hasMore, mint, pool, interval, client, historyKey]);

  const derived = useMemo(() => (kind === 'trades' ? candleSeriesFromTrades(trades, interval, pool) : undefined), [kind, trades, interval, pool]);

  const priceTick = usePriceTick(mint, enabled && nativeKind !== undefined && !tradesRealtime && !curveTick);
  const priceObservation = priceTick.data;

  const intervalSec = INTERVAL_SECONDS[interval];
  const seriesSource = latest.data?.source;
  const seriesFetchedAt = latest.data?.fetchedAt;

  const { candles, liveSource } = useMemo<{ candles: Candle[]; liveSource: CandleFeed['liveSource'] }>(() => {
    if (derived) return { candles: derived.candles, liveSource: undefined };
    const last = nativeCandles.at(-1);
    // A lone price observation is not a candle: with no native bars there is nothing honest to draw.
    if (!last) return { candles: nativeCandles, liveSource: undefined };
    let ticks: LiveTick[] = [];
    let liveSource: CandleFeed['liveSource'];
    if (tradesRealtime && trades.length) {
      ticks = tradeTicks(trades, last.time, seriesFetchedAt ?? 0);
      liveSource = 'trades';
    } else if (curveTick) {
      ticks = [curveTick];
      liveSource = 'curve';
    } else if (priceObservation) {
      ticks = [{ timeSec: Math.floor(priceObservation.at / 1000), price: priceObservation.price }];
      liveSource = 'price';
    }
    if (!ticks.length) return { candles: nativeCandles, liveSource: undefined };
    return { candles: applyTicks(nativeCandles, ticks, intervalSec, { open: isGecko(seriesSource) ? 'previousClose' : 'tick' }), liveSource };
  }, [derived, nativeCandles, tradesRealtime, trades, seriesFetchedAt, curveTick, priceObservation, intervalSec, seriesSource]);

  return {
    candles,
    options,
    kind,
    available: option?.available ?? false,
    reason: option?.reason ?? '',
    source: derived ? 'orbyt' : seriesSource,
    freshness: derived ? input.tradesFreshness : latest.data?.freshness,
    fetchedAt: derived ? input.tradesFetchedAt : seriesFetchedAt,
    pool: derived ? pool : (latest.data?.data.pool ?? pool),
    derivation: derived?.derivation,
    liveSource,
    isPending: nativeEnabled && latest.isPending,
    error: nativeKind ? latest.error : undefined,
    attempts: latest.data?.attempts ?? (latest.error instanceof ChainError ? latest.error.attempts : []),
    notes: latest.data?.notes ?? EMPTY_NOTES,
    loadOlder,
    hasMore,
    loadingOlder,
    intervalSec,
  };
}

const EMPTY_NOTES: string[] = [];
