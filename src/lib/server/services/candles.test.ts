import { describe, expect, it } from 'vitest';
import type { CandlesQuery, ChartDataProvider, ProviderId } from '@/lib/core/providers';
import type { CandleSeries, Interval, Sourced } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import { candleProvidersFor, loadCandles, type CandlesDeps } from './candles';
import { NotConfiguredError } from './errors';

const MINT = '4ov9rwwS4iBHeTWGCrVaQYW1HzWK51MSfs8csGAApump';

function chart(id: ProviderId, intervals: readonly Interval[], impl: (q: CandlesQuery) => Promise<Sourced<CandleSeries>>) {
  const calls: CandlesQuery[] = [];
  const provider: ChartDataProvider = {
    id,
    intervals,
    getCandles: (q) => {
      calls.push(q);
      return impl(q);
    },
  };
  return { provider, calls };
}

function series(interval: Interval, times: number[], source: ProviderId): Sourced<CandleSeries> {
  return {
    data: { interval, candles: times.map((time) => ({ time, open: 1, high: 2, low: 0.5, close: 1.5 })) },
    source,
    fetchedAt: 1,
    freshness: 'fast',
  };
}

const NONE: CandlesDeps = { birdeye: null, solanaTracker: null, coingecko: null };

describe('candleProvidersFor', () => {
  it('keeps configured providers that natively serve the interval, in failover order', () => {
    const bird = chart('birdeye', ['1s', '15s', '1m'], async () => series('1m', [], 'birdeye')).provider;
    const st = chart('solanatracker', ['1s', '5s', '15s', '1m'], async () => series('1m', [], 'solanatracker')).provider;
    const cg = chart('coingecko', ['1m', '5m'], async () => series('1m', [], 'coingecko')).provider;
    const deps = { birdeye: bird, solanaTracker: st, coingecko: cg };
    expect(candleProvidersFor('1m', deps).map((p) => p.id)).toEqual(['birdeye', 'solanatracker', 'coingecko']);
    expect(candleProvidersFor('5s', deps).map((p) => p.id)).toEqual(['solanatracker']);
    expect(candleProvidersFor('4h', deps)).toEqual([]);
  });
});

describe('loadCandles', () => {
  it('is not configured without keyed chart providers', async () => {
    await expect(loadCandles({ mint: MINT, interval: '1m', limit: 300 }, NONE)).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it('answers not configured (never fabricates) when no source serves the interval', async () => {
    const bird = chart('birdeye', ['1s', '15s', '1m'], async () => series('1m', [60], 'birdeye'));
    await expect(loadCandles({ mint: MINT, interval: '5s', limit: 300 }, { ...NONE, birdeye: bird.provider })).rejects.toThrow(/5s candles/);
    expect(bird.calls).toHaveLength(0);
  });

  it('passes the query through and fails over past errors and empty series', async () => {
    const bird = chart('birdeye', ['1m'], async () => {
      throw new ProviderError('birdeye', 'rate_limited', 'birdeye: HTTP 429');
    });
    const st = chart('solanatracker', ['1m'], async () => series('1m', [], 'solanatracker'));
    const cg = chart('coingecko', ['1m'], async () => series('1m', [60, 120], 'coingecko'));
    const query = { mint: MINT, pool: '8HbgiXuiNbHRcxiNG8UBD8GLewoy6QVDnPFPgjFGmszf', interval: '1m' as const, before: 1_759_000_000, limit: 500 };
    const result = await loadCandles(query, { birdeye: bird.provider, solanaTracker: st.provider, coingecko: cg.provider });
    expect(bird.calls[0]).toEqual(query);
    expect(result.source).toBe('coingecko');
    expect(result.data.candles.map((c) => c.time)).toEqual([60, 120]);
    expect(result.attempts.map((a) => [a.provider, a.ok])).toEqual([
      ['birdeye', false],
      ['solanatracker', false],
      ['coingecko', true],
    ]);
  });

  it('returns an honest empty series when every source has none (history exhausted)', async () => {
    const st = chart('solanatracker', ['1h'], async () => series('1h', [], 'solanatracker'));
    const result = await loadCandles({ mint: MINT, interval: '1h', limit: 300 }, { ...NONE, solanaTracker: st.provider });
    expect(result.data.candles).toEqual([]);
    expect(result.source).toBe('solanatracker');
  });
});
