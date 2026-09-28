'use client';

import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { isSolanaAddress } from '@/lib/core/solana';

/**
 * Browser-local user state: watchlist, tracked wallets and the optional
 * deposit-address override. Nothing here leaves the browser.
 */

export interface TrackedWallet {
  address: string;
  label: string;
  addedAt: number;
}

export const MAX_WATCHLIST = 50;
export const MAX_TRACKED_WALLETS = 25;

interface PreferencesState {
  watchlist: string[];
  trackedWallets: TrackedWallet[];
  depositOverride: string | null;
  toggleWatch: (mint: string) => boolean;
  isWatched: (mint: string) => boolean;
  addWallet: (address: string, label?: string) => { ok: true } | { ok: false; reason: string };
  removeWallet: (address: string) => void;
  renameWallet: (address: string, label: string) => void;
  setDepositOverride: (address: string | null) => void;
}

// localStorage can throw (private mode, blocked storage); degrade to memory.
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

export const usePreferences = create<PreferencesState>()(
  persist(
    (set, get) => ({
      watchlist: [],
      trackedWallets: [],
      depositOverride: null,
      toggleWatch: (mint) => {
        if (!isSolanaAddress(mint)) return false;
        const list = get().watchlist;
        if (list.includes(mint)) {
          set({ watchlist: list.filter((m) => m !== mint) });
          return false;
        }
        if (list.length >= MAX_WATCHLIST) return false;
        set({ watchlist: [mint, ...list] });
        return true;
      },
      isWatched: (mint) => get().watchlist.includes(mint),
      addWallet: (address, label) => {
        const trimmed = address.trim();
        if (!isSolanaAddress(trimmed)) return { ok: false, reason: 'Enter a valid Solana wallet address.' };
        const wallets = get().trackedWallets;
        if (wallets.some((w) => w.address === trimmed)) return { ok: false, reason: 'This wallet is already tracked.' };
        if (wallets.length >= MAX_TRACKED_WALLETS) return { ok: false, reason: `You can track up to ${MAX_TRACKED_WALLETS} wallets.` };
        const name = (label ?? '').trim().slice(0, 32) || `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
        set({ trackedWallets: [...wallets, { address: trimmed, label: name, addedAt: Date.now() }] });
        return { ok: true };
      },
      removeWallet: (address) => set({ trackedWallets: get().trackedWallets.filter((w) => w.address !== address) }),
      renameWallet: (address, label) =>
        set({
          trackedWallets: get().trackedWallets.map((w) => (w.address === address ? { ...w, label: label.trim().slice(0, 32) || w.label } : w)),
        }),
      setDepositOverride: (address) => set({ depositOverride: address && isSolanaAddress(address) ? address : null }),
    }),
    {
      name: 'orbyt-preferences-v1',
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({ watchlist: s.watchlist, trackedWallets: s.trackedWallets, depositOverride: s.depositOverride }),
      // Validate anything read back from storage.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PreferencesState>;
        return {
          ...current,
          watchlist: Array.isArray(p.watchlist) ? p.watchlist.filter(isSolanaAddress).slice(0, MAX_WATCHLIST) : [],
          trackedWallets: Array.isArray(p.trackedWallets)
            ? p.trackedWallets
                .filter((w): w is TrackedWallet => !!w && isSolanaAddress(w.address) && typeof w.label === 'string')
                .slice(0, MAX_TRACKED_WALLETS)
            : [],
          depositOverride: typeof p.depositOverride === 'string' && isSolanaAddress(p.depositOverride) ? p.depositOverride : null,
        };
      },
    },
  ),
);
