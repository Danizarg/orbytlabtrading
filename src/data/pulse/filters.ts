import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import type { PulseColumn } from '@/lib/core/types';
import { DEFAULT_PULSE_FILTER, sanitizeFilter, type PulseFilter } from '@/lib/services/pulse';

/**
 * Per-column Pulse filters, remembered in this browser only. Hydration is
 * skipped at creation and triggered after mount (PulseView) so the server
 * render and the first client render agree.
 */

type ColumnFilters = Record<PulseColumn, PulseFilter>;

interface PulseFiltersState {
  filters: ColumnFilters;
  setFilter: (column: PulseColumn, patch: Partial<PulseFilter>) => void;
  resetFilter: (column: PulseColumn) => void;
}

const DEFAULTS: ColumnFilters = { new: DEFAULT_PULSE_FILTER, final: DEFAULT_PULSE_FILTER, migrated: DEFAULT_PULSE_FILTER };

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

export const usePulseFilters = create<PulseFiltersState>()(
  persist(
    (set) => ({
      filters: DEFAULTS,
      setFilter: (column, patch) =>
        set((s) => ({ filters: { ...s.filters, [column]: sanitizeFilter({ ...s.filters[column], ...patch }) } })),
      resetFilter: (column) => set((s) => ({ filters: { ...s.filters, [column]: DEFAULT_PULSE_FILTER } })),
    }),
    {
      name: 'orbyt-pulse-filters-v1',
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      skipHydration: true,
      partialize: (s) => ({ filters: s.filters }),
      merge: (persisted, current) => {
        const raw = (persisted as { filters?: Partial<Record<PulseColumn, unknown>> } | undefined)?.filters ?? {};
        return {
          ...current,
          filters: { new: sanitizeFilter(raw.new), final: sanitizeFilter(raw.final), migrated: sanitizeFilter(raw.migrated) },
        };
      },
    },
  ),
);
