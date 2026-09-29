import { describe, expect, it } from 'vitest';
import type { Candle } from '@/lib/core/types';
import { formatAxisMc, formatAxisPrice, localTickLabel, localTimeLabel, priceScaleBase, scaleCandles, seriesDelta } from './format';

const bar = (time: number, close = 1): Candle => ({ time, open: 1, high: 2, low: 0.5, close, volume: 10 });

describe('priceScaleBase', () => {
  it('returns an exact power of ten sized to the price magnitude, clamped 2..18', () => {
    expect(priceScaleBase(1.5)).toBe(10 ** 4);
    expect(priceScaleBase(0.000001234)).toBe(10 ** 10);
    expect(priceScaleBase(1e-20)).toBe(10 ** 18);
    expect(priceScaleBase(12_345)).toBe(100);
    expect(priceScaleBase(undefined)).toBe(100);
    expect(priceScaleBase(0)).toBe(100);
    expect(Number.isInteger(priceScaleBase(3.3e-9))).toBe(true);
  });
});

describe('axis formatters', () => {
  it('compress zeros and keep market caps compact', () => {
    expect(formatAxisPrice(0.00000123)).toBe('0.0₅123');
    expect(formatAxisPrice(12.5)).toBe('12.50');
    expect(formatAxisMc(1_234_000)).toBe('1.23M');
  });
});

describe('scaleCandles', () => {
  it('multiplies OHLC only and rejects a non-positive factor', () => {
    const [c] = scaleCandles([bar(1, 2)], 1_000);
    expect(c).toEqual({ time: 1, open: 1_000, high: 2_000, low: 500, close: 2_000, volume: 10 });
    expect(scaleCandles([bar(1)], 0)).toEqual([]);
  });
});

describe('seriesDelta', () => {
  const prev = [bar(60), bar(120), bar(180, 1.2)];

  it('detects unchanged data', () => {
    expect(seriesDelta(prev, [bar(60), bar(120), bar(180, 1.2)])).toEqual({ kind: 'same' });
  });

  it('reports a tail update when only the last bar changed or a few bars were appended', () => {
    expect(seriesDelta(prev, [bar(60), bar(120), bar(180, 1.4)])).toEqual({ kind: 'tail', from: 2 });
    expect(seriesDelta(prev, [bar(60), bar(120), bar(180, 1.2), bar(240)])).toEqual({ kind: 'tail', from: 2 });
  });

  it('resets when history was prepended or earlier bars changed', () => {
    expect(seriesDelta(prev, [bar(0), ...prev])).toEqual({ kind: 'reset', prepended: 1, appended: 0 });
    expect(seriesDelta(prev, [bar(60), bar(120, 9), bar(180, 1.2)])).toEqual({ kind: 'reset', prepended: 0, appended: 0 });
    expect(seriesDelta([], [bar(1)])).toEqual({ kind: 'reset', prepended: 0, appended: 1 });
    expect(seriesDelta(prev, [bar(120), bar(180, 1.2)])).toEqual({ kind: 'reset', prepended: 0, appended: 0 });
  });
});

describe('local time labels', () => {
  const noon = Date.UTC(2026, 8, 29, 12, 34, 56) / 1000;
  const d = new Date(noon * 1000);
  const hh = String(d.getHours()).padStart(2, '0');

  it('renders in the viewer time zone with seconds only for sub-minute bars', () => {
    expect(localTickLabel(noon, 0)).toBe(String(d.getFullYear()));
    expect(localTickLabel(noon, 3)).toBe(`${hh}:34`);
    expect(localTickLabel(noon, 4)).toBe(`${hh}:34:56`);
    expect(localTimeLabel(noon, 60)).toBe(`${d.getDate()} Sep 26 ${hh}:34`);
    expect(localTimeLabel(noon, 5)).toBe(`${d.getDate()} Sep 26 ${hh}:34:56`);
    expect(localTimeLabel(noon, 86_400)).toBe(`${d.getDate()} Sep 26`);
  });
});
