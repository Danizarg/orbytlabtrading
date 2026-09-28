'use client';

import { BadgeCheck, Star, TriangleAlert, X } from 'lucide-react';
import { memo, useState } from 'react';
import { useFlash } from '@/client/hooks/useFlash';
import { useHydrated } from '@/client/hooks/useHydrated';
import { useNow } from '@/client/hooks/useNow';
import { MAX_WATCHLIST, usePreferences } from '@/client/store/preferences';
import { cn } from '@/components/ui/cn';
import { DASH, formatAge, formatCompact, formatDateTime, formatPct, formatPrice, formatUsd } from '@/lib/core/format';
import type { LaunchpadState, WindowStats } from '@/lib/core/types';
import { buyShare, launchpadBadge, riskLevel, txCount, type RiskMetric } from '@/lib/services/discover';

/** Quiet em dash for unknown values (never 0). */
export function Dash() {
  return <span className="text-faint">{DASH}</span>;
}

// Full class names so Tailwind generates them; motion-safe honours reduced motion.
const FLASH: Record<string, string> = {
  'animate-flash-up': 'motion-safe:animate-flash-up',
  'animate-flash-down': 'motion-safe:animate-flash-down',
};

/** USD price that flashes green/red when it moves between polls. */
export function PriceCell({ value }: { value?: number }) {
  const flash = useFlash(value);
  if (value === undefined) return <Dash />;
  return <span className={cn('-mr-0.5 rounded-sm px-0.5 tabular text-fg', FLASH[flash])}>{formatPrice(value)}</span>;
}

/** Ticking age; only this cell re-renders every second. */
export function AgeCell({ createdAt }: { createdAt?: number }) {
  const now = useNow();
  if (createdAt === undefined) return <Dash />;
  return (
    <span className="tabular text-fg-dim" title={`Created ${formatDateTime(createdAt)}`}>
      {now ? formatAge(createdAt, now) : DASH}
    </span>
  );
}

export function UsdCell({ value, className, title }: { value?: number; className?: string; title?: string }) {
  if (value === undefined) return <Dash />;
  return (
    <span className={cn('tabular', className)} title={title}>
      {formatUsd(value)}
    </span>
  );
}

export function CountCell({ value, className }: { value?: number; className?: string }) {
  if (value === undefined) return <Dash />;
  return (
    <span className={cn('tabular', className)} title={value.toLocaleString('en-US')}>
      {formatCompact(value)}
    </span>
  );
}

/** Buys / sells with a thin buy-share bar (text labels for screen readers; colour is not the only signal). */
export function TxnsCell({ stats }: { stats?: WindowStats }) {
  const total = txCount(stats);
  if (total === undefined) return <Dash />;
  const buys = stats?.buys ?? 0;
  const sells = stats?.sells ?? 0;
  const share = buyShare(stats);
  return (
    <span
      className="flex flex-col items-end gap-[3px]"
      title={`${buys.toLocaleString('en-US')} buys · ${sells.toLocaleString('en-US')} sells · ${total.toLocaleString('en-US')} total`}
    >
      <span aria-hidden className="tabular leading-none">
        <span className="text-up">{formatCompact(buys)}</span>
        <span className="text-faint">/</span>
        <span className="text-down">{formatCompact(sells)}</span>
      </span>
      <span aria-hidden className={cn('flex h-[3px] w-full max-w-14 overflow-hidden rounded-full', share === undefined ? 'bg-line-strong' : 'bg-down/60')}>
        {share !== undefined && <span className="h-full bg-up" style={{ width: `${share}%` }} />}
      </span>
      <span className="sr-only">
        {buys} buys, {sells} sells
      </span>
    </span>
  );
}

const RISK_CLASS = { ok: 'text-fg-dim', warn: 'text-warn', danger: 'text-down' } as const;

/** Holder-concentration share coloured by the brief's thresholds. */
export function RiskCell({ metric, value }: { metric: RiskMetric; value?: number }) {
  const level = riskLevel(metric, value);
  if (level === 'unknown') return <Dash />;
  return <span className={cn('tabular', RISK_CLASS[level])}>{formatPct(value, { signed: false, decimals: 1 })}</span>;
}

/** Launchpad badge (Pump, Bonk, DBC…) with stage and progress in the tooltip. */
export function LaunchpadChip({ launchpad }: { launchpad?: LaunchpadState }) {
  const text = launchpadBadge(launchpad?.launchpad);
  if (!launchpad || !text) return null;
  let detail: string;
  if (launchpad.stage === 'bonding') {
    detail = launchpad.progressPct !== undefined ? `bonding curve ${launchpad.progressPct.toFixed(1)}%` : 'on bonding curve';
  } else if (launchpad.stage === 'graduated') {
    detail = launchpad.graduatedAt ? `migrated ${formatDateTime(launchpad.graduatedAt)}` : 'migrated';
  } else {
    detail = launchpad.stage;
  }
  return (
    <span
      title={`${launchpad.launchpad} · ${detail}`}
      className={cn(
        'shrink-0 rounded-sm border px-1 text-2xs leading-[14px] font-medium',
        launchpad.stage === 'bonding' ? 'border-line-strong text-fg-dim' : 'border-line text-muted',
      )}
    >
      {text}
    </span>
  );
}

export function VerifiedMark() {
  return (
    <span title="Verified on Jupiter" className="inline-flex shrink-0 text-info">
      <BadgeCheck aria-hidden className="size-3" />
      <span className="sr-only">Verified</span>
    </span>
  );
}

/** Warning mark listing raised flags (active authorities, provider suspicious flag). */
export function FlagMark({ reasons }: { reasons: readonly string[] }) {
  if (!reasons.length) return null;
  const text = reasons.join(' · ');
  return (
    <span title={text} className="inline-flex shrink-0 text-warn">
      <TriangleAlert aria-hidden className="size-3" />
      <span className="sr-only">{text}</span>
    </span>
  );
}

/** Watchlist toggle. Hydration-safe: renders unstarred until the persisted store is available. */
export const WatchStar = memo(function WatchStar({ mint, symbol }: { mint: string; symbol?: string }) {
  const hydrated = useHydrated();
  const watched = usePreferences((s) => s.watchlist.includes(mint));
  const [full, setFull] = useState(false);
  const on = hydrated && watched;
  const name = symbol ?? 'token';
  const label = on ? `Remove ${name} from watchlist` : `Add ${name} to watchlist`;
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={full && !on ? `Watchlist is full (${MAX_WATCHLIST} tokens)` : label}
      onClick={(e) => {
        e.stopPropagation();
        const added = usePreferences.getState().toggleWatch(mint);
        setFull(!on && !added);
      }}
      className={cn(
        'inline-flex size-6 items-center justify-center rounded transition-colors hover:bg-panel-3',
        on ? 'text-warn' : 'text-faint hover:text-fg-dim',
      )}
    >
      <Star aria-hidden className={cn('size-3.5', on && 'fill-current')} />
    </button>
  );
});

export const RemoveButton = memo(function RemoveButton({ mint, symbol }: { mint: string; symbol?: string }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${symbol ?? 'token'} from watchlist`}
      title="Remove from watchlist"
      onClick={(e) => {
        e.stopPropagation();
        const prefs = usePreferences.getState();
        if (prefs.watchlist.includes(mint)) prefs.toggleWatch(mint);
      }}
      className="inline-flex size-6 items-center justify-center rounded text-faint transition-colors hover:bg-panel-3 hover:text-down"
    >
      <X aria-hidden className="size-3.5" />
    </button>
  );
});
