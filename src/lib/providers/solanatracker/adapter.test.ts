import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderId } from '@/lib/core/providers';
import type { Interval } from '@/lib/core/types';
import { isProviderError, ProviderError } from '@/lib/net/errors';
import type { JsonFetcher, JsonRequest } from '@/lib/net/types';
import {
  createSolanaTracker,
  SOLANATRACKER_INTERVALS,
  SOLANATRACKER_PULSE_CACHE_MS,
  SOLANATRACKER_SCORE_LABEL,
  stDex,
} from './index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_KEY = 'test-solanatracker-key-4e21c0';
const TRUMP = '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN';
const TRUMP_POOL = '9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2';
const CC = '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump';
const CC_CURVE = '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A';
const PUMPSWAP_POOL = 'D45QQMsxGhohYXGZKDJEowMv2HArrKAsw5V3JnyDZWeS';

type Json = Record<string, unknown>;

function doc(name: string): unknown {
  const file = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/doc-examples/solanatracker', name), 'utf8')) as Json;
  expect(String(file._note)).toMatch(/^DOC EXAMPLE, NOT LIVE DATA\./);
  return file.response;
}

const MULTI = doc('multi-all.doc-example.json') as { latest: Json[]; graduating: Json[]; graduated: Json[] };
const INFO = doc('token-info.doc-example.json') as Json;
const CHART = doc('chart.doc-example.json') as { oclhv: Json[] };
const TRADES = doc('trades.doc-example.json') as { trades: Json[] };
const HOLDERS = doc('holders.doc-example.json') as Json;
const HOLDERS_ENRICHED = doc('holders-enriched.doc-example.json') as Json;
const HOLDERS_TOP = doc('holders-top.doc-example.json') as Json[];

interface Call {
  provider: ProviderId;
  url: URL;
  init?: JsonRequest;
}

type Responder = (url: URL, init?: JsonRequest) => unknown;

/** Fake transport: the first route whose path matches exactly (or by prefix with `*`) answers; Error → reject. */
function fakeFetcher(routes: Array<[match: string, respond: Responder | unknown]>) {
  const calls: Call[] = [];
  const fetcher: JsonFetcher = async <T>(provider: ProviderId, raw: string, init?: JsonRequest): Promise<T> => {
    const url = new URL(raw);
    calls.push({ provider, url, init });
    for (const [match, respond] of routes) {
      const hit = match.endsWith('*') ? url.pathname.startsWith(match.slice(0, -1)) : url.pathname === match;
      if (!hit) continue;
      const value: unknown = typeof respond === 'function' ? await (respond as Responder)(url, init) : respond;
      if (value instanceof Error) throw value;
      return structuredClone(value) as T;
    }
    throw new Error(`unexpected URL in test: ${raw}`);
  };
  return { fetcher, calls };
}

function tracker(routes: Array<[string, Responder | unknown]>, apiKey = API_KEY) {
  const { fetcher, calls } = fakeFetcher(routes);
  return { st: createSolanaTracker({ apiKey, fetcher }), fetcher, calls };
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Deterministic valid 32-byte base58 address. */
function fakeAddress(i: number): string {
  const bytes = new Uint8Array(32).fill(9);
  bytes[0] = (i % 250) + 1;
  bytes[30] = Math.floor(i / 256) % 256;
  bytes[31] = i % 256;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58.charAt(Number(n % 58n)) + s;
    n /= 58n;
  }
  return s;
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Transport contract
// ---------------------------------------------------------------------------

describe('solanatracker transport', () => {
  it('sends the key as x-api-key, never in the URL, always labelled', async () => {
    const { st, calls } = tracker([[`/tokens/${TRUMP}`, INFO]]);
    await st.getRisk(TRUMP);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.provider).toBe('solanatracker');
    expect(call?.url.origin).toBe('https://data.solanatracker.io');
    expect(call?.url.toString()).not.toContain(API_KEY);
    expect(call?.init?.headers).toEqual({ 'x-api-key': API_KEY });
    expect(call?.init?.label).toBe('solanatracker');
  });

  it('maps 401 → not_configured, 403 → http and passes 429 through', async () => {
    const e401 = await rejectionOf(tracker([[`/tokens/${TRUMP}`, new ProviderError('solanatracker', 'http', 'solanatracker: HTTP 401', { status: 401 })]]).st.getRisk(TRUMP));
    expect(e401.code).toBe('not_configured');
    expect(e401.status).toBe(401);

    const e403 = await rejectionOf(tracker([[`/tokens/${TRUMP}`, new ProviderError('solanatracker', 'http', 'solanatracker: HTTP 403', { status: 403 })]]).st.getRisk(TRUMP));
    expect(e403.code).toBe('http');
    expect(e403.status).toBe(403);

    const limited = new ProviderError('solanatracker', 'rate_limited', 'solanatracker: HTTP 429', { status: 429, retryAfterMs: 3_000 });
    const e429 = await rejectionOf(tracker([[`/tokens/${TRUMP}`, limited]]).st.getRisk(TRUMP));
    expect(e429.code).toBe('rate_limited');
    expect(e429.retryAfterMs).toBe(3_000);
  });

  it('never leaks the key in thrown messages', async () => {
    const leaky = new Error(`request failed with x-api-key ${API_KEY}`);
    const e1 = await rejectionOf(tracker([[`/tokens/${TRUMP}`, leaky]]).st.getRisk(TRUMP));
    expect(e1.code).toBe('network');
    expect(e1.message).not.toContain(API_KEY);

    // The documented error body is `{ error: string }`; an echoed key is redacted.
    const echoed = { error: `Invalid API key ${API_KEY}` };
    const e2 = await rejectionOf(tracker([[`/tokens/${TRUMP}`, echoed]]).st.getRisk(TRUMP));
    expect(e2.code).toBe('http');
    expect(e2.message).not.toContain(API_KEY);
    expect(e2.message).toContain('***');

    const withKey = new ProviderError('solanatracker', 'timeout', `solanatracker: timeout (${API_KEY})`);
    const e3 = await rejectionOf(tracker([[`/tokens/${TRUMP}`, withKey]]).st.getRisk(TRUMP));
    expect(e3.code).toBe('timeout');
    expect(e3.message).not.toContain(API_KEY);
  });

  it('reports a missing key as not_configured and rejects invalid mints, both without calling upstream', async () => {
    const { st, calls } = tracker([], '');
    expect((await rejectionOf(st.getRisk(TRUMP))).code).toBe('not_configured');
    expect((await rejectionOf(st.getPulse('new'))).code).toBe('not_configured');
    const { st: keyed, calls: keyedCalls } = tracker([]);
    expect((await rejectionOf(keyed.getHolders('not-a-mint'))).code).toBe('not_found');
    expect((await rejectionOf(keyed.getTrades({ mint: 'nope' }))).code).toBe('not_found');
    expect(calls).toHaveLength(0);
    expect(keyedCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pulse (/tokens/multi/all)
// ---------------------------------------------------------------------------

describe('solanatracker getPulse', () => {
  it('serves all three columns from one shared /tokens/multi/all call', async () => {
    const { st, calls } = tracker([['/tokens/multi/all', MULTI]]);
    const [n, f, m] = await Promise.all([st.getPulse('new'), st.getPulse('final'), st.getPulse('migrated')]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.searchParams.get('limit')).toBe('50');
    // The shared request is issued without any single caller's signal.
    expect(calls[0]?.init?.signal).toBeUndefined();
    for (const res of [n, f, m]) {
      expect(res.source).toBe('solanatracker');
      expect(res.freshness).toBe('fast');
      expect(res.data).toHaveLength(1);
    }
    expect(n.data[0]?.mint).toBe(CC);
    expect(f.data[0]?.mint).toBe('FS53KrzKqNTp3CS7YDSJ61rgyN1cMyUhAbJrn4tbonk');
    expect(m.data[0]?.mint).toBe('8avqVj8keXnxbNxDQ6w7rKZx2Sid8ygp1MBRnhqepump');
  });

  it('maps latest → new: curvePercentage → progress, created_time SECONDS → ms, risk and socials', async () => {
    // As seen at the pool's own lastUpdated (the pool is 100 s old, so its lifetime counters are 24h counts).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_790_000_100_000);
    const res = await tracker([['/tokens/multi/all', MULTI]]).st.getPulse('new');
    expect(res.data[0]).toEqual({
      mint: CC,
      symbol: 'CC',
      name: 'Corgi Capital',
      image: 'https://image.solanatracker.io/proxy?url=https%3A%2F%2Fexample.invalid%2Fcc.png',
      uri: 'https://gateway.pinata.cloud/ipfs/bafkreiayapwpeno6y5lcw2csdodxotsbtzrklxosixwiej3sk72ous32ku',
      creator: 'J5gXsyettqJsMScenY7q7KnNDcojmaKX9jeBCNAMCgBW',
      createdAt: 1_790_000_000_000,
      detectedAt: res.fetchedAt,
      launchpad: { stage: 'bonding', launchpad: 'pump.fun', progressPct: 50.03, progressSource: 'solanatracker' },
      priceUsd: 0.0000124,
      marketCapUsd: 12400,
      marketCapSol: 70.4,
      liquidityUsd: 3100.5,
      volumeUsd: 2400.5,
      txns: { buys: 41, sells: 12 },
      holders: 37,
      socials: { twitter: 'https://x.com/example_cc' },
      risk: {
        top10Pct: 71.2,
        devHoldingPct: 1.5,
        insidersPct: 0.5,
        snipersPct: 2.1,
        providerScore: { value: 2, max: 10, label: SOLANATRACKER_SCORE_LABEL },
        mintAuthorityDisabled: true,
        freezeAuthorityDisabled: true,
      },
      sources: ['solanatracker'],
      updatedAt: res.fetchedAt,
    });
  });

  it('maps graduating → final with the curve launchpad name, real zeros and object risks', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_752_091_418_185);
    const res = await tracker([['/tokens/multi/all', MULTI]]).st.getPulse('final');
    const token = res.data[0];
    expect(token?.launchpad).toEqual({ stage: 'bonding', launchpad: 'letsbonk', progressPct: 89.2, progressSource: 'solanatracker' });
    expect(token?.createdAt).toBe(1_752_091_418_000);
    expect(token?.marketCapSol).toBe(28.887);
    expect(token?.txns).toEqual({ buys: 2, sells: 0 });
    expect(token && 'holders' in token).toBe(false);
    expect(token?.socials).toEqual({ twitter: 'https://x.com/i/communities/1943034658800963764' });
    // Zero holdings are real zeros, not gaps.
    expect(token?.risk).toMatchObject({ top10Pct: 1.7374, devHoldingPct: 0, insidersPct: 0, snipersPct: 0, providerScore: { value: 3, max: 10 } });
  });

  it('maps graduated → migrated with the destination pool and drops unsafe or out-of-range values', async () => {
    const res = await tracker([['/tokens/multi/all', MULTI]]).st.getPulse('migrated');
    const token = res.data[0];
    expect(token?.launchpad).toEqual({ stage: 'graduated', launchpad: 'pump.fun', migratedPool: PUMPSWAP_POOL });
    // http:// logos are dropped; the metadata URI is carried as given.
    expect(token && 'image' in token).toBe(false);
    expect(token?.uri).toBe('ipfs://QmUPiDnnNMz3dkf8TVoknjyQsdAdixB72BMnURnByatYy9');
    expect(token?.volumeUsd).toBe(180000);
    expect(token?.holders).toBe(1450);
    expect(token?.socials).toEqual({ website: 'https://giraffe.example', telegram: 'https://t.me/giraffe_example' });
    // score 11 is outside the documented 0–10 range: omitted, never clamped.
    expect(token?.risk).toEqual({ top10Pct: 24.5, devHoldingPct: 0, mintAuthorityDisabled: true, freezeAuthorityDisabled: true });
  });

  it('falls back to the pool createdAt (MILLISECONDS) when the creation block is missing', async () => {
    const latest = structuredClone(MULTI.latest);
    delete (latest[0]?.token as Json).creation;
    const res = await tracker([['/tokens/multi/all', { ...MULTI, latest }]]).st.getPulse('new');
    expect(res.data[0]?.createdAt).toBe(1_790_000_000_500);
    // The creator then comes from the curve deployer.
    expect(res.data[0]?.creator).toBe('J5gXsyettqJsMScenY7q7KnNDcojmaKX9jeBCNAMCgBW');
  });

  it('maps 24h volume only, never the pool lifetime volume', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_790_000_100_000);
    const latest = structuredClone(MULTI.latest);
    delete (((latest[0]?.pools as Json[])[0] as Json).txns as Json).volume24h;
    const res = await tracker([['/tokens/multi/all', { ...MULTI, latest }]]).st.getPulse('new');
    expect(res.data[0] && 'volumeUsd' in res.data[0]).toBe(false);
    expect(res.data[0]?.txns).toEqual({ buys: 41, sells: 12 });
  });

  it('maps the pool buy / sell counters (lifetime) as 24h counts only while the pool is younger than 24 hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const created = 1_790_000_000_500;
    vi.setSystemTime(created + 86_400_000);
    const young = await tracker([['/tokens/multi/all', MULTI]]).st.getPulse('new');
    expect(young.data[0]?.txns).toEqual({ buys: 41, sells: 12 });

    // One millisecond later the lifetime counters no longer equal a 24h window: unknown, not guessed.
    vi.setSystemTime(created + 86_400_001);
    const old = await tracker([['/tokens/multi/all', MULTI]]).st.getPulse('new');
    expect(old.data[0] && 'txns' in old.data[0]).toBe(false);
    expect(old.data[0]?.volumeUsd).toBe(2400.5);

    // A pool without createdAt has no known age either.
    vi.setSystemTime(created + 1_000);
    const latest = structuredClone(MULTI.latest);
    delete ((latest[0]?.pools as Json[])[0] as Json).createdAt;
    const undated = await tracker([['/tokens/multi/all', { ...MULTI, latest }]]).st.getPulse('new');
    expect(undated.data[0] && 'txns' in undated.data[0]).toBe(false);

    // The migrated doc example: a PumpSwap pool 1,000 s old, then 2 days old.
    vi.setSystemTime(1_770_720_000_000);
    const migrated = await tracker([['/tokens/multi/all', MULTI]]).st.getPulse('migrated');
    expect(migrated.data[0]?.txns).toEqual({ buys: 1200, sells: 900 });
    vi.setSystemTime(1_770_719_000_000 + 2 * 86_400_000);
    const later = await tracker([['/tokens/multi/all', MULTI]]).st.getPulse('migrated');
    expect(later.data[0] && 'txns' in later.data[0]).toBe(false);
  });

  it('treats a full curve, or a primary AMM pool next to the curve, as graduated', async () => {
    const full = structuredClone(MULTI.latest);
    ((full[0]?.pools as Json[])[0] as Json).curvePercentage = 100;
    const res = await tracker([['/tokens/multi/all', { ...MULTI, latest: full }]]).st.getPulse('new');
    expect(res.data[0]?.launchpad).toEqual({ stage: 'graduated', launchpad: 'pump.fun' });

    const migrated = structuredClone(MULTI.latest);
    const curvePool = (migrated[0]?.pools as Json[])[0] as Json;
    const ammPool = { ...structuredClone((MULTI.graduated[0]?.pools as Json[])[0] as Json), tokenAddress: CC };
    (migrated[0] as Json).pools = [ammPool, curvePool];
    const res2 = await tracker([['/tokens/multi/all', { ...MULTI, latest: migrated }]]).st.getPulse('new');
    expect(res2.data[0]?.launchpad).toEqual({ stage: 'graduated', launchpad: 'pump.fun', migratedPool: PUMPSWAP_POOL });
  });

  it('shares the overview for 10 s, then refetches', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const { st, calls } = tracker([['/tokens/multi/all', MULTI]]);
    await st.getPulse('new');
    vi.setSystemTime(1_800_000_000_000 + SOLANATRACKER_PULSE_CACHE_MS - 1);
    await st.getPulse('migrated');
    expect(calls).toHaveLength(1);
    vi.setSystemTime(1_800_000_000_000 + SOLANATRACKER_PULSE_CACHE_MS);
    const res = await st.getPulse('final');
    expect(calls).toHaveLength(2);
    expect(res.fetchedAt).toBe(1_800_000_000_000 + SOLANATRACKER_PULSE_CACHE_MS);
    expect(SOLANATRACKER_PULSE_CACHE_MS).toBe(10_000);
  });

  it('keeps caches apart per API key and per transport', async () => {
    const { fetcher, calls } = fakeFetcher([['/tokens/multi/all', MULTI]]);
    await createSolanaTracker({ apiKey: 'key-a', fetcher }).getPulse('new');
    await createSolanaTracker({ apiKey: 'key-a', fetcher }).getPulse('final');
    await createSolanaTracker({ apiKey: 'key-b', fetcher }).getPulse('new');
    expect(calls).toHaveLength(2);
    const other = fakeFetcher([['/tokens/multi/all', MULTI]]);
    await createSolanaTracker({ apiKey: 'key-a', fetcher: other.fetcher }).getPulse('new');
    expect(other.calls).toHaveLength(1);
  });

  it('evicts a failed overview so the next caller retries', async () => {
    let attempt = 0;
    const { st, calls } = tracker([
      ['/tokens/multi/all', () => (++attempt === 1 ? new ProviderError('solanatracker', 'timeout', 'solanatracker: timeout') : MULTI)],
    ]);
    expect((await rejectionOf(st.getPulse('new'))).code).toBe('timeout');
    const res = await st.getPulse('new');
    expect(res.data).toHaveLength(1);
    expect(calls).toHaveLength(2);

    const bad = tracker([['/tokens/multi/all', { error: 'Internal error' }]]);
    expect((await rejectionOf(bad.st.getPulse('final'))).code).toBe('http');
    expect((await rejectionOf(bad.st.getPulse('final'))).code).toBe('http');
    expect(bad.calls).toHaveLength(2);
  });

  it("lets one caller abort without cancelling the shared request for the others", async () => {
    const gate = deferred<unknown>();
    const { st, calls } = tracker([['/tokens/multi/all', () => gate.promise]]);
    const controller = new AbortController();
    const aborted = st.getPulse('new', controller.signal);
    const other = st.getPulse('migrated');
    controller.abort();
    expect((await rejectionOf(aborted)).code).toBe('aborted');
    gate.resolve(MULTI);
    const res = await other;
    expect(res.data[0]?.launchpad.stage).toBe('graduated');
    expect(calls).toHaveLength(1);
    // An already-aborted signal rejects immediately, still sharing the cache.
    const pre = new AbortController();
    pre.abort();
    expect((await rejectionOf(st.getPulse('final', pre.signal))).code).toBe('aborted');
    expect(calls).toHaveLength(1);
  });

  it('rejects a payload without the column list as malformed', async () => {
    const { st } = tracker([['/tokens/multi/all', { latest: [], graduating: 'x' }]]);
    expect((await st.getPulse('new')).data).toEqual([]);
    expect((await rejectionOf(st.getPulse('final'))).code).toBe('malformed');
    expect((await rejectionOf(st.getPulse('migrated'))).code).toBe('malformed');
  });
});

// ---------------------------------------------------------------------------
// Risk (/tokens/{mint})
// ---------------------------------------------------------------------------

describe('solanatracker getRisk', () => {
  it('maps the documented token info risk block (0–100 percentages, score label, authorities)', async () => {
    const res = await tracker([[`/tokens/${TRUMP}`, INFO]]).st.getRisk(TRUMP);
    expect(res.freshness).toBe('indexed');
    expect(res.data).toEqual({
      mint: TRUMP,
      top10Pct: 88.9709,
      devHoldingPct: 0,
      insidersPct: 0,
      snipersPct: 0,
      bundlersPct: 0,
      providerScore: { value: 0, max: 10, label: 'Risk score (higher = riskier)' },
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      flags: [{ level: 'good', label: 'Jupiter verified', source: 'solanatracker' }],
      sources: ['solanatracker'],
      updatedAt: res.fetchedAt,
    });
  });

  it('maps risks[] objects and strings, rugged and live authorities', async () => {
    const info = structuredClone(MULTI.graduating[0]) as Json;
    const risk = info.risk as Json;
    risk.rugged = true;
    (risk.risks as unknown[]).push('Low liquidity', { name: 'Freeze authority', level: 'danger' });
    ((info.pools as Json[])[0] as Json).security = { mintAuthority: 'J5gXsyettqJsMScenY7q7KnNDcojmaKX9jeBCNAMCgBW', freezeAuthority: null };
    risk.bundlers = { count: 3, totalPercentage: 12.5 };
    const mint = 'FS53KrzKqNTp3CS7YDSJ61rgyN1cMyUhAbJrn4tbonk';
    const res = await tracker([[`/tokens/${mint}`, info]]).st.getRisk(mint);
    expect(res.data.flags).toEqual([
      { level: 'danger', label: 'Marked as rugged', source: 'solanatracker' },
      { level: 'warn', label: 'Bonding curve not complete', detail: 'No Raydium liquidity pool, bonding curve not complete', source: 'solanatracker' },
      { level: 'info', label: 'Low liquidity', source: 'solanatracker' },
      { level: 'danger', label: 'Freeze authority', source: 'solanatracker' },
    ]);
    expect(res.data.mintAuthorityDisabled).toBe(false);
    expect(res.data.freezeAuthorityDisabled).toBe(true);
    expect(res.data.bundlersPct).toBe(12.5);
    expect(res.data.providerScore?.value).toBe(3);
  });

  it('omits unknown fields instead of zero-filling them', async () => {
    const info = { token: INFO.token, pools: [], risk: { top10: 140, dev: {}, score: -1 } };
    const res = await tracker([[`/tokens/${TRUMP}`, info]]).st.getRisk(TRUMP);
    expect(res.data).toEqual({ mint: TRUMP, flags: [], sources: ['solanatracker'], updatedAt: res.fetchedAt });
  });

  it('rejects a payload with neither token nor risk as malformed', async () => {
    expect((await rejectionOf(tracker([[`/tokens/${TRUMP}`, { pools: [] }]]).st.getRisk(TRUMP))).code).toBe('malformed');
  });
});

// ---------------------------------------------------------------------------
// Chart (/chart/{mint}[/{pool}])
// ---------------------------------------------------------------------------

describe('solanatracker getCandles', () => {
  const SORTED = [
    { time: 1710000000, open: 5.9, high: 5.99, low: 5.86, close: 5.95, volume: 1023456.25 },
    { time: 1710003600, open: 5.95, high: 5.97, low: 5.88, close: 5.91, volume: 812345.5 },
    { time: 1710007200, open: 5.91, high: 5.94, low: 5.9, close: 5.93, volume: 402000 },
  ];

  it('serves every ORBYT interval natively with the type id unchanged', async () => {
    expect([...SOLANATRACKER_INTERVALS]).toEqual(['1s', '5s', '15s', '1m', '5m', '15m', '1h', '4h', '1d']);
    const { st, calls } = tracker([[`/chart/${TRUMP}`, CHART]]);
    expect(st.intervals).toBe(SOLANATRACKER_INTERVALS);
    for (const interval of SOLANATRACKER_INTERVALS) await st.getCandles({ mint: TRUMP, interval });
    expect(calls.map((c) => c.url.searchParams.get('type'))).toEqual([...SOLANATRACKER_INTERVALS]);
    const err = await rejectionOf(st.getCandles({ mint: TRUMP, interval: '2h' as Interval }));
    expect(err.code).toBe('unsupported');
  });

  it("parses the misspelled 'oclhv' key into ascending USD candles over a bounded window", async () => {
    const { st, calls } = tracker([[`/chart/${TRUMP}`, CHART]]);
    const res = await st.getCandles({ mint: TRUMP, interval: '1h', before: 1710010000, limit: 3 });
    expect(res.source).toBe('solanatracker');
    expect(res.freshness).toBe('fast');
    expect(res.data).toEqual({ interval: '1h', candles: SORTED });
    const params = calls[0]?.url.searchParams;
    expect(params?.get('time_to')).toBe('1710009999');
    expect(params?.get('time_from')).toBe(String(1710009999 - 3 * 3600));
    expect(params?.get('currency')).toBe('usd');
  });

  it('accepts the bare-array variant from the official guide and millisecond times', async () => {
    const bare = await tracker([[`/chart/${TRUMP}`, CHART.oclhv]]).st.getCandles({ mint: TRUMP, interval: '1h' });
    expect(bare.data.candles).toEqual(SORTED);
    const ms = CHART.oclhv.map((c) => ({ ...c, time: (c.time as number) * 1000 }));
    const res = await tracker([[`/chart/${TRUMP}`, { oclhv: ms }]]).st.getCandles({ mint: TRUMP, interval: '1h' });
    expect(res.data.candles).toEqual(SORTED);
  });

  it('uses the pool path, pages with `before`, trims to `limit` and drops invalid rows', async () => {
    const rows = [...CHART.oclhv, { time: 1710010800, open: 'x', high: 1, low: 1, close: 1 }, null, { ...CHART.oclhv[0], close: 5.92 }];
    const { st, calls } = tracker([[`/chart/${TRUMP}/${TRUMP_POOL}`, { oclhv: rows }]]);
    const res = await st.getCandles({ mint: TRUMP, pool: TRUMP_POOL, interval: '1h', before: 1710007200, limit: 1 });
    expect(calls[0]?.url.pathname).toBe(`/chart/${TRUMP}/${TRUMP_POOL}`);
    expect(res.data.pool).toBe(TRUMP_POOL);
    // 1710007200 is excluded by `before`; the duplicate 1710003600 keeps the last row; `limit` keeps the newest.
    expect(res.data.candles).toEqual([{ ...SORTED[1], close: 5.92 }]);
  });

  it('drops candles that cannot be charted as reported instead of repairing them', async () => {
    const [second, first, third] = CHART.oclhv as [Json, Json, Json];
    const rows = [
      first,
      // close above high, a zero open, a negative low.
      { ...second, close: 6.5 },
      { ...third, open: 0 },
      { ...third, time: 1710010800, low: -1 },
    ];
    const res = await tracker([[`/chart/${TRUMP}`, { oclhv: rows }]]).st.getCandles({ mint: TRUMP, interval: '1h' });
    expect(res.data.candles).toEqual([SORTED[0]]);
  });

  it('returns an honest empty series and rejects unknown shapes', async () => {
    const empty = await tracker([[`/chart/${TRUMP}`, { oclhv: [] }]]).st.getCandles({ mint: TRUMP, interval: '1m' });
    expect(empty.data.candles).toEqual([]);
    expect((await rejectionOf(tracker([[`/chart/${TRUMP}`, { candles: [] }]]).st.getCandles({ mint: TRUMP, interval: '1m' }))).code).toBe('malformed');
  });
});

// ---------------------------------------------------------------------------
// Trades (/trades/{mint}[/{pool}])
// ---------------------------------------------------------------------------

describe('solanatracker getTrades', () => {
  it('maps swaps (time in ms, USD volume, venue) and drops liquidity rows', async () => {
    const { st, calls } = tracker([[`/trades/${TRUMP}`, TRADES]]);
    const res = await st.getTrades({ mint: TRUMP });
    expect(res.freshness).toBe('fast');
    expect(res.data).toEqual([
      {
        signature: '5V4apVkgHf49J5acYPiuh5rB89EGsF8ocSysgnD9vFfZsTtDamhN3MFDKJSq7Dn7Z6Y5XhjghuVYuvvYWnSFpnvW',
        timestamp: 1_789_722_000_000,
        side: 'sell',
        wallet: 'F7R61te4Ac8xZ4pfkJUdF6iaaHy9tnM8nVRUPv8H8EMi',
        tokenAmount: 90,
        usdValue: 540,
        priceUsd: 6,
        pool: TRUMP_POOL,
        dex: 'pumpswap',
        source: 'solanatracker',
      },
      {
        signature: '3RVpxfaDscntzr4abnmjkkN1cDPthzpxG3Pgt6PksmvhzNDFXxCPPxnKByjPJK4vsmXueD3zxuhYq5PpwCuyigLR',
        timestamp: 1_789_721_940_000,
        side: 'buy',
        wallet: '5e2qRc1DNEXmyxP8qwPwJhRWjef7usLyi7v5xjqLr5G7',
        tokenAmount: 12.5,
        usdValue: 74.25,
        priceUsd: 5.94,
        pool: TRUMP_POOL,
        dex: 'meteora-dlmm',
        source: 'solanatracker',
      },
    ]);
    // volumeSol is a SOL valuation, not necessarily a SOL leg: never mapped to solAmount.
    expect(res.data.every((t) => !('solAmount' in t))).toBe(true);
    const params = calls[0]?.url.searchParams;
    expect(params?.get('limit')).toBe('100');
    expect(params?.get('sortDirection')).toBe('DESC');
    expect(params?.get('hideArb')).toBe('true');
  });

  it('uses the pool path, clamps the limit and keeps only trades newer than `since`', async () => {
    const { st, calls } = tracker([[`/trades/${TRUMP}/${TRUMP_POOL}`, TRADES]]);
    const res = await st.getTrades({ mint: TRUMP, pool: TRUMP_POOL, limit: 5_000, since: 1_789_721_940_000 });
    expect(calls[0]?.url.pathname).toBe(`/trades/${TRUMP}/${TRUMP_POOL}`);
    expect(calls[0]?.url.searchParams.get('limit')).toBe('500');
    expect(res.data.map((t) => t.timestamp)).toEqual([1_789_722_000_000]);
  });

  it('accepts a bare array and rejects unknown shapes', async () => {
    const res = await tracker([[`/trades/${TRUMP}`, TRADES.trades]]).st.getTrades({ mint: TRUMP });
    expect(res.data).toHaveLength(2);
    expect((await rejectionOf(tracker([[`/trades/${TRUMP}`, { items: [] }]]).st.getTrades({ mint: TRUMP }))).code).toBe('malformed');
  });
});

// ---------------------------------------------------------------------------
// Holders (/tokens/{mint}/holders)
// ---------------------------------------------------------------------------

describe('solanatracker getHolders', () => {
  it('requests identity labels and maps pool, dev, KOL and bot wallets', async () => {
    const { st, calls } = tracker([[`/tokens/${CC}/holders`, HOLDERS_ENRICHED]]);
    const res = await st.getHolders(CC);
    expect(calls[0]?.url.searchParams.get('enrich')).toBe('identity');
    expect(res.freshness).toBe('indexed');
    expect(res.data.mint).toBe(CC);
    expect(res.data.totalHolders).toBe(812);
    expect(res.data.top).toHaveLength(14);
    // No identity on the curve vault: the exact PDA derivation labels it.
    expect(res.data.top[0]).toEqual({ owner: CC_CURVE, amount: 603185974.343956, pctOfSupply: 60.3185974343956, label: 'Bonding curve', isProgramAccount: true });
    expect(res.data.top[1]).toMatchObject({ owner: PUMPSWAP_POOL, label: 'PumpSwap pool', isProgramAccount: true });
    expect(res.data.top.slice(2, 5).map((h) => h.label)).toEqual(['Dev', 'Example KOL', 'Bot']);
    expect(res.data.top.slice(5).every((h) => h.label === undefined)).toBe(true);
    // Curve and pool are liquidity: the top 10 are the next ten wallets (1.5 + 1.2 + … + 0.4).
    expect(res.data.distribution).toEqual({ top10Pct: expect.closeTo(8.7, 10) });
    expect(res.notes).toEqual(['Top-holder shares exclude bonding-curve and pool accounts.']);
  });

  it('maps the documented example: identity pool → bonding curve, out-of-range shares dropped', async () => {
    const mint = 'FS53KrzKqNTp3CS7YDSJ61rgyN1cMyUhAbJrn4tbonk';
    const res = await tracker([[`/tokens/${mint}/holders`, HOLDERS]]).st.getHolders(mint, 10);
    const [pool, bot] = res.data.top;
    expect(pool).toMatchObject({ owner: 'HYLHTXn74S378oYQHmoJa9yqrfr3DCd8TZtnFCNvySC5', amount: 1032622458.645721, label: 'Bonding curve' });
    expect(pool && 'pctOfSupply' in pool).toBe(false);
    expect(bot).toMatchObject({ owner: 'BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s', pctOfSupply: 96.7377541354279, label: 'Bot' });
    // total (2) ≤ rows (2): the list is complete, so one non-liquidity holder is the whole top 10.
    expect(res.data.distribution).toEqual({ top10Pct: 96.7377541354279 });
  });

  it('accepts the bare /holders/top array (address rows, no total)', async () => {
    const res = await tracker([[`/tokens/${TRUMP}/holders`, HOLDERS_TOP]]).st.getHolders(TRUMP, 100);
    expect(res.data.top).toHaveLength(15);
    expect(res.data.top[0]?.owner).toBe('2RH6rUTPBJ9rUDPpuV9b8z1YL56k1tYU6Uk5ZoaEFFSK');
    expect('totalHolders' in res.data).toBe(false);
    const pct = HOLDERS_TOP.map((h) => h.percentage as number);
    const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);
    // Fewer rows than the 100 cap: complete, so the 11–20 bucket is exact with five holders.
    expect(res.data.distribution?.top10Pct).toBeCloseTo(sum(pct.slice(0, 10)), 10);
    expect(res.data.distribution?.top11to20Pct).toBeCloseTo(sum(pct.slice(10)), 10);
    // No liquidity account was identified: no exclusion caveat.
    expect(res.notes).toBeUndefined();
  });

  it('treats a 20-row bare array as the /holders/top cap, so the 11–20 bucket is exact only when it can be filled', async () => {
    const wallets = Array.from({ length: 19 }, (_, i) => ({ address: fakeAddress(i + 1), amount: 1_000 - i, percentage: 1 }));
    const withCurve = [{ address: CC_CURVE, amount: 600_000_000, percentage: 60 }, ...wallets];
    const res = await tracker([[`/tokens/${CC}/holders`, withCurve]]).st.getHolders(CC, 100);
    expect(res.data.top[0]?.label).toBe('Bonding curve');
    expect(res.data.top).toHaveLength(20);
    // 20 rows is the cap: after excluding the curve only 19 holders are known, so holders 11–20 may be missing their tail.
    expect(res.data.distribution).toEqual({ top10Pct: 10 });
    // 19 rows are below the cap: the list is complete and both buckets are exact.
    const short = await tracker([[`/tokens/${CC}/holders`, withCurve.slice(0, 19)]]).st.getHolders(CC, 100);
    expect(short.data.distribution).toEqual({ top10Pct: 10, top11to20Pct: 8 });
  });

  it("labels a graduated coin's canonical PumpSwap pool without an identity and leaves it out of concentration", async () => {
    // Live-verified vector: tests/fixtures/pump/pumpswap_canonical_pool_decoded_rpc_2026-09-28.json
    const mint = '4ov9rwwS4iBHeTWGCrVaQYW1HzWK51MSfs8csGAApump';
    const pool = '8HbgiXuiNbHRcxiNG8UBD8GLewoy6QVDnPFPgjFGmszf';
    const wallets = Array.from({ length: 10 }, (_, i) => ({ wallet: fakeAddress(i + 1), amount: 1_000 - i, percentage: 1 }));
    const body = { total: 11, accounts: [{ wallet: pool, amount: 900_000_000, percentage: 90 }, ...wallets] };
    const res = await tracker([[`/tokens/${mint}/holders`, body]]).st.getHolders(mint, 100);
    expect(res.data.top[0]).toMatchObject({ owner: pool, label: 'PumpSwap pool', isProgramAccount: true });
    // Without the label the pool's 90% would have been counted as the largest holder.
    expect(res.data.distribution).toEqual({ top10Pct: 10 });
    expect(res.notes).toEqual(['Top-holder shares exclude bonding-curve and pool accounts.']);
  });

  it('slices to the requested limit (max 100) without changing the distribution', async () => {
    const { st } = tracker([[`/tokens/${CC}/holders`, HOLDERS_ENRICHED]]);
    const res = await st.getHolders(CC, 3);
    expect(res.data.top).toHaveLength(3);
    expect(res.data.distribution?.top10Pct).toBeCloseTo(8.7, 10);
  });

  it('rejects unknown shapes as malformed', async () => {
    expect((await rejectionOf(tracker([[`/tokens/${CC}/holders`, { holders: [] }]]).st.getHolders(CC))).code).toBe('malformed');
  });
});

describe('solanatracker market ids', () => {
  it('normalizes markets to ORBYT DEX ids', () => {
    expect(stDex('pumpfun')).toBe('pumpfun');
    expect(stDex('pumpfun-amm')).toBe('pumpswap');
    expect(stDex('raydium-launchpad')).toBe('launchlab');
    expect(stDex('meteora-curve')).toBe('meteora-dbc');
    expect(stDex('Meteora-DLMM')).toBe('meteora-dlmm');
    expect(stDex('some-new-amm')).toBe('some-new-amm');
    expect(stDex('')).toBeUndefined();
  });
});
