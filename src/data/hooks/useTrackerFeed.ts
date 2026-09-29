'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { useLogsSubscription, useSolanaWsStatus } from '@/client/hooks/useSolanaSubscriptions';
import type { TrackedWallet } from '@/client/store/preferences';
import { describeError, isAbortError, isProviderError, ProviderError } from '@/lib/net/errors';
import {
  feedMints,
  mergeTrackerEntries,
  pruneTrackerEntries,
  staggerMs,
  toTrackerEntries,
  TRACKER_BACKFILL_LIMIT,
  TRACKER_POLL_LIMIT,
  TRACKER_POLL_MS,
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
 * through three paths:
 * 1. backfill: the latest 10 activities from the server route on add (staggered);
 * 2. live: a Solana `logsSubscribe` on the wallet; each successful signature
 *    is parsed through /api/v1/tx/[signature] and prepended;
 * 3. reconciliation: the latest 5 activities every 90 s per wallet, because
 *    the public WS drops notifications.
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
  prune: (wallets: readonly string[]) => void;
}

const EMPTY_STATUS: TrackerWalletStatus = { streamEvents: 0 };

/** Apply a patch; a key present with `undefined` clears that field (e.g. an error after a success). */
function mergeStatus(current: TrackerWalletStatus, patch: Partial<TrackerWalletStatus>): TrackerWalletStatus {
  const pick = <K extends keyof TrackerWalletStatus>(key: K): TrackerWalletStatus[K] | undefined => (key in patch ? patch[key] : current[key]);
  const next: TrackerWalletStatus = { streamEvents: pick('streamEvents') ?? current.streamEvents };
  const backfilledAt = pick('backfilledAt');
  if (backfilledAt !== undefined) next.backfilledAt = backfilledAt;
  const backfillError = pick('backfillError');
  if (backfillError !== undefined) next.backfillError = backfillError;
  const lastPollAt = pick('lastPollAt');
  if (lastPollAt !== undefined) next.lastPollAt = lastPollAt;
  const pollError = pick('pollError');
  if (pollError !== undefined) next.pollError = pollError;
  const lastStreamAt = pick('lastStreamAt');
  if (lastStreamAt !== undefined) next.lastStreamAt = lastStreamAt;
  return next;
}

export const useTrackerStore = create<TrackerState>()((set, get) => ({
  entries: [],
  status: {},
  revision: 0,
  push: (incoming) => {
    const { entries, added } = mergeTrackerEntries(get().entries, incoming);
    if (added > 0) set((s) => ({ entries, revision: s.revision + 1 }));
    return added;
  },
  report: (wallet, patch) => set((s) => ({ status: { ...s.status, [wallet]: mergeStatus(s.status[wallet] ?? EMPTY_STATUS, patch) } })),
  noteStream: (wallet, at) =>
    set((s) => {
      const current = s.status[wallet] ?? EMPTY_STATUS;
      return { status: { ...s.status, [wallet]: { ...current, lastStreamAt: at, streamEvents: current.streamEvents + 1 } } };
    }),
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

// ---------------------------------------------------------------------------
// Per-wallet workers (mounted once per tracked wallet)
// ---------------------------------------------------------------------------

/** Wallets currently mounted in a worker; results for removed wallets are dropped. */
const mounted = new Set<string>();

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

async function reconcile(wallet: string, index: number): Promise<void> {
  const store = useTrackerStore.getState();
  try {
    await wait(staggerMs(index));
    const result = await server.activity.getActivity(wallet, { limit: TRACKER_POLL_LIMIT }, undefined);
    if (!mounted.has(wallet)) return;
    store.push(toTrackerEntries(result.data.items, wallet, 'poll', Date.now()));
    store.report(wallet, { lastPollAt: result.fetchedAt, pollError: undefined });
  } catch (error) {
    if (isAbortError(error) || !mounted.has(wallet)) return;
    store.report(wallet, { pollError: describeError(error) });
  }
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
  try {
    const result = await server.activity.getTransaction(job.signature, job.wallet, undefined);
    txQueued.delete(key);
    if (!mounted.has(job.wallet)) return;
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
    if (isAbortError(error) || !mounted.has(job.wallet)) return;
    const retryable = !isProviderError(error) || error.code === 'rate_limited' || error.code === 'network' || error.code === 'timeout' || error.code === 'http';
    if (retryable && job.attempt + 1 < TX_MAX_ATTEMPTS) setTimeout(() => enqueueTx({ ...job, attempt: job.attempt + 1 }), TX_RETRY_MS * 2);
  }
}

/**
 * Feeds one tracked wallet into the store: backfill on mount (staggered by
 * `index`), live log subscription, and a 90 s reconciliation poll. Mount it
 * once per tracked wallet (headless worker component).
 */
export function useTrackerWallet(wallet: string, index: number): void {
  useEffect(() => {
    mounted.add(wallet);
    return () => {
      mounted.delete(wallet);
    };
  }, [wallet]);

  const backfill = useQuery({
    queryKey: walletKeys.trackerBackfill(wallet),
    queryFn: async ({ signal }) => {
      await wait(staggerMs(index), signal);
      return server.activity.getActivity(wallet, { limit: TRACKER_BACKFILL_LIMIT }, signal);
    },
    staleTime: Infinity,
    // Re-adding a removed wallet backfills again.
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 2,
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

  useVisibleInterval(() => void reconcile(wallet, index), TRACKER_POLL_MS);

  useLogsSubscription(wallet, (notification) => {
    if (notification.err !== null) return;
    useTrackerStore.getState().noteStream(wallet, notification.receivedAt);
    enqueueTx({ wallet, signature: notification.signature, attempt: 0 });
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
  identities: MintIdentities;
  solPriceUsd: number | undefined;
  ws: SolanaWsStatus;
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

  const mints = useMemo(() => feedMints(entries), [entries]);
  const identities = useMintIdentities(mints);

  const live = useMemo(() => {
    const wsState = { open: ws.status === 'open', confirmed: ws.subscriptions > 0 && ws.confirmed >= ws.subscriptions };
    const out: Record<string, TrackerLive> = {};
    for (const a of addresses) out[a] = walletLive(status[a], wsState);
    return out;
  }, [addresses, status, ws.status, ws.subscriptions, ws.confirmed]);

  const backfilled = addresses.every((a) => {
    const s = status[a];
    return !!s && (s.backfilledAt !== undefined || s.backfillError !== undefined);
  });

  return { entries, revision, status, live, identities, solPriceUsd: sol.data?.data.priceUsd, ws, backfilled };
}
