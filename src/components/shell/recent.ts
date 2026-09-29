'use client';

import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { isSolanaAddress } from '@/lib/core/solana';

/**
 * Tokens this browser opened from search (identity only, never prices).
 * Stored locally; nothing leaves the browser.
 */

export interface RecentToken {
  mint: string;
  symbol?: string;
  name?: string;
  image?: string;
  openedAt: number;
}

export const MAX_RECENT = 6;

/** Most recent first, one entry per mint. */
export function pushRecent(list: readonly RecentToken[], entry: RecentToken, max = MAX_RECENT): RecentToken[] {
  if (!isSolanaAddress(entry.mint)) return [...list];
  return [entry, ...list.filter((e) => e.mint !== entry.mint)].slice(0, max);
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Validate untrusted persisted entries (localStorage can hold anything). */
export function sanitizeRecent(value: unknown, max = MAX_RECENT): RecentToken[] {
  if (!Array.isArray(value)) return [];
  const out: RecentToken[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (!isSolanaAddress(r.mint) || seen.has(r.mint)) continue;
    const openedAt = typeof r.openedAt === 'number' && Number.isFinite(r.openedAt) ? r.openedAt : 0;
    const entry: RecentToken = { mint: r.mint, openedAt };
    const symbol = str(r.symbol, 32);
    const name = str(r.name, 80);
    const image = str(r.image, 512);
    if (symbol) entry.symbol = symbol;
    if (name) entry.name = name;
    if (image) entry.image = image;
    seen.add(r.mint);
    out.push(entry);
    if (out.length >= max) break;
  }
  return out;
}

const memory = new Map<string, string>();
const safeStorage: StateStorage = {
  getItem: (name) => {
    try {
      return window.localStorage.getItem(name);
    } catch {
      return memory.get(name) ?? null;
    }
  },
  setItem: (name, value) => {
    try {
      window.localStorage.setItem(name, value);
    } catch {
      memory.set(name, value);
    }
  },
  removeItem: (name) => {
    try {
      window.localStorage.removeItem(name);
    } catch {
      memory.delete(name);
    }
  },
};

interface RecentState {
  items: RecentToken[];
  add: (entry: Omit<RecentToken, 'openedAt'>) => void;
  clear: () => void;
}

export const useRecentSearches = create<RecentState>()(
  persist(
    (set) => ({
      items: [],
      add: (entry) => set((s) => ({ items: pushRecent(s.items, { ...entry, openedAt: Date.now() }) })),
      clear: () => set({ items: [] }),
    }),
    {
      name: 'orbyt-recent-search-v1',
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({ items: s.items }),
      merge: (persisted, current) => ({ ...current, items: sanitizeRecent((persisted as { items?: unknown } | undefined)?.items) }),
    },
  ),
);
