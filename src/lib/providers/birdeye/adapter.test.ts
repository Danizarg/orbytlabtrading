import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProviderId } from '@/lib/core/providers';
import { MINTS } from '@/lib/core/solana';
import { isProviderError, ProviderError } from '@/lib/net/errors';
import type { JsonFetcher, JsonRequest } from '@/lib/net/types';
import { birdeyeDex, birdeyeLaunchpad, BIRDEYE_INTERVALS, createBirdeye } from './index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_KEY = 'test-birdeye-key-9b1d77';
const PEPEAI = '7nM97F8takLArrKLJdT62L54jTtX1e7h7qPSjtBrsMQA';
const ZUMI = 'H5UjPsXoxaJAkAcpkfs7Fds3T6oypK7BwLgTFUtTs6vy';
const HOLDER_MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const PAIR = '9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT';

function doc(name: string): Record<string, unknown> {
  const file = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/doc-examples/birdeye', name), 'utf8')) as Record<string, unknown>;
  return file.response as Record<string, unknown>;
}

const OHLCV = doc('ohlcv-v3-token.doc-example.json');
const OHLCV_PAIR = doc('ohlcv-v3-pair.doc-example.json');
const TXS = doc('token-txs-v3.doc-example.json');
const HOLDERS = doc('token-holder-v3.doc-example.json');
const SECURITY = doc('token-security.doc-example.json');
const PROFILE = doc('holder-profile.doc-example.json');
const MEMES = doc('meme-list.doc-example.json');

interface Call {
  provider: ProviderId;
  url: URL;
  init?: JsonRequest;
}

type Responder = (url: URL, init?: JsonRequest) => unknown;

/** Fake transport: first route whose substring matches the URL path answers (Error → reject). */
function fakeFetcher(routes: Array<[match: string, respond: Responder | unknown]>) {
  const calls: Call[] = [];
  const fetcher: JsonFetcher = async <T>(provider: ProviderId, raw: string, init?: JsonRequest): Promise<T> => {
    const url = new URL(raw);
    calls.push({ provider, url, init });
    for (const [match, respond] of routes) {
      if (!`${url.pathname}?`.includes(`${match}?`)) continue;
      const value: unknown = typeof respond === 'function' ? (respond as Responder)(url, init) : respond;
      if (value instanceof Error) throw value;
      return structuredClone(value) as T;
    }
    throw new Error(`unexpected URL in test: ${raw}`);
  };
  return { fetcher, calls };
}

async function rejectionOf(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (isProviderError(error)) return error;
    throw new Error(`expected ProviderError, got ${String(error)}`);
  }
  throw new Error('expected rejection');
}

function items(payload: Record<string, unknown>): unknown[] {
  return (payload.data as { items: unknown[] }).items;
}

function withItems(payload: Record<string, unknown>, list: unknown[]): Record<string, unknown> {
  return { ...payload, data: { ...(payload.data as object), items: list } };
}

// ---------------------------------------------------------------------------
// Transport contract
// ---------------------------------------------------------------------------

describe('birdeye transport', () => {
  it('sends the key as X-API-KEY with x-chain: solana, never in the URL, always labelled', async () => {
    const { fetcher, calls } = fakeFetcher([['/defi/v3/token/holder', HOLDERS]]);
    await createBirdeye({ apiKey: API_KEY, fetcher }).getHolders(HOLDER_MINT);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.provider).toBe('birdeye');
    expect(call?.url.origin).toBe('https://public-api.birdeye.so');
    expect(call?.url.toString()).not.toContain(API_KEY);
    expect(call?.init?.headers).toEqual({ 'X-API-KEY': API_KEY, 'x-chain': 'solana' });
    expect(call?.init?.label).toBe('birdeye');
  });

  it('maps 401 → not_configured, 403 → http and passes 429 through', async () => {
    const e401 = await rejectionOf(
      createBirdeye({ apiKey: API_KEY, fetcher: fakeFetcher([['/defi/v3/token/holder', new ProviderError('birdeye', 'http', 'birdeye: HTTP 401', { status: 401 })]]).fetcher }).getHolders(HOLDER_MINT),
    );
    expect(e401.code).toBe('not_configured');
    const e403 = await rejectionOf(
      createBirdeye({ apiKey: API_KEY, fetcher: fakeFetcher([['/defi/v3/token/holder', new ProviderError('birdeye', 'http', 'birdeye: HTTP 403', { status: 403 })]]).fetcher }).getHolders(HOLDER_MINT),
    );
    expect(e403.code).toBe('http');
    expect(e403.status).toBe(403);
    const e429 = await rejectionOf(
      createBirdeye({
        apiKey: API_KEY,
        fetcher: fakeFetcher([['/defi/v3/token/holder', new ProviderError('birdeye', 'rate_limited', 'birdeye: HTTP 429', { status: 429, retryAfterMs: 4_000 })]]).fetcher,
      }).getHolders(HOLDER_MINT),
    );
    expect(e429.code).toBe('rate_limited');
    expect(e429.retryAfterMs).toBe(4_000);
  });

  it('never leaks the key in thrown messages', async () => {
    const leaky = new Error(`request with X-API-KEY ${API_KEY} failed`);
    const e1 = await rejectionOf(createBirdeye({ apiKey: API_KEY, fetcher: fakeFetcher([['/defi/v3/token/holder', leaky]]).fetcher }).getHolders(HOLDER_MINT));
    expect(e1.code).toBe('network');
    expect(e1.message).not.toContain(API_KEY);

    const echoed = { success: false, message: `Invalid api key ${API_KEY}` };
    const e2 = await rejectionOf(createBirdeye({ apiKey: API_KEY, fetcher: fakeFetcher([['/defi/v3/token/holder', echoed]]).fetcher }).getHolders(HOLDER_MINT));
    expect(e2.code).toBe('http');
    expect(e2.message).not.toContain(API_KEY);
    expect(e2.message).toContain('***');
  });

  it('treats a null data payload as not_found and a non-object as malformed', async () => {
    const e1 = await rejectionOf(createBirdeye({ apiKey: API_KEY, fetcher: fakeFetcher([['/defi/v3/token/holder', { success: true, data: null }]]).fetcher }).getHolders(HOLDER_MINT));
    expect(e1.code).toBe('not_found');
    const e2 = await rejectionOf(createBirdeye({ apiKey: API_KEY, fetcher: fakeFetcher([['/defi/v3/token/holder', ['nope']]]).fetcher }).getHolders(HOLDER_MINT));
    expect(e2.code).toBe('malformed');
    const e3 = await rejectionOf(
      createBirdeye({ apiKey: API_KEY, fetcher: fakeFetcher([['/defi/v3/token/holder', { success: true, data: { items: 'x' } }]]).fetcher }).getHolders(HOLDER_MINT),
    );
    expect(e3.code).toBe('malformed');
  });

  it('reports a missing key as not_configured without calling upstream', async () => {
    const { fetcher, calls } = fakeFetcher([]);
    const err = await rejectionOf(createBirdeye({ apiKey: '', fetcher }).getHolders(HOLDER_MINT));
    expect(err.code).toBe('not_configured');
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Candles
// ---------------------------------------------------------------------------

describe('birdeye getCandles', () => {
  it('exposes only native intervals and maps hour/day types to upper case', async () => {
    expect([...BIRDEYE_INTERVALS]).toEqual(['1s', '15s', '1m', '5m', '15m', '1h', '4h', '1d']);
    const { fetcher, calls } = fakeFetcher([['/defi/v3/ohlcv', OHLCV]]);
    const be = createBirdeye({ apiKey: API_KEY, fetcher });
    expect(be.intervals).toBe(BIRDEYE_INTERVALS);
    await be.getCandles({ mint: MINTS.SOL, interval: '1h' });
    await be.getCandles({ mint: MINTS.SOL, interval: '4h' });
    await be.getCandles({ mint: MINTS.SOL, interval: '1d' });
    await be.getCandles({ mint: MINTS.SOL, interval: '1s' });
    expect(calls.map((c) => c.url.searchParams.get('type'))).toEqual(['1H', '4H', '1D', '1s']);
  });

  it('rejects unsupported intervals without calling upstream', async () => {
    const { fetcher, calls } = fakeFetcher([]);
    const err = await rejectionOf(createBirdeye({ apiKey: API_KEY, fetcher }).getCandles({ mint: MINTS.SOL, interval: '5s' }));
    expect(err.code).toBe('unsupported');
    expect(calls).toHaveLength(0);
  });

  it('maps v3 token candles (UNIX seconds, USD volume) using count mode', async () => {
    const { fetcher, calls } = fakeFetcher([['/defi/v3/ohlcv', OHLCV]]);
    const before = Date.now();
    const res = await createBirdeye({ apiKey: API_KEY, fetcher }).getCandles({ mint: MINTS.SOL, interval: '15m', limit: 2 });
    expect(res.source).toBe('birdeye');
    expect(res.freshness).toBe('fast');
    expect(res.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(res.data.interval).toBe('15m');
    expect(res.data.candles).toEqual([
      { time: 1726670700, open: 128.27328370924414, high: 128.6281001340782, low: 127.91200927364626, close: 127.97284640184616, volume: 7506048 },
      { time: 1726671600, open: 127.97284640184616, high: 128.49450996585105, low: 127.89354285873108, close: 128.04188346328968, volume: 7506048 },
    ]);
    expect(res.data.hasMore).toBe(true);
    expect(res.notes).toBeUndefined();

    const params = calls[0]?.url.searchParams;
    expect(calls[0]?.url.pathname).toBe('/defi/v3/ohlcv');
    expect(params?.get('address')).toBe(MINTS.SOL);
    expect(params?.get('type')).toBe('15m');
    expect(params?.get('currency')).toBe('usd');
    expect(params?.get('mode')).toBe('count');
    expect(params?.get('count_limit')).toBe('2');
    expect(params?.has('time_from')).toBe(false);
    expect(Number(params?.get('time_to'))).toBeGreaterThan(1_700_000_000);
  });

  it('sorts ascending, drops duplicates and invalid rows, and pages with `before`', async () => {
    const list = items(OHLCV);
    const shuffled = withItems(OHLCV, [list[1], list[0], { ...(list[0] as object), c: 999 }, { unix_time: 1726672500, o: 'x' }, null]);
    const { fetcher, calls } = fakeFetcher([['/defi/v3/ohlcv', shuffled]]);
    const res = await createBirdeye({ apiKey: API_KEY, fetcher }).getCandles({ mint: MINTS.SOL, interval: '15m', before: 1726671600, limit: 10 });
    // 1726671600 is excluded by `before`; the duplicate 1726670700 keeps the last occurrence.
    expect(res.data.candles).toEqual([{ time: 1726670700, open: 128.27328370924414, high: 128.6281001340782, low: 127.91200927364626, close: 999, volume: 7506048 }]);
    expect(calls[0]?.url.searchParams.get('time_to')).toBe('1726671599');
    expect(res.data.hasMore).toBe(false);
  });

  it('uses the pair endpoint when a pool is given and flags non-USD pricing', async () => {
    const { fetcher, calls } = fakeFetcher([['/defi/v3/ohlcv/pair', OHLCV_PAIR]]);
    const be = createBirdeye({ apiKey: API_KEY, fetcher });
    const res = await be.getCandles({ mint: MINTS.SOL, pool: PAIR, interval: '15m', limit: 5 });
    expect(calls[0]?.url.pathname).toBe('/defi/v3/ohlcv/pair');
    expect(calls[0]?.url.searchParams.get('address')).toBe(PAIR);
    expect(calls[0]?.url.searchParams.has('currency')).toBe(false);
    expect(res.data.pool).toBe(PAIR);
    expect(res.data.candles).toHaveLength(2);
    expect(res.data.candles[0]?.volume).toBe(1000);
    expect(res.notes).toBeUndefined();

    const native = withItems(OHLCV_PAIR, items(OHLCV_PAIR).map((i) => ({ ...(i as object), currency: 'native' })));
    const res2 = await createBirdeye({ apiKey: API_KEY, fetcher: fakeFetcher([['/defi/v3/ohlcv/pair', native]]).fetcher }).getCandles({
      mint: MINTS.SOL,
      pool: PAIR,
      interval: '15m',
    });
    expect(res2.notes?.[0]).toMatch(/native/);
  });

  it('falls back to an explicit range when count mode is rejected with HTTP 400', async () => {
    const { fetcher, calls } = fakeFetcher([
      [
        '/defi/v3/ohlcv',
        (url: URL) => (url.searchParams.get('mode') === 'count' ? new ProviderError('birdeye', 'http', 'birdeye: HTTP 400', { status: 400 }) : OHLCV),
      ],
    ]);
    const res = await createBirdeye({ apiKey: API_KEY, fetcher }).getCandles({ mint: MINTS.SOL, interval: '15m', limit: 4, before: 1726680000 });
    expect(calls).toHaveLength(2);
    const range = calls[1]?.url.searchParams;
    expect(range?.get('mode')).toBe('range');
    expect(range?.get('time_to')).toBe('1726679999');
    expect(range?.get('time_from')).toBe(String(1726679999 - 4 * 900));
    expect(res.data.candles).toHaveLength(2);
    expect(res.data.hasMore).toBeUndefined();
  });

  it('returns an honest empty series when Birdeye has no candles', async () => {
    const { fetcher } = fakeFetcher([['/defi/v3/ohlcv', withItems(OHLCV, [])]]);
    const res = await createBirdeye({ apiKey: API_KEY, fetcher }).getCandles({ mint: MINTS.SOL, interval: '1m' });
    expect(res.data.candles).toEqual([]);
    expect(res.data.hasMore).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

describe('birdeye getTrades', () => {
  it('derives the side from the requested token leg (matches Birdeye `side` for the queried SOL leg)', async () => {
    const { fetcher } = fakeFetcher([['/defi/v3/token/txs', TXS]]);
    const res = await createBirdeye({ apiKey: API_KEY, fetcher }).getTrades({ mint: MINTS.SOL });
    // The add-liquidity row is dropped; the three swaps all have a SOL leg.
    expect(res.data.map((t) => t.side)).toEqual(['buy', 'sell', 'buy']);
    expect(res.data.map((t) => t.timestamp)).toEqual([1740380278000, 1741033247000, 1754884657000]);
    expect(res.freshness).toBe('fast');
  });

  it('maps a trade from the token perspective with ui amounts, USD volume and venue', async () => {
    const { fetcher, calls } = fakeFetcher([['/defi/v3/token/txs', TXS]]);
    const res = await createBirdeye({ apiKey: API_KEY, fetcher }).getTrades({ mint: ZUMI, limit: 500 });
    expect(res.data).toEqual([
      {
        signature: '351zF2LEwyW9izUT9WeKEL4yr3Ej4fjwDgbuijWSMTsCZoXHVverNwUEh4YjggAcYAP8j2cv1BW9j2CFNWbXUGSh',
        timestamp: 1754884657000,
        // The owner gave up ZUMI for SOL: a sell of ZUMI (Birdeye's `side: buy` is relative to SOL).
        side: 'sell',
        wallet: '2s44dURNXwC65t7t9XSZfRWA9eyXJDfWTPHDv8jbDKNp',
        tokenAmount: 1296668.48062,
        quoteAmount: 0.200754834,
        quoteSymbol: 'SOL',
        solAmount: 0.200754834,
        usdValue: 37.190281762690454,
        priceUsd: 0.000028681411107415812,
        pool: 'D45QQMsxGhohYXGZKDJEowMv2HArrKAsw5V3JnyDZWeS',
        dex: 'pumpswap',
        source: 'birdeye',
      },
    ]);
    const params = calls[0]?.url.searchParams;
    expect(params?.get('address')).toBe(ZUMI);
    expect(params?.get('tx_type')).toBe('swap');
    expect(params?.get('sort_type')).toBe('desc');
    expect(params?.get('limit')).toBe('100');
  });

  it('skips rows that do not involve the requested mint', async () => {
    const { fetcher } = fakeFetcher([['/defi/v3/token/txs', TXS]]);
    const res = await createBirdeye({ apiKey: API_KEY, fetcher }).getTrades({ mint: PEPEAI });
    expect(res.data).toHaveLength(1);
    expect(res.data[0]?.side).toBe('sell');
    expect(res.data[0]?.dex).toBe('raydium');
  });

  it('passes pool_id / after_time and keeps only strictly newer trades', async () => {
    const since = Date.now() - 60_000;
    const recent = Math.floor(Date.now() / 1000);
    const list = items(TXS);
    const payload = withItems(TXS, [
      { ...(list[3] as object), block_unix_time: recent },
      { ...(list[3] as object), tx_hash: 'old', block_unix_time: Math.floor(since / 1000) - 10 },
    ]);
    const { fetcher, calls } = fakeFetcher([['/defi/v3/token/txs', payload]]);
    const res = await createBirdeye({ apiKey: API_KEY, fetcher }).getTrades({ mint: ZUMI, pool: 'D45QQMsxGhohYXGZKDJEowMv2HArrKAsw5V3JnyDZWeS', since });
    expect(res.data).toHaveLength(1);
    expect(calls[0]?.url.searchParams.get('pool_id')).toBe('D45QQMsxGhohYXGZKDJEowMv2HArrKAsw5V3JnyDZWeS');
    expect(calls[0]?.url.searchParams.get('after_time')).toBe(String(Math.floor(since / 1000)));

    // `after_time` older than 30 days is rejected upstream, so it is not sent.
    const { fetcher: f2, calls: c2 } = fakeFetcher([['/defi/v3/token/txs', TXS]]);
    await createBirdeye({ apiKey: API_KEY, fetcher: f2 }).getTrades({ mint: ZUMI, since: Date.now() - 40 * 86_400_000 });
    expect(c2[0]?.url.searchParams.has('after_time')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Holders
// ---------------------------------------------------------------------------

describe('birdeye getHolders', () => {
  it('maps token-account holders with the total count and a 0–100 top-10 share', async () => {
    const { fetcher, calls } = fakeFetcher([['/defi/v3/token/holder', HOLDERS]]);
    const res = await createBirdeye({ apiKey: API_KEY, fetcher }).getHolders(HOLDER_MINT, 250);
    expect(calls[0]?.url.searchParams.get('limit')).toBe('100');
    expect(res.freshness).toBe('indexed');
    expect(res.data.mint).toBe(HOLDER_MINT);
    expect(res.data.totalHolders).toBe(5321);
    expect(res.data.distribution).toEqual({ top10Pct: 22.15 });
    expect(res.data.top).toEqual([
      { owner: '6Zk9e3nfXdYLXHYu5NvDiPHGMcjujVBv6gWRr7ckSdhP', tokenAccount: 'HdmGPmTkBgsiJcyVDgiGkYdTZr4h5XmpjYoUjU2rapf4', amount: 100, isProgramAccount: false },
      { owner: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', tokenAccount: 'EauuZAnB7CcnCrwvCMcnb2Rjk12Ecs13ycAZQBb5tLYM', amount: 90, isProgramAccount: true },
    ]);
    // No supply in this payload → no invented percentages.
    expect(res.data.top.every((h) => !('pctOfSupply' in h))).toBe(true);
    expect('supply' in res.data).toBe(false);
  });

  it('slices to the requested limit', async () => {
    const { fetcher } = fakeFetcher([['/defi/v3/token/holder', HOLDERS]]);
    const res = await createBirdeye({ apiKey: API_KEY, fetcher }).getHolders(HOLDER_MINT, 1);
    expect(res.data.top).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

describe('birdeye getRisk', () => {
  it('converts token_security fractions to percent and merges holder-profile tags', async () => {
    const { fetcher, calls } = fakeFetcher([
      ['/defi/token_security', SECURITY],
      ['/token/v1/holder-profile', PROFILE],
    ]);
    const res = await createBirdeye({ apiKey: API_KEY, fetcher }).getRisk(HOLDER_MINT);
    expect(res.freshness).toBe('indexed');
    expect(res.notes).toBeUndefined();
    const r = res.data;
    expect(r.mint).toBe(HOLDER_MINT);
    expect(r.sources).toEqual(['birdeye']);
    expect(r.top10Pct).toBeCloseTo(30.41667404641445, 10);
    expect(r.devHoldingPct).toBeCloseTo(5.44198858929173e-8, 18);
    expect(r.bundlersPct).toBe(50.45166);
    expect(r.snipersPct).toBe(0);
    expect(r.insidersPct).toBe(0);
    // freezeable/freezeAuthority are both null: unknown, so omitted.
    expect('freezeAuthorityDisabled' in r).toBe(false);
    expect('mintAuthorityDisabled' in r).toBe(false);
    expect(r.flags).toEqual([
      { level: 'warn', label: 'Mutable metadata', source: 'birdeye' },
      { level: 'good', label: 'On Jupiter strict list', source: 'birdeye' },
    ]);
    expect(calls.find((c) => c.url.pathname === '/token/v1/holder-profile')?.url.searchParams.get('token_address')).toBe(HOLDER_MINT);
  });

  it('flags an enabled freeze authority', async () => {
    const sec = { ...SECURITY, data: { ...(SECURITY.data as object), freezeAuthority: '9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw', freezeable: true } };
    const { fetcher } = fakeFetcher([
      ['/defi/token_security', sec],
      ['/token/v1/holder-profile', PROFILE],
    ]);
    const res = await createBirdeye({ apiKey: API_KEY, fetcher }).getRisk(HOLDER_MINT);
    expect(res.data.freezeAuthorityDisabled).toBe(false);
    expect(res.data.flags[0]).toEqual({ level: 'danger', label: 'Freeze authority enabled', detail: '9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw', source: 'birdeye' });
  });

  it('tolerates a failing token_security call (Lite+ endpoint) with a note', async () => {
    const { fetcher } = fakeFetcher([
      ['/defi/token_security', new ProviderError('birdeye', 'http', 'birdeye: HTTP 403', { status: 403 })],
      ['/token/v1/holder-profile', PROFILE],
    ]);
    const res = await createBirdeye({ apiKey: API_KEY, fetcher }).getRisk(HOLDER_MINT);
    expect(res.data.top10Pct).toBe(32.82937);
    expect(res.data.devHoldingPct).toBe(0);
    expect(res.data.bundlersPct).toBe(50.45166);
    expect(res.data.flags).toEqual([]);
    expect(res.notes?.[0]).toMatch(/security unavailable/i);
  });

  it('tolerates a failing holder-profile call', async () => {
    const { fetcher } = fakeFetcher([
      ['/defi/token_security', SECURITY],
      ['/token/v1/holder-profile', new ProviderError('birdeye', 'timeout', 'birdeye: timeout')],
    ]);
    const res = await createBirdeye({ apiKey: API_KEY, fetcher }).getRisk(HOLDER_MINT);
    expect(res.data.top10Pct).toBeCloseTo(30.41667404641445, 10);
    expect('snipersPct' in res.data).toBe(false);
    expect(res.notes?.[0]).toMatch(/holder profile unavailable/i);
  });

  it('fails when both calls fail', async () => {
    const unauthorized = new ProviderError('birdeye', 'http', 'birdeye: HTTP 401', { status: 401 });
    const { fetcher } = fakeFetcher([
      ['/defi/token_security', unauthorized],
      ['/token/v1/holder-profile', unauthorized],
    ]);
    const err = await rejectionOf(createBirdeye({ apiKey: API_KEY, fetcher }).getRisk(HOLDER_MINT));
    expect(err.code).toBe('not_configured');
  });
});

// ---------------------------------------------------------------------------
// Pulse
// ---------------------------------------------------------------------------

describe('birdeye getPulse', () => {
  it('queries each column with the documented filters', async () => {
    const { fetcher, calls } = fakeFetcher([['/defi/v3/token/meme/list', MEMES]]);
    const be = createBirdeye({ apiKey: API_KEY, fetcher });
    await be.getPulse('new');
    await be.getPulse('final');
    await be.getPulse('migrated');
    const [n, f, m] = calls.map((c) => c.url.searchParams);
    expect(n?.get('sort_by')).toBe('creation_time');
    expect(n?.get('graduated')).toBe('false');
    expect(n?.get('limit')).toBe('50');
    expect(f?.get('sort_by')).toBe('progress_percent');
    expect(f?.get('min_progress_percent')).toBe('50');
    expect(Number(f?.get('min_last_trade_unix_time'))).toBeGreaterThan(Math.floor(Date.now() / 1000) - 3_700);
    expect(m?.get('sort_by')).toBe('graduated_time');
    expect(m?.get('graduated')).toBe('true');
    for (const p of [n, f, m]) expect(p?.get('sort_type')).toBe('desc');
  });

  it('maps meme tokens with Birdeye curve progress, seconds → ms and USD stats', async () => {
    const { fetcher } = fakeFetcher([['/defi/v3/token/meme/list', MEMES]]);
    const res = await createBirdeye({ apiKey: API_KEY, fetcher }).getPulse('new');
    expect(res.freshness).toBe('fast');
    expect(res.data).toHaveLength(3);
    expect(res.data[0]).toEqual({
      mint: '4kniCuBuhsLBPv1zzGFEw8tySw6xV6NiHjme3pN8pump',
      symbol: 'neh',
      name: 'nothing ever Happens',
      image: 'https://ipfs.io/ipfs/QmZF9uaGwUYYq4v9xbPxivHDH561jd1auoPQ8zZLmssLNx',
      creator: '2J2rtMBRLxAbFkSLgrsuSNN8N5KMTJVaRTdnGfbZ5Vjw',
      createdAt: 1770717909000,
      detectedAt: res.fetchedAt,
      launchpad: { stage: 'bonding', launchpad: 'pump.fun', progressPct: 1.08639, progressSource: 'birdeye' },
      priceUsd: 0.000002378761186407517,
      marketCapUsd: 2378.761186407517,
      liquidityUsd: 0.32746902247014553,
      volumeUsd: 83.33272090352035,
      txns: { buys: 3, sells: 2 },
      holders: 2,
      sources: ['birdeye'],
      updatedAt: res.fetchedAt,
    });

    const graduated = res.data[2];
    expect(graduated?.launchpad).toEqual({ stage: 'graduated', launchpad: 'pump.fun', graduatedAt: 1770710000000 });
    expect(graduated?.priceUsd).toBe(0.0000850005);
    expect(graduated?.volumeUsd).toBe(125000.25);
    expect(graduated && 'image' in graduated).toBe(false);
    expect(graduated?.socials).toEqual({ twitter: 'https://x.com/example', website: 'https://example.org' });
  });
});

describe('birdeye venue mapping', () => {
  it('normalizes sources to ORBYT DEX ids and launchpad names', () => {
    expect(birdeyeDex('pump_dot_fun')).toBe('pumpfun');
    expect(birdeyeDex('pump_amm')).toBe('pumpswap');
    expect(birdeyeDex('raydium_cp')).toBe('raydium-cpmm');
    expect(birdeyeDex('meteora_dynamic_bonding_curve')).toBe('meteora-dbc');
    expect(birdeyeDex('solfi_v2')).toBe('solfi-v2');
    expect(birdeyeDex('')).toBeUndefined();
    expect(birdeyeLaunchpad('raydium_launchlab')).toBe('LaunchLab');
    expect(birdeyeLaunchpad('meteora_dynamic_bonding_curve')).toBe('Meteora DBC');
    expect(birdeyeLaunchpad('four.meme')).toBe('four.meme');
  });
});
