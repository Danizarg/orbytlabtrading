'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import { useAccountSubscription, useLogsSubscription, useSolanaWsStatus } from '@/client/hooks/useSolanaSubscriptions';
import type { TrackedWallet } from '@/client/store/preferences';
import { describeError, isAbortError, isProviderError, ProviderError } from '@/lib/net/errors';
import {
  accountHintGapMs,
  countStreamMisses,
  feedMints,
  IDENTITY_LOOKUP_MAX,
  mergeTrackerEntries,
  patchTrackerStatus,
  pruneTrackerEntries,
  reconcileIntervalMs,
  retryDelayMs,
  staggerMs,
  streamReliable,
  toTrackerEntries,
  TRACKER_BACKFILL_LIMIT,
  TRACKER_FAST_POLL_MS,
  TRACKER_POLL_LIMIT,
  trackerKey,
  walletLive,
  type TrackerEntry,
  type TrackerLive,
  type TrackerWalletStatus,
} from '@/lib/services/wallet';
import type { SolanaWsStatus } from '@/lib/streams/solana-ws';
import { useVisibleInterval } from '../pulse/timers';
import { server } from '../sources';
import { useMintIdentities, walletKeys, type MintIdentities } from './usePortfolio';
import { useSolPrice } from './useSolPrice';

/**
 * Tracker feed for this tab. Entries live in a store (not per component) so
 * they survive navigating away and back, and every tracked wallet feeds it
 * through these paths:
 * 1. backfill: the latest 10 activities from the server route on add (staggered);
 * 2. live: a Solana `logsSubscribe` on the wallet; each successful signature
 *    is parsed through /api/v1/tx/[signature] and prepended;
 * 3. live hint: an `accountSubscribe` on the wallet. Every transaction the
 *    wallet signs changes its SOL balance (fees), so a balance change
 *    triggers an immediate poll of the newest 5 activities (coalesced per
 *    wallet). Measured 2026-09-29: publicnode confirms wallet log
 *    subscriptions but delivered 0 of 43 transactions, while account
 *    notifications arrived for the same wallet within ~1 s;
 * 4. reconciliation: the latest 5 activities every 90 s per wallet (plus one
 *    probe 30 s after the backfill and one after a WS reconnect). When a poll
 *    finds transactions neither live path surfaced, that wallet is reconciled
 *    every 30 s (small lists) until a live path delivers again.
 */

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface TrackerState {
  entries: TrackerEntry[];
  status: Readonly<Record<string, TrackerWalletStatus>>;
  /** Incremented whenever new entries are merged (drives "N new" while paused). */
  revision: number;
  push: (incoming: readonly TrackerEntry[]) => number;
  report: (wallet: string, patch: Partial<TrackerWalletStatus>) => void;
  noteStream: (wallet: string, at: number) => void;
  noteAccount: (wallet: string, at: number) => void;
  prune: (wallets: readonly string[]) => void;
}

const EMPTY_STATUS: TrackerWalletStatus = { streamEvents: 0 };
/** A busy wallet changes balance every slot; its "last live event" time is recorded at this granularity to avoid re-rendering per slot. */
const ACCOUNT_NOTE_MS = 5_000;

export const useTrackerStore = create<TrackerState>()((set, get) => ({
  entries: [],
  status: {},
  revision: 0,
  push: (incoming) => {
    const { entries, added } = mergeTrackerEntries(get().entries, incoming);
    if (added > 0) set((s) => ({ entries, revision: s.revision + 1 }));
    return added;
  },
  report: (wallet, patch) => set((s) => ({ status: { ...s.status, [wallet]: patchTrackerStatus(s.status[wallet] ?? EMPTY_STATUS, patch) } })),
  noteStream: (wallet, at) =>
    set((s) => {
      const current = s.status[wallet] ?? EMPTY_STATUS;
      return { status: { ...s.status, [wallet]: { ...current, lastStreamAt: at, streamEvents: current.streamEvents + 1 } } };
    }),
  noteAccount: (wallet, at) => {
    const current = get().status[wallet] ?? EMPTY_STATUS;
    if (current.lastAccountAt !== undefined && at - current.lastAccountAt < ACCOUNT_NOTE_MS) return;
    set((s) => ({ status: { ...s.status, [wallet]: { ...(s.status[wallet] ?? EMPTY_STATUS), lastAccountAt: at } } }));
  },
  prune: (wallets) => {
    const s = get();
    const entries = pruneTrackerEntries(s.entries, wallets);
    const keep = new Set(wallets);
    const stale = Object.keys(s.status).some((w) => !keep.has(w));
    if (entries === s.entries && !stale) return;
    const status: Record<string, TrackerWalletStatus> = {};
    for (const [w, st] of Object.entries(s.status)) if (keep.has(w)) status[w] = st;
    set({ entries, status });
  },
}));

function hasEntry(wallet: string, signature: string): boolean {
  const key = trackerKey(wallet, signature);
  return useTrackerStore.getState().entries.some((e) => e.key === key);
}

/** Wallet + signature keys the log subscription announced (bounded), to tell stream hits from misses. */
const streamed = new Set<string>();
const STREAMED_MAX = 2_000;

function noteStreamed(key: string): void {
  streamed.add(key);
  if (streamed.size > STREAMED_MAX) {
    const oldest = streamed.values().next().value;
    if (oldest !== undefined) streamed.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// Per-wallet workers (mounted once per tracked wallet)
// ---------------------------------------------------------------------------

interface MountedWallet {
  at: number;
  /** Aborted when the wallet's worker unmounts (removed from the tracker or page left). */
  controller: AbortController;
}

/** Wallets currently mounted in a worker; results for removed wallets are dropped and their requests aborted. */
const mounted = new Map<string, MountedWallet>();
/** Transactions this soon after mount may predate the confirmed subscription, so they are not counted as stream misses. */
const SUBSCRIBE_GRACE_MS = 10_000;
/** Reconciliations of one wallet closer together than this are skipped (probe, interval, tab focus and reconnect can coincide). */
const RECONCILE_MIN_GAP_MS = 10_000;
const reconciling = new Set<string>();
const lastReconcileAt = new Map<string, number>();

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError('orbyt', 'aborted', 'tracker: aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Backfills that are waiting for their turn. Wallets mounting together (page
 * load with many tracked wallets) start 300 ms apart; a wallet added later,
 * with nothing queued, starts at once.
 */
let backfillQueue = 0;

async function staggeredStart(signal?: AbortSignal): Promise<void> {
  const slot = backfillQueue++;
  try {
    await wait(staggerMs(slot), signal);
  } finally {
    backfillQueue--;
  }
}

/**
 * Poll the wallet's newest activities. `interval` polls (periodic, probe,
 * tab focus, reconnect) are staggered by list position and count stream
 * misses; `account` polls run right after a balance change and their finds
 * count as live.
 */
async function reconcile(wallet: string, index: number, trigger: 'interval' | 'account' = 'interval'): Promise<void> {
  const entry = mounted.get(wallet);
  if (!entry || reconciling.has(wallet)) return;
  const now = Date.now();
  if (now - (lastReconcileAt.get(wallet) ?? 0) < RECONCILE_MIN_GAP_MS) return;
  reconciling.add(wallet);
  lastReconcileAt.set(wallet, now);
  const { signal } = entry.controller;
  const store = useTrackerStore.getState();
  try {
    if (trigger === 'interval') await wait(staggerMs(index), signal);
    const result = await server.activity.getActivity(wallet, { limit: TRACKER_POLL_LIMIT }, signal);
    if (mounted.get(wallet) !== entry) return;
    const incoming = toTrackerEntries(result.data.items, wallet, trigger === 'account' ? 'account' : 'poll', Date.now());
    const known = (e: TrackerEntry) => streamed.has(e.key) || txQueued.has(e.key) || hasEntry(wallet, e.activity.signature);
    const patch: Partial<TrackerWalletStatus> = { lastPollAt: result.fetchedAt, pollError: undefined, backfillError: undefined };
    const status = useTrackerStore.getState().status[wallet];
    if (trigger === 'account') {
      const found = incoming.filter((e) => !known(e)).length;
      if (found > 0) patch.hintedFound = (status?.hintedFound ?? 0) + found;
    } else {
      // New to the feed, confirmed after the subscriptions were up, and surfaced by neither live path: missed.
      const missed = countStreamMisses(incoming, entry.at + SUBSCRIBE_GRACE_MS, known);
      if (missed > 0) {
        patch.lastMissAt = Date.now();
        patch.missedByStream = (status?.missedByStream ?? 0) + missed;
      }
    }
    store.push(incoming);
    // A successful poll also recovers a wallet whose initial backfill failed.
    store.report(wallet, patch);
  } catch (error) {
    if (isAbortError(error) || mounted.get(wallet) !== entry) return;
    store.report(wallet, { pollError: describeError(error) });
  } finally {
    reconciling.delete(wallet);
  }
}

/** Trailing poll scheduled by balance-change hints, per wallet. */
const hintTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Let the transaction settle at `confirmed` on the server's RPC before reading it. */
const HINT_SETTLE_MS = 1_500;

/**
 * Coalesce balance-change notifications into at most one poll per window
 * (see accountHintGapMs): the first change after a quiet period is read
 * ~1.5 s later, a burst yields one trailing read per window.
 */
function scheduleHintPoll(wallet: string, index: number, walletCount: number): void {
  if (hintTimers.has(wallet) || !mounted.has(wallet)) return;
  const gap = Math.max(accountHintGapMs(walletCount), RECONCILE_MIN_GAP_MS);
  const fire = () => {
    hintTimers.delete(wallet);
    // A hidden tab catches up when it becomes visible again.
    if (!mounted.has(wallet) || document.hidden) return;
    // Another poll is running or just ran (possibly before this change confirmed): read again once allowed.
    const blocked = (lastReconcileAt.get(wallet) ?? 0) + RECONCILE_MIN_GAP_MS - Date.now();
    if (reconciling.has(wallet) || blocked > 0) {
      hintTimers.set(wallet, setTimeout(fire, Math.max(blocked, 1_000)));
      return;
    }
    void reconcile(wallet, index, 'account');
  };
  hintTimers.set(wallet, setTimeout(fire, Math.max(HINT_SETTLE_MS, (lastReconcileAt.get(wallet) ?? 0) + gap - Date.now())));
}

function clearHintPoll(wallet: string): void {
  const timer = hintTimers.get(wallet);
  if (timer !== undefined) clearTimeout(timer);
  hintTimers.delete(wallet);
}

// Live signatures are parsed through the tx route with bounded concurrency; a
// transaction the node does not have yet ("not found / no block time") is
// retried twice, 2.5 s apart.
interface TxJob {
  wallet: string;
  signature: string;
  attempt: number;
}

const TX_CONCURRENCY = 2;
const TX_RETRY_MS = 2_500;
const TX_MAX_ATTEMPTS = 3;
const txQueue: TxJob[] = [];
const txQueued = new Set<string>();
let txActive = 0;

function enqueueTx(job: TxJob): void {
  const key = trackerKey(job.wallet, job.signature);
  if (txQueued.has(key) || hasEntry(job.wallet, job.signature)) return;
  txQueued.add(key);
  txQueue.push(job);
  pumpTx();
}

function pumpTx(): void {
  while (txActive < TX_CONCURRENCY && txQueue.length) {
    const job = txQueue.shift();
    if (!job) break;
    txActive++;
    void runTx(job).finally(() => {
      txActive--;
      pumpTx();
    });
  }
}

async function runTx(job: TxJob): Promise<void> {
  const key = trackerKey(job.wallet, job.signature);
  const store = useTrackerStore.getState();
  const owner = mounted.get(job.wallet);
  if (!owner) {
    txQueued.delete(key);
    return;
  }
  try {
    const result = await server.activity.getTransaction(job.signature, job.wallet, owner.controller.signal);
    txQueued.delete(key);
    if (mounted.get(job.wallet) !== owner) return;
    if (result.data) {
      store.push(toTrackerEntries([result.data], job.wallet, 'stream', Date.now()));
      return;
    }
    // null with a note: not confirmed on the node yet → retry; null without a note: no balance change (final).
    if (result.notes?.length && job.attempt + 1 < TX_MAX_ATTEMPTS) {
      setTimeout(() => enqueueTx({ ...job, attempt: job.attempt + 1 }), TX_RETRY_MS);
    }
  } catch (error) {
    txQueued.delete(key);
    if (isAbortError(error) || mounted.get(job.wallet) !== owner) return;
    const retryable = !isProviderError(error) || error.code === 'rate_limited' || error.code === 'network' || error.code === 'timeout' || error.code === 'http';
    if (retryable && job.attempt + 1 < TX_MAX_ATTEMPTS) setTimeout(() => enqueueTx({ ...job, attempt: job.attempt + 1 }), TX_RETRY_MS * 2);
  }
}

/**
 * Feeds one tracked wallet into the store: backfill on mount (staggered with
 * the other wallets mounting at the same time), live log subscription, and a
 * reconciliation poll (90 s, faster while the stream misses this wallet's
 * transactions; offset by `index`). Mount it once per tracked wallet
 * (headless worker component).
 */
export function useTrackerWallet(wallet: string, index: number, ctx: { walletCount: number; wsLive: boolean; wsOpen: boolean }): void {
  const reliable = useTrackerStore((s) => streamReliable(s.status[wallet], ctx.wsLive));
  useEffect(() => {
    const entry: MountedWallet = { at: Date.now(), controller: new AbortController() };
    mounted.set(wallet, entry);
    return () => {
      entry.controller.abort();
      clearHintPoll(wallet);
      if (mounted.get(wallet) === entry) mounted.delete(wallet);
    };
  }, [wallet]);

  // The socket dropped and came back: notifications sent meanwhile are lost, so reconcile right away
  // instead of waiting for the next cycle (the first open of the page is covered by the backfill).
  const wasOpen = useRef(ctx.wsOpen);
  const everOpen = useRef(ctx.wsOpen);
  useEffect(() => {
    const reopened = ctx.wsOpen && !wasOpen.current && everOpen.current;
    wasOpen.current = ctx.wsOpen;
    if (ctx.wsOpen) everOpen.current = true;
    if (reopened && !document.hidden) void reconcile(wallet, index);
  }, [ctx.wsOpen, wallet, index]);

  const backfill = useQuery({
    queryKey: walletKeys.trackerBackfill(wallet),
    queryFn: async ({ signal }) => {
      await staggeredStart(signal);
      return server.activity.getActivity(wallet, { limit: TRACKER_BACKFILL_LIMIT }, signal);
    },
    staleTime: Infinity,
    // Re-adding a removed wallet backfills again.
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 2,
    retryDelay: retryDelayMs,
  });

  useEffect(() => {
    if (!backfill.data) return;
    const store = useTrackerStore.getState();
    store.push(toTrackerEntries(backfill.data.data.items, wallet, 'backfill', Date.now()));
    store.report(wallet, { backfilledAt: backfill.data.fetchedAt, backfillError: undefined });
  }, [backfill.data, wallet]);

  useEffect(() => {
    if (!backfill.isError) return;
    useTrackerStore.getState().report(wallet, { backfillError: describeError(backfill.error) });
  }, [backfill.isError, backfill.error, wallet]);

  // One early probe 30 s after the backfill answers tells within seconds whether the stream is delivering this
  // wallet's transactions (a miss switches it to faster polling) instead of waiting a full 90 s cycle. After a
  // failed backfill the same probe is the first recovery attempt.
  const answered = backfill.data !== undefined || backfill.isError;
  useEffect(() => {
    if (!answered) return;
    const timer = setTimeout(() => {
      if (!document.hidden) void reconcile(wallet, index);
    }, TRACKER_FAST_POLL_MS);
    return () => clearTimeout(timer);
  }, [answered, wallet, index]);

  // Hidden tabs stop polling; coming back reconciles at once because the WS may have dropped events meanwhile.
  useVisibleInterval(() => void reconcile(wallet, index), reconcileIntervalMs(ctx.walletCount, reliable), { runOnVisible: true });

  useLogsSubscription(wallet, (notification) => {
    if (notification.err !== null) return;
    noteStreamed(trackerKey(wallet, notification.signature));
    useTrackerStore.getState().noteStream(wallet, notification.receivedAt);
    enqueueTx({ wallet, signature: notification.signature, attempt: 0 });
  });

  // Balance changes of the wallet itself (every signed transaction pays a fee): read the newest activities.
  useAccountSubscription(wallet, 'base64', (update) => {
    useTrackerStore.getState().noteAccount(wallet, update.receivedAt);
    scheduleHintPoll(wallet, index, ctx.walletCount);
  });
}

// ---------------------------------------------------------------------------
// Merged feed
// ---------------------------------------------------------------------------

export interface TrackerFeedView {
  entries: TrackerEntry[];
  revision: number;
  status: Readonly<Record<string, TrackerWalletStatus>>;
  live: Readonly<Record<string, TrackerLive>>;
  /** Current reconciliation interval per wallet (ms). */
  pollMs: Readonly<Record<string, number>>;
  identities: MintIdentities;
  solPriceUsd: number | undefined;
  ws: SolanaWsStatus;
  /** The shared socket is open with every subscription confirmed. */
  wsLive: boolean;
  /** The shared socket is open (a false → true change after being open is a reconnect). */
  wsOpen: boolean;
  /** Every tracked wallet has answered its backfill (ok or error). */
  backfilled: boolean;
}

/** Merged live feed across the tracked wallets plus per-wallet status. */
export function useTrackerFeed(wallets: readonly TrackedWallet[]): TrackerFeedView {
  const entries = useTrackerStore((s) => s.entries);
  const revision = useTrackerStore((s) => s.revision);
  const status = useTrackerStore((s) => s.status);
  const ws = useSolanaWsStatus();
  const sol = useSolPrice();

  const addresses = useMemo(() => wallets.map((w) => w.address), [wallets]);
  useEffect(() => {
    useTrackerStore.getState().prune(addresses);
  }, [addresses]);

  const mints = useMemo(() => feedMints(entries, IDENTITY_LOOKUP_MAX), [entries]);
  const identities = useMintIdentities(mints);

  const open = ws.status === 'open';
  const confirmed = ws.subscriptions > 0 && ws.confirmed >= ws.subscriptions;
  const { live, pollMs } = useMemo(() => {
    const liveOut: Record<string, TrackerLive> = {};
    const pollOut: Record<string, number> = {};
    for (const a of addresses) {
      liveOut[a] = walletLive(status[a], { open, confirmed });
      pollOut[a] = reconcileIntervalMs(addresses.length, streamReliable(status[a], open && confirmed));
    }
    return { live: liveOut, pollMs: pollOut };
  }, [addresses, status, open, confirmed]);

  const backfilled = addresses.every((a) => {
    const s = status[a];
    return !!s && (s.backfilledAt !== undefined || s.backfillError !== undefined);
  });

  return { entries, revision, status, live, pollMs, identities, solPriceUsd: sol.data?.data.priceUsd, ws, wsLive: open && confirmed, wsOpen: open, backfilled };
}
