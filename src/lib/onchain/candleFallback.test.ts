import { describe, expect, it } from 'vitest';
import { ChainError } from '@/lib/core/chain';
import type { Candle, Trade } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import { intervalOptions } from '@/lib/services/token';
import {
  fallbackNote,
  isNotFound,
  onchainHistoryComplete,
  selectCandleSource,
  solChartTrades,
  withOnchainIntervals,
  type NativeCandleState,
  type TradeCandleState,
} from './candleFallback';
import { onchainHeaderPrice } from './headerPrice';

const bar = (time: number): Candle => ({ time, open: 1, high: 1, low: 1, close: 1 });
const native = (over: Partial<NativeCandleState> = {}): NativeCandleState => ({ enabled: true, pending: false, candles: [], ...over });
const trades = (over: Partial<TradeCandleState> = {}): TradeCandleState => ({ available: true, count: 5, fromMs: 1_000_000_000, ...over });
const notFound = new ChainError('candles', [{ provider: 'geckoterminal', ok: false, error: 'geckoterminal: not found', code: 'not_found' }]);
const rateLimited = new ChainError('candles', [{ provider: 'geckoterminal', ok: false, error: 'geckoterminal: rate limited', code: 'rate_limited' }]);

describe('selectCandleSource', () => {
  it('keeps the native source when no on-chain trade feed runs', () => {
    expect(selectCandleSource(native({ error: notFound }), trades({ available: false }))).toEqual({ source: 'native' });
  });

  it('charts trades when no native source can be asked (pool not indexed)', () => {
    expect(selectCandleSource(native({ enabled: false }), trades({ count: 0 }))).toEqual({ source: 'trades', reason: 'no-native' });
  });

  it('charts trades when the indexer answers "not found" (owner screenshot: a 6-second-old pump.fun token)', () => {
    expect(selectCandleSource(native({ error: notFound }), trades({ count: 0 }))).toEqual({ source: 'trades', reason: 'not-found' });
    expect(selectCandleSource(native({ error: new ProviderError('geckoterminal', 'not_found', 'geckoterminal: not found') }), trades())).toEqual({
      source: 'trades',
      reason: 'not-found',
    });
  });

  it('charts trades when the indexer answers with no candles', () => {
    expect(selectCandleSource(native(), trades({ count: 1 }))).toEqual({ source: 'trades', reason: 'empty' });
  });

  it('keeps a native failure on screen unless at least 2 real trades can draw bars', () => {
    expect(selectCandleSource(native({ error: rateLimited }), trades({ count: 1 }))).toEqual({ source: 'native' });
    expect(selectCandleSource(native({ error: rateLimited }), trades({ count: 2 }))).toEqual({ source: 'trades', reason: 'failed' });
  });

  it('waits for the indexer, except for a young pool already charting from trades', () => {
    expect(selectCandleSource(native({ pending: true }), trades())).toEqual({ source: 'native' });
    expect(selectCandleSource(native({ pending: true }), trades({ young: true, count: 1 }))).toEqual({ source: 'native' });
    expect(selectCandleSource(native({ pending: true }), trades({ young: true }))).toEqual({ source: 'trades', reason: 'pending' });
  });

  it('prefers native candles that cover more than the trades in hand (large / old pools)', () => {
    // Native series starts well before the first on-chain trade held.
    expect(selectCandleSource(native({ candles: [bar(900_000), bar(900_060)] }), trades({ fromMs: 999_000_000 }))).toEqual({ source: 'native' });
    // Same start bucket: native wins.
    expect(selectCandleSource(native({ candles: [bar(1_000_000)] }), trades({ fromMs: 1_000_000_000 }))).toEqual({ source: 'native' });
  });

  it('prefers trades that reach back further than the native series (pool younger than the indexer coverage)', () => {
    expect(selectCandleSource(native({ candles: [bar(1_000_120)] }), trades({ fromMs: 1_000_000_000 }))).toEqual({ source: 'trades', reason: 'coverage' });
    // …but never with fewer than 2 trades.
    expect(selectCandleSource(native({ candles: [bar(1_000_120)] }), trades({ fromMs: 1_000_000_000, count: 1 }))).toEqual({ source: 'native' });
  });

  it('prefers the complete on-chain history of the pool over the indexer', () => {
    expect(selectCandleSource(native({ candles: [bar(900_000)] }), trades({ complete: true }))).toEqual({ source: 'trades', reason: 'complete-history' });
    expect(selectCandleSource(native({ candles: [bar(900_000)] }), trades({ complete: true, count: 1 }))).toEqual({ source: 'native' });
  });

  it('has a note for every fallback reason', () => {
    for (const reason of ['no-native', 'not-found', 'empty', 'failed', 'coverage', 'complete-history', 'pending'] as const) expect(fallbackNote(reason)).toBeTruthy();
    expect(fallbackNote(undefined)).toBeUndefined();
  });
});

describe('onchainHistoryComplete', () => {
  it('is complete when the feed holds every trade, or right away for a pool whose whole life fits the first page', () => {
    expect(onchainHistoryComplete({ complete: true, exhausted: true, listed: 900 })).toBe(true);
    expect(onchainHistoryComplete({ complete: false, exhausted: true, listed: 40 })).toBe(true);
    expect(onchainHistoryComplete({ complete: false, exhausted: false, listed: 40 })).toBe(false);
    expect(onchainHistoryComplete(undefined)).toBe(false);
  });

  it('is never complete while listed transactions are missing (live: 652 of 1,303 held, labelled "complete")', () => {
    expect(onchainHistoryComplete({ complete: true, exhausted: true, listed: 1_071, missed: 651 })).toBe(false);
    expect(onchainHistoryComplete({ complete: false, exhausted: true, listed: 30, missed: 1 })).toBe(false);
    // …so the indexer's series keeps the chart when it covers the pool (no 'complete-history' takeover).
    const bars = [{ time: 1_000, open: 1, high: 1, low: 1, close: 1 }];
    const complete = onchainHistoryComplete({ complete: true, exhausted: true, listed: 1_071, missed: 651 });
    expect(selectCandleSource(native({ candles: bars }), trades({ fromMs: 2_000_000, complete }))).toEqual({ source: 'native' });
  });
});

describe('solChartTrades', () => {
  // A 2.36 SOL sell of 19.7M tokens on a young curve: its own ratio is 1.198e-7 SOL, the post-trade reserve price 1.10e-7.
  const sell: Trade = { signature: 'a', timestamp: 1_000, side: 'sell', tokenAmount: 19_700_000, solAmount: 2.36, priceUsd: 0.0000131, usdValue: 280.8, source: 'solana-rpc' };
  const other: Trade = { signature: 'b', timestamp: 2_000, side: 'buy', tokenAmount: 1_000, solAmount: 0.5, source: 'geckoterminal' };

  it('prices on-chain feed trades by their exact SOL price (the basis of their USD price), volume in SOL', () => {
    const [a, b] = solChartTrades([sell, other], new Map([['a', 1.1e-7]]));
    expect(a).toMatchObject({ signature: 'a', priceUsd: 1.1e-7, usdValue: 2.36 });
    expect(a?.marketCapUsd).toBeUndefined();
    // Without an exact SOL price: the trade's own SOL / token ratio.
    expect(b).toMatchObject({ signature: 'b', priceUsd: 0.0005, usdValue: 0.5 });
  });

  it('falls back to each trade’s own ratio without a price map', () => {
    expect(solChartTrades([sell])[0]?.priceUsd).toBeCloseTo(2.36 / 19_700_000, 15);
  });
});

describe('isNotFound', () => {
  it('is a definitive absence only', () => {
    expect(isNotFound(notFound)).toBe(true);
    expect(isNotFound(rateLimited)).toBe(false);
    expect(isNotFound(new ProviderError('geckoterminal', 'timeout', 'x'))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});

describe('withOnchainIntervals', () => {
  const base = intervalOptions({ serverCandles: false, serverSecondIntervals: [], geckoIntervals: ['1m', '5m', '15m', '1h', '4h', '1d'], hasPool: false, hasTradeFeed: true });

  it('turns every minute interval without a native source into a trade-built one', () => {
    const options = withOnchainIntervals(base, true);
    expect(options.every((o) => o.available && o.kind === 'trades')).toBe(true);
    expect(options.find((o) => o.interval === '1m')?.reason).toMatch(/on-chain trades/);
  });

  it('leaves options alone without an on-chain feed or when a native source exists', () => {
    expect(withOnchainIntervals(base, false)).toEqual(base);
    const indexed = intervalOptions({ serverCandles: false, serverSecondIntervals: [], geckoIntervals: ['1m', '5m', '15m', '1h', '4h', '1d'], hasPool: true, hasTradeFeed: true });
    expect(withOnchainIntervals(indexed, true)).toEqual(indexed);
  });
});

describe('onchainHeaderPrice', () => {
  const trade = (over: Partial<Trade>): Trade => ({ signature: 's', timestamp: 2_000, side: 'buy', source: 'solana-ws', priceUsd: 0.002, ...over });

  it('takes the newer of the curve read and the last on-chain trade, labelled', () => {
    expect(onchainHeaderPrice({ curve: { priceUsd: 0.001, marketCapUsd: 1_000_000, at: 1_000 }, trades: [trade({})], supply: 1e9 })).toEqual({
      priceUsd: 0.002,
      marketCapUsd: 2_000_000,
      source: 'trade',
      at: 2_000,
      label: 'last on-chain trade',
    });
    expect(onchainHeaderPrice({ curve: { priceUsd: 0.001, marketCapUsd: 1_000_000, at: 3_000 }, trades: [trade({})] })).toMatchObject({ source: 'curve', label: 'pump.fun curve', priceUsd: 0.001 });
  });

  it('ignores indexed trades and unpriced rows; undefined without any observation', () => {
    expect(onchainHeaderPrice({ trades: [trade({ source: 'geckoterminal' })] })).toBeUndefined();
    expect(onchainHeaderPrice({ trades: [trade({ priceUsd: undefined })] })).toBeUndefined();
    expect(onchainHeaderPrice({ curve: { priceUsd: 0.001 }, trades: [] })).toBeUndefined();
  });
});
