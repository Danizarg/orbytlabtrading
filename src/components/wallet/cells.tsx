'use client';

import { Activity, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, CircleArrowDown, CircleArrowUp, MoveDownLeft, MoveUpRight, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useNow } from '@/client/hooks/useNow';
import { TokenAvatar } from '@/components/ui/TokenAvatar';
import { cn } from '@/components/ui/cn';
import { DASH, formatAge, formatAmount, formatDateTime, formatSol, formatUsd } from '@/lib/core/format';
import { shortAddress } from '@/lib/core/solana';
import type { ActivityKind, TokenIdentity } from '@/lib/core/types';
import { KIND_VIEW, type KindTone, type UsdEstimate } from '@/lib/services/wallet';

/** Quiet em dash for unknown values (never 0). */
export function Dash() {
  return <span className="text-faint">{DASH}</span>;
}

/** Local-zone "12s" age that ticks; the exact date-time is in the tooltip. */
export function TimeCell({ at, className }: { at?: number; className?: string }) {
  const now = useNow();
  if (at === undefined) return <Dash />;
  return (
    <time dateTime={new Date(at).toISOString()} title={formatDateTime(at)} className={cn('tabular text-fg-dim', className)}>
      {now ? `${formatAge(at, now)} ago` : DASH}
    </time>
  );
}

const KIND_ICON: Record<ActivityKind, LucideIcon> = {
  buy: ArrowDownLeft,
  sell: ArrowUpRight,
  swap: ArrowLeftRight,
  transfer_in: MoveDownLeft,
  transfer_out: MoveUpRight,
  sol_in: CircleArrowDown,
  sol_out: CircleArrowUp,
  other: Activity,
};

const TONE: Record<KindTone, string> = {
  up: 'bg-up-soft text-up',
  down: 'bg-down-soft text-down',
  neutral: 'bg-panel-3 text-fg-dim',
  muted: 'bg-panel-3 text-muted',
};

/** Activity kind with icon and text (colour is never the only signal). */
export function KindBadge({ kind, failed }: { kind: ActivityKind; failed?: boolean }) {
  const view = KIND_VIEW[kind];
  const Icon = KIND_ICON[kind];
  return (
    <span
      className={cn('inline-flex h-5 items-center gap-1 rounded px-1.5 text-2xs font-semibold', failed ? 'bg-panel-3 text-muted line-through' : TONE[view.tone])}
      title={failed ? `${view.label} · transaction failed` : view.label}
    >
      <Icon aria-hidden className="size-3" strokeWidth={1.75} />
      {view.label}
    </span>
  );
}

/** Token avatar + symbol linking to the trade page; falls back to the short mint. */
export function TokenCell({
  mint,
  identity,
  symbol,
  size = 20,
  className,
}: {
  mint?: string;
  identity?: TokenIdentity;
  /** Symbol reported alongside the activity, used when the identity lookup has not answered. */
  symbol?: string;
  size?: number;
  className?: string;
}) {
  if (!mint) return <Dash />;
  const sym = identity?.symbol ?? symbol;
  const name = identity?.name;
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <TokenAvatar src={identity?.image} symbol={sym ?? shortAddress(mint, 2, 0)} size={size} className="-m-1" />
      <Link
        href={`/trade/${mint}`}
        prefetch={false}
        title={name ? `${sym ?? shortAddress(mint)} · ${name} · ${mint}` : mint}
        className="min-w-0 truncate font-semibold text-fg hover:text-brand-strong"
      >
        {sym ?? <span className="font-mono font-normal text-fg-dim">{shortAddress(mint)}</span>}
      </Link>
      {name && (
        <span className="hidden min-w-0 truncate text-2xs text-muted xl:inline" title={name}>
          {name}
        </span>
      )}
    </span>
  );
}

export function AmountCell({ value, symbol, className }: { value?: number; symbol?: string; className?: string }) {
  if (value === undefined) return <Dash />;
  return (
    <span className={cn('tabular text-fg-dim', className)} title={`${value.toLocaleString('en-US', { maximumFractionDigits: 9 })}${symbol ? ` ${symbol}` : ''}`}>
      {formatAmount(value)}
    </span>
  );
}

/** Signed SOL change coloured by direction; unsigned values render neutral. */
export function SolCell({ value, signed = true, className }: { value?: number; signed?: boolean; className?: string }) {
  if (value === undefined) return <Dash />;
  const tone = !signed || value === 0 ? 'text-fg-dim' : value > 0 ? 'text-up' : 'text-down';
  const text = formatSol(Math.abs(value));
  return (
    <span className={cn('tabular', tone, className)} title={`${value.toLocaleString('en-US', { maximumFractionDigits: 9 })} SOL`}>
      {signed && value !== 0 ? (value > 0 ? '+' : '−') : ''}
      {text}
    </span>
  );
}

/** USD value: exact from the provider, or "≈" at the current SOL price (labelled). */
export function UsdCell({ estimate, className }: { estimate?: UsdEstimate; className?: string }) {
  if (!estimate) return <Dash />;
  return (
    <span
      className={cn('tabular', estimate.exact ? 'text-fg-dim' : 'text-muted', className)}
      title={estimate.exact ? 'USD value reported for this transaction' : '≈ SOL amount × current SOL price (now, not at execution time)'}
    >
      {estimate.exact ? '' : '≈'}
      {formatUsd(estimate.value)}
    </span>
  );
}

export function ProgramCell({ program }: { program?: string }) {
  if (!program) return <Dash />;
  return (
    <span className="block truncate text-fg-dim" title={program}>
      {program}
    </span>
  );
}

/** Small stat tile used by the wallet summary strip. */
export function StatTile({
  label,
  value,
  sub,
  tone,
  title,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'up' | 'down' | 'neutral';
  title?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col justify-center gap-0.5 bg-panel px-3 py-2', className)} title={title}>
      <span className="text-2xs font-medium tracking-wide text-muted uppercase">{label}</span>
      <span className={cn('truncate font-display text-sm font-semibold tabular', tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-fg')}>{value}</span>
      {sub !== undefined && <span className="truncate text-2xs tabular text-muted">{sub}</span>}
    </div>
  );
}
