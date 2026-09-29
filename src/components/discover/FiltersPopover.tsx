'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/components/ui/cn';
import {
  activeFilterCount,
  AGE_PRESETS,
  CLEAR_FILTERS,
  formatUsdInput,
  parseUsdInput,
  STAGE_FILTERS,
  type DiscoverFilters,
} from '@/lib/services/discover';

/**
 * "$" amount input that accepts 10k / 1.5m shorthand; empty = no minimum.
 * Initialised from the filter on mount; the popover remounts it on Reset, so
 * in-progress typing is never overwritten by a URL update.
 */
function UsdInput({ id, label, value, onChange }: { id: string; label: string; value?: number; onChange: (v: number | undefined) => void }) {
  const [text, setText] = useState(() => formatUsdInput(value));
  const invalid = text.trim() !== '' && parseUsdInput(text) === undefined;
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-2xs text-muted">
        {label}
      </label>
      <span
        className={cn(
          'flex h-7 w-32 items-center rounded-md border bg-panel-2 px-2 focus-within:border-brand',
          invalid ? 'border-down' : 'border-line-strong',
        )}
      >
        <span aria-hidden className="text-2xs text-faint">
          $
        </span>
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="Any"
          value={text}
          aria-invalid={invalid || undefined}
          onChange={(e) => {
            setText(e.target.value);
            const next = parseUsdInput(e.target.value);
            if (e.target.value.trim() === '' || next !== undefined) onChange(next);
          }}
          className="w-full min-w-0 bg-transparent pl-1 text-right text-xs tabular text-fg outline-none placeholder:text-faint"
        />
      </span>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-2xs text-muted">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
        {items.map((item) => {
          const active = item.value === value;
          return (
            <button
              key={item.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(item.value)}
              className={cn(
                'h-6 rounded border px-2 text-2xs font-medium transition-colors',
                active ? 'border-brand/50 bg-brand-soft text-brand-strong' : 'border-line-strong text-muted hover:bg-hover hover:text-fg',
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const AGE_ITEMS = [{ value: 'any', label: 'Any' }, ...AGE_PRESETS.map((p) => ({ value: p.value, label: p.label }))];

/** Panel width (w-72) and the minimum gap to the viewport edge (matches max-w-[calc(100vw-24px)]). */
const PANEL_WIDTH = 288;
const PANEL_GUTTER = 12;

/** Left offset (≤ 0) from the button that keeps the whole panel on screen at phone widths. */
function panelShift(buttonLeft: number, viewportWidth: number): number {
  const width = Math.min(PANEL_WIDTH, viewportWidth - 2 * PANEL_GUTTER);
  return Math.min(0, viewportWidth - PANEL_GUTTER - width - buttonLeft);
}

/** Filters button + popover (min liquidity, min MC, max age, launch stage, hide flagged). Emits partial patches. */
export function FiltersPopover({ value, onChange }: { value: DiscoverFilters; onChange: (patch: Partial<DiscoverFilters>) => void }) {
  const [open, setOpen] = useState(false);
  // Horizontal shift (px, ≤ 0) that keeps the panel inside a narrow viewport.
  const [shift, setShift] = useState(0);
  const [resetCount, setResetCount] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const count = activeFilterCount(value);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect();
          if (!open && rect) setShift(panelShift(rect.left, window.innerWidth));
          setOpen((o) => !o);
        }}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors',
          count ? 'border-brand/40 text-brand-strong' : 'border-line-strong text-muted hover:bg-hover hover:text-fg',
          open && 'bg-hover',
        )}
      >
        <SlidersHorizontal aria-hidden className="size-3.5" strokeWidth={1.75} />
        Filters
        {count > 0 && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded bg-brand-soft px-1 text-2xs tabular text-brand-strong">{count}</span>
        )}
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Filters"
          style={{ left: shift }}
          className="absolute top-full z-50 mt-1 flex w-72 max-w-[calc(100vw-24px)] flex-col gap-3 rounded-lg border border-line-strong bg-panel-2 p-3 shadow-lg"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-fg">Filters</span>
            <button
              type="button"
              disabled={!count}
              onClick={() => {
                onChange(CLEAR_FILTERS);
                setResetCount((n) => n + 1);
              }}
              className="text-2xs text-muted hover:text-fg disabled:opacity-40 disabled:hover:text-muted"
            >
              Reset
            </button>
          </div>
          <UsdInput key={`liq-${resetCount}`} id={`${panelId}-liq`} label="Min liquidity" value={value.minLiquidityUsd} onChange={(v) => onChange({ minLiquidityUsd: v })} />
          <UsdInput key={`mc-${resetCount}`} id={`${panelId}-mc`} label="Min market cap" value={value.minMarketCapUsd} onChange={(v) => onChange({ minMarketCapUsd: v })} />
          <Segmented
            label="Max age"
            items={AGE_ITEMS}
            value={value.maxAge ?? 'any'}
            onChange={(v) => onChange({ maxAge: v === 'any' ? undefined : v })}
          />
          <Segmented label="Launch stage" items={STAGE_FILTERS} value={value.stage} onChange={(v) => onChange({ stage: v })} />
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={value.hideFlagged}
              onChange={(e) => onChange({ hideFlagged: e.target.checked })}
              className="mt-0.5 size-3.5 accent-brand"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-xs text-fg-dim">Hide flagged tokens</span>
              <span className="text-2xs text-faint">Active mint or freeze authority, or flagged suspicious by the provider</span>
            </span>
          </label>
          <p className="border-t border-line pt-2 text-2xs text-faint">A bound on a metric the provider did not report hides that token.</p>
        </div>
      )}
    </div>
  );
}
