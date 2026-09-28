'use client';

import { useNow } from '@/client/hooks/useNow';
import { formatAge } from '@/lib/core/format';
import { cn } from './cn';

/**
 * Makes data freshness explicit.
 * - LIVE: streaming source delivered an update within `liveWindowMs`
 * - "12s ago": polled/indexed data, with its age
 * - Delayed: last refresh failed or data is older than `staleAfterMs`
 */
export function FreshnessBadge({
  updatedAt,
  live = false,
  error,
  stale = false,
  liveWindowMs = 10_000,
  staleAfterMs = 120_000,
  className,
}: {
  updatedAt?: number | null;
  live?: boolean;
  error?: string | null;
  stale?: boolean;
  liveWindowMs?: number;
  staleAfterMs?: number;
  className?: string;
}) {
  const now = useNow();
  const age = updatedAt && now ? now - updatedAt : undefined;
  const isLive = live && age !== undefined && age <= liveWindowMs && !error;
  const delayed = !!error || stale || (age !== undefined && age > staleAfterMs);

  let label: string;
  if (!updatedAt) label = error ? 'Unavailable' : 'Connecting…';
  else if (isLive) label = 'LIVE';
  else if (!now) label = 'Updated';
  else label = `${formatAge(updatedAt, now)} ago`;

  return (
    <span
      title={error ?? (updatedAt ? new Date(updatedAt).toLocaleString() : undefined)}
      className={cn(
        'inline-flex h-5 items-center gap-1.5 rounded px-1.5 text-2xs font-semibold tracking-wide whitespace-nowrap',
        isLive ? 'bg-up-soft text-up' : delayed ? 'bg-warn-soft text-warn' : 'bg-panel-3 text-muted',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn('size-1.5 rounded-full', isLive ? 'animate-pulse-dot bg-up' : delayed ? 'bg-warn' : 'bg-faint')}
      />
      {delayed && updatedAt ? `Delayed · ${label}` : label}
    </span>
  );
}
