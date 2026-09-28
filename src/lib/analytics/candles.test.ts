import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Candle, Trade } from '@/lib/core/types';
import {
  aggregateTrades,
  applyLiveTick,
  bucketStart,
  candleSeriesFromTrades,
  isValidCandle,
  mergeCandles,
  sanitizeCandles,
  toChartTime,
} from './candles';

function gtFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/geckoterminal', name), 'utf8')) as T;
}

/** GeckoTerminal OHLCV rows are [time s, o, h, l, c, volume USD], newest first. */
function gtCandles(name: string): Candle[] {
  const raw = gtFixture<{ data: { attributes: { ohlcv_list: number[][] } } }>(name);
  return raw.data.attributes.ohlcv_list.map(([time, open, high, low, close, volume]) => ({
    time: time ?? NaN,
    open: open ?? NaN,
    high: high ?? NaN,
    low: low ?? NaN,
    close: close ?? NaN,
    volume,
  }));
}

interface GtTradeResource {
  attributes: { block_timestamp: string; tx_hash: string; kind: 'buy' | 'sell'; from_token_amount: string; to_token_amount: string; price_from_in_usd: string; price_to_in_usd: string; volume_in_usd: string };
}

function gtTrades(name: string): Trade[] {
  return gtFixture<{ data: GtTradeResource[] }>(name).data.map(({ attributes: a }) => {
    const buy = a.kind === 'buy';
    return {
      signature: a.tx_hash,
      timestamp: Date.parse(a.block_timestamp),
      side: a.kind,
      tokenAmount: Number(buy ? a.to_token_amount : a.from_token_amount),
      usdValue: Number(a.volume_in_usd),
      priceUsd: Number(buy ? a.price_to_in_usd : a.price_from_in_usd),
      source: 'geckoterminal',
    };
  });
}

const T0 = Date.parse('2026-09-28T20:00:00Z'); // minute-aligned
const T0S = T0 / 1000;

function trade(signature: string, ms: number, priceUsd: number | undefined, extra: Partial<Trade> = {}): Trade {
  return { signature, timestamp: T0 + ms, side: 'buy', priceUsd, source: 'orbyt', ...extra };
}

const candle = (time: number, open: number, high: number, low: number, close: number, volume?: number): Candle =>
  volume === undefined ? { time, open, high, low, close } : { time, open, high, low, close, volume };

describe('time helpers', () => {
  it('toChartTime floors ms to UNIX seconds', () => {
    expect(toChartTime(1_790_628_304_000)).toBe(1_790_628_304);
    expect(toChartTime(1_790_628_304_999)).toBe(1_790_628_304);
    expect(toChartTime(0)).toBe(0);
  });

  it('bucketStart floors to the interval grid', () => {
    expect(bucketStart(T0S + 59, 60)).toBe(T0S);
    expect(bucketStart(T0S + 60, 60)).toBe(T0S + 60);
    expect(bucketStart(T0S + 14_399, 14_400)).toBe(Math.floor((T0S + 14_399) / 14_400) * 14_400);
    expect(bucketStart(T0S + 0.5, 1)).toBe(T0S);
  });

  it('rejects invalid intervals loudly', () => {
    expect(() => bucketStart(T0S, 0)).toThrow(RangeError);
    expect(() => bucketStart(T0S, -60)).toThrow(RangeError);
    expect(() => aggregateTrades([], Number.NaN)).toThrow(RangeError);
    expect(() => applyLiveTick([], { timeSec: T0S, price: 1 }, 0)).toThrow(RangeError);
  });
});

describe('aggregateTrades', () => {
  it('builds OHLCV per bucket from execution prices in time order', () => {
    const trades = [
      trade('c', 50_000, 1.5, { usdValue: 3 }),
      trade('a', 1_000, 1.0, { usdValue: 10 }),
      trade('b', 20_000, 2.0, { usdValue: 5 }),
      trade('d', 61_000, 1.4, { usdValue: 1 }),
      trade('e', 119_999, 1.3, { usdValue: 2 }),
    ];
    expect(aggregateTrades(trades, 60)).toEqual([candle(T0S, 1.0, 2.0, 1.0, 1.5, 18), candle(T0S + 60, 1.4, 1.4, 1.3, 1.3, 3)]);
  });

  it('puts a trade exactly on a boundary in the new bucket', () => {
    const out = aggregateTrades([trade('a', 59_999, 1), trade('b', 60_000, 2)], 60);
    expect(out.map((c) => c.time)).toEqual([T0S, T0S + 60]);
  });

  it('does not fill gaps between traded buckets', () => {
    const out = aggregateTrades([trade('a', 0, 1), trade('b', 10 * 60_000, 2)], 60);
    expect(out).toHaveLength(2);
    expect(out[1]?.open).toBe(2);
  });

  it('skips trades without a usable price or timestamp', () => {
    const out = aggregateTrades(
      [trade('a', 0, undefined), trade('b', 1_000, 0), trade('c', 2_000, -1), trade('d', 3_000, Number.NaN), trade('e', Number.NaN, 1), trade('f', 4_000, 0.5)],
      60,
    );
    expect(out).toEqual([candle(T0S, 0.5, 0.5, 0.5, 0.5)]);
  });

  it('sums known USD volume (usdValue, else price × amount) and omits it when unknown', () => {
    const out = aggregateTrades(
      [trade('a', 0, 2, { tokenAmount: 10 }), trade('b', 1_000, 2, { usdValue: 1 }), trade('c', 60_000, 3), trade('d', 61_000, 3)],
      60,
    );
    expect(out[0]?.volume).toBe(21);
    expect(out[1]).not.toHaveProperty('volume');
  });

  it('orders same-second trades by signature regardless of input order', () => {
    const forward = aggregateTrades([trade('a', 0, 1), trade('b', 0, 2), trade('c', 0, 3)], 60);
    const reversed = aggregateTrades([trade('c', 0, 3), trade('b', 0, 2), trade('a', 0, 1)], 60);
    expect(forward).toEqual(reversed);
    expect(forward[0]).toMatchObject({ open: 1, close: 3 });
  });

  it('counts exact duplicate rows once but keeps distinct trades sharing a signature', () => {
    const dup = trade('x', 0, 1, { usdValue: 5, tokenAmount: 5 });
    expect(aggregateTrades([dup, { ...dup }], 60)[0]?.volume).toBe(5);
    const second = trade('x', 0, 1.1, { usdValue: 7, tokenAmount: 6, side: 'sell' });
    expect(aggregateTrades([dup, second], 60)[0]?.volume).toBe(12);
  });

  it('returns ascending unique times for real GeckoTerminal trades (newest-first input)', () => {
    const trades = [...gtTrades('trades_pool.json'), ...gtTrades('trades_pool_volume_gt_1000.json')];
    const out = aggregateTrades(trades, 60);
    const times = out.map((c) => c.time);
    expect(times).toEqual([...new Set(times)].sort((a, b) => a - b));
    expect(out.every(isValidCandle)).toBe(true);
    // 20:34:01, 20:45:04 (×3), 20:49:46, 20:50:48 → 4 one-minute buckets.
    expect(times).toEqual(['2026-09-28T20:34:00Z', '2026-09-28T20:45:00Z', '2026-09-28T20:49:00Z', '2026-09-28T20:50:00Z'].map((s) => Date.parse(s) / 1000));
    const bucket = out[1];
    const sameSecond = trades.filter((t) => t.timestamp === Date.parse('2026-09-28T20:45:04Z'));
    expect(bucket?.volume).toBeCloseTo(sameSecond.reduce((s, t) => s + (t.usdValue ?? 0), 0), 6);
    expect(bucket?.high).toBe(Math.max(...sameSecond.map((t) => t.priceUsd ?? 0)));
    expect(bucket?.low).toBe(Math.min(...sameSecond.map((t) => t.priceUsd ?? Infinity)));
  });

  it('returns [] for no trades', () => {
    expect(aggregateTrades([], 60)).toEqual([]);
  });
});

describe('candleSeriesFromTrades', () => {
  it('labels the series as derived with trade count and covered range', () => {
    const trades = [trade('a', 0, 1), trade('b', 90_000, 2), trade('c', 30_000, undefined)];
    const series = candleSeriesFromTrades(trades, '1m', 'POOL');
    expect(series).toEqual({
      interval: '1m',
      pool: 'POOL',
      derivedFromTrades: true,
      derivation: { trades: 2, from: T0, to: T0 + 90_000 },
      candles: [candle(T0S, 1, 1, 1, 1), candle(T0S + 60, 2, 2, 2, 2)],
    });
  });

  it('omits derivation when no trade had a price', () => {
    const series = candleSeriesFromTrades([trade('a', 0, undefined)], '5m');
    expect(series.candles).toEqual([]);
    expect(series).not.toHaveProperty('derivation');
    expect(series).not.toHaveProperty('pool');
  });
});

describe('mergeCandles', () => {
  it('unions by time, b wins, ascending', () => {
    const a = [candle(120, 1, 1, 1, 1), candle(60, 2, 2, 2, 2)];
    const b = [candle(60, 3, 3, 3, 3), candle(180, 4, 4, 4, 4)];
    expect(mergeCandles(a, b)).toEqual([candle(60, 3, 3, 3, 3), candle(120, 1, 1, 1, 1), candle(180, 4, 4, 4, 4)]);
  });

  it('prepends an older page to live history', () => {
    const history = gtCandles('ohlcv_minute_1_limit1000.json');
    const older = [candle(1_790_628_120, 1e-3, 1.1e-3, 0.9e-3, 1.05e-3)];
    const merged = mergeCandles(older, history);
    expect(merged.map((c) => c.time)).toEqual([1_790_628_120, 1_790_628_180, 1_790_628_240, 1_790_628_300]);
  });

  it('drops rows with a non-finite time and leaves inputs untouched', () => {
    const a = [candle(Number.NaN, 1, 1, 1, 1), candle(60, 1, 1, 1, 1)];
    const snapshot = JSON.stringify(a);
    expect(mergeCandles(a, [])).toEqual([candle(60, 1, 1, 1, 1)]);
    expect(JSON.stringify(a)).toBe(snapshot);
  });
});

describe('sanitizeCandles', () => {
  it('sorts and dedupes real GeckoTerminal OHLCV (newest-first) without changing values', () => {
    const raw = gtCandles('ohlcv_minute_1_limit1000.json');
    const clean = sanitizeCandles(raw);
    expect(clean.map((c) => c.time)).toEqual([1_790_628_180, 1_790_628_240, 1_790_628_300]);
    expect(clean).toEqual([...raw].reverse());
  });

  it('confirms GeckoTerminal opens each candle at the previous close', () => {
    const clean = sanitizeCandles(gtCandles('ohlcv_minute_1_limit1000.json'));
    for (let i = 1; i < clean.length; i++) expect(clean[i]?.open).toBe(clean[i - 1]?.close);
  });

  it('drops invalid rows instead of repairing them', () => {
    const rows = [
      candle(60, 1, 2, 0.5, 1.5, 10), // valid
      candle(120, 1, 1.2, 0.9, 1.3), // high < close
      candle(180, 1, 1.2, 1.05, 1.1), // low > open
      candle(240, 0, 1, 0, 1), // zero price
      candle(300, Number.NaN, 1, 1, 1),
      candle(360, 1, Infinity, 1, 1),
      candle(0, 1, 1, 1, 1), // no time
      candle(420, -1, 1, -2, 1),
    ];
    expect(sanitizeCandles(rows)).toEqual([candle(60, 1, 2, 0.5, 1.5, 10)]);
  });

  it('removes an invalid volume but keeps the price bar', () => {
    expect(sanitizeCandles([candle(60, 1, 1, 1, 1, -5), candle(120, 1, 1, 1, 1, Number.NaN)])).toEqual([
      candle(60, 1, 1, 1, 1),
      candle(120, 1, 1, 1, 1),
    ]);
  });

  it('keeps the last row for a duplicated time', () => {
    expect(sanitizeCandles([candle(60, 1, 1, 1, 1), candle(60, 2, 2, 2, 2)])).toEqual([candle(60, 2, 2, 2, 2)]);
  });
});

describe('applyLiveTick', () => {
  const base = [candle(T0S, 1, 1.2, 0.9, 1.1, 100)];

  it('updates the last candle within the same bucket', () => {
    const up = applyLiveTick(base, { timeSec: T0S + 30, price: 1.5, volumeUsd: 20 }, 60);
    expect(up.changed).toBe('update');
    expect(up.candles).toEqual([candle(T0S, 1, 1.5, 0.9, 1.5, 120)]);
    const down = applyLiveTick(up.candles, { timeSec: T0S + 59.9, price: 0.8 }, 60);
    expect(down.candles).toEqual([candle(T0S, 1, 1.5, 0.8, 0.8, 120)]);
  });

  it('appends a newer bucket opening at the tick price by default', () => {
    const res = applyLiveTick(base, { timeSec: T0S + 60, price: 1.3, volumeUsd: 4 }, 60);
    expect(res.changed).toBe('append');
    expect(res.candles).toEqual([...base, candle(T0S + 60, 1.3, 1.3, 1.3, 1.3, 4)]);
  });

  it("can open at the previous close (GeckoTerminal convention) when asked", () => {
    const history = sanitizeCandles(gtCandles('ohlcv_minute_1_limit1000.json'));
    const last = history.at(-1);
    const res = applyLiveTick(history, { timeSec: (last?.time ?? 0) + 75, price: 0.00095 }, 60, { open: 'previousClose' });
    expect(res.changed).toBe('append');
    expect(res.candles.at(-1)).toEqual({
      time: (last?.time ?? 0) + 60,
      open: last?.close,
      high: Math.max(last?.close ?? 0, 0.00095),
      low: Math.min(last?.close ?? 0, 0.00095),
      close: 0.00095,
    });
    expect(res.candles.every(isValidCandle)).toBe(true);
  });

  it('does not fill skipped buckets', () => {
    const res = applyLiveTick(base, { timeSec: T0S + 600, price: 2 }, 60);
    expect(res.candles.map((c) => c.time)).toEqual([T0S, T0S + 600]);
  });

  it('starts a series from an empty array', () => {
    expect(applyLiveTick([], { timeSec: T0S + 5, price: 3 }, 60, { open: 'previousClose' })).toEqual({
      candles: [candle(T0S, 3, 3, 3, 3)],
      changed: 'append',
    });
  });

  it('ignores ticks older than the last bar (lightweight-charts would throw) and returns the same array', () => {
    const res = applyLiveTick(base, { timeSec: T0S - 1, price: 5 }, 60);
    expect(res.changed).toBe('ignored');
    expect(res.candles).toBe(base);
  });

  it('ignores invalid ticks', () => {
    for (const tick of [
      { timeSec: T0S, price: 0 },
      { timeSec: T0S, price: -1 },
      { timeSec: T0S, price: Number.NaN },
      { timeSec: Number.NaN, price: 1 },
    ]) {
      expect(applyLiveTick(base, tick, 60)).toEqual({ candles: base, changed: 'ignored' });
    }
  });

  it('keeps unknown volume unknown instead of starting a partial sum', () => {
    const noVolume = [candle(T0S, 1, 1, 1, 1)];
    expect(applyLiveTick(noVolume, { timeSec: T0S + 1, price: 1, volumeUsd: 50 }, 60).candles[0]).not.toHaveProperty('volume');
    expect(applyLiveTick(base, { timeSec: T0S + 1, price: 1 }, 60).candles[0]?.volume).toBe(100);
    expect(applyLiveTick(base, { timeSec: T0S + 1, price: 1, volumeUsd: -3 }, 60).candles[0]?.volume).toBe(100);
  });

  it('never mutates the input array or its candles', () => {
    const input = [candle(T0S, 1, 1, 1, 1, 1)];
    const snapshot = JSON.stringify(input);
    applyLiveTick(input, { timeSec: T0S + 1, price: 2, volumeUsd: 1 }, 60);
    applyLiveTick(input, { timeSec: T0S + 61, price: 2 }, 60);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
