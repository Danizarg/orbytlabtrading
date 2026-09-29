'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useCapabilities } from '@/client/capabilities';
import { candleSeriesFromTrades, mergeCandles, sanitizeCandles, type LiveTick } from '@/lib/analytics/candles';
import { ChainError, runChain, type ChainAttempt, type ChainResult } from '@/lib/core/chain';
import type { ProviderId } from '@/lib/core/providers';
import { INTERVAL_SECONDS, type Candle, type CandleSeries, type Freshness, type Interval, type Sourced, type Trade } from '@/lib/core/types';
import { PUBLIC_ENDPOINTS } from '@/lib/config/capabilities';
import { browserFetcher } from '@/lib/net/browser';
import { ProviderError } from '@/lib/net/errors';
import { GECKOTERMINAL_ACCEPT } from '@/lib/providers/geckoterminal';
import { parseOhlcv } from '@/lib/providers/geckoterminal/parse';
import {
  applyTicks,
  chartCurrencyOption,
  chainWinner,
  geckoQuoteOhlcvPath,
  intervalOptions,
  isGecko,
  pollForWinner,
  solPricedTrades,
  tradeTicks,
  usdToSol,
  type CandleSourceKind,
  type ChartCurrency,
  type CurrencyOption,
  type IntervalOption,
} from '@/lib/services/token';
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
 * - SOL mode (SOL-quoted pools only): GeckoTerminal quote-token OHLCV, or
 *   trade-built bars priced by each trade's SOL / token amounts. USD bars are
 *   never converted with today's SOL price.
 * - Live ticks move the last bar with real prices only: each realtime trade,
 *   the on-chain bonding-curve price, or Jupiter's price every 10 s.
 */

export const CANDLES_LIMIT = 300;
export const HISTORY_THROTTLE_MS = 1_500;

/** 'gecko-sol' = GeckoTerminal OHLCV priced in the pool's quote token (SOL). */
type NativeKind = 'server' | 'gecko' | 'gecko-sol';

export const candlesKey = (mint: string, pool: string | undefined, interval: Interval, kind: string) =>
  ['candles', mint, pool ?? '', interval, kind] as const;
export const candleHistoryKey = (mint: string, pool: string | undefined, interval: Interval, kind: string) =>
  ['candles-history', mint, pool ?? '', interval, kind] as const;
export const priceTickKey = (mint: string) => ['price-tick', mint] as const;

export interface HistoryPages {
  candles: Candle[];
  hasMore: boolean;
}

const GECKO_CACHE_MS = { latest: 15_000, history: 600_000 } as const;

/**
 * GeckoTerminal pool OHLCV in the quote token (SOL), through the browser
 * transport (GeckoTerminal budget, cooldowns, dedupe) and the adapter's own
 * OHLCV parser.
 */
export async function loadGeckoQuoteCandles(
  input: { mint: string; pool: string | undefined; interval: Interval; before?: number },
  signal?: AbortSignal,
): Promise<Sourced<CandleSeries>> {
  const { mint, pool, interval, before } = input;
  const path = pool ? geckoQuoteOhlcvPath({ pool, mint, interval, limit: CANDLES_LIMIT, before }) : undefined;
  if (!pool || !path) throw new ProviderError('geckoterminal', 'unsupported', `geckoterminal: ${interval} SOL candles need a SOL pool`);
  const payload = await browserFetcher<unknown>('geckoterminal', `${PUBLIC_ENDPOINTS.geckoTerminal}${path}`, {
    headers: { accept: GECKOTERMINAL_ACCEPT },
    label: `geckoterminal ohlcv ${interval} (SOL)`,
    cacheMs: before !== undefined ? GECKO_CACHE_MS.history : GECKO_CACHE_MS.latest,
    ...(signal ? { signal } : {}),
  });
  const { candles, rows } = parseOhlcv('geckoterminal', payload, 'geckoterminal ohlcv');
  return {
    data: { interval, candles: before !== undefined ? candles.filter((c) => c.time < before) : candles, pool, hasMore: rows >= CANDLES_LIMIT },
    source: 'geckoterminal',
    fetchedAt: Date.now(),
    freshness: 'indexed',
  };
}

export function loadNativeCandles(
  input: { mint: string; pool: string | undefined; interval: Interval; kind: NativeKind; before?: number },
  signal?: AbortSignal,
): Promise<ChainResult<CandleSeries>> {
  const { mint, pool, interval, kind, before } = input;
  const query = { mint, pool, interval, before, limit: CANDLES_LIMIT };
  if (kind === 'gecko-sol') {
    return runChain<CandleSeries>('candles', [{ id: 'geckoterminal', run: () => loadGeckoQuoteCandles({ mint, pool, interval, before }, signal) }], { signal });
  }
  return runChain<CandleSeries>(
    'candles',
    [
      kind === 'server' && { id: 'orbyt', run: () => server.candles.getCandles(query, signal) },
      gecko.intervals.includes(interval) && { id: 'geckoterminal', run: () => gecko.getCandles(query, signal) },
    ],
    { signal },
  );
}

/** A real USD price observation with its fetch time (ms). */
export interface PriceObservation {
  price: number;
  at: number;
}

/**
 * Jupiter Price V3 observation for a live tick when no realtime trade feed,
 * curve or fresh Jupiter-backed token row exists. A mint Jupiter does not
 * price is re-checked once a minute, not every 10 s (budget: 4 calls / 10 s).
 */
export function usePriceTick(mint: string, enabled: boolean) {
  return useQuery<PriceObservation>({
    queryKey: priceTickKey(mint),
    queryFn: async ({ signal }) => {
      const result = await jup.getPrices([mint], signal);
      const price = result.data[mint];
      if (price === undefined) throw new ProviderError('jupiter', 'not_found', 'jupiter: no price for this mint');
      return { price, at: result.fetchedAt };
    },
    enabled,
    refetchInterval: (query) => (query.state.status === 'error' ? POLL.slow : POLL.fast),
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
  /** Requested currency; falls back to USD where SOL candles are unavailable. */
  currency?: ChartCurrency;
  /** The charted pool is quoted in SOL. */
  quoteIsSol?: boolean;
  /** Live SOL/USD, only to express Jupiter's live USD price tick in SOL. */
  solUsd?: number;
  /** Accumulated trade feed (derived intervals and realtime ticks). */
  trades: readonly Trade[];
  tradesEnabled: boolean;
  tradesRealtime: boolean;
  tradesFreshness?: Freshness;
  tradesFetchedAt?: number;
  /** On-chain bonding-curve price (USD) with its read time (UNIX seconds). */
  curveTick?: LiveTick;
  /** The same curve read priced in SOL (SOL-quoted curves only). */
  curveTickSol?: LiveTick;
  /**
   * The token row's USD price when Jupiter or ORBYT's route answered it (10 s
   * poll). Used as the live tick instead of a second Jupiter price request.
   */
  rowPrice?: PriceObservation;
  /**
   * Token-level (aggregate) prices may move the last bar. False when the user
   * pinned a specific pool: its bars must only move with that pool's trades.
   */
  aggregateTicks?: boolean;
  enabled?: boolean;
}

export interface CandleFeed {
  candles: Candle[];
  options: IntervalOption[];
  kind?: CandleSourceKind;
  /** Currency actually shown. */
  currency: ChartCurrency;
  currencyOption: CurrencyOption;
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
  const { mint, pool, hasPool, interval, trades, tradesEnabled, tradesRealtime, solUsd } = input;
  const enabled = input.enabled ?? true;
  const { serverCandles, serverSecondIntervals } = useCapabilities();
  const client = useQueryClient();

  const options = useMemo(
    () => intervalOptions({ serverCandles, serverSecondIntervals, geckoIntervals: gecko.intervals, hasPool, hasTradeFeed: tradesEnabled }),
    [serverCandles, serverSecondIntervals, hasPool, tradesEnabled],
  );
  const option = options.find((o) => o.interval === interval);
  const kind = option?.available ? option.kind : undefined;

  const currencyOption = useMemo(
    () => chartCurrencyOption({ quoteIsSol: input.quoteIsSol ?? false, kind, interval, geckoIntervals: gecko.intervals }),
    [input.quoteIsSol, kind, interval],
  );
  const currency: ChartCurrency = input.currency === 'sol' && currencyOption.available ? 'sol' : 'usd';
  const sol = currency === 'sol';

  const nativeKind: NativeKind | undefined = kind === 'server' || kind === 'gecko' ? (sol ? 'gecko-sol' : kind) : undefined;
  // GeckoTerminal needs the pool address (it would spend a call finding one); the server route resolves it itself.
  const nativeEnabled = enabled && nativeKind !== undefined && (pool !== undefined || nativeKind === 'server');

  const keyKind = nativeKind ?? kind ?? 'none';
  const historyKey = useMemo(() => candleHistoryKey(mint, pool, interval, keyKind), [mint, pool, interval, keyKind]);

  const latest = useQuery({
    queryKey: candlesKey(mint, pool, interval, keyKind),
    queryFn: ({ signal }) => loadNativeCandles({ mint, pool, interval, kind: nativeKind ?? 'gecko' }, signal),
    enabled: nativeEnabled,
    // The chain winner, not `source`: the server route reports its upstream provider (e.g. 'birdeye') as the source.
    refetchInterval: (query) => pollForWinner(chainWinner(query.state.data), 15_000, POLL.slow),
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

  // keepPreviousData can briefly hold another series (e.g. USD while SOL loads): never mix units.
  const latestData = latest.data && !latest.isPlaceholderData ? latest.data : undefined;
  const historyCandles = history.data?.candles;
  const latestCandles = latestData?.data.candles;
  const nativeCandles = useMemo(() => sanitizeCandles(mergeCandles(historyCandles ?? [], latestCandles ?? [])), [historyCandles, latestCandles]);
  const hasMore = nativeKind !== undefined && (history.data?.hasMore ?? true) && latestData?.data.hasMore !== false;
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

  // Trades in the shown currency (SOL mode: priced by their own SOL / token amounts, volume in SOL).
  const pricedTrades = useMemo(() => (sol ? solPricedTrades(trades) : trades), [sol, trades]);
  const derived = useMemo(() => (kind === 'trades' ? candleSeriesFromTrades(pricedTrades, interval, pool) : undefined), [kind, pricedTrades, interval, pool]);

  const aggregateTicks = input.aggregateTicks ?? true;
  const curveTick = aggregateTicks ? (sol ? input.curveTickSol : input.curveTick) : undefined;
  const rowPrice = aggregateTicks ? input.rowPrice : undefined;
  const priceTick = usePriceTick(mint, enabled && aggregateTicks && nativeKind !== undefined && !tradesRealtime && !curveTick && !rowPrice);
  const priceObservation = rowPrice ?? (priceTick.isPlaceholderData ? undefined : priceTick.data);

  const intervalSec = INTERVAL_SECONDS[interval];
  const seriesSource = latestData?.source;
  const seriesFetchedAt = latestData?.fetchedAt;

  const { candles, liveSource } = useMemo<{ candles: Candle[]; liveSource: CandleFeed['liveSource'] }>(() => {
    if (derived) return { candles: derived.candles, liveSource: undefined };
    const last = nativeCandles.at(-1);
    // A lone price observation is not a candle: with no native bars there is nothing honest to draw.
    if (!last) return { candles: nativeCandles, liveSource: undefined };
    let ticks: LiveTick[] = [];
    let liveSource: CandleFeed['liveSource'];
    if (tradesRealtime && pricedTrades.length) {
      ticks = tradeTicks(pricedTrades, last.time, seriesFetchedAt ?? 0);
      liveSource = 'trades';
    } else if (curveTick) {
      ticks = [curveTick];
      liveSource = 'curve';
    } else if (priceObservation) {
      const price = sol ? usdToSol(priceObservation.price, solUsd) : priceObservation.price;
      if (price !== undefined) {
        ticks = [{ timeSec: Math.floor(priceObservation.at / 1000), price }];
        liveSource = 'price';
      }
    }
    if (!ticks.length) return { candles: nativeCandles, liveSource: undefined };
    return { candles: applyTicks(nativeCandles, ticks, intervalSec, { open: isGecko(seriesSource) ? 'previousClose' : 'tick' }), liveSource };
  }, [derived, nativeCandles, tradesRealtime, pricedTrades, seriesFetchedAt, curveTick, priceObservation, sol, solUsd, intervalSec, seriesSource]);

  return {
    candles,
    options,
    kind,
    currency,
    currencyOption,
    available: option?.available ?? false,
    reason: option?.reason ?? '',
    source: derived ? 'orbyt' : seriesSource,
    freshness: derived ? input.tradesFreshness : latestData?.freshness,
    fetchedAt: derived ? input.tradesFetchedAt : seriesFetchedAt,
    pool: derived ? pool : (latestData?.data.pool ?? pool),
    derivation: derived?.derivation,
    liveSource,
    // Still waiting also covers a native source that cannot start yet (pool or saved settings not known):
    // an empty chart must not read as "no candles" before anything was asked.
    isPending: nativeKind !== undefined && (latest.isPending || latest.isPlaceholderData) && !nativeCandles.length,
    // React Query reports `null` when there is no error.
    error: nativeKind ? (latest.error ?? undefined) : undefined,
    attempts: latestData?.attempts ?? (latest.error instanceof ChainError ? latest.error.attempts : []),
    notes: latestData?.notes ?? EMPTY_NOTES,
    loadOlder,
    hasMore,
    loadingOlder,
    intervalSec,
  };
}

const EMPTY_NOTES: string[] = [];
