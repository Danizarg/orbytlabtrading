'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCapabilities } from '@/client/capabilities';
import { candleSeriesFromTrades, mergeCandles, sanitizeCandles, type LiveTick } from '@/lib/analytics/candles';
import { ChainError, runChain, type ChainAttempt, type ChainResult } from '@/lib/core/chain';
import type { ProviderId } from '@/lib/core/providers';
import { INTERVAL_SECONDS, type Candle, type CandleSeries, type Freshness, type Interval, type Sourced, type Trade } from '@/lib/core/types';
import { PUBLIC_ENDPOINTS } from '@/lib/config/capabilities';
import { browserFetcher } from '@/lib/net/browser';
import { ProviderError } from '@/lib/net/errors';
import { onchainHistoryComplete, selectCandleSource, solChartTrades, withOnchainIntervals, type CandleFallbackReason } from '@/lib/onchain/candleFallback';
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
  SECOND_INTERVALS,
  tradeTicks,
  usdToSol,
  type CandleSourceKind,
  type ChartCurrency,
  type CurrencyOption,
  type IntervalOption,
} from '@/lib/services/token';
import { POLL } from '../query';
import { gecko, isServerStale, jup, runWithServerFallback, server } from '../sources';

/**
 * Chart data for one pool and interval.
 *
 * - Native candles: ORBYT's candles route (keyed Birdeye / Solana Tracker /
 *   CoinGecko) for the intervals it serves, else GeckoTerminal OHLCV
 *   (1m–1d). Refreshed every 15 s (server) / 60 s (GeckoTerminal). Older
 *   history is paged on demand (`before` = first candle) into the query cache.
 * - Sub-minute intervals without a native source are aggregated by ORBYT from
 *   the real trade feed (`derivedFromTrades`, with provenance). Never synthetic.
 * - On-chain fallback (trades from the on-chain feed): any interval charts
 *   from real trades when the native source cannot (no indexed pool, "not
 *   found", no candles, or a failure while ≥ 2 trades are in hand), or when
 *   the on-chain history reaches back further than the native series (a pool
 *   younger than the indexer's coverage). See selectCandleSource. For such
 *   pools (and pump.fun curves / pools under 30 min old) the feed also pages
 *   older history (up to ~300 transactions) so the chart covers the pool's
 *   whole short life.
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
  const geckoServes = gecko.intervals.includes(interval);
  return runWithServerFallback<CandleSeries>(
    'candles',
    [
      kind === 'server' && { id: 'orbyt', run: () => server.candles.getCandles(query, signal) },
      geckoServes && { id: 'geckoterminal', run: () => gecko.getCandles(query, signal) },
    ],
    // ORBYT's keyless candles route (GeckoTerminal fetched by the server, CDN-cached) after a real browser failure,
    // e.g. this visitor's GeckoTerminal quota is spent; never after "not found" (the server would ask the same index).
    kind === 'gecko' && geckoServes && server.candlesKeyless.intervals.includes(interval) && { id: 'orbyt', run: () => server.candlesKeyless.getCandles(query, signal) },
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
  /** Exact SOL price per trade from the on-chain feed (signature → SOL): SOL bars on the basis of the USD ones. */
  tradeSolPrices?: ReadonlyMap<string, number>;
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
  /**
   * The trades come from the on-chain feed of the charted pool: they may stand
   * in for native candles (see selectCandleSource) and page older history.
   */
  onchain?: OnchainCandleSource;
  /** Pool creation time (ms) when a provider reports it: pools under 30 min load their older on-chain history. */
  poolCreatedAt?: number;
  enabled?: boolean;
}

/** What useCandles needs from the on-chain trade feed (useTrades' `feed.onchain`). */
export interface OnchainCandleSource {
  /** The feed reads a pump.fun bonding curve (a young pool by nature). */
  pumpCurve: boolean;
  /** The listing reached the pool's first transaction. */
  exhausted: boolean;
  /** Every trade since the pool's first transaction is held. */
  complete: boolean;
  historyLoading: boolean;
  /** The history walk finished (possibly capped before the pool's first transaction). */
  historyDone: boolean;
  /** Signatures listed so far. */
  listed: number;
  /** Listed successful transactions the feed could not load (> 0: the trades are a subset, never "complete"). */
  missed?: number;
  loadHistory: () => void;
}

/** Pools younger than this page their on-chain history for the chart. */
export const YOUNG_POOL_MS = 30 * 60_000;

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
  /** Why trade-built bars stand in for the native source (undefined: native, or a sub-minute trade interval). */
  fallback?: CandleFallbackReason;
  /** Trade-built bars come from the on-chain feed. */
  fromOnchain: boolean;
  /** On-chain transactions of the pool the feed listed but could not load: trade-built bars are drawn from a subset. */
  missedTrades: number;
  /** Older on-chain history is being fetched for this chart. */
  historyLoading: boolean;
  /** Native bars on screen are older than they should be (a failed refresh, or ORBYT served its last good response). */
  delayed: boolean;
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
  const { mint, pool, hasPool, interval, trades, tradesEnabled, tradesRealtime, solUsd, onchain, poolCreatedAt } = input;
  const enabled = input.enabled ?? true;
  const { serverCandles, serverSecondIntervals } = useCapabilities();
  const client = useQueryClient();
  const onchainOn = !!onchain && tradesEnabled;

  const options = useMemo(
    () =>
      withOnchainIntervals(
        intervalOptions({ serverCandles, serverSecondIntervals, geckoIntervals: gecko.intervals, hasPool, hasTradeFeed: tradesEnabled }),
        onchainOn,
      ),
    [serverCandles, serverSecondIntervals, hasPool, tradesEnabled, onchainOn],
  );
  const option = options.find((o) => o.interval === interval);
  /** Source configured for the interval; trade-built bars may still stand in for a native one (`decision`). */
  const staticKind = option?.available ? option.kind : undefined;

  const currencyOption = useMemo(
    () => chartCurrencyOption({ quoteIsSol: input.quoteIsSol ?? false, kind: staticKind, interval, geckoIntervals: gecko.intervals }),
    [input.quoteIsSol, staticKind, interval],
  );
  const currency: ChartCurrency = input.currency === 'sol' && currencyOption.available ? 'sol' : 'usd';
  const sol = currency === 'sol';

  const nativeKind: NativeKind | undefined = staticKind === 'server' || staticKind === 'gecko' ? (sol ? 'gecko-sol' : staticKind) : undefined;
  // GeckoTerminal needs the pool address (it would spend a call finding one); the server route resolves it itself.
  const nativeEnabled = enabled && nativeKind !== undefined && (pool !== undefined || nativeKind === 'server');

  const keyKind = nativeKind ?? staticKind ?? 'none';
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

  // Trades in the shown currency (SOL mode: volume in SOL; priced by the on-chain feed's exact SOL price on the basis
  // of the USD price, else by the trade's own SOL / token amounts).
  const tradeSolPrices = input.tradeSolPrices;
  const pricedTrades = useMemo(() => (sol ? solChartTrades(trades, tradeSolPrices) : trades), [sol, trades, tradeSolPrices]);
  // Aggregated whenever trade-built bars are (or may become) the chart: a trade interval, or an on-chain feed standing by.
  const tradeSeries = useMemo(
    () => (staticKind === 'trades' || onchainOn ? candleSeriesFromTrades(pricedTrades, interval, pool) : undefined),
    [staticKind, onchainOn, pricedTrades, interval, pool],
  );

  const nativePending = latest.isPending || latest.isPlaceholderData;
  const nativeError = latest.error ?? undefined;
  const onchainMissed = onchain?.missed ?? 0;
  // Never "complete" while listed transactions are missing (a busy pool outran the RPC budget).
  const onchainComplete = onchainHistoryComplete(onchain);
  const onchainYoung = !!onchain && (onchain.pumpCurve || onchain.exhausted);
  const decision = useMemo<{ source: 'native' | 'trades'; reason?: CandleFallbackReason }>(() => {
    if (staticKind === 'trades') {
      // A minute interval with no native source at all (no indexed pool) is itself a fallback.
      return onchainOn && !SECOND_INTERVALS.includes(interval) ? { source: 'trades', reason: 'no-native' } : { source: 'trades' };
    }
    // Saved settings not applied yet, or no trades from the chain to stand in: the native source as configured.
    if (!enabled || !onchainOn || nativeKind === undefined) return { source: 'native' };
    return selectCandleSource(
      { enabled: nativeEnabled, pending: nativePending, candles: nativeCandles, error: nativeError },
      { available: true, count: tradeSeries?.derivation?.trades ?? 0, fromMs: tradeSeries?.derivation?.from, complete: onchainComplete, young: onchainYoung },
    );
  }, [staticKind, onchainOn, interval, enabled, nativeKind, nativeEnabled, nativePending, nativeCandles, nativeError, tradeSeries, onchainComplete, onchainYoung]);
  const kind: CandleSourceKind | undefined = decision.source === 'trades' ? 'trades' : staticKind;
  const derived = kind === 'trades' ? tradeSeries : undefined;

  // Young pools (pump.fun curves, pools under 30 min, or any pool the indexer does not chart yet) page their older
  // on-chain history so trade-built bars can cover the pool's whole life. Paced by the feed's RPC budget.
  const loadHistory = onchain?.loadHistory;
  const historyWanted = onchainOn && !(onchain?.complete ?? false) && !(onchain?.historyDone ?? false);
  const historyBusy = onchain?.historyLoading ?? false;
  const fallbackReason = decision.reason;
  const pumpCurve = onchain?.pumpCurve ?? false;
  useEffect(() => {
    if (!enabled || !historyWanted || historyBusy || !loadHistory) return;
    const young = pumpCurve || (poolCreatedAt !== undefined && Date.now() - poolCreatedAt < YOUNG_POOL_MS);
    // Trade-built bars standing in for the indexer should cover as much of the pool's life as the budget allows.
    if (young || fallbackReason !== undefined) loadHistory();
  }, [enabled, historyWanted, historyBusy, loadHistory, pumpCurve, poolCreatedAt, fallbackReason]);

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

  // Scrolling past the left edge of trade-built bars asks the on-chain feed for older history.
  const tradesHasMore = kind === 'trades' && historyWanted;
  const loadOlderTrades = useCallback(() => loadHistory?.(), [loadHistory]);

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
    fallback: decision.reason,
    fromOnchain: !!derived && onchainOn,
    missedTrades: derived && onchainOn ? onchainMissed : 0,
    historyLoading: !!derived && historyBusy,
    delayed: kind !== 'trades' && nativeCandles.length > 0 && (latest.isRefetchError || isServerStale(latestData)),
    liveSource,
    // Still waiting also covers a native source that cannot start yet (pool or saved settings not known):
    // an empty chart must not read as "no candles" before anything was asked.
    isPending: kind !== 'trades' && nativeKind !== undefined && nativePending && !nativeCandles.length,
    // React Query reports `null` when there is no error. Trade-built bars in place of a failed native
    // source are not an error state (the failure stays listed in `attempts`).
    error: kind !== 'trades' && nativeKind ? nativeError : undefined,
    attempts: latestData?.attempts ?? (latest.error instanceof ChainError ? latest.error.attempts : []),
    notes: latestData?.notes ?? EMPTY_NOTES,
    loadOlder: kind === 'trades' ? loadOlderTrades : loadOlder,
    hasMore: kind === 'trades' ? tradesHasMore : hasMore,
    loadingOlder: kind === 'trades' ? historyBusy : loadingOlder,
    intervalSec,
  };
}

const EMPTY_NOTES: string[] = [];
