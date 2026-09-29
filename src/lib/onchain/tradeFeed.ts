import { decodePumpTradeEvents, decodePumpTradeEventsFromLogs, deriveTradeForMint, logsTruncated } from '@/lib/analytics/swaps';
import { compareTradesNewestFirst } from '@/lib/analytics/trades';
import type { RpcParsedTransaction } from '@/lib/analytics/tx-types';
import { MINTS, STABLE_MINTS } from '@/lib/core/solana';
import type { Freshness, Trade } from '@/lib/core/types';
import { describeError, isAbortError, isProviderError, type ProviderError } from '@/lib/net/errors';
import type { RpcSignatureInfo, SignaturesQuery } from '@/lib/providers/solana/rpc';
import { toTrade } from '@/lib/providers/solana/trades';
import type { Commitment, LogsNotification } from '@/lib/streams/solana-ws';
import { PUMP_DECIMALS, priceWithSol, pumpTradeFromEvents, type NativeTrade, type QuoteUsd } from './pumpTrades';
import { corroborateWithPool } from './tradeGuard';

/**
 * On-chain trade feed for one pool, keyless, straight from the browser:
 * publicnode's JSON-RPC (getSignaturesForAddress + getTransaction) and its
 * WebSocket (logsSubscribe). It exists because GeckoTerminal / DEX Screener
 * need 40 s to minutes to index a new pool, and fresh tokens are exactly what
 * traders open from Pulse.
 *
 * - backfill(): the pool's newest 60 signatures; successful ones, newest
 *   first, up to 40 transactions (2 at a time) → trades, emitted as they
 *   arrive.
 * - live (while subscribed):
 *   · pump.fun curves: logsSubscribe(curve) and the TradeEvent decoded straight
 *     from the notification's `Program data:` lines — exact SOL / token
 *     amounts, trader, on-chain clock, post-trade reserves → price. No RPC.
 *     Logs without a usable event (truncated, a bundle, another quote asset,
 *     not a trade) fall back to getTransaction.
 *   · other pools: logsSubscribe(pool) as a hint → getTransaction → swap
 *     derivation (max 3 in flight, duplicates dropped, queue bounded).
 *   · reconciliation every 8 s: one listing of every signature newer than the
 *     last one listed (`until`; the newest 20 before anything was listed),
 *     unseen successful ones fetched 10 per round (the rest carried to the
 *     next round). publicnode's WS drops notifications (on 2026-09-29 it
 *     delivered nothing for minutes), so polling is the source of truth;
 *     everything is deduplicated by signature.
 *   · paused while the document is hidden (reconciliation stops, nothing is
 *     fetched); a catch-up round runs when it is shown again.
 * - loadHistory(): older pages (getSignaturesForAddress `before`, up to 1,000
 *   signatures per call) until ~300 successful transactions are in hand, so a
 *   young pool's chart can cover its whole life. Failed transactions cost
 *   nothing (never fetched) and dominate fresh tokens: a live 34 s old
 *   pump.fun curve had 734 signatures, 681 of them failed sniper attempts, so
 *   the walk is bounded by transactions to fetch, not by signatures listed.
 *
 * Budget: the browser transport allows 45 publicnode calls / 10 s for the
 * whole tab (bonding-curve reads, mint info and wallet reads share it). The
 * feed keeps itself to 28 calls / 10 s and leaves 6 of those to live work, so
 * a backfill or history walk never starves the live feed or the other panels.
 * A 429 pauses the feed (at least 5 s, or the error's retry hint).
 *
 * Nothing is invented: a trade exists only when a real transaction proved it,
 * USD figures need the live SOL price, or for a pool quoted in another
 * asset (e.g. GLDx) that asset's live USD price (they stay undefined until it
 * is known), market cap needs the on-chain supply. "Mentions the pool" proves
 * nothing (any transaction may list any account): a pump.fun curve trade needs
 * pump's own TradeEvent for the mint, and a balance-derived trade needs the
 * pool to have taken the other side (src/lib/onchain/tradeGuard.ts).
 *
 * Completeness is reported, never assumed: successful signatures the feed
 * listed but could not fetch within its budget (a busy pool while the
 * WebSocket is silent) are counted in `status.missed`, a listing that hit its
 * window marks `status.unlisted`, and either keeps `complete` false. While a
 * history walk was requested, reconciliation overflow is fetched later on the
 * history lane instead of being dropped.
 */

/** `getSignatureStatuses` entry (null: the node does not know the signature). */
export interface SignatureStatus {
  err: unknown;
  confirmationStatus?: string | null;
}

export interface FeedRpc {
  getSignaturesForAddress(address: string, query?: SignaturesQuery, signal?: AbortSignal): Promise<RpcSignatureInfo[]>;
  getTransaction(signature: string, signal?: AbortSignal): Promise<RpcParsedTransaction | null>;
  /** Up to 256 signatures, aligned with the input (confirms WS trades seen at 'processed'). */
  getSignatureStatuses?(signatures: string[], signal?: AbortSignal): Promise<Array<SignatureStatus | null>>;
}

/** FeedRpc over ORBYT's JSON-RPC client (adds getSignatureStatuses through its raw `call`). */
export function feedRpcFromClient(client: {
  getSignaturesForAddress: FeedRpc['getSignaturesForAddress'];
  getTransaction: FeedRpc['getTransaction'];
  call<T = unknown>(method: string, params: unknown[], signal?: AbortSignal): Promise<T>;
}): FeedRpc {
  return {
    getSignaturesForAddress: (address, query, signal) => client.getSignaturesForAddress(address, query, signal),
    getTransaction: (signature, signal) => client.getTransaction(signature, signal),
    getSignatureStatuses: async (signatures, signal) => {
      const result = await client.call<{ value?: unknown }>('getSignatureStatuses', [signatures, { searchTransactionHistory: false }], signal);
      const value: unknown[] = Array.isArray(result?.value) ? result.value : [];
      return signatures.map((_, i) => {
        const item = value[i];
        if (typeof item !== 'object' || item === null) return null;
        const record = item as { err?: unknown; confirmationStatus?: unknown };
        return { err: record.err ?? null, confirmationStatus: typeof record.confirmationStatus === 'string' ? record.confirmationStatus : null };
      });
    },
  };
}

export interface FeedWs {
  logsSubscribe(address: string, listener: (notification: LogsNotification) => void, options?: { commitment?: Commitment }): () => void;
  getStatus?(): { status: string };
  onStatus?(listener: (status: { status: string }) => void): () => void;
}

export interface FeedClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface FeedVisibility {
  hidden(): boolean;
  subscribe(listener: (hidden: boolean) => void): () => void;
}

export interface FeedConfig {
  backfillSignatures: number;
  backfillTransactions: number;
  /** In-flight transactions for backfill / history. */
  backfillConcurrency: number;
  /** In-flight transactions overall (live fetches may use all of them). */
  liveConcurrency: number;
  reconcileMs: number;
  /** First reconciliation listing (nothing listed yet). */
  reconcileSignatures: number;
  /** Later listings: every signature newer than the last one listed, up to this many. */
  reconcileWindow: number;
  /** Transactions fetched per reconciliation round (the rest wait for the next round). */
  reconcilePerRound: number;
  /** Unseen signatures carried between rounds (newest kept). */
  reconcileBacklog: number;
  /** Successful transactions the backfill + history walk fetch at most. */
  historyTransactions: number;
  /** Reconciliation overflow fetched later on the history lane (once a history walk was requested), at most. */
  gapTransactions: number;
  /** Signatures the history walk lists at most (failed ones included). */
  historySignatures: number;
  historyPageSize: number;
  /** The feed's own request budget (every RPC call it makes). */
  budgetLimit: number;
  budgetWindowMs: number;
  /** Budget slots backfill / history leave free for live fetches and reconciliation. */
  budgetReserve: number;
  maxTrades: number;
  /** Queued WS-triggered fetches kept (oldest dropped; reconciliation catches up). */
  liveQueueMax: number;
  /** Retries for a transaction the node does not return yet (null). */
  missingRetries: number;
  retryDelayMs: number;
  /** Retries after a network / HTTP error. */
  errorRetries: number;
  /** Pause after a 429 when the error carries no retry hint. */
  rateLimitPauseMs: number;
  /** Rows count as "new" (flash) for this long after they arrived live. */
  freshMs: number;
  /** Freshness stays 'stream' this long after the last WS-delivered trade. */
  streamFreshMs: number;
  /** Live work (WS + reconciliation) keeps running this long after the last listener left. */
  idleMs: number;
  /**
   * logsSubscribe commitments, one subscription each. publicnode's backends
   * flip: on 2026-09-29 one connection got 1,747 pump-program notifications
   * in 20 s at 'processed' and none at 'confirmed'; ten minutes later four
   * connections got 441 each at 'confirmed' and none at 'processed'. The feed
   * listens at both and deduplicates by signature. A trade decoded from a
   * 'processed' notification is provisional until its 'confirmed'
   * notification, a confirmed listing or getSignatureStatuses confirms it; one
   * that never confirms (a dropped fork) or failed is removed.
   */
  wsCommitments: readonly Commitment[];
  /** A WS hint at 'processed' is fetched (at 'confirmed') after this delay. */
  streamFetchDelayMs: number;
  /** WS-decoded trades older than this are checked with getSignatureStatuses when no listing confirmed them. */
  provisionalCheckMs: number;
  /** A WS-decoded trade the chain still does not know after this long was on a dropped fork: removed. */
  provisionalDropMs: number;
}

export const FEED_DEFAULTS: FeedConfig = {
  backfillSignatures: 60,
  backfillTransactions: 40,
  backfillConcurrency: 2,
  liveConcurrency: 3,
  reconcileMs: 8_000,
  reconcileSignatures: 20,
  reconcileWindow: 200,
  reconcilePerRound: 10,
  reconcileBacklog: 60,
  historyTransactions: 300,
  gapTransactions: 600,
  historySignatures: 5_000,
  historyPageSize: 1_000,
  budgetLimit: 28,
  budgetWindowMs: 10_000,
  budgetReserve: 6,
  maxTrades: 1_000,
  liveQueueMax: 40,
  missingRetries: 2,
  retryDelayMs: 1_500,
  errorRetries: 2,
  rateLimitPauseMs: 5_000,
  freshMs: 2_500,
  streamFreshMs: 30_000,
  idleMs: 3_000,
  wsCommitments: ['confirmed', 'processed'],
  streamFetchDelayMs: 800,
  provisionalCheckMs: 4_000,
  provisionalDropMs: 45_000,
};

export interface OnchainTradeFeedOptions {
  mint: string;
  /** Pool account: the pump.fun bonding-curve PDA, or an AMM pool address. */
  pool: string;
  /** `pool` is a pump.fun bonding curve (trades decode from logs). */
  isPumpCurve: boolean;
  rpc: FeedRpc;
  /** Solana PubSub client; without it the feed polls only. */
  ws?: FeedWs;
  /** SOL/USD at creation; update with `setSolPriceUsd`. */
  solPriceUsd?: number;
  /** USD price of the pool's quote asset when it is neither SOL nor a stablecoin; update with `setQuotePriceUsd`. */
  quoteUsd?: QuoteUsd;
  /** On-chain supply (UI units) for market cap at trade; update with `setSupply`. */
  supply?: number;
  tokenDecimals?: number;
  config?: Partial<FeedConfig>;
  clock?: FeedClock;
  /** Defaults to `document` visibility in browsers; null disables pausing. */
  visibility?: FeedVisibility | null;
  /** Called once the feed has had no listener for `idleMs` (the shared registry tears it down). */
  onIdle?: () => void;
}

export type FeedVia = 'backfill' | 'history' | 'stream' | 'poll' | 'reprice' | 'status';

export interface FeedBatch {
  via: FeedVia;
  /** Signatures added or re-priced by this batch. */
  signatures: readonly string[];
}

export type FeedListener = (batch: FeedBatch) => void;

export type FeedPhase = 'idle' | 'loading' | 'done' | 'error';

export interface OnchainFeedStatus {
  backfill: FeedPhase;
  history: FeedPhase;
  /** Signatures listed so far (backfill + older pages). */
  listed: number;
  /** The listing reached the pool's first transaction. */
  exhausted: boolean;
  /** Every successful transaction since the pool's first one was processed: the whole pool history is in hand. */
  complete: boolean;
  /** Transactions waiting or in flight. */
  queued: number;
  ws: 'off' | 'connecting' | 'open';
  /** Last trade pushed by the WebSocket (local ms). */
  lastStreamAt?: number;
  /** Last successful reconciliation (local ms). */
  lastPollAt?: number;
  polls: number;
  /** Latest RPC failure (user-safe), cleared by the next successful call. */
  error?: string;
  errorCode?: string;
  /** Nothing was ever read from the chain and the last attempt failed. */
  failed: boolean;
  /** Paused while the document is hidden. */
  paused: boolean;
  /** Transactions that could not be fetched or parsed (skipped). */
  skipped: number;
  /**
   * Successful signatures listed from the chain whose transactions the feed
   * gave up on (reconciliation backlog overflow, or skipped after errors): the
   * trades held are a subset of the pool's.
   */
  missed: number;
  /** Of `missed`: listed successful signatures left unloaded for lack of RPC budget (reconciliation overflow). */
  dropped: number;
  /** A reconciliation listing hit its window: signatures between two listings may never have been listed. */
  unlisted: boolean;
}

export interface OnchainFeedSnapshot {
  /** Newest first, deduplicated by signature, capped at `maxTrades`. */
  trades: readonly Trade[];
  /** Signatures that arrived live in the last few seconds (row flash). */
  fresh: ReadonlySet<string>;
  /**
   * Exact price per token in SOL for each held trade that has one (signature → SOL), on the same basis as its
   * `priceUsd` (pump.fun: post-trade curve reserves; pools: the swap's own quote). SOL charts use it so USD and
   * SOL bars share one basis (a trade's own SOL / token ratio differs from the reserve price by the trade's impact).
   */
  solPrices: ReadonlyMap<string, number>;
  status: OnchainFeedStatus;
  /** 'stream' while WS-delivered trades keep arriving, else 'realtime' (polled chain reads). */
  freshness: Extract<Freshness, 'stream' | 'realtime'>;
  /** Last time the feed confirmed data from the chain (a trade, a listing, a reconciliation). */
  updatedAt?: number;
  /** The most recent failure as an error object (for error panels). */
  lastError?: ProviderError | Error;
  version: number;
}

export interface OnchainTradeFeed {
  readonly mint: string;
  readonly pool: string;
  readonly isPumpCurve: boolean;
  /** Newest 60 signatures → up to 40 transactions (idempotent; resolves when they are processed). */
  backfill(): Promise<void>;
  /** Older pages until ~300 successful transactions are in hand (idempotent while running; paced by the budget). */
  loadHistory(): Promise<void>;
  /** Trade batches and status changes. The first listener starts the live feed (and the backfill). */
  subscribe(listener: FeedListener): () => void;
  getSnapshot(): OnchainFeedSnapshot;
  setSolPriceUsd(price: number | undefined): void;
  /** USD price of the pool's quote asset (non-SOL, non-stable quotes, e.g. GLDx): prices the trades held in it. */
  setQuotePriceUsd(quote: QuoteUsd | undefined): void;
  setSupply(supply: number | undefined): void;
  teardown(): void;
  readonly tornDown: boolean;
}

type Lane = 'stream' | 'poll' | 'backfill' | 'history';
const LANE_PRIORITY: Record<Lane, number> = { stream: 0, poll: 1, backfill: 2, history: 3 };
const isLow = (lane: Lane) => lane === 'backfill' || lane === 'history';

interface Task {
  signature: string;
  lane: Lane;
  seq: number;
  notBefore: number;
  missing: number;
  errors: number;
}

const EMPTY_FRESH: ReadonlySet<string> = new Set();
const SEEN_CAP = 20_000;

const systemClock: FeedClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function documentVisibility(): FeedVisibility | null {
  if (typeof document === 'undefined') return null;
  return {
    hidden: () => document.hidden,
    subscribe: (listener) => {
      const handler = () => listener(document.hidden);
      document.addEventListener('visibilitychange', handler);
      return () => document.removeEventListener('visibilitychange', handler);
    },
  };
}

const positive = (n: number | undefined): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);

function validQuoteUsd(quote: QuoteUsd | undefined): QuoteUsd | undefined {
  const priceUsd = positive(quote?.priceUsd);
  return quote && quote.mint && priceUsd !== undefined ? { mint: quote.mint, priceUsd } : undefined;
}

export function createOnchainTradeFeed(options: OnchainTradeFeedOptions): OnchainTradeFeed {
  const { mint, pool, isPumpCurve, rpc, ws } = options;
  const cfg: FeedConfig = { ...FEED_DEFAULTS, ...options.config };
  const clock = options.clock ?? systemClock;
  const visibility = options.visibility === undefined ? documentVisibility() : options.visibility;
  const tokenDecimals = options.tokenDecimals ?? PUMP_DECIMALS;

  let solUsd = positive(options.solPriceUsd);
  let quoteUsd = validQuoteUsd(options.quoteUsd);
  let supply = positive(options.supply);

  // Trades: native (SOL terms) and priced (USD fields added).
  const natives = new Map<string, NativeTrade>();
  const priced = new Map<string, Trade>();
  /** Processed signatures (trade or not): never fetched twice. */
  const seen = new Set<string>();
  /** Queued or in-flight signatures. */
  const pending = new Set<string>();
  const freshAt = new Map<string, number>();
  /** WS-decoded trades seen at 'processed', not yet confirmed (signature → arrival). */
  const provisional = new Map<string, number>();
  const queue: Task[] = [];
  const listeners = new Set<FeedListener>();
  const stamps: number[] = [];
  const laneOutstanding: Record<Lane, number> = { stream: 0, poll: 0, backfill: 0, history: 0 };
  const laneWaiters: Array<{ lanes: Lane[]; resolve: () => void }> = [];
  const sleepers = new Set<() => void>();
  const resumeWaiters = new Set<() => void>();

  let seq = 0;
  let active = 0;
  let activeLow = 0;
  let pausedUntil = 0;
  let torn = false;
  let live = false;
  let paused = false;
  let everOk = false;
  let lowFailures = 0;
  let deferred: string[] = [];
  let oldestListed: string | undefined;
  /** Newest signature any listing returned (reconciliation cursor). */
  let newestListed: string | undefined;
  /** Unseen successful signatures listed by reconciliation, waiting for a round (newest first). */
  let backlog: string[] = [];
  /** Successful signatures handed to the backfill / history lanes. */
  let historyQueued = 0;
  /** The history walk left listed successful transactions out (transaction cap). */
  let historyCapped = false;
  /** loadHistory() was called: the chart wants the pool's whole life, so reconciliation overflow is fetched later. */
  let historyRequested = false;
  /** Reconciliation overflow handed to the history lane. */
  let gapQueued = 0;

  let pumpTimer: unknown;
  let pumpAt = Infinity;
  let reconcileTimer: unknown;
  let idleTimer: unknown;
  let unsubWs: Array<() => void> = [];
  let unsubWsStatus: (() => void) | undefined;
  let unsubVisibility: (() => void) | undefined;
  let backfillPromise: Promise<void> | undefined;
  let historyPromise: Promise<void> | undefined;
  let reconciling = false;

  const status: OnchainFeedStatus = {
    backfill: 'idle',
    history: 'idle',
    listed: 0,
    exhausted: false,
    complete: false,
    queued: 0,
    ws: 'off',
    polls: 0,
    failed: false,
    paused: false,
    skipped: 0,
    missed: 0,
    dropped: 0,
    unlisted: false,
  };
  let updatedAt: number | undefined;
  let lastError: ProviderError | Error | undefined;
  let version = 0;
  let sorted: Trade[] = [];
  let solPrices: ReadonlyMap<string, number> = new Map();
  let sortedDirty = false;
  let snapshot: OnchainFeedSnapshot | undefined;

  // -------------------------------------------------------------------------
  // Snapshot / emission
  // -------------------------------------------------------------------------

  function commit(via: FeedVia, signatures: readonly string[] = []): void {
    if (torn) return;
    version++;
    snapshot = undefined;
    const batch: FeedBatch = { via, signatures };
    for (const listener of [...listeners]) {
      try {
        listener(batch);
      } catch (error) {
        console.error('[orbyt:onchain] listener failed', error);
      }
    }
  }

  function buildSnapshot(): OnchainFeedSnapshot {
    const now = clock.now();
    if (sortedDirty) {
      sorted = [...priced.values()].sort(compareTradesNewestFirst);
      const bySignature = new Map<string, number>();
      for (const [signature, native] of natives) if (native.priceSol !== undefined) bySignature.set(signature, native.priceSol);
      solPrices = bySignature;
      sortedDirty = false;
    }
    let fresh: Set<string> | undefined;
    for (const [signature, at] of freshAt) {
      if (now - at >= cfg.freshMs) freshAt.delete(signature);
      else (fresh ??= new Set()).add(signature);
    }
    status.queued = pending.size;
    status.paused = paused;
    status.failed = !everOk && lastError !== undefined;
    // Live lag (the newest few signatures still in flight) is steady state, not a gap; a signature the feed gave up
    // on, or a listing window that overflowed, is a gap for good.
    status.complete =
      status.exhausted &&
      !historyCapped &&
      deferred.length === 0 &&
      laneOutstanding.backfill === 0 &&
      laneOutstanding.history === 0 &&
      lowFailures === 0 &&
      status.missed === 0 &&
      !status.unlisted;
    const streaming = status.lastStreamAt !== undefined && now - status.lastStreamAt < cfg.streamFreshMs;
    return {
      trades: sorted,
      fresh: fresh ?? EMPTY_FRESH,
      solPrices,
      status: { ...status },
      freshness: streaming ? 'stream' : 'realtime',
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(lastError ? { lastError } : {}),
      version,
    };
  }

  function markOk(): void {
    everOk = true;
    updatedAt = clock.now();
    if (status.error !== undefined) {
      status.error = undefined;
      status.errorCode = undefined;
      lastError = undefined;
    }
  }

  function recordError(error: unknown): void {
    lastError = error instanceof Error ? error : new Error(describeError(error));
    status.error = describeError(error);
    status.errorCode = isProviderError(error) ? error.code : undefined;
    if (isProviderError(error) && error.code === 'rate_limited') {
      pausedUntil = Math.max(pausedUntil, clock.now() + Math.max(error.retryAfterMs ?? 0, cfg.rateLimitPauseMs));
    }
  }

  function markSeen(signature: string): void {
    seen.add(signature);
    if (seen.size > SEEN_CAP) {
      // Oldest insertions first; anything that old is far outside every listing we still make.
      const drop = seen.size - SEEN_CAP;
      let i = 0;
      for (const s of seen) {
        if (i++ >= drop) break;
        seen.delete(s);
      }
    }
  }

  const known = (signature: string) => seen.has(signature) || pending.has(signature);

  function addTrades(list: NativeTrade[], via: FeedVia): void {
    if (!list.length) return;
    const now = clock.now();
    const arrivedLive = via === 'stream' || via === 'poll';
    const signatures: string[] = [];
    for (const native of list) {
      const signature = native.trade.signature;
      natives.set(signature, native);
      priced.set(signature, priceWithSol(native, solUsd, supply, quoteUsd));
      if (arrivedLive) freshAt.set(signature, now);
      signatures.push(signature);
    }
    if (priced.size > cfg.maxTrades) {
      const oldest = [...priced.values()].sort(compareTradesNewestFirst).slice(cfg.maxTrades);
      for (const t of oldest) {
        priced.delete(t.signature);
        natives.delete(t.signature);
      }
    }
    sortedDirty = true;
    markOk();
    commit(via, signatures);
  }

  function reprice(): void {
    const changed: string[] = [];
    for (const [signature, native] of natives) {
      const current = priced.get(signature);
      if (!current) continue;
      if (current.priceUsd !== undefined && current.usdValue !== undefined && (current.marketCapUsd !== undefined || supply === undefined)) continue;
      const next = priceWithSol(native, solUsd, supply, quoteUsd);
      if (next.priceUsd !== current.priceUsd || next.usdValue !== current.usdValue || next.marketCapUsd !== current.marketCapUsd) {
        priced.set(signature, next);
        changed.push(signature);
      }
    }
    if (changed.length) {
      sortedDirty = true;
      commit('reprice', changed);
    }
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        sleepers.delete(done);
        resolve();
      };
      sleepers.add(done);
      clock.setTimeout(done, Math.max(0, ms));
    });
  }

  function waitForResume(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        resumeWaiters.delete(done);
        resolve();
      };
      resumeWaiters.add(done);
    });
  }

  /** Delay until a call of `lane` fits the budget (0 = now). */
  function budgetWait(lane: Lane, now: number): number {
    while (stamps.length && now - (stamps[0] as number) >= cfg.budgetWindowMs) stamps.shift();
    if (now < pausedUntil) return pausedUntil - now;
    const cap = isLow(lane) ? Math.max(1, cfg.budgetLimit - cfg.budgetReserve) : cfg.budgetLimit;
    if (stamps.length < cap) return 0;
    const pivot = stamps[stamps.length - cap] as number;
    return Math.max(1, cfg.budgetWindowMs - (now - pivot) + 1);
  }

  /** Wait for a budget slot (and for the document to be visible); false once torn down. */
  async function acquireBudget(lane: Lane): Promise<boolean> {
    for (;;) {
      if (torn) return false;
      if (paused) {
        await waitForResume();
        continue;
      }
      const now = clock.now();
      const wait = budgetWait(lane, now);
      if (wait === 0) {
        stamps.push(now);
        return true;
      }
      await sleep(wait);
    }
  }

  function schedulePump(delay: number): void {
    const at = clock.now() + delay;
    if (pumpTimer !== undefined && pumpAt <= at) return;
    if (pumpTimer !== undefined) clock.clearTimeout(pumpTimer);
    pumpAt = at;
    pumpTimer = clock.setTimeout(() => {
      pumpTimer = undefined;
      pumpAt = Infinity;
      pump();
    }, Math.max(0, delay));
  }

  // -------------------------------------------------------------------------
  // Transaction queue
  // -------------------------------------------------------------------------

  function enqueue(signatures: readonly string[], lane: Lane, delay = 0): number {
    let added = 0;
    const notBefore = delay > 0 ? clock.now() + delay : 0;
    for (const signature of signatures) {
      if (known(signature)) continue;
      pending.add(signature);
      laneOutstanding[lane]++;
      queue.push({ signature, lane, seq: seq++, notBefore, missing: 0, errors: 0 });
      added++;
    }
    if (lane === 'stream') {
      // Bounded: drop the oldest queued live fetches; the next reconciliation lists them again.
      let streamQueued = queue.filter((t) => t.lane === 'stream').length;
      for (let i = 0; streamQueued > cfg.liveQueueMax && i < queue.length; ) {
        const task = queue[i] as Task;
        if (task.lane === 'stream') {
          queue.splice(i, 1);
          pending.delete(task.signature);
          settle(task);
          streamQueued--;
        } else i++;
      }
    }
    if (added) pump();
    return added;
  }

  function settle(task: Task): void {
    laneOutstanding[task.lane] = Math.max(0, laneOutstanding[task.lane] - 1);
    for (let i = laneWaiters.length - 1; i >= 0; i--) {
      const waiter = laneWaiters[i] as (typeof laneWaiters)[number];
      if (waiter.lanes.every((lane) => laneOutstanding[lane] === 0)) {
        laneWaiters.splice(i, 1);
        waiter.resolve();
      }
    }
  }

  function waitForLanes(lanes: Lane[]): Promise<void> {
    if (torn || lanes.every((lane) => laneOutstanding[lane] === 0)) return Promise.resolve();
    return new Promise((resolve) => laneWaiters.push({ lanes, resolve }));
  }

  function pump(): void {
    if (torn || paused) return;
    const now = clock.now();
    let wakeAt = Infinity;
    while (active < cfg.liveConcurrency) {
      let best: Task | undefined;
      let bestIndex = -1;
      for (let i = 0; i < queue.length; i++) {
        const task = queue[i] as Task;
        if (task.notBefore > now) {
          wakeAt = Math.min(wakeAt, task.notBefore);
          continue;
        }
        if (isLow(task.lane) && activeLow >= cfg.backfillConcurrency) continue;
        if (!best || LANE_PRIORITY[task.lane] < LANE_PRIORITY[best.lane] || (LANE_PRIORITY[task.lane] === LANE_PRIORITY[best.lane] && task.seq < best.seq)) {
          best = task;
          bestIndex = i;
        }
      }
      if (!best) break;
      const wait = budgetWait(best.lane, now);
      if (wait > 0) {
        wakeAt = Math.min(wakeAt, now + wait);
        break;
      }
      queue.splice(bestIndex, 1);
      stamps.push(now);
      void run(best);
    }
    if (wakeAt < Infinity) schedulePump(wakeAt - now);
  }

  function requeue(task: Task, delay: number): void {
    task.notBefore = clock.now() + delay;
    queue.push(task);
  }

  async function run(task: Task): Promise<void> {
    active++;
    const low = isLow(task.lane);
    if (low) activeLow++;
    let tx: RpcParsedTransaction | null = null;
    let failure: unknown;
    try {
      tx = await rpc.getTransaction(task.signature);
    } catch (error) {
      failure = error;
    }
    active--;
    if (low) activeLow--;
    if (torn) return;

    if (failure !== undefined) {
      if (isAbortError(failure)) {
        finish(task, false);
      } else if (isProviderError(failure) && failure.code === 'rate_limited') {
        recordError(failure);
        requeue(task, 0);
        commit('status');
      } else {
        task.errors++;
        recordError(failure);
        if (task.errors <= cfg.errorRetries) requeue(task, 2_000 * task.errors);
        else if (task.lane === 'stream') {
          // A WS hint that kept failing: hand it to reconciliation (its listing may already have passed it as "known").
          finish(task, false);
          if (!backlog.includes(task.signature)) backlog.unshift(task.signature);
        } else {
          status.skipped++;
          noteGap(task.lane);
          finish(task, true);
        }
        commit('status');
      }
    } else if (tx === null) {
      // Not visible at 'confirmed' on this node yet (a notification can outrun the node that answers).
      task.missing++;
      if (task.missing <= cfg.missingRetries) requeue(task, cfg.retryDelayMs);
      else if (task.lane === 'stream') {
        // A hint seen at 'processed' that never reached 'confirmed' (a dropped fork): nothing happened, nothing
        // is skipped. Not marked seen, so a re-landed transaction with the same signature is still listed.
        finish(task, false);
      } else {
        // Listed as successful at 'confirmed', yet never returned: a real transaction the feed does not hold.
        status.skipped++;
        noteGap(task.lane);
        finish(task, true);
        commit('status');
      }
    } else {
      let native: NativeTrade | null = null;
      let parsed = true;
      try {
        native = tradeFromTransaction(tx, task.signature);
      } catch {
        parsed = false;
      }
      finish(task, true);
      if (!parsed) {
        status.skipped++;
        noteGap(task.lane);
      }
      // The stream is credited (freshness 'stream', LIVE) only for trades it delivered, not for any hint it sent.
      if (task.lane === 'stream' && native) status.lastStreamAt = clock.now();
      if (native) addTrades([native], viaFor(task.lane));
      else {
        markOk();
        commit('status');
      }
    }
    pump();
  }

  function finish(task: Task, processed: boolean): void {
    pending.delete(task.signature);
    if (processed) markSeen(task.signature);
    settle(task);
  }

  /** A listed successful transaction the feed gave up on: the history walk's own failures, or a live gap. */
  function noteGap(lane: Lane): void {
    if (isLow(lane)) lowFailures++;
    else status.missed++;
  }

  const viaFor = (lane: Lane): FeedVia => (lane === 'stream' ? 'stream' : lane === 'poll' ? 'poll' : lane);

  /**
   * One transaction → the trade of `mint` on this pool (null when there is none). Throws on malformed data.
   *
   * A transaction may list the pool without trading on it, so:
   * - pump.fun curve: only pump's own TradeEvent of the mint (unforgeable: emitted by the program, the self-CPI
   *   signed by its event authority) proves a trade; a curve quoted in another asset is derived from balances,
   *   and only when such an event exists.
   * - other pools: the balance-derived trade must be corroborated by the pool's own balances (tradeGuard).
   */
  function tradeFromTransaction(tx: RpcParsedTransaction, signature: string): NativeTrade | null {
    if (tx.meta && tx.meta.err !== null && tx.meta.err !== undefined) return null;
    const blockMs = typeof tx.blockTime === 'number' && Number.isFinite(tx.blockTime) && tx.blockTime > 0 ? tx.blockTime * 1000 : undefined;
    if (isPumpCurve) {
      const events = decodePumpTradeEvents(tx).filter((e) => e.mint === mint);
      if (events.length === 0) return null;
      // Same basis as the WS path: the curve's own event (exact amounts, post-trade reserves).
      const fromEvent = pumpTradeFromEvents(events, { signature, mint, pool, source: 'solana-rpc', timestampMs: blockMs, tokenDecimals });
      if (fromEvent) return fromEvent;
    }
    const derived = deriveTradeForMint(tx, mint, { pool });
    if (!derived) return null;
    const check = corroborateWithPool(tx, derived, mint, pool);
    if (!check.ok) return null;
    const trade = toTrade(derived, pool, 'solana-rpc');
    if (!trade) return null;
    if (check.poolPrice) {
      // The trader paid another asset than the pool took (a routed trade): the venue price is the pool's.
      delete trade.priceUsd;
      const { quoteMint, price } = check.poolPrice;
      if (quoteMint === MINTS.SOL) return { trade, priceSol: price };
      if (STABLE_MINTS.has(quoteMint)) {
        trade.priceUsd = price;
        return { trade };
      }
      // A pool quoted in another asset (e.g. GLDx): priced in it, in USD once that asset's price is known.
      return { trade, quote: { mint: quoteMint, price } };
    }
    const priceSol = trade.solAmount !== undefined ? positive(derived.priceQuote) : undefined;
    if (priceSol !== undefined) return { trade, priceSol };
    const quotePrice = trade.solAmount === undefined && trade.priceUsd === undefined && derived.quoteMint ? positive(derived.priceQuote) : undefined;
    if (derived.quoteMint && quotePrice !== undefined) {
      const amount = positive(derived.quoteAmount);
      return { trade, quote: { mint: derived.quoteMint, price: quotePrice, ...(amount !== undefined ? { amount } : {}) } };
    }
    return { trade };
  }

  // -------------------------------------------------------------------------
  // Backfill and history
  // -------------------------------------------------------------------------

  async function listSignatures(lane: Lane, query: SignaturesQuery): Promise<RpcSignatureInfo[] | undefined> {
    if (!(await acquireBudget(lane))) return undefined;
    try {
      const signatures = await rpc.getSignaturesForAddress(pool, query);
      if (torn) return undefined;
      markOk();
      return signatures;
    } catch (error) {
      if (torn || isAbortError(error)) return undefined;
      recordError(error);
      throw error;
    }
  }

  const succeeded = (list: readonly RpcSignatureInfo[]) => list.filter((s) => s.err === null || s.err === undefined).map((s) => s.signature);

  async function runBackfill(): Promise<void> {
    status.backfill = 'loading';
    commit('status');
    let signatures: RpcSignatureInfo[] | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        signatures = await listSignatures('backfill', { limit: cfg.backfillSignatures });
        break;
      } catch {
        if (attempt >= 2) {
          status.backfill = 'error';
          backfillPromise = undefined;
          commit('status');
          return;
        }
        commit('status');
        await sleep(3_000 * 2 ** attempt);
      }
    }
    if (!signatures || torn) return;
    status.listed = signatures.length;
    status.exhausted = signatures.length < cfg.backfillSignatures;
    oldestListed = signatures.at(-1)?.signature;
    newestListed ??= signatures[0]?.signature;
    const ok = succeeded(signatures).filter((s) => !known(s));
    deferred = ok.slice(cfg.backfillTransactions);
    const first = ok.slice(0, cfg.backfillTransactions);
    historyQueued += first.length;
    enqueue(first, 'backfill');
    commit('status');
    await waitForLanes(['backfill']);
    if (torn) return;
    status.backfill = 'done';
    commit('status');
  }

  async function runHistory(): Promise<void> {
    await backfill();
    if (torn) return;
    if (status.backfill !== 'done') {
      // The newest page could not be listed: nothing to page from yet (a later call retries).
      historyPromise = undefined;
      return;
    }
    status.history = 'loading';
    commit('status');
    if (deferred.length) {
      const next = deferred;
      deferred = [];
      historyQueued += next.length;
      enqueue(next, 'history');
    }
    let failures = 0;
    while (!status.exhausted && !historyCapped && historyQueued < cfg.historyTransactions && status.listed < cfg.historySignatures && oldestListed && !torn) {
      const limit = Math.min(cfg.historyPageSize, cfg.historySignatures - status.listed);
      let page: RpcSignatureInfo[] | undefined;
      try {
        page = await listSignatures('history', { before: oldestListed, limit });
      } catch {
        if (++failures > 2) {
          // Stop here (what was loaded stays); the chart keeps the trades in hand.
          status.history = 'error';
          commit('status');
          return;
        }
        commit('status');
        await sleep(5_000 * 2 ** (failures - 1));
        continue;
      }
      if (!page || torn) return;
      status.listed += page.length;
      if (page.length < limit) status.exhausted = true;
      oldestListed = page.at(-1)?.signature ?? oldestListed;
      const ok = succeeded(page).filter((signature) => !known(signature));
      const room = Math.max(0, cfg.historyTransactions - historyQueued);
      if (ok.length > room) historyCapped = true;
      const take = ok.slice(0, room);
      historyQueued += take.length;
      enqueue(take, 'history');
      commit('status');
    }
    await waitForLanes(['backfill', 'history']);
    if (torn) return;
    status.history = 'done';
    commit('status');
  }

  function backfill(): Promise<void> {
    if (torn) return Promise.resolve();
    return (backfillPromise ??= runBackfill());
  }

  function loadHistory(): Promise<void> {
    if (torn) return Promise.resolve();
    historyRequested = true;
    return (historyPromise ??= runHistory());
  }

  // -------------------------------------------------------------------------
  // Live: WebSocket + reconciliation
  // -------------------------------------------------------------------------

  function onLogs(notification: LogsNotification, commitment: Commitment): void {
    if (torn || !live) return;
    const signature = notification.signature;
    const confirmed = commitment !== 'processed';
    if (notification.err !== null && notification.err !== undefined) {
      // Failed at 'confirmed': a provisional success seen on another fork is not a trade.
      if (confirmed && provisional.has(signature)) {
        dropTrade(signature);
        commit('status');
      }
      return;
    }
    if (confirmed) provisional.delete(signature);
    if (known(signature)) {
      // A 'confirmed' hint for a fetch still waiting out its 'processed' delay can go now.
      if (confirmed) {
        const task = queue.find((t) => t.signature === signature && t.lane === 'stream');
        if (task && task.notBefore > clock.now()) {
          task.notBefore = 0;
          pump();
        }
      }
      return;
    }
    // Truncated logs may hold only part of the transaction's events (one leg of a split buy, one user of a bundle):
    // the full transaction decides (its event self-CPIs are never truncated).
    if (isPumpCurve && Array.isArray(notification.logs) && !logsTruncated(notification.logs)) {
      const built = pumpTradeFromEvents(decodePumpTradeEventsFromLogs(notification.logs), {
        signature,
        mint,
        pool,
        source: 'solana-ws',
        tokenDecimals,
      });
      if (built) {
        markSeen(signature);
        status.lastStreamAt = clock.now();
        if (!confirmed) provisional.set(signature, clock.now());
        addTrades([built], 'stream');
        return;
      }
      // Another quote asset or not a trade at all: the transaction decides.
    }
    if (paused) return;
    // getTransaction reads at 'confirmed': give a 'processed' hint a moment to get there.
    enqueue([signature], 'stream', confirmed ? 0 : cfg.streamFetchDelayMs);
  }

  function dropTrade(signature: string): void {
    provisional.delete(signature);
    freshAt.delete(signature);
    // Not seen any more: a transaction dropped with its fork can land again under the same signature, and a
    // failed one is never listed as successful (listings filter on `err`), so a later listing decides.
    seen.delete(signature);
    if (priced.delete(signature)) {
      natives.delete(signature);
      sortedDirty = true;
    }
  }

  /**
   * Settle WS-decoded trades seen at 'processed': a confirmed listing or
   * status promotes them; a failed status, or no status at all after
   * `provisionalDropMs` (a dropped fork), removes them.
   */
  async function confirmProvisional(listed: readonly RpcSignatureInfo[]): Promise<void> {
    for (const s of listed) {
      if (!provisional.has(s.signature)) continue;
      if (s.err === null || s.err === undefined) provisional.delete(s.signature);
      else dropTrade(s.signature);
    }
    const now = clock.now();
    const due = [...provisional].filter(([, at]) => now - at >= cfg.provisionalCheckMs).map(([signature]) => signature).slice(0, 256);
    if (!due.length || !rpc.getSignatureStatuses) return;
    if (!(await acquireBudget('poll'))) return;
    let statuses: Array<SignatureStatus | null>;
    try {
      statuses = await rpc.getSignatureStatuses(due);
    } catch (error) {
      if (!torn && !isAbortError(error)) recordError(error);
      return;
    }
    if (torn) return;
    const at = clock.now();
    due.forEach((signature, i) => {
      const entry = statuses[i];
      const since = provisional.get(signature);
      if (since === undefined) return;
      if (entry && entry.err !== null && entry.err !== undefined) dropTrade(signature);
      else if (entry && (entry.confirmationStatus === 'confirmed' || entry.confirmationStatus === 'finalized')) provisional.delete(signature);
      else if (!entry && at - since >= cfg.provisionalDropMs) dropTrade(signature);
    });
  }

  /**
   * Successful signatures the reconciliation backlog cannot hold (a busy pool while the WebSocket is silent).
   * When the chart wants every trade of a young pool (a history walk was requested and the listing reached the
   * pool's first transaction), they wait on the history lane, paced by the budget behind live work; otherwise
   * (an old, busy pool: no whole history to complete), or past `gapTransactions`, they are counted as missed.
   */
  function overflow(signatures: readonly string[]): void {
    if (!signatures.length) return;
    const room = historyRequested && status.exhausted ? Math.max(0, cfg.gapTransactions - gapQueued) : 0;
    const take = signatures.slice(0, room);
    gapQueued += enqueue(take, 'history');
    status.dropped += signatures.length - take.length;
    status.missed += signatures.length - take.length;
  }

  function scheduleReconcile(delay = cfg.reconcileMs): void {
    if (reconcileTimer !== undefined) clock.clearTimeout(reconcileTimer);
    reconcileTimer = clock.setTimeout(() => {
      reconcileTimer = undefined;
      void reconcile();
    }, delay);
  }

  async function reconcile(): Promise<void> {
    if (torn || !live || paused || reconciling) return;
    if (status.backfill === 'error') {
      // The first listing failed three times: start over instead of a 20-signature round.
      void backfill();
      scheduleReconcile();
      return;
    }
    reconciling = true;
    try {
      const query: SignaturesQuery = newestListed ? { until: newestListed, limit: cfg.reconcileWindow } : { limit: cfg.reconcileSignatures };
      const signatures = await listSignatures('poll', query);
      if (!signatures) return;
      // A full window after a cursor: older signatures between it and the cursor were never listed.
      if (query.until !== undefined && signatures.length >= cfg.reconcileWindow) status.unlisted = true;
      if (signatures[0]) newestListed = signatures[0].signature;
      status.polls++;
      status.lastPollAt = clock.now();
      // New signatures first (newest first), then what earlier rounds could not fetch yet.
      const next = new Set<string>();
      for (const signature of [...succeeded(signatures), ...backlog]) if (!known(signature)) next.add(signature);
      const ordered = [...next];
      backlog = ordered.slice(0, cfg.reconcileBacklog);
      overflow(ordered.slice(cfg.reconcileBacklog));
      enqueue(backlog.splice(0, cfg.reconcilePerRound), 'poll');
      await confirmProvisional(signatures);
      if (torn) return;
      commit('poll');
    } catch {
      commit('status');
    } finally {
      reconciling = false;
      if (live && !torn && !paused) scheduleReconcile();
    }
  }

  function setPaused(hidden: boolean): void {
    if (hidden === paused) return;
    paused = hidden;
    if (hidden) {
      if (reconcileTimer !== undefined) clock.clearTimeout(reconcileTimer);
      reconcileTimer = undefined;
      // Live fetches would be stale by the time the tab is shown; the catch-up round lists them again.
      for (let i = queue.length - 1; i >= 0; i--) {
        const task = queue[i] as Task;
        if (task.lane === 'stream') {
          queue.splice(i, 1);
          pending.delete(task.signature);
          settle(task);
        }
      }
    } else {
      for (const resume of [...resumeWaiters]) resume();
      pump();
      if (live) void reconcile();
    }
    commit('status');
  }

  function wsStatusOf(value: { status: string } | undefined): OnchainFeedStatus['ws'] {
    return value?.status === 'open' ? 'open' : 'connecting';
  }

  function startLive(): void {
    if (live || torn) return;
    live = true;
    if (visibility) {
      paused = visibility.hidden();
      unsubVisibility = visibility.subscribe(setPaused);
    }
    if (ws) {
      unsubWs = cfg.wsCommitments.map((commitment) => ws.logsSubscribe(pool, (n) => onLogs(n, commitment), { commitment }));
      status.ws = wsStatusOf(ws.getStatus?.());
      unsubWsStatus = ws.onStatus?.((s) => {
        const next = wsStatusOf(s);
        if (next !== status.ws) {
          status.ws = next;
          commit('status');
        }
      });
    }
    if (!paused) scheduleReconcile();
  }

  function stopLive(): void {
    if (!live) return;
    live = false;
    for (const unsubscribe of unsubWs) unsubscribe();
    unsubWsStatus?.();
    unsubVisibility?.();
    unsubWs = [];
    unsubWsStatus = unsubVisibility = undefined;
    if (reconcileTimer !== undefined) clock.clearTimeout(reconcileTimer);
    reconcileTimer = undefined;
    status.ws = 'off';
    if (paused) {
      paused = false;
      for (const resume of [...resumeWaiters]) resume();
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  const feed: OnchainTradeFeed = {
    mint,
    pool,
    isPumpCurve,
    backfill,
    loadHistory,
    subscribe(listener) {
      if (torn) return () => {};
      listeners.add(listener);
      if (idleTimer !== undefined) {
        clock.clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      startLive();
      void backfill();
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
        if (listeners.size === 0 && !torn && idleTimer === undefined) {
          idleTimer = clock.setTimeout(() => {
            idleTimer = undefined;
            if (listeners.size > 0 || torn) return;
            stopLive();
            options.onIdle?.();
          }, cfg.idleMs);
        }
      };
    },
    getSnapshot() {
      return (snapshot ??= buildSnapshot());
    },
    setSolPriceUsd(price) {
      const next = positive(price);
      if (next === solUsd) return;
      solUsd = next;
      if (next !== undefined) reprice();
    },
    setQuotePriceUsd(quote) {
      const next = validQuoteUsd(quote);
      if (next?.mint === quoteUsd?.mint && next?.priceUsd === quoteUsd?.priceUsd) return;
      quoteUsd = next;
      if (next !== undefined) reprice();
    },
    setSupply(value) {
      const next = positive(value);
      if (next === supply) return;
      supply = next;
      if (next !== undefined) reprice();
    },
    teardown() {
      if (torn) return;
      stopLive();
      torn = true;
      if (pumpTimer !== undefined) clock.clearTimeout(pumpTimer);
      if (idleTimer !== undefined) clock.clearTimeout(idleTimer);
      pumpTimer = idleTimer = undefined;
      queue.length = 0;
      pending.clear();
      listeners.clear();
      for (const wake of [...sleepers]) wake();
      for (const resume of [...resumeWaiters]) resume();
      for (const waiter of laneWaiters.splice(0)) waiter.resolve();
    },
    get tornDown() {
      return torn;
    },
  };
  return feed;
}

// ---------------------------------------------------------------------------
// Shared feeds (one per mint + pool per tab)
// ---------------------------------------------------------------------------

const shared = new Map<string, OnchainTradeFeed>();

export function onchainFeedKey(mint: string, pool: string, isPumpCurve: boolean): string {
  return `${mint}|${pool}|${isPumpCurve ? 'curve' : 'pool'}`;
}

/**
 * The tab-wide feed for this mint + pool, created on first use. Creating it
 * starts nothing: the first `subscribe` starts the backfill and the live
 * feed; it is torn down (and forgotten) `idleMs` after its last listener
 * left, so a StrictMode remount or a quick back-navigation reuses it.
 */
export function sharedOnchainTradeFeed(options: Omit<OnchainTradeFeedOptions, 'onIdle'>): OnchainTradeFeed {
  const key = onchainFeedKey(options.mint, options.pool, options.isPumpCurve);
  const existing = shared.get(key);
  if (existing && !existing.tornDown) return existing;
  const feed = createOnchainTradeFeed({
    ...options,
    onIdle: () => {
      if (shared.get(key) === feed) shared.delete(key);
      feed.teardown();
    },
  });
  shared.set(key, feed);
  return feed;
}
