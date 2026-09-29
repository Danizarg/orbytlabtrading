import { formatCompact, formatPrice } from '@/lib/core/format';
import type { Candle } from '@/lib/core/types';

/**
 * Pure helpers for the lightweight-charts price chart (unit tested in
 * format.test.ts). lightweight-charts constraints (docs/research/platform.json):
 * - times are UTC seconds, setData needs ascending unique times, update() may
 *   never go back in time;
 * - micro-prices need priceFormat { type: 'custom', base: 10^k } with an EXACT
 *   power of ten (1 / minMove is inexact for 1e-9 and throws 'unexpected base').
 */

/** Exact power of ten for the price-scale base: 10^k, k = −floor(log10(ref)) + 4, clamped to 2..18. */
export function priceScaleBase(reference: number | undefined): number {
  if (reference === undefined || !Number.isFinite(reference) || reference <= 0) return 100;
  const k = Math.max(2, Math.min(18, -Math.floor(Math.log10(reference)) + 4));
  return 10 ** k;
}

/** Axis / crosshair label for a USD price: subscript zero compression, 4 significant digits. */
export function formatAxisPrice(value: number): string {
  return formatPrice(value, { currency: false });
}

/** Axis label in market-cap mode: compact (1.23M). */
export function formatAxisMc(value: number): string {
  return formatCompact(value, 2);
}

/** Multiply OHLC by a positive factor (price → market cap with the token supply). Volume is unchanged. */
export function scaleCandles(candles: readonly Candle[], factor: number): Candle[] {
  if (!Number.isFinite(factor) || factor <= 0) return [];
  return candles.map((c) => ({ ...c, open: c.open * factor, high: c.high * factor, low: c.low * factor, close: c.close * factor }));
}

function sameBar(a: Candle | undefined, b: Candle | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;
}

/** How to move the chart from `prev` to `next` data. */
export type SeriesDelta =
  /** Nothing changed. */
  | { kind: 'same' }
  /** Only the last bar changed and/or up to a few bars were appended: series.update() from `from`. */
  | { kind: 'tail'; from: number }
  /** Anything else: setData. `prepended` = bars added before the previous first bar (to keep the user's view). */
  | { kind: 'reset'; prepended: number; appended: number };

const MAX_TAIL_APPEND = 5;

export function seriesDelta(prev: readonly Candle[], next: readonly Candle[]): SeriesDelta {
  const first = prev[0];
  if (!first) return { kind: 'reset', prepended: 0, appended: next.length };
  const offset = next.findIndex((c) => c.time === first.time);
  if (offset === 0 && next.length >= prev.length && next.length - prev.length <= MAX_TAIL_APPEND) {
    let stable = true;
    for (let i = 0; i < prev.length - 1; i++) {
      if (!sameBar(prev[i], next[i])) {
        stable = false;
        break;
      }
    }
    const last = prev.length - 1;
    // series.update() may never move back in time: a replaced last bar that starts earlier needs setData.
    const monotonic = (next[last]?.time ?? -Infinity) >= (prev[last]?.time ?? Infinity);
    if (stable && monotonic) {
      if (next.length === prev.length && sameBar(prev[last], next[last])) return { kind: 'same' };
      return { kind: 'tail', from: last };
    }
  }
  const prepended = offset > 0 ? offset : 0;
  return { kind: 'reset', prepended, appended: Math.max(0, next.length - prepended - prev.length) };
}

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Time-axis label in the viewer's local time zone (lightweight-charts itself
 * is UTC-only). `type` follows TickMarkType: 0 year, 1 month, 2 day, 3 time,
 * 4 time with seconds.
 */
export function localTickLabel(timeSec: number, type: number): string {
  const d = new Date(timeSec * 1000);
  switch (type) {
    case 0:
      return String(d.getFullYear());
    case 1:
      return MONTHS[d.getMonth()] ?? '';
    case 2:
      return `${d.getDate()} ${MONTHS[d.getMonth()] ?? ''}`;
    case 4:
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    default:
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}

/** Crosshair / legend time: local date and time, with seconds for sub-minute bars. */
export function localTimeLabel(timeSec: number, intervalSec: number): string {
  const d = new Date(timeSec * 1000);
  const date = `${d.getDate()} ${MONTHS[d.getMonth()] ?? ''} ${String(d.getFullYear()).slice(2)}`;
  if (intervalSec >= 86_400) return date;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}${intervalSec < 60 ? `:${pad(d.getSeconds())}` : ''}`;
  return `${date} ${time}`;
}
