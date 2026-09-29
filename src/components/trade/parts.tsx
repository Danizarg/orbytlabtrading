'use client';

import { Globe, Send, Star } from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import { useHydrated } from '@/client/hooks/useHydrated';
import { useNow } from '@/client/hooks/useNow';
import { MAX_WATCHLIST, usePreferences } from '@/client/store/preferences';
import { cn } from '@/components/ui/cn';
import { Skeleton } from '@/components/ui/Skeleton';
import { DASH, formatAge, formatPrice } from '@/lib/core/format';
import type { ProviderId } from '@/lib/core/providers';
import type { Freshness, Socials } from '@/lib/core/types';
import type { ChainAttempt } from '@/lib/core/chain';
import type { QuotePrice } from '@/data/hooks/useQuotePrice';
import { describeAttempt, isGecko, providerLabel, safeHttpUrl, visibleFailures } from '@/lib/services/token';

/**
 * Provenance of USD figures for trades on a pool quoted in another asset than
 * SOL or a stablecoin (e.g. "USD via GLDx $385.20 · Jupiter").
 */
export function QuotePriceNote({ quote }: { quote: QuotePrice | undefined }) {
  if (!quote) return null;
  const symbol = quote.symbol ?? 'quote asset';
  const via = quote.implied ? `implied by ${providerLabel(quote.source)} pool prices` : providerLabel(quote.source);
  return (
    <span title={`Trades on this pool are priced in ${symbol}; USD figures use ${symbol}'s live USD price (${via}).`}>
      USD via {symbol} {formatPrice(quote.priceUsd)} · {via}
    </span>
  );
}

/** Quiet em dash for unknown values (never 0). */
export function Dash() {
  return <span className="text-faint">{DASH}</span>;
}

/** Flat terminal panel (no radius: panels sit in a 1 px grid). */
export function Pane({
  title,
  actions,
  children,
  className,
  bodyClassName,
  headClassName,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  headClassName?: string;
}) {
  return (
    <section className={cn('flex min-h-0 min-w-0 flex-col bg-panel', className)}>
      {(title || actions) && (
        <header className={cn('flex h-8 shrink-0 items-center justify-between gap-2 border-b border-line px-3', headClassName)}>
          {title && <h2 className="min-w-0 truncate text-2xs font-semibold tracking-wide text-fg-dim uppercase">{title}</h2>}
          {actions && <div className="flex min-w-0 shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={cn('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  );
}

/** Label / value row for sidebar cards. */
export function KV({ label, children, title, className }: { label: ReactNode; children: ReactNode; title?: string; className?: string }) {
  return (
    <div className={cn('flex h-6 items-center justify-between gap-3 text-xs', className)} title={title}>
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 truncate text-right tabular text-fg-dim">{children}</span>
    </div>
  );
}

/** Small segmented chip (interval buttons, presets). */
export function Chip({
  active,
  disabled,
  onClick,
  title,
  children,
  className,
  tone = 'brand',
  ariaPressed,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
  tone?: 'brand' | 'up' | 'down';
  ariaPressed?: boolean;
}) {
  const activeClass = tone === 'up' ? 'bg-up-soft text-up' : tone === 'down' ? 'bg-down-soft text-down' : 'bg-brand-soft text-brand-strong';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-pressed={ariaPressed ?? active}
      className={cn(
        'inline-flex h-6 items-center justify-center gap-1 rounded px-1.5 text-2xs font-medium whitespace-nowrap transition-colors',
        active ? activeClass : 'text-muted hover:bg-hover hover:text-fg',
        disabled && 'opacity-40 hover:bg-transparent hover:text-muted',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Ticking age, isolated so only this span re-renders each second. */
export function Age({ from, prefix, className, title }: { from?: number; prefix?: string; className?: string; title?: string }) {
  const now = useNow();
  if (from === undefined) return <Dash />;
  return (
    <span className={cn('tabular', className)} title={title ?? new Date(from).toLocaleString()}>
      {now ? `${prefix ?? ''}${formatAge(from, now)}` : DASH}
    </span>
  );
}

/** "updated 4s ago" that only ticks in this span. */
export function UpdatedAgo({ at }: { at?: number }) {
  const now = useNow();
  if (!at || !now) return null;
  return <span className="tabular">updated {formatAge(at, now)} ago</span>;
}

export interface SourceLineProps {
  source?: ProviderId;
  contributors?: readonly ProviderId[];
  fetchedAt?: number;
  freshness?: Freshness;
  attempts?: readonly ChainAttempt[];
  notes?: readonly string[];
  error?: unknown;
  /** Extra text placed before the attribution. */
  extra?: ReactNode;
  className?: string;
}

/** Panel footer: provenance, age, failed providers and the GeckoTerminal attribution when its data is shown. */
export function SourceLine({ source, contributors, fetchedAt, freshness, attempts, notes, extra, className }: SourceLineProps) {
  const failures = visibleFailures(attempts);
  const showGecko = isGecko(source) || contributors?.some(isGecko);
  const names = [source, ...(contributors ?? [])].filter((p): p is ProviderId => !!p).map(providerLabel);
  return (
    <p className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1 text-2xs text-faint', className)}>
      {names.length > 0 && <span>Source: {[...new Set(names)].join(' · ')}</span>}
      {freshness === 'indexed' && <span title="Aggregator data, cached upstream">~30 s delayed</span>}
      <UpdatedAgo at={fetchedAt} />
      {extra}
      {failures.map((a) => (
        <span key={a.provider} className="text-warn" title={a.error}>
          {describeAttempt(a)}
        </span>
      ))}
      {notes?.map((n) => (
        <span key={n} title={n} className="truncate">
          {n}
        </span>
      ))}
      {showGecko && <span className="ml-auto">On-chain data powered by GeckoTerminal</span>}
    </p>
  );
}

export function ErrorLines({ lines, className }: { lines: readonly string[]; className?: string }) {
  return (
    <ul role="alert" className={cn('space-y-0.5 text-2xs text-down', className)}>
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

export function SkeletonRows({ rows, cols = 6 }: { rows: number; cols?: number }) {
  return (
    <div aria-hidden className="px-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-7 items-center gap-3 border-b border-line/50" style={{ opacity: Math.max(0.15, 1 - i * 0.1) }}>
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={cn('h-2.5', c === 0 ? 'w-10' : c === 1 ? 'w-8' : 'w-16')} />
          ))}
        </div>
      ))}
    </div>
  );
}

function XMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function SocialLinks({ socials, className }: { socials?: Socials; className?: string }) {
  const links: Array<{ href: string; label: string; icon: ReactNode }> = [];
  const twitter = safeHttpUrl(socials?.twitter);
  const telegram = safeHttpUrl(socials?.telegram);
  const website = safeHttpUrl(socials?.website);
  if (twitter) links.push({ href: twitter, label: 'X (Twitter)', icon: <XMark className="size-3" /> });
  if (telegram) links.push({ href: telegram, label: 'Telegram', icon: <Send aria-hidden className="size-3" /> });
  if (website) links.push({ href: website, label: 'Website', icon: <Globe aria-hidden className="size-3" /> });
  if (!links.length) return null;
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5', className)}>
      {links.map((l) => (
        <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer nofollow" aria-label={l.label} title={l.href} className="text-muted transition-colors hover:text-fg">
          {l.icon}
        </a>
      ))}
    </span>
  );
}

/** Watchlist toggle; hydration-safe (renders unstarred until the persisted store is ready). */
export const WatchStar = memo(function WatchStar({ mint, symbol, className }: { mint: string; symbol?: string; className?: string }) {
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
      onClick={() => {
        const added = usePreferences.getState().toggleWatch(mint);
        setFull(!on && !added);
      }}
      className={cn('inline-flex size-7 items-center justify-center rounded transition-colors hover:bg-hover', on ? 'text-warn' : 'text-faint hover:text-fg-dim', className)}
    >
      <Star aria-hidden className={cn('size-3.5', on && 'fill-current')} />
    </button>
  );
});
