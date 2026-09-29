'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { cn } from '@/components/ui/cn';
import { usePulseFilters } from '@/data/pulse/filters';
import { formatUsd } from '@/lib/core/format';
import type { PulseColumn } from '@/lib/core/types';
import { activeFilterCount, type LaunchpadFilter } from '@/lib/services/pulse';

const LAUNCHPADS: readonly TabItem<LaunchpadFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'pump', label: 'Pump' },
  { value: 'bonk', label: 'Bonk' },
  { value: 'other', label: 'Other' },
];

const MC_PRESETS = [5_000, 10_000, 30_000, 100_000] as const;

function parseUsd(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Per-column filter popover: min MC, launchpad, require socials. */
export function PulseFilterMenu({ column, title }: { column: PulseColumn; title: string }) {
  const filter = usePulseFilters((s) => s.filters[column]);
  const setFilter = usePulseFilters((s) => s.setFilter);
  const resetFilter = usePulseFilters((s) => s.resetFilter);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const count = activeFilterCount(filter);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${title} filters${count ? ` (${count} active)` : ''}`}
        title="Filters"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-6 items-center gap-1 rounded px-1.5 text-2xs font-semibold transition-colors',
          count || open ? 'bg-brand-soft text-brand-strong' : 'text-muted hover:bg-hover hover:text-fg',
        )}
      >
        <SlidersHorizontal aria-hidden className="size-3.5" strokeWidth={1.75} />
        {count > 0 && <span className="tabular">{count}</span>}
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={`${title} filters`}
          className="absolute top-full right-0 z-30 mt-1 w-64 rounded-md border border-line-strong bg-panel-2 p-3 shadow-xl shadow-black/50"
        >
          <fieldset>
            <legend className="mb-1.5 text-2xs font-semibold tracking-wide text-muted uppercase">Min market cap</legend>
            <label className="relative block">
              <span className="sr-only">Minimum market cap in USD</span>
              <span aria-hidden className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-xs text-muted">
                $
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1_000}
                placeholder="Any"
                value={filter.minMcUsd ?? ''}
                onChange={(e) => setFilter(column, { minMcUsd: parseUsd(e.target.value) })}
                className="h-7 w-full rounded border border-line bg-panel pr-2 pl-5 text-xs text-fg tabular outline-none placeholder:text-faint focus:border-brand"
              />
            </label>
            <div className="mt-1.5 flex gap-1">
              {MC_PRESETS.map((value) => {
                const active = filter.minMcUsd === value;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setFilter(column, { minMcUsd: active ? undefined : value })}
                    className={cn(
                      'h-6 flex-1 rounded text-2xs font-medium tabular transition-colors',
                      active ? 'bg-brand-soft text-brand-strong' : 'bg-panel-3 text-muted hover:bg-hover hover:text-fg',
                    )}
                  >
                    {formatUsd(value, { decimals: 0 })}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="mt-3">
            <legend className="mb-1.5 text-2xs font-semibold tracking-wide text-muted uppercase">Launchpad</legend>
            <Tabs
              items={LAUNCHPADS}
              value={filter.launchpad}
              onChange={(launchpad) => setFilter(column, { launchpad })}
              size="xs"
              ariaLabel="Launchpad"
              className="w-full [&>button]:flex-1 [&>button]:justify-center"
            />
          </fieldset>

          <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-fg-dim">
            <input
              type="checkbox"
              checked={filter.requireSocials}
              onChange={(e) => setFilter(column, { requireSocials: e.target.checked })}
              className="size-3.5 accent-brand"
            />
            Require socials (X, Telegram or website)
          </label>

          <div className="mt-3 flex items-center justify-between border-t border-line pt-2">
            <button
              type="button"
              onClick={() => resetFilter(column)}
              disabled={count === 0}
              className="text-2xs font-medium text-muted hover:text-fg disabled:opacity-40"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
              className="h-6 rounded bg-brand-soft px-2.5 text-2xs font-semibold text-brand-strong hover:bg-brand/25"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
