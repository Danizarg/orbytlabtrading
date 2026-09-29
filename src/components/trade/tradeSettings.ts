'use client';

import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { INTERVALS, type Interval } from '@/lib/core/types';
import { DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS, type ChartCurrency, type QuoteSide } from '@/lib/services/token';

/**
 * Browser-local trade-panel and chart preferences. Slippage feeds the quote
 * request; priority fee and MEV protection describe what the user intends to
 * set in their wallet / Jupiter (the swap link cannot carry them). Nothing
 * here leaves the browser.
 *
 * Hydration: the store starts with defaults on the server AND on the
 * client's first render (skipHydration), so SSR markup matches; the token
 * page calls `rehydrateTradeSettings()` after mount and `hydrated` flips to
 * true once the saved values are applied (the chart waits for it, so it does
 * not spend a GeckoTerminal call on a default interval it is about to leave).
 */

export type ChartMode = 'price' | 'mc';
export type OrderMode = 'market' | 'limit';

export interface TradeSettings {
  side: QuoteSide;
  orderMode: OrderMode;
  slippageBps: number;
  /** Priority fee the user intends to pay, SOL (informational). */
  priorityFeeSol: string;
  mevProtection: boolean;
  advancedOpen: boolean;
  interval: Interval;
  chartMode: ChartMode;
  currency: ChartCurrency;
  logScale: boolean;
  /** Saved preferences have been applied (never persisted). */
  hydrated: boolean;
  setSide: (side: QuoteSide) => void;
  setOrderMode: (mode: OrderMode) => void;
  setSlippageBps: (bps: number) => void;
  setPriorityFeeSol: (value: string) => void;
  setMevProtection: (on: boolean) => void;
  setAdvancedOpen: (open: boolean) => void;
  setInterval: (interval: Interval) => void;
  setChartMode: (mode: ChartMode) => void;
  setCurrency: (currency: ChartCurrency) => void;
  setLogScale: (on: boolean) => void;
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

const clampBps = (bps: number) => Math.min(MAX_SLIPPAGE_BPS, Math.max(MIN_SLIPPAGE_BPS, Math.round(bps)));

export const useTradeSettings = create<TradeSettings>()(
  persist(
    (set) => ({
      side: 'buy',
      orderMode: 'market',
      slippageBps: DEFAULT_SLIPPAGE_BPS,
      priorityFeeSol: '0.001',
      mevProtection: false,
      advancedOpen: false,
      interval: '1m',
      chartMode: 'price',
      currency: 'usd',
      logScale: false,
      hydrated: false,
      setSide: (side) => set({ side }),
      setOrderMode: (orderMode) => set({ orderMode }),
      setSlippageBps: (bps) => set({ slippageBps: Number.isFinite(bps) ? clampBps(bps) : DEFAULT_SLIPPAGE_BPS }),
      setPriorityFeeSol: (priorityFeeSol) => set({ priorityFeeSol: priorityFeeSol.slice(0, 12) }),
      setMevProtection: (mevProtection) => set({ mevProtection }),
      setAdvancedOpen: (advancedOpen) => set({ advancedOpen }),
      setInterval: (interval) => set({ interval }),
      setChartMode: (chartMode) => set({ chartMode }),
      setCurrency: (currency) => set({ currency }),
      setLogScale: (logScale) => set({ logScale }),
    }),
    {
      name: 'orbyt-trade-settings-v1',
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      skipHydration: true,
      onRehydrateStorage: () => () => useTradeSettings.setState({ hydrated: true }),
      partialize: (s) => ({
        side: s.side,
        slippageBps: s.slippageBps,
        priorityFeeSol: s.priorityFeeSol,
        mevProtection: s.mevProtection,
        advancedOpen: s.advancedOpen,
        interval: s.interval,
        chartMode: s.chartMode,
        currency: s.currency,
        logScale: s.logScale,
      }),
      // Validate whatever comes back from storage.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<TradeSettings>;
        return {
          ...current,
          side: p.side === 'sell' ? 'sell' : 'buy',
          slippageBps: typeof p.slippageBps === 'number' && Number.isFinite(p.slippageBps) ? clampBps(p.slippageBps) : DEFAULT_SLIPPAGE_BPS,
          priorityFeeSol: typeof p.priorityFeeSol === 'string' ? p.priorityFeeSol.slice(0, 12) : current.priorityFeeSol,
          mevProtection: p.mevProtection === true,
          advancedOpen: p.advancedOpen === true,
          interval: INTERVALS.includes(p.interval as Interval) ? (p.interval as Interval) : current.interval,
          chartMode: p.chartMode === 'mc' ? 'mc' : 'price',
          currency: p.currency === 'sol' ? 'sol' : 'usd',
          logScale: p.logScale === true,
        };
      },
    },
  ),
);

/** Apply the saved preferences once, after mount (see the hydration note above). */
export function rehydrateTradeSettings(): void {
  if (useTradeSettings.getState().hydrated) return;
  void useTradeSettings.persist.rehydrate();
}
