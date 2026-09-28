import type { Candle, CandleSeries, Interval, Trade } from '@/lib/core/types';
import { INTERVAL_SECONDS } from '@/lib/core/types';
import { tradeUsdValue } from './trades';

/**
 * Candle construction and maintenance for lightweight-charts (v5).
 *
 * Chart constraints (live-verified, lightweight-charts 5.2.1):
 * - Times are UTCTimestamp SECONDS.
 * - `setData` needs strictly ascending, unique times; the check exists only in
 *   the development build, so production silently renders garbage. Always pass
 *   data through `sanitizeCandles` / `mergeCandles`.
 * - `series.update(bar)` replaces the last bar for an equal time and appends
 *   for a newer one; an OLDER time throws even in production, which is why
 *   `applyLiveTick` reports 'ignored' instead.
 *
 * Nothing here fills gaps: buckets without trades produce no candle (the chart
 * shows whitespace) rather than a flat, invented bar.
 */

const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function assertInterval(intervalSec: number): void {
  if (!isFiniteNumber(intervalSec) || intervalSec <= 0) {
    throw new RangeError(`candle interval must be a positive number of seconds, got ${String(intervalSec)}`);
  }
}

/** ms timestamp → chart time (UNIX seconds, floored). */
export function toChartTime(ms: number): number {
  return Math.floor(ms / 1000);
}

/** Bucket start (UNIX seconds) containing `timeSec`: floor(time / interval) × interval. */
export function bucketStart(timeSec: number, intervalSec: number): number {
  assertInterval(intervalSec);
  return Math.floor(timeSec / intervalSec) * intervalSec;
}

/** True when a candle can be charted as-is: finite positive prices, low ≤ open/close ≤ high. */
export function isValidCandle(c: Candle): boolean {
  if (!isFiniteNumber(c.time) || c.time <= 0) return false;
  const { open, high, low, close } = c;
  if (![open, high, low, close].every((v) => isFiniteNumber(v) && v > 0)) return false;
  return high >= Math.max(open, close) && low <= Math.min(open, close);
}

/**
 * Chart-safe candles: drops rows with non-finite / non-positive prices or
 * inconsistent OHLC (high below open/close, low above them) instead of
 * "repairing" real data; an invalid optional volume is removed from an
 * otherwise valid row. Output is ascending with unique times — for duplicate
 * times the LAST row in input order wins.
 */
export function sanitizeCandles(candles: readonly Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of candles) {
    if (!isValidCandle(c)) continue;
    let row = c;
    if (c.volume !== undefined && !(isFiniteNumber(c.volume) && c.volume >= 0)) {
      const { volume: _dropped, ...rest } = c;
      row = rest;
    }
    byTime.set(row.time, row);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Union by time (b wins on equal times), ascending. Used to prepend older
 * pages (`before` pagination) or overlay a fresher page onto history. Rows
 * with a non-finite time are dropped; OHLC is not otherwise validated.
 */
export function mergeCandles(a: readonly Candle[], b: readonly Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of a) if (isFiniteNumber(c.time)) byTime.set(c.time, c);
  for (const c of b) if (isFiniteNumber(c.time)) byTime.set(c.time, c);
  return [...byTime.values()].sort((x, y) => x.time - y.time);
}

/** Chronological (timestamp, signature) order; signature only breaks same-block ties deterministically. */
function compareChronological(a: Trade, b: Trade): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0;
}

function tradeKey(t: Trade): string {
  return [t.signature, t.side, t.wallet ?? '', t.tokenAmount ?? '', t.priceUsd ?? '', t.usdValue ?? ''].join('|');
}

/**
 * Aggregate real trades into OHLCV candles.
 * - Bucket = floor(timestamp / 1000 / interval) × interval (UNIX seconds).
 * - OHLC from each trade's execution `priceUsd`, in chronological order
 *   (same-second ties ordered by signature: intra-block order is unknown).
 *   Open is the bucket's first trade, not the previous close (the
 *   GeckoTerminal convention), so derived and provider bars can differ in open.
 * - Volume = sum of known USD values (`usdValue`, else priceUsd × tokenAmount);
 *   omitted for a bucket where no trade has one.
 * - Trades without a finite positive price or finite timestamp are skipped;
 *   exact duplicate rows (same signature, side, wallet, amounts, price) count once.
 * Output: ascending, unique times, no gap filling.
 */
export function aggregateTrades(trades: readonly Trade[], intervalSec: number, opts: { priceField?: 'priceUsd' } = {}): Candle[] {
  assertInterval(intervalSec);
  const field = opts.priceField ?? 'priceUsd';
  const seen = new Set<string>();
  const rows: Array<{ trade: Trade; price: number }> = [];
  for (const trade of trades) {
    const price = trade[field];
    if (!isFiniteNumber(price) || price <= 0 || !isFiniteNumber(trade.timestamp)) continue;
    const key = tradeKey(trade);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ trade, price });
  }
  rows.sort((x, y) => compareChronological(x.trade, y.trade));

  const candles: Candle[] = [];
  let current: Candle | undefined;
  for (const { trade, price } of rows) {
    const time = bucketStart(trade.timestamp / 1000, intervalSec);
    const usd = tradeUsdValue(trade);
    if (!current || current.time !== time) {
      current = { time, open: price, high: price, low: price, close: price };
      if (usd !== undefined) current.volume = usd;
      candles.push(current);
      continue;
    }
    current.high = Math.max(current.high, price);
    current.low = Math.min(current.low, price);
    current.close = price;
    if (usd !== undefined) current.volume = (current.volume ?? 0) + usd;
  }
  return candles;
}

/**
 * Candle series derived by ORBYT from real trades, with provenance so the UI
 * can label it ("built from N trades"). `from` / `to` are the covered trade
 * times (ms); `derivation` is omitted when no trade had a usable price.
 */
export function candleSeriesFromTrades(trades: readonly Trade[], interval: Interval, pool?: string): CandleSeries {
  const candles = aggregateTrades(trades, INTERVAL_SECONDS[interval]);
  const used = trades.filter((t) => isFiniteNumber(t.priceUsd) && t.priceUsd > 0 && isFiniteNumber(t.timestamp));
  const series: CandleSeries = { interval, candles, derivedFromTrades: true };
  if (pool) series.pool = pool;
  if (used.length) {
    let from = Infinity;
    let to = -Infinity;
    for (const t of used) {
      from = Math.min(from, t.timestamp);
      to = Math.max(to, t.timestamp);
    }
    series.derivation = { trades: new Set(used.map(tradeKey)).size, from, to };
  }
  return series;
}

export interface LiveTick {
  /** Trade / observation time, UNIX SECONDS. */
  timeSec: number;
  /** Execution price (same unit as the series). */
  price: number;
  /** USD volume of this trade, when known. */
  volumeUsd?: number;
}

export type LiveTickResult = { candles: Candle[]; changed: 'update' | 'append' | 'ignored' };

export interface LiveTickOptions {
  /**
   * How a newly appended candle opens:
   * - 'tick' (default): at the tick price — the first trade actually observed
   *   in that bucket. Nothing is carried over from earlier buckets.
   * - 'previousClose': at the previous candle's close (the last traded price
   *   when the bucket began), with high/low widened to include it. This is the
   *   convention of GeckoTerminal OHLCV (each candle opens at the prior close,
   *   verified on live data), so use it when extending a GeckoTerminal series
   *   to keep the live bar consistent with the bars the provider will return.
   */
  open?: 'tick' | 'previousClose';
}

/**
 * Apply one real trade / price observation to a candle array (immutable).
 *
 * - Same bucket as the last candle → 'update': close = price, high/low widened.
 *   Volume accumulates only when both the candle and the tick have one (a
 *   candle whose volume is unknown stays unknown rather than becoming a
 *   partial sum).
 * - Newer bucket → 'append' a new candle (open per `opts.open`, default the
 *   tick price). Skipped buckets are not filled.
 * - Older bucket (lightweight-charts would throw) or an invalid tick →
 *   'ignored', returning the same array instance.
 */
export function applyLiveTick(candles: Candle[], tick: LiveTick, intervalSec: number, opts: LiveTickOptions = {}): LiveTickResult {
  assertInterval(intervalSec);
  if (!isFiniteNumber(tick.timeSec) || !isFiniteNumber(tick.price) || tick.price <= 0) return { candles, changed: 'ignored' };
  const volume = isFiniteNumber(tick.volumeUsd) && tick.volumeUsd >= 0 ? tick.volumeUsd : undefined;
  const time = bucketStart(tick.timeSec, intervalSec);
  const last = candles.at(-1);

  if (!last || time > last.time) {
    const open = opts.open === 'previousClose' && last && isFiniteNumber(last.close) && last.close > 0 ? last.close : tick.price;
    const next: Candle = {
      time,
      open,
      high: Math.max(open, tick.price),
      low: Math.min(open, tick.price),
      close: tick.price,
    };
    if (volume !== undefined) next.volume = volume;
    return { candles: [...candles, next], changed: 'append' };
  }
  if (time < last.time) return { candles, changed: 'ignored' };

  const updated: Candle = {
    ...last,
    high: Math.max(last.high, tick.price),
    low: Math.min(last.low, tick.price),
    close: tick.price,
  };
  if (last.volume !== undefined && volume !== undefined) updated.volume = last.volume + volume;
  return { candles: [...candles.slice(0, -1), updated], changed: 'update' };
}
