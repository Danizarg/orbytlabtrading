import { describe, expect, it, vi } from 'vitest';
import { ChainError } from '@/lib/core/chain';
import type { CandlesQuery, ChartDataProvider, ProviderId } from '@/lib/core/providers';
import type { CandleSeries, Interval, Sourced } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import {
  candleProvidersFor,
  candlesAreKeylessOnly,
  candlesCachePolicy,
  KEYLESS_CANDLES_CACHE,
  keylessCandlesFor,
  loadCandles,
  poolLookupError,
  type CandlesDeps,
} from './candles';
import { noProviderCanServe } from './envelope';
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

const GECKO_INTERVALS: readonly Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
const POOL = '8HbgiXuiNbHRcxiNG8UBD8GLewoy6QVDnPFPgjFGmszf';
const RESOLVED = 'DdMA1cHcHEqYfttc1z1sJEY978CcU1pyjNuTWTNmdvzU';

describe('loadCandles keyless GeckoTerminal fallback', () => {
  it('serves GeckoTerminal OHLCV without any keyed provider, passing the query through', async () => {
    const gt = chart('geckoterminal', GECKO_INTERVALS, async (q) => series(q.interval, [60, 120], 'geckoterminal'));
    const query = { mint: MINT, pool: POOL, interval: '5m' as const, before: 1_759_000_000, limit: 300 };
    const result = await loadCandles(query, { ...NONE, geckoKeyless: gt.provider });
    expect(gt.calls).toEqual([query]);
    expect(result.source).toBe('geckoterminal');
    expect(result.attempts).toEqual([{ provider: 'geckoterminal', ok: true }]);
  });

  it('resolves the pool from the cached pool list when the request names none', async () => {
    const gt = chart('geckoterminal', GECKO_INTERVALS, async (q) => series(q.interval, [60], 'geckoterminal'));
    const resolvePool = vi.fn(async () => RESOLVED);
    await loadCandles({ mint: MINT, interval: '1m', limit: 300 }, { ...NONE, geckoKeyless: gt.provider, resolvePool });
    expect(resolvePool).toHaveBeenCalledWith(MINT);
    expect(gt.calls[0]?.pool).toBe(RESOLVED);
  });

  it('answers unsupported (never guesses a pool) when no pool is known', async () => {
    const gt = chart('geckoterminal', GECKO_INTERVALS, async (q) => series(q.interval, [60], 'geckoterminal'));
    const error = await loadCandles({ mint: MINT, interval: '1m', limit: 300 }, { ...NONE, geckoKeyless: gt.provider, resolvePool: async () => undefined }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).attempts).toEqual([expect.objectContaining({ provider: 'geckoterminal', ok: false, code: 'unsupported' })]);
    expect(gt.calls).toHaveLength(0);
  });

  it('reports a failed pool lookup as a retryable failure, never as "not configured" (501)', async () => {
    const gt = chart('geckoterminal', GECKO_INTERVALS, async (q) => series(q.interval, [60], 'geckoterminal'));
    const lookup = new ChainError('pools', [
      { provider: 'dexscreener', ok: false, error: 'dexscreener: timeout', code: 'timeout' },
      { provider: 'geckoterminal', ok: false, error: 'geckoterminal: HTTP 429', code: 'rate_limited' },
    ]);
    const error = await loadCandles(
      { mint: MINT, interval: '5m', limit: 300 },
      {
        ...NONE,
        geckoKeyless: gt.provider,
        resolvePool: async () => {
          throw lookup;
        },
      },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainError);
    const attempts = (error as ChainError).attempts;
    expect(attempts).toEqual([expect.objectContaining({ provider: 'geckoterminal', ok: false, code: 'rate_limited' })]);
    // The route maps an all-'unsupported' chain to 501, which clients skip silently: this must not be one.
    expect(noProviderCanServe(attempts)).toBe(false);
    expect(gt.calls).toHaveLength(0);
  });

  it('maps pool lookup failures to retryable codes and keeps aborts as they are', () => {
    const timeout = poolLookupError('geckoterminal', new ProviderError('dexscreener', 'timeout', 'dexscreener: timeout'));
    expect(timeout).toMatchObject({ provider: 'geckoterminal', code: 'timeout' });
    expect(poolLookupError('geckoterminal', new Error('boom'))).toMatchObject({ code: 'http' });
    const abort = new ProviderError('dexscreener', 'aborted', 'dexscreener: aborted');
    expect(poolLookupError('geckoterminal', abort)).toBe(abort);
  });

  it('runs after every keyed provider and only when they fail or have no candles', async () => {
    const order: string[] = [];
    const bird = chart('birdeye', ['1m'], async () => {
      order.push('birdeye');
      throw new ProviderError('birdeye', 'rate_limited', 'birdeye: HTTP 429');
    });
    const cg = chart('coingecko', ['1m'], async () => {
      order.push('coingecko');
      return series('1m', [], 'coingecko');
    });
    const gt = chart('geckoterminal', GECKO_INTERVALS, async () => {
      order.push('geckoterminal');
      return series('1m', [60], 'geckoterminal');
    });
    const result = await loadCandles({ mint: MINT, pool: POOL, interval: '1m', limit: 300 }, { ...NONE, birdeye: bird.provider, coingecko: cg.provider, geckoKeyless: gt.provider });
    expect(order).toEqual(['birdeye', 'coingecko', 'geckoterminal']);
    expect(result.source).toBe('geckoterminal');

    const keyedOk = chart('solanatracker', ['1m'], async () => series('1m', [60], 'solanatracker'));
    const gt2 = chart('geckoterminal', GECKO_INTERVALS, async () => series('1m', [60], 'geckoterminal'));
    const keyed = await loadCandles({ mint: MINT, pool: POOL, interval: '1m', limit: 300 }, { ...NONE, solanaTracker: keyedOk.provider, geckoKeyless: gt2.provider });
    expect(keyed.source).toBe('solanatracker');
    expect(gt2.calls).toHaveLength(0);
  });

  it('never fabricates sub-minute candles: keyless-only deployments answer not configured', async () => {
    const gt = chart('geckoterminal', GECKO_INTERVALS, async (q) => series(q.interval, [1], 'geckoterminal'));
    for (const interval of ['1s', '5s', '15s'] as const) {
      await expect(loadCandles({ mint: MINT, pool: POOL, interval, limit: 300 }, { ...NONE, geckoKeyless: gt.provider })).rejects.toThrow(
        new RegExp(`${interval} candles`),
      );
    }
    expect(gt.calls).toHaveLength(0);
  });
});

describe('candles cache semantics', () => {
  const gt = chart('geckoterminal', GECKO_INTERVALS, async (q) => series(q.interval, [60], 'geckoterminal')).provider;
  const bird = chart('birdeye', ['1s', '1m'], async (q) => series(q.interval, [60], 'birdeye')).provider;

  it('knows when only the keyless source can answer an interval', () => {
    expect(candlesAreKeylessOnly('1m', { ...NONE, geckoKeyless: gt })).toBe(true);
    expect(candlesAreKeylessOnly('1m', { ...NONE, birdeye: bird, geckoKeyless: gt })).toBe(false);
    expect(candlesAreKeylessOnly('5m', { ...NONE, birdeye: bird, geckoKeyless: gt })).toBe(true);
    expect(candlesAreKeylessOnly('1s', { ...NONE, geckoKeyless: gt })).toBe(false);
    expect(keylessCandlesFor('1s', { ...NONE, geckoKeyless: gt })).toBeUndefined();
  });

  it('caches keyless GeckoTerminal answers 30 s (latest) / 600 s (older pages) and keyed ones by their own policy', () => {
    const keyed = { latest: { sMaxAge: 10, swr: 30 }, history: { sMaxAge: 300, swr: 3_600 } };
    expect(candlesCachePolicy('geckoterminal', false, keyed)).toEqual(KEYLESS_CANDLES_CACHE.latest);
    expect(candlesCachePolicy('geckoterminal', true, keyed)).toEqual(KEYLESS_CANDLES_CACHE.history);
    expect(KEYLESS_CANDLES_CACHE.latest.sMaxAge).toBe(30);
    expect(KEYLESS_CANDLES_CACHE.history.sMaxAge).toBe(600);
    expect(candlesCachePolicy('birdeye', false, keyed)).toBe(keyed.latest);
    expect(candlesCachePolicy('coingecko', true, keyed)).toBe(keyed.history);
  });
});
