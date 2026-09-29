'use client';

import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { INTERVALS, type Interval } from '@/lib/core/types';
import { DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS, type ChartCurrency, type QuoteSide } from '@/lib/services/token';
import { BUY_PRESET_COUNT, DEFAULT_BUY_PRESETS, normalizeBuyPresets, parsePresetInput } from './panel/amounts';

/**
 * Browser-local trade-panel and chart preferences. Slippage feeds both the
 * quote and the order the wallet signs; buy presets are the SOL amounts on
 * the preset chips (editable). Nothing here leaves the browser.
 *
 * Hydration: the store starts with defaults on the server AND on the
 * client's first render (skipHydration), so SSR markup matches; the token
 * page calls `rehydrateTradeSettings()` after mount and `hydrated` flips to
 * true once the saved values are applied (the chart waits for it, so it does
 * not spend a GeckoTerminal call on a default interval it is about to leave).
 */

export type ChartMode = 'price' | 'mc';

export interface TradeSettings {
  side: QuoteSide;
  slippageBps: number;
  /** SOL amounts on the four buy preset chips. */
  buyPresets: number[];
  interval: Interval;
  chartMode: ChartMode;
  currency: ChartCurrency;
  logScale: boolean;
  /** Saved preferences have been applied (never persisted). */
  hydrated: boolean;
  setSide: (side: QuoteSide) => void;
  setSlippageBps: (bps: number) => void;
  /** Replace one buy preset from user text; false (nothing changes) when the text is not a valid SOL amount. */
  setBuyPreset: (index: number, text: string) => boolean;
  resetBuyPresets: () => void;
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
    (set, get) => ({
      side: 'buy',
      slippageBps: DEFAULT_SLIPPAGE_BPS,
      buyPresets: [...DEFAULT_BUY_PRESETS],
      interval: '1m',
      chartMode: 'price',
      currency: 'usd',
      logScale: false,
      hydrated: false,
      setSide: (side) => set({ side }),
      setSlippageBps: (bps) => set({ slippageBps: Number.isFinite(bps) ? clampBps(bps) : DEFAULT_SLIPPAGE_BPS }),
      setBuyPreset: (index, text) => {
        const value = parsePresetInput(text);
        if (value === undefined || !Number.isInteger(index) || index < 0 || index >= BUY_PRESET_COUNT) return false;
        const next = [...get().buyPresets];
        next[index] = value;
        set({ buyPresets: normalizeBuyPresets(next) });
        return true;
      },
      resetBuyPresets: () => set({ buyPresets: [...DEFAULT_BUY_PRESETS] }),
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
        buyPresets: s.buyPresets,
        interval: s.interval,
        chartMode: s.chartMode,
        currency: s.currency,
        logScale: s.logScale,
      }),
      // Validate whatever comes back from storage (fields of older versions are dropped).
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<TradeSettings>;
        return {
          ...current,
          side: p.side === 'sell' ? 'sell' : 'buy',
          slippageBps: typeof p.slippageBps === 'number' && Number.isFinite(p.slippageBps) ? clampBps(p.slippageBps) : DEFAULT_SLIPPAGE_BPS,
          buyPresets: normalizeBuyPresets(p.buyPresets),
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
