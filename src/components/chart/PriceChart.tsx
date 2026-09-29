'use client';

import type { CandlestickData, HistogramData, IChartApi, ISeriesApi, MouseEventParams, UTCTimestamp, WhitespaceData } from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/components/ui/cn';
import { DASH, formatCompact, formatPct } from '@/lib/core/format';
import type { Candle } from '@/lib/core/types';
import { describeError } from '@/lib/net/errors';
import type { ChartCurrency } from '@/lib/services/token';
import { formatAxisMc, formatAxisPrice, localTickLabel, localTimeLabel, priceScaleBase, seriesDelta } from './format';

/**
 * TradingView Lightweight Charts (v5) candlestick + volume chart.
 *
 * - The library is imported dynamically inside the effect, so it never blocks
 *   first paint; `chart.remove()` on cleanup keeps StrictMode double-mounts safe.
 * - `candles` must be ascending with unique times (the data layer guarantees
 *   it). Updates are applied as deltas: a changed last bar or a few appended
 *   bars go through `series.update`, anything else through `setData` with the
 *   visible range restored (shifted by the number of prepended history bars),
 *   so the user's zoom survives refreshes. A new `seriesKey` refits.
 * - Micro-prices use a custom price format with an exact power-of-ten base
 *   recomputed from the last close (see format.ts).
 * - Times render in the viewer's zone through the localization hooks; the
 *   TradingView attribution logo stays on (licence).
 */

export type ChartMode = 'price' | 'mc';

export interface PriceChartProps {
  candles: readonly Candle[];
  intervalSec: number;
  /** Identity of the series (mint · pool · interval): a change refits the view. */
  seriesKey: string;
  mode: ChartMode;
  /** Unit of prices and volume ('sol': bars and volume are in SOL). */
  currency: ChartCurrency;
  logScale: boolean;
  /** Counters: bump to fit all bars, scroll to the newest bar or restore auto-scale. */
  fitSignal: number;
  realtimeSignal: number;
  autoscaleSignal: number;
  /** Called (throttled by the caller) when the user scrolls near the oldest bar. */
  onNeedHistory?: () => void;
  className?: string;
}

interface Legend {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface ChartHandles {
  chart: IChartApi;
  candles: ISeriesApi<'Candlestick'>;
  volume: ISeriesApi<'Histogram'>;
  logMode: number;
  normalMode: number;
}

interface Theme {
  panel: string;
  panel3: string;
  line: string;
  lineStrong: string;
  muted: string;
  fgDim: string;
  up: string;
  down: string;
  font: string;
}

function cssVar(el: Element, name: string, fallback: string): string {
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  return value || fallback;
}

function readTheme(el: Element): Theme {
  const root = el.ownerDocument.documentElement;
  return {
    panel: cssVar(root, '--color-panel', '#101116'),
    panel3: cssVar(root, '--color-panel-3', '#1b1c25'),
    line: cssVar(root, '--color-line', '#22232c'),
    lineStrong: cssVar(root, '--color-line-strong', '#30323e'),
    muted: cssVar(root, '--color-muted', '#7d8092'),
    fgDim: cssVar(root, '--color-fg-dim', '#b4b6c6'),
    up: cssVar(root, '--color-up', '#69e6b2'),
    down: cssVar(root, '--color-down', '#fa788d'),
    font: cssVar(root, '--font-sans', 'ui-sans-serif, system-ui, sans-serif'),
  };
}

/** #rrggbb → rgba(); other colour formats pass through untouched. */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m || !m[1]) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const toBar = (c: Candle): CandlestickData<UTCTimestamp> => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close });

/** Unknown volume is a whitespace point (no bar, legend "—"), never a zero bar. */
function toVolume(c: Candle, up: string, down: string): HistogramData<UTCTimestamp> | WhitespaceData<UTCTimestamp> {
  if (c.volume === undefined || !Number.isFinite(c.volume)) return { time: c.time as UTCTimestamp };
  return { time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? up : down };
}

/** Bars from the left edge at which older history is requested. */
const HISTORY_EDGE_BARS = 12;

/** Pointer / wheel / touch input on the chart: only a user's own pan or zoom pages in older history. */
const INTERACTION_EVENTS = ['pointerdown', 'wheel', 'touchstart'] as const;

export function PriceChart({ candles, intervalSec, seriesKey, mode, currency, logScale, fitSignal, realtimeSignal, autoscaleSignal, onNeedHistory, className }: PriceChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const handles = useRef<ChartHandles | null>(null);
  const theme = useRef<Theme | null>(null);
  const applied = useRef<{ key: string; candles: readonly Candle[]; base: number; unit: string }>({ key: '', candles: [], base: 0, unit: '' });
  const intervalRef = useRef(intervalSec);
  const historyRef = useRef(onNeedHistory);
  const legendNext = useRef<Legend | null>(null);
  // Programmatic fits also move the visible range to the first bar; history loads only after the user pans / zooms.
  const interacted = useRef(false);
  const [ready, setReady] = useState(0);
  const [legend, setLegend] = useState<Legend | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    intervalRef.current = intervalSec;
    historyRef.current = onNeedHistory;
  }, [intervalSec, onNeedHistory]);

  // Create the chart once; the library loads on demand.
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    let disposed = false;
    let chart: IChartApi | undefined;
    let raf = 0;
    const markInteraction = () => {
      interacted.current = true;
    };
    for (const type of INTERACTION_EVENTS) el.addEventListener(type, markInteraction, { passive: true, capture: true });

    import('lightweight-charts')
      .then((lib) => {
        if (disposed) return;
        const t = readTheme(el);
        theme.current = t;
        chart = lib.createChart(el, {
          autoSize: true,
          layout: {
            background: { type: lib.ColorType.Solid, color: t.panel },
            textColor: t.muted,
            fontSize: 11,
            fontFamily: t.font,
            attributionLogo: true,
          },
          grid: { vertLines: { color: withAlpha(t.line, 0.6) }, horzLines: { color: withAlpha(t.line, 0.6) } },
          crosshair: {
            mode: lib.CrosshairMode.Normal,
            vertLine: { color: t.lineStrong, labelBackgroundColor: t.panel3 },
            horzLine: { color: t.lineStrong, labelBackgroundColor: t.panel3 },
          },
          rightPriceScale: { borderColor: t.line, scaleMargins: { top: 0.08, bottom: 0.22 } },
          timeScale: {
            borderColor: t.line,
            timeVisible: true,
            secondsVisible: false,
            rightOffset: 6,
            tickMarkFormatter: (time: unknown, type: number) => (typeof time === 'number' ? localTickLabel(time, type) : ''),
          },
          localization: {
            locale: 'en-US',
            timeFormatter: (time: unknown) => (typeof time === 'number' ? localTimeLabel(time, intervalRef.current) : ''),
          },
        });
        const candleSeries = chart.addSeries(lib.CandlestickSeries, {
          upColor: t.up,
          downColor: t.down,
          wickUpColor: t.up,
          wickDownColor: t.down,
          borderVisible: false,
          priceLineVisible: true,
          lastValueVisible: true,
          priceFormat: { type: 'custom', formatter: formatAxisPrice, base: 100 },
        });
        const volumeSeries = chart.addSeries(lib.HistogramSeries, {
          priceFormat: { type: 'volume' },
          priceScaleId: '',
          lastValueVisible: false,
          priceLineVisible: false,
        });
        volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

        const onMove = (param: MouseEventParams) => {
          const bar = param.time !== undefined ? (param.seriesData.get(candleSeries) as CandlestickData<UTCTimestamp> | undefined) : undefined;
          const vol = param.time !== undefined ? (param.seriesData.get(volumeSeries) as Partial<HistogramData<UTCTimestamp>> | undefined) : undefined;
          const volume = typeof vol?.value === 'number' && Number.isFinite(vol.value) ? vol.value : undefined;
          legendNext.current = bar
            ? { time: Number(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close, ...(volume !== undefined ? { volume } : {}) }
            : null;
          if (!raf) {
            raf = requestAnimationFrame(() => {
              raf = 0;
              setLegend(legendNext.current);
            });
          }
        };
        chart.subscribeCrosshairMove(onMove);
        chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
          if (range && interacted.current && range.from < HISTORY_EDGE_BARS) historyRef.current?.();
        });

        handles.current = {
          chart,
          candles: candleSeries,
          volume: volumeSeries,
          logMode: lib.PriceScaleMode.Logarithmic,
          normalMode: lib.PriceScaleMode.Normal,
        };
        setReady((n) => n + 1);
      })
      .catch((error: unknown) => {
        if (!disposed) setLoadError(describeError(error));
      });

    return () => {
      disposed = true;
      for (const type of INTERACTION_EVENTS) el.removeEventListener(type, markInteraction, { capture: true });
      if (raf) cancelAnimationFrame(raf);
      chart?.remove();
      handles.current = null;
      applied.current = { key: '', candles: [], base: 0, unit: '' };
    };
  }, []);

  // Data: deltas keep the view; a new series or first data fits the content.
  useEffect(() => {
    const h = handles.current;
    const t = theme.current;
    if (!h || !t) return;
    const prev = applied.current;
    const last = candles.at(-1);

    if (last) {
      const unit = `${mode}:${currency}`;
      const base = mode === 'mc' ? 100 : priceScaleBase(last.close);
      if (base !== prev.base || unit !== prev.unit) {
        h.candles.applyOptions({ priceFormat: { type: 'custom', formatter: mode === 'mc' ? formatAxisMc : formatAxisPrice, base } });
        prev.base = base;
      }
      if (unit !== prev.unit) {
        // Price ↔ MC or USD ↔ SOL rescales every value: re-fit the price axis, keep the time range.
        if (prev.unit) h.chart.priceScale('right').applyOptions({ autoScale: true });
        prev.unit = unit;
      }
    }

    const sameSeries = prev.key === seriesKey;
    const delta = sameSeries ? seriesDelta(prev.candles, candles) : ({ kind: 'reset', prepended: 0, appended: candles.length } as const);
    if (delta.kind === 'same') return;

    const upVol = withAlpha(t.up, 0.45);
    const downVol = withAlpha(t.down, 0.45);
    if (delta.kind === 'tail') {
      for (let i = delta.from; i < candles.length; i++) {
        const c = candles[i];
        if (!c) continue;
        h.candles.update(toBar(c));
        h.volume.update(toVolume(c, upVol, downVol));
      }
    } else {
      const timeScale = h.chart.timeScale();
      const range = sameSeries && prev.candles.length ? timeScale.getVisibleLogicalRange() : null;
      h.candles.setData(candles.map(toBar));
      h.volume.setData(candles.map((c) => toVolume(c, upVol, downVol)));
      if (!range) {
        // A new series starts fitted; it pages in older history only once the user scrolls it.
        interacted.current = false;
        if (candles.length) timeScale.fitContent();
      } else if (delta.prepended > 0) {
        timeScale.setVisibleLogicalRange({ from: range.from + delta.prepended, to: range.to + delta.prepended });
      }
    }
    applied.current = { ...prev, key: seriesKey, candles };
  }, [candles, seriesKey, mode, currency, ready]);

  useEffect(() => {
    const h = handles.current;
    if (!h) return;
    h.chart.priceScale('right').applyOptions({ mode: logScale ? h.logMode : h.normalMode });
  }, [logScale, ready]);

  useEffect(() => {
    if (fitSignal <= 0) return;
    // "Fit all bars" shows what is loaded; it is not a request for more history.
    interacted.current = false;
    handles.current?.chart.timeScale().fitContent();
  }, [fitSignal]);

  useEffect(() => {
    if (realtimeSignal > 0) handles.current?.chart.timeScale().scrollToRealTime();
  }, [realtimeSignal]);

  useEffect(() => {
    if (autoscaleSignal > 0) handles.current?.chart.priceScale('right').applyOptions({ autoScale: true });
  }, [autoscaleSignal]);

  const lastBar = candles.at(-1);
  const shown: Legend | undefined = legend ?? (lastBar ? { time: lastBar.time, open: lastBar.open, high: lastBar.high, low: lastBar.low, close: lastBar.close, ...(lastBar.volume !== undefined ? { volume: lastBar.volume } : {}) } : undefined);
  const fmt = mode === 'mc' ? formatAxisMc : formatAxisPrice;
  const unitLabel = `${mode === 'mc' ? 'MC' : 'Price'} · ${currency === 'sol' ? 'SOL' : 'USD'}`;

  return (
    <div className={cn('relative min-h-0 min-w-0', className)}>
      <div ref={container} className="absolute inset-0" />
      {shown && (
        <div
          aria-live="off"
          className="pointer-events-none absolute top-1.5 left-2 z-10 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs tabular text-muted"
        >
          <span className="text-faint">{unitLabel}</span>
          <span className="text-fg-dim">{localTimeLabel(shown.time, intervalSec)}</span>
          <LegendValue label="O" value={fmt(shown.open)} />
          <LegendValue label="H" value={fmt(shown.high)} />
          <LegendValue label="L" value={fmt(shown.low)} />
          <LegendValue label="C" value={fmt(shown.close)} tone={shown.close >= shown.open ? 'up' : 'down'} />
          <span className={shown.close >= shown.open ? 'text-up' : 'text-down'}>
            {shown.open > 0 ? formatPct(((shown.close - shown.open) / shown.open) * 100) : DASH}
          </span>
          <LegendValue label="V" value={formatVolume(shown.volume, currency)} />
        </div>
      )}
      {loadError && (
        <div role="alert" className="absolute inset-0 flex items-center justify-center bg-panel text-xs text-down">
          Chart library failed to load: {loadError}
        </div>
      )}
    </div>
  );
}

/** Volume in the series unit: USD bars carry USD volume, SOL bars SOL volume. */
function formatVolume(volume: number | undefined, currency: ChartCurrency): string {
  if (volume === undefined) return DASH;
  return currency === 'sol' ? `${formatCompact(volume, 2)} SOL` : `$${formatCompact(volume, 2)}`;
}

function LegendValue({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <span>
      <span className="text-faint">{label} </span>
      <span className={tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-fg-dim'}>{value}</span>
    </span>
  );
}
