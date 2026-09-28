'use client';

import type { ReactNode } from 'react';
import { cn } from './cn';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  badge?: ReactNode;
}

/** Compact segmented control used for filters, intervals and panel tabs. */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  size = 'sm',
  className,
  ariaLabel,
}: {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'xs' | 'sm';
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className={cn('flex items-center gap-0.5 rounded-md bg-panel-2 p-0.5', className)}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={cn(
              'flex items-center gap-1 rounded px-2 font-medium whitespace-nowrap transition-colors',
              size === 'xs' ? 'h-6 text-2xs' : 'h-7 text-xs',
              active ? 'bg-brand-soft text-brand-strong' : 'text-muted hover:bg-hover hover:text-fg',
            )}
          >
            {item.label}
            {item.badge}
          </button>
        );
      })}
    </div>
  );
}
