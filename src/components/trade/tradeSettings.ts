'use client';

import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { INTERVALS, type Interval } from '@/lib/core/types';
import { DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS, type QuoteSide } from '@/lib/services/token';

/**
 * Browser-local trade-panel and chart preferences. Purely presentational:
 * ORBYT never signs or submits anything, so slippage, priority fee and MEV
 * protection only describe what the user intends to set in their wallet /
 * Jupiter. Nothing here leaves the browser.
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
  logScale: boolean;
  setSide: (side: QuoteSide) => void;
  setOrderMode: (mode: OrderMode) => void;
  setSlippageBps: (bps: number) => void;
  setPriorityFeeSol: (value: string) => void;
  setMevProtection: (on: boolean) => void;
  setAdvancedOpen: (open: boolean) => void;
  setInterval: (interval: Interval) => void;
  setChartMode: (mode: ChartMode) => void;
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
      logScale: false,
      setSide: (side) => set({ side }),
      setOrderMode: (orderMode) => set({ orderMode }),
      setSlippageBps: (bps) => set({ slippageBps: Number.isFinite(bps) ? clampBps(bps) : DEFAULT_SLIPPAGE_BPS }),
      setPriorityFeeSol: (priorityFeeSol) => set({ priorityFeeSol: priorityFeeSol.slice(0, 12) }),
      setMevProtection: (mevProtection) => set({ mevProtection }),
      setAdvancedOpen: (advancedOpen) => set({ advancedOpen }),
      setInterval: (interval) => set({ interval }),
      setChartMode: (chartMode) => set({ chartMode }),
      setLogScale: (logScale) => set({ logScale }),
    }),
    {
      name: 'orbyt-trade-settings-v1',
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({
        side: s.side,
        slippageBps: s.slippageBps,
        priorityFeeSol: s.priorityFeeSol,
        mevProtection: s.mevProtection,
        advancedOpen: s.advancedOpen,
        interval: s.interval,
        chartMode: s.chartMode,
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
          logScale: p.logScale === true,
        };
      },
    },
  ),
);
