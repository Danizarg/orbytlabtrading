'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useCapabilities } from '@/client/capabilities';
import { usePumpPortalMigrations, usePumpPortalNewTokens } from '@/client/hooks/usePumpPortal';
import { useSolPrice } from '@/data/hooks/useSolPrice';
import { browserCurves, gecko, jup, server } from '@/data/sources';
import { PUBLIC_ENDPOINTS } from '@/lib/config/capabilities';
import { runChain, type ChainStep } from '@/lib/core/chain';
import { PROVIDER_LABELS } from '@/lib/core/providers';
import type { BondingCurveState, PulseColumn, TokenRow } from '@/lib/core/types';
import { isAbortError, isProviderError } from '@/lib/net/errors';
import {
  classifyGeckoPool,
  feedErrorText,
  geckoMigrationAction,
  isCurveTarget,
  patchFromCurve,
  patchFromGeckoPool,
  patchFromMigration,
  patchFromNewToken,
  patchFromServerToken,
  patchFromTokenRow,
  patchFromUltra,
  pickBatch,
  verifyCandidate,
  type PatchMeta,
  type PendingCandidate,
  type PulseFeedId,
  type PulsePatch,
} from '@/lib/services/pulse';
import { enqueuePatches, flushPatches, FLUSH_INTERVAL_MS, getVisibleMints, usePulseStore, visibleMintSet } from './store';
import { useVisibleInterval } from './timers';

/**
 * Every Pulse input, mounted once by the page:
 *
 * 1. PumpPortal stream (browser WebSocket): pump.fun creates appear instantly,
 *    migrations flip tokens to graduated. bonk creates wait for confirmation.
 * 2. Keyless backfill: Jupiter /tokens/v2/recent (6 s), GeckoTerminal new
 *    pools and pump.fun curve pools (60 s each, 2 calls/min).
 * 3. On-chain pump.fun curves via publicnode (4 s, ≤100 mints, falling back
 *    to ORBYT's RPC proxy): exact progress, price and market cap.
 * 4. Enrichment: Jupiter token rows (15 s) and Ultra risk extras (60 s).
 * 5. Keyed server lists when configured (10 s per column).
 *
 * Jupiter keyless budget (4 calls / 10 s per browser): recent 1.7 + rows 0.7
 * + Ultra 0.2 + SOL price 0.3 ≈ 2.8 calls / 10 s. React Query pauses polling
 * while the tab is hidden; the manual timers here do the same.
 */

export const PULSE_CADENCE = {
  jupRecent: 6_000,
  geckoNew: 60_000,
  geckoPump: 60_000,
  curves: 4_000,
  jupRows: 15_000,
  jupUltra: 60_000,
  server: 10_000,
  prune: 10_000,
} as const;

/** Re-check sooner when the previous run had nothing to request (no network call was made). */
const IDLE_RETRY_MS = { curves: 1_500, jupRows: 3_000, jupUltra: 20_000 } as const;

const BATCH = { curves: 100, rows: 100, ultra: 100 } as const;
const MAX_CURVE_MISSES = 2;
const MAX_PENDING = 100;
const PENDING_TTL_MS = 5 * 60_000;
const MAX_VERIFY_ATTEMPTS = 4;
const MAX_PUMP_CANDIDATES = 60;
const TRACKING_LIMIT = 1_500;

// ---------------------------------------------------------------------------
// Poller bookkeeping (tab-wide, outside React state: nothing here is rendered)
// ---------------------------------------------------------------------------

const curveLastPolled = new Map<string, number>();
const curveMisses = new Map<string, number>();
const rowsLastPicked = new Map<string, number>();
const ultraLastPicked = new Map<string, number>();
/** GeckoTerminal pump.fun curves not yet tracked; inserted together with their first on-chain read. */
const pumpCandidates = new Map<string, PulsePatch>();
/** Readings waiting for launchpad confirmation (bonk creates, unknown migration pools). */
const pending = new Map<string, PendingCandidate>();
let pumpSortByVolume = false;

function addPending(candidate: PendingCandidate): void {
  const existing = pending.get(candidate.patch.mint);
  if (existing && existing.kind === candidate.kind) return;
  pending.set(candidate.patch.mint, candidate);
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

function trimTracking(): void {
  const { items } = usePulseStore.getState();
  const keep = (mint: string) => items.has(mint) || pumpCandidates.has(mint) || pending.has(mint);
  for (const map of [curveLastPolled, curveMisses, rowsLastPicked, ultraLastPicked]) {
    if (map.size <= TRACKING_LIMIT) continue;
    for (const mint of map.keys()) if (!keep(mint)) map.delete(mint);
  }
  const now = Date.now();
  for (const [mint, c] of pending) if (now - c.addedAt > PENDING_TTL_MS) pending.delete(mint);
}

const browserRpcLabel = (() => {
  try {
    const host = new URL(PUBLIC_ENDPOINTS.solanaRpc).hostname;
    return host.includes('publicnode') ? 'publicnode' : host;
  } catch {
    return 'browser RPC';
  }
})();

// ---------------------------------------------------------------------------
// Poll runner
// ---------------------------------------------------------------------------

interface PollResult {
  polled: number;
  applied: number;
  via?: string;
}

/** Runs one poll, records feed health and keeps provider errors visible. `null` = nothing to request. */
async function runFeed(id: PulseFeedId, task: () => Promise<PollResult | null>): Promise<PollResult> {
  const store = usePulseStore.getState();
  try {
    const result = await task();
    if (!result) return { polled: 0, applied: 0 };
    store.reportOk(id, Date.now(), result.via);
    return result;
  } catch (error) {
    if (!isAbortError(error)) {
      if (isProviderError(error) && error.code === 'not_configured') store.disableFeed(id);
      else store.reportError(id, feedErrorText(error), Date.now());
    }
    throw error;
  }
}

function usePulsePoll(
  id: PulseFeedId,
  intervalMs: number,
  task: (signal: AbortSignal) => Promise<PollResult | null>,
  opts: { idleMs?: number; enabled?: boolean } = {},
) {
  const idleMs = opts.idleMs ?? intervalMs;
  return useQuery({
    queryKey: ['pulse-feed', id],
    queryFn: ({ signal }) => runFeed(id, () => task(signal)),
    enabled: opts.enabled ?? true,
    refetchInterval: (query) => (query.state.data?.polled === 0 ? idleMs : intervalMs),
    // Polls own their cadence: no focus bursts against keyless budgets, no retries on top of the next poll.
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Math.min(intervalMs, idleMs),
    gcTime: 60_000,
  });
}

function metaOf(r: { source: PatchMeta['source']; freshness: PatchMeta['freshness']; fetchedAt: number }): PatchMeta {
  return { source: r.source, freshness: r.freshness, fetchedAt: r.fetchedAt };
}

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

/** Jupiter's 30 latest first-pool creations (all launchpads). */
async function pollRecent(signal: AbortSignal, serverFirst: boolean): Promise<PollResult> {
  const result = await runChain<TokenRow[]>(
    'pulse recent',
    [
      serverFirst && { id: 'orbyt', run: () => server.discover.discover({ list: 'new', window: '5m' }, signal) },
      { id: 'jupiter', run: () => jup.discover({ list: 'new', window: '5m' }, signal) },
    ],
    { signal },
  );
  const meta = metaOf(result);
  const now = Date.now();
  const patches: PulsePatch[] = [];
  for (const row of result.data) {
    const lp = row.token.launchpad;
    // Launches only: tokens without a launchpad are plain AMM listings.
    if (!lp?.launchpad || lp.stage === 'amm') continue;
    const mint = row.token.mint;
    const candidate = pending.get(mint);
    if (candidate) {
      const outcome = verifyCandidate(candidate, row, meta, now);
      if (outcome.status !== 'unknown') pending.delete(mint);
      if (outcome.status === 'confirmed') {
        patches.push(...outcome.patches);
        continue;
      }
    }
    patches.push(patchFromTokenRow(row, meta));
    rowsLastPicked.set(mint, now);
  }
  enqueuePatches(patches);
  return { polled: result.data.length, applied: patches.length, via: PROVIDER_LABELS[result.source] };
}

/** GeckoTerminal newest pools: launchpad curves → New Pairs; migration venues → Migrated (after confirmation). */
async function pollGeckoNew(signal: AbortSignal): Promise<PollResult> {
  const result = await gecko.getNewPools(1, signal);
  const meta = metaOf(result);
  const { items } = usePulseStore.getState();
  const now = Date.now();
  const patches: PulsePatch[] = [];
  for (const pool of result.data) {
    const kind = classifyGeckoPool(pool);
    if (kind === 'other') continue;
    const patch = patchFromGeckoPool(pool, meta);
    if (!patch) continue;
    if (kind === 'bonding') {
      patches.push(patch);
      continue;
    }
    const action = geckoMigrationAction(items.get(pool.baseMint), pool);
    if (action === 'apply') patches.push(patch);
    else if (action === 'verify') addPending({ kind: 'migration', patch, addedAt: now, attempts: 0 });
  }
  enqueuePatches(patches);
  return { polled: result.data.length, applied: patches.length, via: PROVIDER_LABELS[result.source] };
}

/**
 * Busiest pump.fun curve pools (Final Stretch candidates). Most are already
 * complete, so untracked ones are held until their curve is read on-chain.
 * Alternates the tx-count and volume sorts to widen the candidate set.
 */
async function pollGeckoPump(signal: AbortSignal): Promise<PollResult> {
  const sort = pumpSortByVolume ? 'h24_volume_usd_desc' : 'h24_tx_count_desc';
  pumpSortByVolume = !pumpSortByVolume;
  const result = await gecko.getDexPools('pump-fun', { sort }, signal);
  const meta = metaOf(result);
  const { items } = usePulseStore.getState();
  const patches: PulsePatch[] = [];
  for (const pool of result.data) {
    if (classifyGeckoPool(pool) !== 'bonding') continue;
    const patch = patchFromGeckoPool(pool, meta);
    if (!patch) continue;
    if (items.has(pool.baseMint)) {
      patches.push({ ...patch, updateOnly: true });
    } else {
      pumpCandidates.delete(pool.baseMint);
      pumpCandidates.set(pool.baseMint, patch);
    }
  }
  while (pumpCandidates.size > MAX_PUMP_CANDIDATES) {
    const oldest = pumpCandidates.keys().next().value;
    if (oldest === undefined) break;
    pumpCandidates.delete(oldest);
  }
  enqueuePatches(patches);
  return { polled: result.data.length, applied: patches.length, via: PROVIDER_LABELS[result.source] };
}

/** Decoded pump.fun bonding curves for visible tokens, candidates and a rotation of the rest. */
async function pollCurves(signal: AbortSignal, serverFirst: boolean, solPriceUsd: number | undefined): Promise<PollResult | null> {
  const now = Date.now();
  const { items } = usePulseStore.getState();
  const visible = getVisibleMints();
  const eligible = (mint: string) => {
    if ((curveMisses.get(mint) ?? 0) >= MAX_CURVE_MISSES) return false;
    const item = items.get(mint);
    return item ? isCurveTarget(item) : pumpCandidates.has(mint);
  };
  const rotation: string[] = [];
  for (const item of items.values()) if (eligible(item.mint)) rotation.push(item.mint);
  const mints = pickBatch(
    [visible.final.filter(eligible), [...pumpCandidates.keys()].filter(eligible), visible.new.filter(eligible)],
    rotation,
    curveLastPolled,
    BATCH.curves,
  );
  if (!mints.length) return null;
  for (const mint of mints) curveLastPolled.set(mint, now);

  const browser: ChainStep<Record<string, BondingCurveState>> = { id: 'solana-rpc', run: () => browserCurves.getCurves(mints, signal) };
  const proxied: ChainStep<Record<string, BondingCurveState>> = { id: 'orbyt', run: () => server.curves.getCurves(mints, signal) };
  const result = await runChain('pulse curves', serverFirst ? [proxied, browser] : [browser, proxied], { signal });

  const tracked = usePulseStore.getState().items;
  const patches: PulsePatch[] = [];
  for (const mint of mints) {
    const curve = result.data[mint];
    if (!curve) {
      // No pump.fun curve account for this mint.
      curveMisses.set(mint, (curveMisses.get(mint) ?? 0) + 1);
      if (!tracked.has(mint)) pumpCandidates.delete(mint);
      continue;
    }
    curveMisses.delete(mint);
    const candidate = tracked.has(mint) ? undefined : pumpCandidates.get(mint);
    if (candidate) {
      patches.push(candidate);
      pumpCandidates.delete(mint);
    }
    patches.push(patchFromCurve(curve, solPriceUsd));
  }
  enqueuePatches(patches);
  const via = result.attempts.at(-1)?.provider === 'orbyt' ? 'ORBYT RPC proxy' : browserRpcLabel;
  return { polled: mints.length, applied: patches.length, via };
}

/** Token rows: identity, holders, 24 h activity, audit, graduation; also confirms pending candidates. */
async function pollRows(signal: AbortSignal, serverFirst: boolean): Promise<PollResult | null> {
  const now = Date.now();
  const { items } = usePulseStore.getState();
  const visible = getVisibleMints();
  const shown = [...visible.final, ...visible.new, ...visible.migrated];
  const missingIdentity = shown.filter((mint) => !items.get(mint)?.symbol);
  const awaitingMigration: string[] = [];
  for (const item of items.values()) if (item.launchpad.stage === 'bonding' && item.curveComplete === true) awaitingMigration.push(item.mint);
  const mints = pickBatch([[...pending.keys()], missingIdentity, awaitingMigration, shown], items.keys(), rowsLastPicked, BATCH.rows);
  if (!mints.length) return null;
  for (const mint of mints) rowsLastPicked.set(mint, now);

  const result = await runChain<TokenRow[]>(
    'pulse rows',
    [
      serverFirst && { id: 'orbyt', run: () => server.tokens.getRows(mints, signal) },
      { id: 'jupiter', run: () => jup.getRows(mints, signal) },
    ],
    { signal },
  );
  const meta = metaOf(result);
  const rows = new Map(result.data.map((row) => [row.token.mint, row]));
  const patches: PulsePatch[] = [];
  for (const mint of mints) {
    const row = rows.get(mint);
    const candidate = pending.get(mint);
    if (candidate) {
      const outcome = verifyCandidate(candidate, row, meta, now);
      if (outcome.status === 'confirmed') patches.push(...outcome.patches);
      if (outcome.status !== 'unknown' || candidate.attempts + 1 >= MAX_VERIFY_ATTEMPTS) pending.delete(mint);
      else pending.set(mint, { ...candidate, attempts: candidate.attempts + 1 });
      continue;
    }
    if (row) patches.push({ ...patchFromTokenRow(row, meta), updateOnly: true });
  }
  enqueuePatches(patches);
  return { polled: mints.length, applied: patches.length, via: PROVIDER_LABELS[result.source] };
}

/** Jupiter Ultra extras (snipers, insiders, bundlers; progress for non-pump launchpads). Optional enrichment. */
async function pollUltra(signal: AbortSignal): Promise<PollResult | null> {
  const { items } = usePulseStore.getState();
  const visible = getVisibleMints();
  const nonPump: string[] = [];
  const bonding: string[] = [];
  for (const item of items.values()) {
    if (item.launchpad.stage !== 'bonding' || item.curveComplete === true) continue;
    (item.launchpad.launchpad === 'pump.fun' ? bonding : nonPump).push(item.mint);
  }
  const mints = pickBatch([visible.final, visible.new, visible.migrated], [...nonPump, ...bonding], ultraLastPicked, BATCH.ultra);
  if (!mints.length) return null;
  const now = Date.now();
  for (const mint of mints) ultraLastPicked.set(mint, now);
  const result = await jup.getUltraInfo(mints, signal);
  const meta = metaOf(result);
  const patches: PulsePatch[] = [];
  for (const [mint, info] of Object.entries(result.data)) {
    const patch = patchFromUltra(mint, info, meta);
    if (patch) patches.push(patch);
  }
  enqueuePatches(patches);
  return { polled: mints.length, applied: patches.length, via: 'Jupiter Ultra' };
}

/** Keyed launchpad lists (Solana Tracker / Birdeye) through /api/v1/pulse. */
async function pollServer(column: PulseColumn, signal: AbortSignal): Promise<PollResult> {
  const result = await server.pulse.getPulse(column, signal);
  const meta = metaOf(result);
  const patches = result.data.map((token) => patchFromServerToken(token, meta));
  enqueuePatches(patches);
  return { polled: result.data.length, applied: patches.length, via: PROVIDER_LABELS[result.source] };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function usePulseStream(solPriceUsd: number | undefined): void {
  usePumpPortalNewTokens((event) => {
    const patch = patchFromNewToken(event, solPriceUsd);
    if (event.unverified) {
      // bonk creates: unverified schema, confirmed against Jupiter before they are shown.
      if (!usePulseStore.getState().items.has(event.mint)) addPending({ kind: 'launch', patch, addedAt: event.receivedAt, attempts: 0 });
      return;
    }
    enqueuePatches([patch]);
  });
  usePumpPortalMigrations((event) => enqueuePatches([patchFromMigration(event)]));
}

function pruneTick(): void {
  usePulseStore.getState().prune(visibleMintSet(), Date.now());
  trimTracking();
}

/** Mount every Pulse feed (call once, from the page). */
export function usePulseFeeds(): void {
  const caps = useCapabilities();
  const solPriceUsd = useSolPrice().data?.data.priceUsd;
  // A keyed RPC behind the server beats publicnode; otherwise the browser reads the chain itself.
  const serverRpcFirst = caps.configured.helius || caps.configured.customRpc;
  const serverNewOff = usePulseStore((s) => s.feeds.serverNew?.disabled === true);
  const serverFinalOff = usePulseStore((s) => s.feeds.serverFinal?.disabled === true);
  const serverMigratedOff = usePulseStore((s) => s.feeds.serverMigrated?.disabled === true);

  usePulseStream(solPriceUsd);
  useVisibleInterval(flushPatches, FLUSH_INTERVAL_MS, { runOnVisible: true });
  useVisibleInterval(pruneTick, PULSE_CADENCE.prune);
  useEffect(() => () => flushPatches(), []);

  usePulsePoll('jupRecent', PULSE_CADENCE.jupRecent, (signal) => pollRecent(signal, caps.serverDiscover));
  usePulsePoll('geckoNew', PULSE_CADENCE.geckoNew, pollGeckoNew);
  usePulsePoll('geckoPump', PULSE_CADENCE.geckoPump, pollGeckoPump);
  usePulsePoll('curves', PULSE_CADENCE.curves, (signal) => pollCurves(signal, serverRpcFirst, solPriceUsd), { idleMs: IDLE_RETRY_MS.curves });
  usePulsePoll('jupRows', PULSE_CADENCE.jupRows, (signal) => pollRows(signal, caps.serverDiscover), { idleMs: IDLE_RETRY_MS.jupRows });
  usePulsePoll('jupUltra', PULSE_CADENCE.jupUltra, pollUltra, { idleMs: IDLE_RETRY_MS.jupUltra });
  usePulsePoll('serverNew', PULSE_CADENCE.server, (signal) => pollServer('new', signal), { enabled: caps.serverPulse && !serverNewOff });
  usePulsePoll('serverFinal', PULSE_CADENCE.server, (signal) => pollServer('final', signal), { enabled: caps.serverPulse && !serverFinalOff });
  usePulsePoll('serverMigrated', PULSE_CADENCE.server, (signal) => pollServer('migrated', signal), {
    enabled: caps.serverPulse && !serverMigratedOff,
  });
}
