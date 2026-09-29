import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getAddressEncoder } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import type { RpcParsedTransaction } from '@/lib/analytics/tx-types';
import { ProviderError } from '@/lib/net/errors';
import type { RpcSignatureInfo, SignaturesQuery } from '@/lib/providers/solana/rpc';
import type { Commitment, LogsNotification } from '@/lib/streams/solana-ws';
import { candleSeriesFromTrades } from '@/lib/analytics/candles';
import { LAMPORTS, p2pMentioningPool, synthTx, WALLET_A, WALLET_B } from '@/test/synthTx';
import {
  createOnchainTradeFeed,
  sharedOnchainTradeFeed,
  type FeedBatch,
  type FeedClock,
  type FeedRpc,
  type FeedVisibility,
  type FeedWs,
  type OnchainTradeFeedOptions,
  type SignatureStatus,
} from './tradeFeed';

/**
 * The on-chain trade feed against mocked RPC / WebSocket / clock /
 * visibility. Transactions are real captures (tests/fixtures/solana-rpc)
 * re-signed so each test controls signatures and block times.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fixtureTx(name: string): RpcParsedTransaction & { meta: { logMessages: string[] } } {
  const file = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/solana-rpc', name), 'utf8')) as { response: { result: RpcParsedTransaction & { meta: { logMessages: string[] } } } };
  return file.response.result;
}

const PUMP_TX = fixtureTx('rpc_getTransaction_pumpfun_bondingcurve_buyV2_v0.json');
const PUMP_MINT = '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump';
const PUMP_CURVE = '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A';
const AMM_TX = fixtureTx('rpc_getTransaction_pumpswap_sell_token2022_v0.json');
const AMM_MINT = '5RJGBaFrTcTrmu5HuukxHxKeqpmRWf346YxQ1kXGetRs';
const AMM_POOL = 'CnJYShWKkDCHeees6Jgi2nx6rekrsu62VqJkDLxpZeNs';
const BASE_TIME = 1_790_628_000;

const sig = (i: number) => `Sig${String(i).padStart(5, '0')}${'x'.repeat(80)}`;

function resign(tx: RpcParsedTransaction, signature: string, blockTime: number): RpcParsedTransaction {
  const copy = structuredClone(tx);
  copy.transaction.signatures[0] = signature;
  copy.blockTime = blockTime;
  return copy;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

async function flush(): Promise<void> {
  // Drain every chained promise / immediate (mock RPC answers take one immediate each) before time moves on.
  for (let i = 0; i < 60; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function manualClock(start = BASE_TIME * 1000 + 600_000): FeedClock & { advance(ms: number): Promise<void> } {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        await flush();
        let next: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of timers) if (entry[1].at <= target && (!next || entry[1].at < next[1].at || (entry[1].at === next[1].at && entry[0] < next[0]))) next = entry;
        if (!next) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].fn();
      }
      now = target;
      await flush();
    },
  };
}

interface MockRpc extends FeedRpc {
  listing: RpcSignatureInfo[];
  txs: Map<string, RpcParsedTransaction | null>;
  statuses: Map<string, SignatureStatus | null>;
  listCalls: SignaturesQuery[];
  txCalls: string[];
  statusCalls: string[][];
  inflight: number;
  maxInflight: number;
  /** Hold getTransaction answers until release(). */
  hold: boolean;
  release(): void;
  failNext: unknown[];
}

function mockRpc(listing: RpcSignatureInfo[] = [], txs = new Map<string, RpcParsedTransaction | null>()): MockRpc {
  const held: Array<() => void> = [];
  const rpc: MockRpc = {
    listing,
    txs,
    statuses: new Map(),
    listCalls: [],
    txCalls: [],
    statusCalls: [],
    inflight: 0,
    maxInflight: 0,
    hold: false,
    failNext: [],
    release() {
      for (const resolve of held.splice(0)) resolve();
    },
    async getSignaturesForAddress(_address, query = {}) {
      rpc.listCalls.push({ ...query });
      let list = rpc.listing;
      if (query.until) {
        const index = list.findIndex((s) => s.signature === query.until);
        if (index >= 0) list = list.slice(0, index);
      }
      if (query.before) {
        const index = list.findIndex((s) => s.signature === query.before);
        list = index >= 0 ? list.slice(index + 1) : [];
      }
      return list.slice(0, query.limit ?? 1000).map((s) => ({ ...s }));
    },
    async getTransaction(signature) {
      rpc.txCalls.push(signature);
      rpc.inflight++;
      rpc.maxInflight = Math.max(rpc.maxInflight, rpc.inflight);
      try {
        if (rpc.hold) await new Promise<void>((resolve) => held.push(resolve));
        else await new Promise<void>((resolve) => setImmediate(resolve));
        const failure = rpc.failNext.shift();
        if (failure !== undefined) throw failure;
        return rpc.txs.get(signature) ?? null;
      } finally {
        rpc.inflight--;
      }
    },
    async getSignatureStatuses(signatures) {
      rpc.statusCalls.push([...signatures]);
      return signatures.map((s) => (rpc.statuses.has(s) ? (rpc.statuses.get(s) ?? null) : null));
    },
  };
  return rpc;
}

function mockWs(): FeedWs & { emit(commitment: Commitment, n: Partial<LogsNotification> & { signature: string }): void; subscriptions: Array<{ address: string; commitment: Commitment }> } {
  const listeners = new Map<Commitment, Set<(n: LogsNotification) => void>>();
  const subscriptions: Array<{ address: string; commitment: Commitment }> = [];
  return {
    subscriptions,
    logsSubscribe(address, listener, options) {
      const commitment = options?.commitment ?? 'confirmed';
      subscriptions.push({ address, commitment });
      let set = listeners.get(commitment);
      if (!set) listeners.set(commitment, (set = new Set()));
      set.add(listener);
      return () => set.delete(listener);
    },
    getStatus: () => ({ status: 'open' }),
    emit(commitment, n) {
      const full: LogsNotification = { err: null, logs: [], receivedAt: 0, source: 'solana-ws', ...n };
      for (const listener of [...(listeners.get(commitment) ?? [])]) listener(full);
    },
  };
}

function mockVisibility(hidden: boolean): FeedVisibility & { set(hidden: boolean): void } {
  let state = hidden;
  const listeners = new Set<(hidden: boolean) => void>();
  return {
    hidden: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      state = next;
      for (const l of [...listeners]) l(next);
    },
  };
}

/** Newest first: index 0 is the most recent. */
function pumpPool(count: number, failed: ReadonlySet<number> = new Set()) {
  const listing: RpcSignatureInfo[] = [];
  const txs = new Map<string, RpcParsedTransaction | null>();
  for (let i = 0; i < count; i++) {
    const blockTime = BASE_TIME + (count - i) * 2;
    const err = failed.has(i) ? { InstructionError: [4, { Custom: 6002 }] } : null;
    listing.push({ signature: sig(i), slot: 1_000 + count - i, blockTime, err, memo: null });
    txs.set(sig(i), resign(PUMP_TX, sig(i), blockTime));
  }
  return { listing, txs };
}

function pumpFeed(rpc: FeedRpc, clock: FeedClock, extra: Partial<OnchainTradeFeedOptions> = {}) {
  return createOnchainTradeFeed({ mint: PUMP_MINT, pool: PUMP_CURVE, isPumpCurve: true, rpc, clock, visibility: null, ...extra });
}

const PUMP_LOGS = PUMP_TX.meta.logMessages;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backfill', () => {
  it('lists 60 signatures and fetches the successful ones newest first, 40 at most, 2 at a time, emitting as they arrive', async () => {
    const { listing, txs } = pumpPool(80, new Set([2, 5]));
    const rpc = mockRpc(listing, txs);
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock, { solPriceUsd: 200, supply: 1_000_000_000 });
    const batches: FeedBatch[] = [];
    feed.subscribe((b) => batches.push(b));
    await clock.advance(30_000);

    expect(rpc.listCalls[0]).toEqual({ limit: 60 });
    const expected = listing.slice(0, 60).filter((s) => s.err === null).slice(0, 40).map((s) => s.signature);
    expect(rpc.txCalls.slice(0, 40)).toEqual(expected);
    expect(rpc.txCalls).not.toContain(sig(2));
    expect(rpc.txCalls).not.toContain(sig(5));
    expect(rpc.maxInflight).toBeLessThanOrEqual(2);
    expect(batches.filter((b) => b.via === 'backfill').length).toBeGreaterThan(10);

    const snapshot = feed.getSnapshot();
    expect(snapshot.status.backfill).toBe('done');
    expect(snapshot.status.listed).toBe(60);
    expect(snapshot.status.exhausted).toBe(false);
    expect(snapshot.trades).toHaveLength(40);
    expect(snapshot.trades.map((t) => t.signature)).toEqual(expected);
    const newest = snapshot.trades[0];
    expect(newest).toMatchObject({ side: 'buy', source: 'solana-rpc', dex: 'pumpfun', pool: PUMP_CURVE, solAmount: 0.987650071, timestamp: (BASE_TIME + 160) * 1000 });
    // Post-trade reserves 39.703185855 SOL / 810,766,172.125991 tokens × $200; MC = price × 1B supply.
    const priceSol = 39.703185855 / 810_766_172.125991;
    expect(newest?.priceUsd).toBeCloseTo(priceSol * 200, 12);
    expect(newest?.usdValue).toBeCloseTo(0.987650071 * 200, 9);
    expect(newest?.marketCapUsd).toBeCloseTo(priceSol * 200 * 1e9, 3);
    // The exact SOL price on the same basis, for SOL charts (not the trade's own 0.98765 SOL / 20.68M tokens ratio).
    expect(snapshot.solPrices.get(newest?.signature ?? '')).toBeCloseTo(priceSol, 18);
    expect(snapshot.solPrices.size).toBe(40);
    feed.teardown();
  });

  it('keeps itself within its RPC budget (28 calls / 10 s, backfill leaves 6 for live work)', async () => {
    const { listing, txs } = pumpPool(60);
    const rpc = mockRpc(listing, txs);
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock);
    feed.subscribe(() => {});
    await clock.advance(5_000);
    // 1 listing + 21 transactions: the low-priority lanes stop at 22 calls in the window.
    expect(rpc.listCalls.length + rpc.txCalls.length).toBe(22);
    await clock.advance(10_000);
    expect(rpc.txCalls.length).toBe(40);
    feed.teardown();
  });

  it('marks a pool whose whole life fits the first page as exhausted and complete', async () => {
    const { listing, txs } = pumpPool(12, new Set([11]));
    const rpc = mockRpc(listing, txs);
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock);
    feed.subscribe(() => {});
    await clock.advance(3_000);
    const { status, trades } = feed.getSnapshot();
    expect(status).toMatchObject({ exhausted: true, complete: true, backfill: 'done', listed: 12 });
    expect(trades).toHaveLength(11);
    feed.teardown();
  });
});

describe('live: WebSocket + reconciliation', () => {
  it('decodes pump.fun trades straight from the notification logs (no RPC) and dedupes everything by signature', async () => {
    const { listing, txs } = pumpPool(2);
    const rpc = mockRpc(listing, txs);
    const ws = mockWs();
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock, { ws, solPriceUsd: 150 });
    feed.subscribe(() => {});
    await clock.advance(1_000);
    expect(ws.subscriptions).toEqual([
      { address: PUMP_CURVE, commitment: 'confirmed' },
      { address: PUMP_CURVE, commitment: 'processed' },
    ]);
    expect(rpc.txCalls).toEqual([sig(0), sig(1)]);

    ws.emit('processed', { signature: sig(50), logs: PUMP_LOGS });
    ws.emit('confirmed', { signature: sig(50), logs: PUMP_LOGS });
    ws.emit('confirmed', { signature: sig(0), logs: PUMP_LOGS });
    let snapshot = feed.getSnapshot();
    expect(snapshot.trades).toHaveLength(3);
    const streamed = snapshot.trades.find((t) => t.signature === sig(50));
    expect(streamed).toMatchObject({ source: 'solana-ws', side: 'buy', wallet: 'DHpRzLRuACd8i1BVGZh8rGQWaQsP7b4spBZFWbzW5WSb', timestamp: 1_790_628_401_000 });
    expect(streamed?.priceUsd).toBeCloseTo((39.703185855 / 810_766_172.125991) * 150, 12);
    expect(snapshot.freshness).toBe('stream');
    expect(snapshot.fresh.has(sig(50))).toBe(true);
    expect(rpc.txCalls).toEqual([sig(0), sig(1)]);

    // Reconciliation lists everything newer than the backfill's newest signature, the streamed one
    // included: nothing is fetched twice; only the unseen one.
    const extra = pumpPool(60);
    rpc.listing = [{ ...extra.listing[59]!, signature: sig(51) }, { ...listing[0]!, signature: sig(50) }, ...listing];
    rpc.txs.set(sig(51), resign(PUMP_TX, sig(51), BASE_TIME + 900));
    await clock.advance(8_000);
    expect(rpc.listCalls.at(-1)).toEqual({ until: sig(0), limit: 200 });
    expect(rpc.txCalls).toEqual([sig(0), sig(1), sig(51)]);
    snapshot = feed.getSnapshot();
    expect(snapshot.trades.map((t) => t.signature)).toEqual([sig(51), sig(50), sig(0), sig(1)]);
    feed.teardown();
  });

  it('fetches the transaction when the logs carry no usable event (truncated logs)', async () => {
    const rpc = mockRpc();
    const ws = mockWs();
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock, { ws });
    feed.subscribe(() => {});
    await clock.advance(100);
    rpc.txs.set(sig(7), resign(PUMP_TX, sig(7), BASE_TIME + 10));
    ws.emit('confirmed', { signature: sig(7), logs: [...PUMP_LOGS.slice(0, 20), 'Log truncated'] });
    await clock.advance(100);
    expect(rpc.txCalls).toEqual([sig(7)]);
    expect(feed.getSnapshot().trades[0]).toMatchObject({ signature: sig(7), source: 'solana-rpc' });
    feed.teardown();
  });

  it('reconciles every 8 s: one listing, successful and unseen only, 10 fetched per round, the rest carried over', async () => {
    const rpc = mockRpc([]);
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock, { ws: mockWs() });
    feed.subscribe(() => {});
    await clock.advance(1_000);
    expect(feed.getSnapshot().status).toMatchObject({ backfill: 'done', exhausted: true });

    const { listing, txs } = pumpPool(25, new Set([0, 3]));
    rpc.listing = listing;
    for (const [k, v] of txs) rpc.txs.set(k, v);
    await clock.advance(7_000); // t = 8 s: nothing listed yet → the newest 20
    expect(rpc.listCalls.at(-1)).toEqual({ limit: 20 });
    const firstRound = listing.slice(0, 20).filter((s) => s.err === null).slice(0, 10).map((s) => s.signature);
    expect(rpc.txCalls).toEqual(firstRound);

    // Two new signatures land; the next round lists only what is newer than the last listing.
    const newer = pumpPool(2);
    rpc.listing = [{ ...newer.listing[0]!, signature: sig(90) }, { ...newer.listing[1]!, signature: sig(91) }, ...listing];
    rpc.txs.set(sig(90), resign(PUMP_TX, sig(90), BASE_TIME + 500));
    rpc.txs.set(sig(91), resign(PUMP_TX, sig(91), BASE_TIME + 499));
    await clock.advance(8_000); // t = 16 s
    expect(rpc.listCalls.at(-1)).toEqual({ until: sig(0), limit: 200 });
    const carried = listing.slice(0, 20).filter((s) => s.err === null).slice(10).map((s) => s.signature);
    // New ones first, then the backlog, 10 per round.
    const secondRound = [sig(90), sig(91), ...carried].slice(0, 10);
    expect(rpc.txCalls).toEqual([...firstRound, ...secondRound]);
    await clock.advance(8_000); // t = 24 s
    expect(rpc.listCalls.at(-1)).toEqual({ until: sig(90), limit: 200 });
    expect(new Set(rpc.txCalls)).toEqual(new Set([...firstRound, sig(90), sig(91), ...carried]));
    expect(rpc.txCalls).not.toContain(sig(0));
    expect(rpc.txCalls).not.toContain(sig(3));
    expect(feed.getSnapshot().status.polls).toBe(3);
    feed.teardown();
  });

  it('AMM pools: a WS hint triggers getTransaction + swap derivation, 3 in flight at most; failed transactions are ignored', async () => {
    const rpc = mockRpc();
    const ws = mockWs();
    const clock = manualClock();
    const feed = createOnchainTradeFeed({ mint: AMM_MINT, pool: AMM_POOL, isPumpCurve: false, rpc, ws, clock, visibility: null, solPriceUsd: 100 });
    feed.subscribe(() => {});
    await clock.advance(100);

    rpc.txs.set(sig(1), resign(AMM_TX, sig(1), BASE_TIME + 1));
    ws.emit('processed', { signature: sig(1) });
    await clock.advance(500);
    expect(rpc.txCalls).toEqual([]); // a 'processed' hint waits for 'confirmed'
    await clock.advance(400);
    expect(rpc.txCalls).toEqual([sig(1)]);
    const trade = feed.getSnapshot().trades[0];
    expect(trade).toMatchObject({ signature: sig(1), side: 'sell', pool: AMM_POOL, source: 'solana-rpc' });
    expect(trade?.priceUsd).toBeGreaterThan(0);

    ws.emit('confirmed', { signature: sig(2), err: { InstructionError: [0, { Custom: 1 }] } });
    rpc.hold = true;
    for (let i = 10; i < 16; i++) {
      rpc.txs.set(sig(i), resign(AMM_TX, sig(i), BASE_TIME + i));
      ws.emit('confirmed', { signature: sig(i) });
    }
    await clock.advance(50);
    expect(rpc.inflight).toBe(3);
    rpc.hold = false;
    for (let round = 0; round < 3; round++) {
      rpc.release();
      await clock.advance(10);
    }
    expect(rpc.maxInflight).toBe(3);
    expect(rpc.txCalls).not.toContain(sig(2));
    expect(feed.getSnapshot().trades).toHaveLength(7);
    expect(feed.getSnapshot().freshness).toBe('stream');
    feed.teardown();
  });

  it('removes a trade seen at "processed" that the chain reports failed or never confirms; keeps confirmed ones', async () => {
    const rpc = mockRpc();
    const ws = mockWs();
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock, { ws });
    feed.subscribe(() => {});
    await clock.advance(100);
    ws.emit('processed', { signature: sig(1), logs: PUMP_LOGS });
    ws.emit('processed', { signature: sig(2), logs: PUMP_LOGS });
    ws.emit('processed', { signature: sig(3), logs: PUMP_LOGS });
    ws.emit('confirmed', { signature: sig(3), logs: PUMP_LOGS });
    expect(feed.getSnapshot().trades).toHaveLength(3);

    rpc.statuses.set(sig(1), { err: { InstructionError: [3, { Custom: 6003 }] }, confirmationStatus: 'confirmed' });
    await clock.advance(8_000);
    expect(rpc.statusCalls[0]).toEqual([sig(1), sig(2)]);
    expect(feed.getSnapshot().trades.map((t) => t.signature).sort()).toEqual([sig(2), sig(3)]);

    // sig(2): still unknown to the chain 45 s later → a dropped fork.
    await clock.advance(40_000);
    expect(feed.getSnapshot().trades.map((t) => t.signature)).toEqual([sig(3)]);
    feed.teardown();
  });

  it('pauses while the document is hidden and catches up when it is shown', async () => {
    const { listing, txs } = pumpPool(5);
    const rpc = mockRpc(listing, txs);
    const clock = manualClock();
    const visibility = mockVisibility(true);
    const feed = pumpFeed(rpc, clock, { visibility, ws: mockWs() });
    feed.subscribe(() => {});
    await clock.advance(30_000);
    expect(rpc.listCalls).toEqual([]);
    expect(rpc.txCalls).toEqual([]);
    expect(feed.getSnapshot().status.paused).toBe(true);

    visibility.set(false);
    await clock.advance(1_000);
    expect(rpc.listCalls.map((q) => q.limit).sort()).toEqual([20, 60]); // backfill + the catch-up round
    expect(feed.getSnapshot().trades).toHaveLength(5);

    visibility.set(true);
    const calls = rpc.listCalls.length;
    await clock.advance(30_000);
    expect(rpc.listCalls.length).toBe(calls);
    feed.teardown();
  });

  it('backs off on a rate limit and keeps the error visible until the next success', async () => {
    const { listing, txs } = pumpPool(1);
    const rpc = mockRpc(listing, txs);
    rpc.failNext.push(new ProviderError('solana-rpc', 'rate_limited', 'browser-rpc getTransaction: HTTP 429', { status: 429 }));
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock);
    feed.subscribe(() => {});
    await clock.advance(100);
    expect(feed.getSnapshot().status.error).toBe('solana-rpc: rate limited');
    expect(feed.getSnapshot().trades).toHaveLength(0);
    await clock.advance(3_000);
    expect(rpc.txCalls).toHaveLength(1); // paused ≥ 5 s
    await clock.advance(3_000);
    expect(rpc.txCalls).toHaveLength(2);
    expect(feed.getSnapshot().trades).toHaveLength(1);
    expect(feed.getSnapshot().status.error).toBeUndefined();
    feed.teardown();
  });

  it('reports a failed feed when nothing could be read, then restarts the backfill from the reconciliation loop', async () => {
    const rpc = mockRpc();
    rpc.getSignaturesForAddress = async () => {
      throw new ProviderError('solana-rpc', 'network', 'browser-rpc getSignaturesForAddress: network error');
    };
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock);
    feed.subscribe(() => {});
    // Listing attempts at 0 s, 3 s and 9 s, then 'error'.
    await clock.advance(12_000);
    expect(feed.getSnapshot().status).toMatchObject({ backfill: 'error', failed: true, error: 'solana-rpc: unavailable', errorCode: 'network' });
    // The 16 s reconciliation round starts the backfill over instead of a 20-signature round.
    await clock.advance(5_000);
    expect(feed.getSnapshot().status).toMatchObject({ backfill: 'loading', failed: true });
    feed.teardown();
  });
});

describe('history', () => {
  it('pages older signatures with `before` until the pool’s first transaction, then reports the history complete', async () => {
    const { listing, txs } = pumpPool(150);
    const rpc = mockRpc(listing, txs);
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock);
    feed.subscribe(() => {});
    await clock.advance(20_000);
    expect(feed.getSnapshot().status).toMatchObject({ listed: 60, exhausted: false, complete: false });

    void feed.loadHistory();
    await clock.advance(80_000);
    expect(rpc.listCalls.filter((q) => q.before !== undefined)).toEqual([{ before: sig(59), limit: 1_000 }]);
    const { status, trades } = feed.getSnapshot();
    expect(status).toMatchObject({ listed: 150, exhausted: true, complete: true, history: 'done' });
    expect(trades).toHaveLength(150);
    expect(trades.at(-1)?.signature).toBe(sig(149));
    feed.teardown();
  });

  it('stops after ~300 transactions for a busy pool (never reports it complete)', async () => {
    const { listing, txs } = pumpPool(1_500);
    const rpc = mockRpc(listing, txs);
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock);
    feed.subscribe(() => {});
    void feed.loadHistory();
    await clock.advance(200_000);
    expect(rpc.listCalls.filter((q) => q.limit !== 200 && q.limit !== 20)).toEqual([{ limit: 60 }, { before: sig(59), limit: 1_000 }]);
    const { status } = feed.getSnapshot();
    expect(status).toMatchObject({ listed: 1_060, exhausted: false, complete: false, history: 'done' });
    expect(new Set(rpc.txCalls).size).toBe(300);
    // Newest first: the 300 most recent transactions.
    expect(new Set(rpc.txCalls)).toEqual(new Set(listing.slice(0, 300).map((s) => s.signature)));
    feed.teardown();
  });

  it('walks past failed sniper spam: a live-shaped 734-signature curve with 53 successful trades is fetched whole', async () => {
    // Shape of a real 34 s old pump.fun curve (2026-09-29): 734 signatures, 681 failed.
    const okAt = new Set([1, 2, 3, 4, 5, 6, 7, 53, 68, 163, 181, 182, 254, 280, 295, 297, 308, 349, 396, 408, 417, 420, 438, 447, 453, 454, 455, 459, 464, 469, 470, 473, 474, 489, 512, 534, 545, 594, 640, 651, 681, 716, 717, 722, 724, 725, 726, 727, 728, 730, 731, 732, 733]);
    const failed = new Set(Array.from({ length: 734 }, (_, i) => i).filter((i) => !okAt.has(i)));
    const { listing, txs } = pumpPool(734, failed);
    const rpc = mockRpc(listing, txs);
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock);
    feed.subscribe(() => {});
    void feed.loadHistory();
    await clock.advance(30_000);
    const { status, trades } = feed.getSnapshot();
    expect(status).toMatchObject({ listed: 734, exhausted: true, complete: true, history: 'done' });
    expect(trades).toHaveLength(53);
    expect(rpc.txCalls.every((signature) => okAt.has(Number(signature.slice(3, 8))))).toBe(true);
    feed.teardown();
  });
});

describe('pricing, lifecycle and sharing', () => {
  it('re-prices held trades when the SOL price and the supply arrive', async () => {
    const { listing, txs } = pumpPool(2);
    const rpc = mockRpc(listing, txs);
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock);
    const batches: FeedBatch[] = [];
    feed.subscribe((b) => batches.push(b));
    await clock.advance(1_000);
    expect(feed.getSnapshot().trades[0]?.priceUsd).toBeUndefined();
    feed.setSolPriceUsd(120);
    expect(batches.at(-1)).toMatchObject({ via: 'reprice' });
    expect(feed.getSnapshot().trades[0]?.priceUsd).toBeCloseTo((39.703185855 / 810_766_172.125991) * 120, 12);
    expect(feed.getSnapshot().trades[0]?.marketCapUsd).toBeUndefined();
    feed.setSupply(1_000_000_000);
    expect(feed.getSnapshot().trades[0]?.marketCapUsd).toBeGreaterThan(0);
    feed.teardown();
  });

  it('keeps the snapshot and the trades array stable between changes', async () => {
    const { listing, txs } = pumpPool(2);
    const rpc = mockRpc(listing, txs);
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock);
    feed.subscribe(() => {});
    await clock.advance(1_000);
    const a = feed.getSnapshot();
    expect(feed.getSnapshot()).toBe(a);
    await clock.advance(8_000); // a reconciliation round with nothing new
    const b = feed.getSnapshot();
    expect(b).not.toBe(a);
    expect(b.trades).toBe(a.trades);
    feed.teardown();
  });

  it('stops everything on teardown', async () => {
    const { listing, txs } = pumpPool(3);
    const rpc = mockRpc(listing, txs);
    const ws = mockWs();
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock, { ws });
    let calls = 0;
    feed.subscribe(() => calls++);
    await clock.advance(1_000);
    feed.teardown();
    const before = { list: rpc.listCalls.length, tx: rpc.txCalls.length, calls };
    ws.emit('confirmed', { signature: sig(99), logs: PUMP_LOGS });
    await clock.advance(60_000);
    expect({ list: rpc.listCalls.length, tx: rpc.txCalls.length, calls }).toEqual(before);
    expect(feed.tornDown).toBe(true);
    expect(feed.subscribe(() => {})).toBeTypeOf('function');
  });

  it('shares one feed per mint + pool and tears it down after the last listener left (StrictMode remounts reuse it)', async () => {
    const { listing, txs } = pumpPool(2);
    const rpc = mockRpc(listing, txs);
    const clock = manualClock();
    const options = { mint: PUMP_MINT, pool: PUMP_CURVE, isPumpCurve: true, rpc, clock, visibility: null };
    const a = sharedOnchainTradeFeed(options);
    expect(sharedOnchainTradeFeed(options)).toBe(a);
    const off1 = a.subscribe(() => {});
    off1();
    const off2 = a.subscribe(() => {}); // remount within the idle window
    await clock.advance(5_000);
    expect(a.tornDown).toBe(false);
    expect(rpc.listCalls[0]).toEqual({ limit: 60 });
    expect(rpc.listCalls.filter((q) => q.limit === 60)).toHaveLength(1); // one backfill for both mounts
    off2();
    await clock.advance(3_000);
    expect(a.tornDown).toBe(true);
    const b = sharedOnchainTradeFeed(options);
    expect(b).not.toBe(a);
    b.teardown();
  });
});

// ---------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------

const PROGRAM_DATA = 'Program data: ';
const EVENT_LINE = PUMP_LOGS.findIndex((line) => line.startsWith(PROGRAM_DATA));

/** The buy's logs with a second TradeEvent of the same mint by wallet B for 3× the tokens (a launch bundle). */
function bundleLogs(): string[] {
  const bytes = Buffer.from((PUMP_LOGS[EVENT_LINE] as string).slice(PROGRAM_DATA.length), 'base64');
  const other = Buffer.from(bytes);
  other.set(getAddressEncoder().encode(WALLET_B as Parameters<ReturnType<typeof getAddressEncoder>['encode']>[0]), 57);
  other.writeBigUInt64LE(bytes.readBigUInt64LE(48) * 3n, 48);
  return [...PUMP_LOGS.slice(0, EVENT_LINE + 1), `${PROGRAM_DATA}${other.toString('base64')}`, ...PUMP_LOGS.slice(EVENT_LINE + 1)];
}

const listed = (signature: string, blockTime: number, err: unknown = null): RpcSignatureInfo => ({ signature, slot: blockTime, blockTime, err, memo: null });

describe('transactions that only list the pool are not trades', () => {
  it('AMM pool: a peer-to-peer transfer listing the pool never becomes a trade (backfill and WS hint)', async () => {
    const rpc = mockRpc(
      [listed(sig(2), BASE_TIME + 2), listed(sig(1), BASE_TIME + 1)],
      new Map([
        [sig(1), resign(AMM_TX, sig(1), BASE_TIME + 1)],
        [sig(2), p2pMentioningPool(sig(2), AMM_POOL, AMM_MINT, BASE_TIME + 2)],
      ]),
    );
    const ws = mockWs();
    const clock = manualClock();
    const feed = createOnchainTradeFeed({ mint: AMM_MINT, pool: AMM_POOL, isPumpCurve: false, rpc, ws, clock, visibility: null, solPriceUsd: 100 });
    feed.subscribe(() => {});
    await clock.advance(1_000);
    expect(rpc.txCalls).toEqual([sig(2), sig(1)]);
    expect(feed.getSnapshot().trades.map((t) => t.signature)).toEqual([sig(1)]);

    // The same fake print pushed through the log subscription: fetched, rejected, and the stream is not credited.
    rpc.txs.set(sig(3), p2pMentioningPool(sig(3), AMM_POOL, AMM_MINT, BASE_TIME + 3));
    ws.emit('confirmed', { signature: sig(3) });
    await clock.advance(100);
    expect(rpc.txCalls).toContain(sig(3));
    expect(feed.getSnapshot().trades.map((t) => t.signature)).toEqual([sig(1)]);
    expect(feed.getSnapshot().freshness).toBe('realtime');
    expect(feed.getSnapshot().status.lastStreamAt).toBeUndefined();
    feed.teardown();
  });

  it('pump.fun curve: only the program’s own TradeEvent of the mint proves a trade (a transfer listing the curve is ignored)', async () => {
    const rpc = mockRpc(
      [listed(sig(2), BASE_TIME + 2), listed(sig(1), BASE_TIME + 1)],
      new Map([
        [sig(1), resign(PUMP_TX, sig(1), BASE_TIME + 1)],
        [sig(2), p2pMentioningPool(sig(2), PUMP_CURVE, PUMP_MINT, BASE_TIME + 2)],
      ]),
    );
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock, { solPriceUsd: 100 });
    feed.subscribe(() => {});
    await clock.advance(1_000);
    expect(feed.getSnapshot().trades.map((t) => t.signature)).toEqual([sig(1)]);
    expect(feed.getSnapshot().status.skipped).toBe(0);
    feed.teardown();
  });
});

describe('pools quoted in another asset than SOL or a stablecoin (e.g. StonkFun / GLDx)', () => {
  // A quote asset that is neither SOL nor a stablecoin (a StonkFun pool's GLDx, say), 9 decimals.
  const GLDX = 'GLDxQuoteAsset11111111111111111111111111111';
  const OTHER_POOL = '3JsCd8LjmmyPT1PhfQZnJeZQwxr5FD6YgzZQDM61Btwc';
  const tokens = (raw: bigint) => ({ owner: WALLET_A, mint: AMM_MINT, decimals: 6, pre: 0n, post: raw });
  const poolLegs = [
    { owner: AMM_POOL, mint: AMM_MINT, decimals: 6, pre: 5_000_000_000n, post: 4_000_000_000n },
    { owner: AMM_POOL, mint: GLDX, decimals: 9, pre: 10_000_000_000n, post: 10_200_000_000n },
  ];
  // The trader pays 0.2 GLDx for 1,000 tokens.
  const direct = (signature: string, blockTime: number) =>
    synthTx(
      signature,
      [
        { pubkey: WALLET_A, signer: true, pre: 10 * LAMPORTS, post: 10 * LAMPORTS - 5_000 },
        { pubkey: AMM_POOL, pre: LAMPORTS, post: LAMPORTS },
      ],
      [tokens(1_000_000_000n), { owner: WALLET_A, mint: GLDX, decimals: 9, pre: 1_000_000_000n, post: 800_000_000n }, ...poolLegs],
      [],
      blockTime,
    );
  // The trader pays 0.5 SOL; another pool swaps it into the 0.2 GLDx this pool takes for 1,000 tokens.
  const routed = (signature: string, blockTime: number) =>
    synthTx(
      signature,
      [
        { pubkey: WALLET_A, signer: true, pre: 10 * LAMPORTS, post: 9.5 * LAMPORTS - 5_000 },
        { pubkey: AMM_POOL, pre: LAMPORTS, post: LAMPORTS },
        { pubkey: OTHER_POOL, pre: LAMPORTS, post: 1.5 * LAMPORTS },
      ],
      [tokens(1_000_000_000n), ...poolLegs, { owner: OTHER_POOL, mint: GLDX, decimals: 9, pre: 5_000_000_000n, post: 4_800_000_000n }],
      [],
      blockTime,
    );

  it('prices trades in the quote asset and values them in USD once its USD price is known, so the chart can draw them', async () => {
    const rpc = mockRpc(
      [listed(sig(2), BASE_TIME + 90), listed(sig(1), BASE_TIME + 1)],
      new Map([
        [sig(1), direct(sig(1), BASE_TIME + 1)],
        [sig(2), routed(sig(2), BASE_TIME + 90)],
      ]),
    );
    const clock = manualClock();
    const feed = createOnchainTradeFeed({ mint: AMM_MINT, pool: AMM_POOL, isPumpCurve: false, rpc, clock, visibility: null, solPriceUsd: 100 });
    const batches: FeedBatch[] = [];
    feed.subscribe((b) => batches.push(b));
    await clock.advance(1_000);

    // Both trades are real and held, but without GLDx/USD neither has a USD price: no bar can be drawn yet.
    const before = feed.getSnapshot().trades;
    expect(before.map((t) => t.signature)).toEqual([sig(2), sig(1)]);
    expect(before.every((t) => t.priceUsd === undefined)).toBe(true);
    expect(before[0]?.usdValue).toBeCloseTo(50, 9); // the 0.5 SOL the routed trader paid
    expect(before[1]?.usdValue).toBeUndefined();
    expect(candleSeriesFromTrades(before, '1m').candles).toEqual([]);

    feed.setQuotePriceUsd({ mint: GLDX, priceUsd: 400 });
    expect(batches.at(-1)).toMatchObject({ via: 'reprice' });
    const [routedTrade, directTrade] = feed.getSnapshot().trades;
    // Venue price 0.0002 GLDx per token × $400, for both: the routed trade is priced by the pool, not by its SOL leg.
    expect(directTrade?.priceUsd).toBeCloseTo(0.08, 12);
    expect(directTrade?.usdValue).toBeCloseTo(80, 9);
    expect(routedTrade?.priceUsd).toBeCloseTo(0.08, 12);
    expect(routedTrade?.usdValue).toBeCloseTo(50, 9);
    const series = candleSeriesFromTrades(feed.getSnapshot().trades, '1m');
    expect(series.derivation?.trades).toBe(2);
    expect(series.candles).toHaveLength(2);

    // Trades keep the value they were first priced at when the quote price goes away.
    feed.setQuotePriceUsd(undefined);
    expect(feed.getSnapshot().trades[1]?.priceUsd).toBeCloseTo(0.08, 12);
    feed.teardown();
  });

  it('never values GLDx trades with a price for another asset', async () => {
    const rpc = mockRpc([listed(sig(1), BASE_TIME + 1)], new Map([[sig(1), direct(sig(1), BASE_TIME + 1)]]));
    const clock = manualClock();
    const feed = createOnchainTradeFeed({ mint: AMM_MINT, pool: AMM_POOL, isPumpCurve: false, rpc, clock, visibility: null, solPriceUsd: 100, quoteUsd: { mint: OTHER_POOL, priceUsd: 5 } });
    feed.subscribe(() => {});
    await clock.advance(1_000);
    expect(feed.getSnapshot().trades).toHaveLength(1);
    expect(feed.getSnapshot().trades[0]?.priceUsd).toBeUndefined();
    feed.teardown();
  });
});

describe('WebSocket log decoding edge cases', () => {
  it('fetches the transaction when the logs are truncated after an event (the cut may hide more events)', async () => {
    const rpc = mockRpc();
    const ws = mockWs();
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock, { ws });
    feed.subscribe(() => {});
    await clock.advance(100);
    rpc.txs.set(sig(7), resign(PUMP_TX, sig(7), BASE_TIME + 10));
    ws.emit('confirmed', { signature: sig(7), logs: [...PUMP_LOGS.slice(0, EVENT_LINE + 1), 'Log truncated'] });
    await clock.advance(100);
    expect(rpc.txCalls).toEqual([sig(7)]);
    expect(feed.getSnapshot().trades[0]).toMatchObject({ signature: sig(7), source: 'solana-rpc' });
    feed.teardown();
  });

  it('decodes a bundle (two users in one transaction) from the logs: the larger user’s own events, no RPC', async () => {
    const rpc = mockRpc();
    const ws = mockWs();
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock, { ws, solPriceUsd: 150 });
    feed.subscribe(() => {});
    await clock.advance(100);
    ws.emit('confirmed', { signature: sig(8), logs: bundleLogs() });
    expect(rpc.txCalls).toEqual([]);
    const trade = feed.getSnapshot().trades[0];
    expect(trade).toMatchObject({ signature: sig(8), source: 'solana-ws', side: 'buy', wallet: WALLET_B });
    expect(trade?.tokenAmount).toBeCloseTo(20_682_995.874269 * 3, 6);
    feed.teardown();
  });
});

describe('completeness is reported, never assumed', () => {
  /** 1 signature at backfill, then `extra` newer successful ones land at once while the WebSocket is silent. */
  async function busyPool(extra: number, opts: { history?: boolean } = {}) {
    const { listing, txs } = pumpPool(extra + 1);
    const rpc = mockRpc(listing.slice(extra), txs);
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock, { ws: mockWs() });
    feed.subscribe(() => {});
    await clock.advance(1_000);
    if (opts.history) await feed.loadHistory();
    expect(feed.getSnapshot().status).toMatchObject({ exhausted: true, complete: true, listed: 1 });
    rpc.listing = listing;
    return { rpc, clock, feed };
  }

  it('counts listed signatures the reconciliation backlog cannot hold, and never calls that history complete', async () => {
    const { rpc, clock, feed } = await busyPool(100);
    await clock.advance(7_500); // first reconciliation: 100 new, 60 kept, 40 dropped, 10 fetched
    expect(feed.getSnapshot().status).toMatchObject({ dropped: 40, missed: 40, unlisted: false, complete: false });
    expect(rpc.txCalls).toHaveLength(11);
    await clock.advance(60_000); // the backlog drains; the 40 dropped stay missing
    expect(feed.getSnapshot().trades).toHaveLength(61);
    expect(feed.getSnapshot().status).toMatchObject({ dropped: 40, complete: false });
    feed.teardown();
  });

  it('once the chart asked for the whole history of a young pool, overflow is fetched later on the history lane', async () => {
    const { rpc, clock, feed } = await busyPool(100, { history: true });
    await clock.advance(7_500);
    expect(feed.getSnapshot().status).toMatchObject({ dropped: 0, missed: 0, complete: false });
    await clock.advance(90_000);
    expect(new Set(rpc.txCalls).size).toBe(101);
    expect(feed.getSnapshot().trades).toHaveLength(101);
    expect(feed.getSnapshot().status).toMatchObject({ dropped: 0, missed: 0, complete: true });
    feed.teardown();
  });

  it('marks a listing that filled its whole window (signatures between two polls may never be listed)', async () => {
    const { clock, feed } = await busyPool(250, { history: true });
    await clock.advance(7_500);
    expect(feed.getSnapshot().status).toMatchObject({ unlisted: true, complete: false });
    feed.teardown();
  });

  it('a WS hint the node never returns (a dropped fork) is neither skipped nor remembered: a later listing still fetches it', async () => {
    const rpc = mockRpc();
    const ws = mockWs();
    const clock = manualClock();
    const feed = createOnchainTradeFeed({ mint: AMM_MINT, pool: AMM_POOL, isPumpCurve: false, rpc, ws, clock, visibility: null, solPriceUsd: 100 });
    feed.subscribe(() => {});
    await clock.advance(100);
    ws.emit('confirmed', { signature: sig(5) });
    await clock.advance(7_000);
    expect(rpc.txCalls).toEqual([sig(5), sig(5), sig(5)]);
    expect(feed.getSnapshot().status).toMatchObject({ skipped: 0, missed: 0 });

    // It lands after all and is listed: fetched again, now a trade.
    rpc.txs.set(sig(5), resign(AMM_TX, sig(5), BASE_TIME + 5));
    rpc.listing = [listed(sig(5), BASE_TIME + 5)];
    await clock.advance(8_000);
    expect(feed.getSnapshot().trades.map((t) => t.signature)).toEqual([sig(5)]);
    feed.teardown();
  });

  it('a provisional trade dropped with its fork can be listed and fetched again when it re-lands', async () => {
    const rpc = mockRpc();
    const ws = mockWs();
    const clock = manualClock();
    const feed = pumpFeed(rpc, clock, { ws });
    feed.subscribe(() => {});
    await clock.advance(100);
    ws.emit('processed', { signature: sig(1), logs: PUMP_LOGS });
    expect(feed.getSnapshot().trades).toHaveLength(1);
    await clock.advance(50_000); // no status for 45 s: dropped
    expect(feed.getSnapshot().trades).toHaveLength(0);

    rpc.txs.set(sig(1), resign(PUMP_TX, sig(1), BASE_TIME + 60));
    rpc.listing = [listed(sig(1), BASE_TIME + 60)];
    await clock.advance(8_000);
    expect(rpc.txCalls).toEqual([sig(1)]);
    expect(feed.getSnapshot().trades[0]).toMatchObject({ signature: sig(1), source: 'solana-rpc' });
    feed.teardown();
  });
});
