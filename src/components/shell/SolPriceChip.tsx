'use client';

import { useFlash } from '@/client/hooks/useFlash';
import { useNow } from '@/client/hooks/useNow';
import { Change } from '@/components/ui/Change';
import { cn } from '@/components/ui/cn';
import { Skeleton } from '@/components/ui/Skeleton';
import { useSolPrice } from '@/data/hooks/useSolPrice';
import { formatAge, formatUsd } from '@/lib/core/format';
import { PROVIDER_LABELS } from '@/lib/core/providers';
import { describeError } from '@/lib/net/errors';

/** Older than this, the price is flagged as delayed (it refreshes every 30 s). */
const STALE_AFTER_MS = 120_000;

/**
 * ◎ $price ±24h%. Polled (Jupiter Price V3, GeckoTerminal fallback), so it is
 * never labelled LIVE: the title carries the source and age, and a warn dot
 * marks a failed refresh or data older than two minutes.
 */
export function SolPriceChip({
  className,
  variant = 'chip',
}: {
  /** Include the display utility (e.g. "hidden sm:flex"); defaults to "flex". */
  className?: string;
  /** `chip` for the header, `bare` for inline use in the status bar. */
  variant?: 'chip' | 'bare';
}) {
  const { data, error, isPending } = useSolPrice();
  const now = useNow();
  const price = data?.data.priceUsd;
  const change = data?.data.change24hPct;
  const flash = useFlash(price);

  const updatedAt = data?.fetchedAt;
  const age = updatedAt && now ? now - updatedAt : undefined;
  const delayed = !!error || (age !== undefined && age > STALE_AFTER_MS);

  let title: string;
  if (data) {
    const parts = [`SOL/USD · ${PROVIDER_LABELS[data.source] ?? data.source}`];
    if (updatedAt && now) parts.push(`updated ${formatAge(updatedAt, now)} ago`);
    if (error) parts.push(`last refresh failed: ${describeError(error)}`);
    title = parts.join(' · ');
  } else {
    title = error ? `SOL price unavailable: ${describeError(error)}` : 'Loading SOL price';
  }

  const loading = price === undefined && isPending && !error;

  return (
    <span
      title={title}
      className={cn(
        'shrink-0 items-center gap-1.5',
        variant === 'chip' ? 'h-7 rounded-md border border-line bg-panel-2 px-2 text-xs' : 'text-2xs',
        className ?? 'flex',
      )}
    >
      <span aria-hidden className="text-muted">
        ◎
      </span>
      <span className="sr-only">SOL price</span>
      {price !== undefined ? (
        <span className={cn('tabular rounded-sm font-semibold text-fg', flash)}>{formatUsd(price, { compact: false })}</span>
      ) : loading ? (
        <>
          <Skeleton className="h-3 w-12" />
          <span className="sr-only">loading</span>
        </>
      ) : (
        <span className="text-faint">
          —<span className="sr-only"> unavailable</span>
        </span>
      )}
      {price !== undefined && (
        <>
          <Change value={change} className="text-2xs font-medium" />
          <span className="sr-only">24h</span>
        </>
      )}
      {delayed && (
        <>
          <span aria-hidden className="size-1.5 rounded-full bg-warn" />
          <span className="sr-only">{error ? '(last refresh failed)' : '(delayed)'}</span>
        </>
      )}
    </span>
  );
}
