'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PulseColumn } from '@/lib/core/types';
import { activeFilterCount, applyPause, inColumn, selectColumn, type PulseFilter, type PulseItem } from '@/lib/services/pulse';
import { usePulseFilters } from './filters';
import { setVisibleMints, usePulseStore } from './store';
import { usePulseClock } from './timers';

export interface PulseColumnView {
  /** Tokens to render, in display order. */
  shown: PulseItem[];
  /** Live tokens waiting while the column is paused. */
  queued: number;
  paused: boolean;
  /** The column is empty only because of the user's filters. */
  hiddenByFilter: boolean;
  filter: PulseFilter;
  /** Freeze the current order (hover / keyboard focus / scrolled down). */
  pause: () => void;
  resume: () => void;
}

/**
 * One Pulse column: selection from the shared store (filter before cap),
 * hover-pause, and registration of the rendered mints so pollers enrich and
 * read on-chain state for exactly what the user sees.
 */
export function usePulseColumn(column: PulseColumn, solPriceUsd: number | undefined): PulseColumnView {
  const items = usePulseStore((s) => s.items);
  const filter = usePulseFilters((s) => s.filters[column]);
  const clock = usePulseClock();

  const live = useMemo(
    () => (clock ? selectColumn(column, items.values(), clock, { filter, solPriceUsd }) : []),
    [column, items, clock, filter, solPriceUsd],
  );

  const hiddenByFilter = useMemo(() => {
    if (live.length || !clock || activeFilterCount(filter) === 0) return false;
    for (const item of items.values()) if (inColumn(column, item, clock)) return true;
    return false;
  }, [live.length, clock, filter, items, column]);

  const [frozen, setFrozen] = useState<readonly string[] | null>(null);
  const view = useMemo(() => (frozen ? applyPause(frozen, live, items) : { shown: live, queued: 0 }), [frozen, live, items]);

  const mintsKey = view.shown.map((item) => item.mint).join(',');
  useEffect(() => {
    setVisibleMints(column, mintsKey ? mintsKey.split(',') : []);
  }, [column, mintsKey]);
  useEffect(() => () => setVisibleMints(column, []), [column]);

  const pause = useCallback(() => setFrozen((prev) => prev ?? (mintsKey ? mintsKey.split(',') : [])), [mintsKey]);
  const resume = useCallback(() => setFrozen(null), []);

  return { shown: view.shown, queued: view.queued, paused: frozen !== null, hiddenByFilter, filter, pause, resume };
}
