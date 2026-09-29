import { create } from 'zustand';
import type { PulseColumn } from '@/lib/core/types';
import {
  applyPatches,
  pruneItems,
  type PulseFeedId,
  type PulseFeeds,
  type PulseFeedStatus,
  type PulseItem,
  type PulsePatch,
} from '@/lib/services/pulse';

/**
 * Pulse state for this tab: every tracked launch (Map<mint, PulseItem>) and
 * the health of each polled feed. Readings reach the store through a patch
 * buffer flushed every 250 ms, so a burst of stream events costs one render.
 */

interface PulseStoreState {
  items: ReadonlyMap<string, PulseItem>;
  feeds: PulseFeeds;
  apply: (patches: readonly PulsePatch[]) => void;
  prune: (visible: ReadonlySet<string>, now: number) => void;
  reportOk: (id: PulseFeedId, at: number, via?: string) => void;
  reportError: (id: PulseFeedId, error: string, at: number) => void;
  disableFeed: (id: PulseFeedId) => void;
}

function withFeed(feeds: PulseFeeds, id: PulseFeedId, update: (status: PulseFeedStatus) => PulseFeedStatus): PulseFeeds {
  return { ...feeds, [id]: update(feeds[id] ?? {}) };
}

export const usePulseStore = create<PulseStoreState>()((set, get) => ({
  items: new Map(),
  feeds: {},
  apply: (patches) => {
    if (!patches.length) return;
    const result = applyPatches(get().items, patches);
    if (result.changed) set({ items: result.items });
  },
  prune: (visible, now) => {
    const items = get().items;
    const next = pruneItems(items, visible, now);
    if (next !== items) set({ items: next });
  },
  reportOk: (id, at, via) =>
    set((s) => ({
      feeds: withFeed(s.feeds, id, (status) => {
        const next: PulseFeedStatus = { ...status, lastOkAt: at };
        if (via) next.via = via;
        return next;
      }),
    })),
  reportError: (id, error, at) => set((s) => ({ feeds: withFeed(s.feeds, id, (status) => ({ ...status, error, lastErrorAt: at })) })),
  disableFeed: (id) => set((s) => ({ feeds: withFeed(s.feeds, id, (status) => ({ ...status, disabled: true })) })),
}));

// ---------------------------------------------------------------------------
// Patch buffer (throttled store writes)
// ---------------------------------------------------------------------------

export const FLUSH_INTERVAL_MS = 250;
/** Oldest readings are dropped beyond this (e.g. a long-hidden tab still receiving stream events). */
export const MAX_BUFFERED_PATCHES = 2_000;

export interface PatchBuffer {
  push: (patches: readonly PulsePatch[]) => void;
  drain: () => PulsePatch[];
  size: () => number;
}

export function createPatchBuffer(max: number = MAX_BUFFERED_PATCHES): PatchBuffer {
  let buffer: PulsePatch[] = [];
  return {
    push(patches) {
      if (!patches.length) return;
      buffer.push(...patches);
      if (buffer.length > max) buffer = buffer.slice(buffer.length - max);
    },
    drain() {
      const out = buffer;
      buffer = [];
      return out;
    },
    size: () => buffer.length,
  };
}

const buffer = createPatchBuffer();

/** Queue readings for the next flush. */
export function enqueuePatches(patches: readonly PulsePatch[]): void {
  buffer.push(patches);
}

/** Apply all queued readings in one store update. */
export function flushPatches(): void {
  if (!buffer.size()) return;
  usePulseStore.getState().apply(buffer.drain());
}

// ---------------------------------------------------------------------------
// Visible tokens per column (read by pollers; not reactive state)
// ---------------------------------------------------------------------------

const visibleByColumn: Record<PulseColumn, readonly string[]> = { new: [], final: [], migrated: [] };

export function setVisibleMints(column: PulseColumn, mints: readonly string[]): void {
  visibleByColumn[column] = mints;
}

export function getVisibleMints(): Readonly<Record<PulseColumn, readonly string[]>> {
  return visibleByColumn;
}

export function visibleMintSet(): Set<string> {
  return new Set([...visibleByColumn.new, ...visibleByColumn.final, ...visibleByColumn.migrated]);
}
