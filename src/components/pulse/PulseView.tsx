'use client';

import { RotateCw, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { cn } from '@/components/ui/cn';
import { usePulseFilters } from '@/data/pulse/filters';
import { usePulseFeeds } from '@/data/pulse/usePulseFeeds';
import type { PulseColumn } from '@/lib/core/types';
import { PULSE_COLUMNS } from './columns';
import { PulseColumnPanel } from './PulseColumnPanel';
import { PulseToolbar } from './PulseToolbar';

/** Mounts every Pulse input; renders nothing, so feed state never re-renders the columns. */
function PulseFeeds() {
  usePulseFeeds();
  return null;
}

function FeedsCrashed({ onRestart }: { onRestart: () => void }) {
  return (
    <div role="alert" className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-warn-soft px-3 text-2xs text-warn">
      <TriangleAlert aria-hidden className="size-3" strokeWidth={1.75} />
      Live feeds stopped after an error. Columns show the last data received.
      <button type="button" onClick={onRestart} className="ml-auto inline-flex items-center gap-1 font-semibold hover:text-fg">
        <RotateCw aria-hidden className="size-3" strokeWidth={1.75} />
        Restart
      </button>
    </div>
  );
}

/**
 * /pulse: New Pairs · Final Stretch · Migrated. Three edge-to-edge columns on
 * desktop, a column switcher below 1024 px. Height fills the viewport under
 * the 48 px header and the 28 px status bar; each column scrolls on its own.
 */
export function PulseView() {
  const [active, setActive] = useState<PulseColumn>('new');

  useEffect(() => {
    void usePulseFilters.persist.rehydrate();
  }, []);

  return (
    <div className="flex h-[calc(100dvh-var(--shell-header-h)-var(--shell-footer-h))] min-h-[32rem] flex-col">
      <ErrorBoundary label="Pulse feeds" fallback={(reset) => <FeedsCrashed onRestart={reset} />}>
        <PulseFeeds />
      </ErrorBoundary>
      <PulseToolbar active={active} onActiveChange={setActive} />
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-line lg:grid-cols-3">
        {PULSE_COLUMNS.map((config) => {
          const visibility = config.id === active ? 'flex' : 'hidden lg:flex';
          return (
            <ErrorBoundary
              key={config.id}
              label={config.title}
              className={cn('min-h-0 flex-col items-center justify-center gap-2 bg-panel p-4 text-center', visibility)}
            >
              <PulseColumnPanel config={config} className={visibility} />
            </ErrorBoundary>
          );
        })}
      </div>
    </div>
  );
}
