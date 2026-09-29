'use client';

import { Boxes, ChefHat, Coins, Crosshair, Droplets, Ghost, Globe, Send, UserStar, Users, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { memo, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { useCapabilities } from '@/client/capabilities';
import { useFlash } from '@/client/hooks/useFlash';
import { useNow } from '@/client/hooks/useNow';
import { CopyButton } from '@/components/ui/CopyButton';
import { TokenAvatar } from '@/components/ui/TokenAvatar';
import { cn } from '@/components/ui/cn';
import { prefetchTokenPage } from '@/data/hooks/useTokenOverview';
import { DASH, formatAge, formatAmount, formatCompact, formatDateTime, formatPct, formatUsd } from '@/lib/core/format';
import { shortAddress } from '@/lib/core/solana';
import type { PulseColumn, Socials } from '@/lib/core/types';
import { launchpadShort, pulseTime, sameCardData, type PulseItem } from '@/lib/services/pulse';

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function pctText(value: number): string {
  return formatPct(value, { signed: false, decimals: value === 0 || value >= 10 ? 0 : 1 });
}

/** Live-ticking age; only this span re-renders every second. */
function Age({ from, approx, className, title }: { from?: number; approx?: boolean; className?: string; title?: string }) {
  const now = useNow();
  return (
    <span className={cn('tabular', className)} title={title}>
      {now && from !== undefined ? `${approx ? '≈' : ''}${formatAge(from, now)}` : DASH}
    </span>
  );
}

function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function XMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function SocialLinks({ socials }: { socials?: Socials }) {
  const candidates: Array<{ href: string | undefined; label: string; icon: ReactNode }> = [
    { href: safeHref(socials?.twitter), label: 'X (Twitter)', icon: <XMark className="size-3" /> },
    { href: safeHref(socials?.telegram), label: 'Telegram', icon: <Send aria-hidden className="size-3" /> },
    { href: safeHref(socials?.website), label: 'Website', icon: <Globe aria-hidden className="size-3" /> },
  ];
  const links = candidates.filter((l): l is { href: string; label: string; icon: ReactNode } => !!l.href);
  if (!links.length) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {links.map((l) => (
        <a
          key={l.label}
          href={l.href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          aria-label={l.label}
          title={l.href}
          className="text-muted transition-colors hover:text-fg"
        >
          {l.icon}
        </a>
      ))}
    </span>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  warnAbove,
  dangerAbove,
}: {
  icon: LucideIcon;
  label: string;
  value: number | undefined;
  warnAbove: number;
  dangerAbove?: number;
}) {
  const tone =
    value === undefined
      ? 'text-faint'
      : dangerAbove !== undefined && value > dangerAbove
        ? 'text-down'
        : value > warnAbove
          ? 'text-warn'
          : 'text-fg-dim';
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-0.5 tabular', tone)} title={`${label}: ${value === undefined ? 'unknown' : pctText(value)}`}>
      <Icon aria-hidden className="size-3 opacity-80" />
      <span className="sr-only">{label}</span>
      {value === undefined ? DASH : pctText(value)}
    </span>
  );
}

function Progress({ pct, complete }: { pct?: number; complete?: boolean }) {
  if (complete) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-warn" title="Bonding curve complete; migration pending">
        <span className="h-1 w-10 rounded-full bg-warn" />
        Complete
      </span>
    );
  }
  if (pct === undefined) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-faint" title="Bonding progress not reported yet">
        <span className="h-1 w-10 rounded-full bg-line-strong" />
        {DASH}
      </span>
    );
  }
  const hot = pct >= 85;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5" title={`Bonding curve ${pct.toFixed(2)}% complete`}>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-line-strong">
        <span className={cn('block h-full rounded-full', hot ? 'bg-warn' : 'bg-up')} style={{ width: `${pct}%` }} />
      </span>
      <span className={cn('tabular font-medium', hot ? 'text-warn' : 'text-fg-dim')}>{pct >= 99.95 ? '100' : pct.toFixed(1)}%</span>
    </span>
  );
}

const FLASH_CLASS: Record<string, string> = {
  'animate-flash-up': 'motion-safe:animate-flash-up',
  'animate-flash-down': 'motion-safe:animate-flash-down',
};

/** The pointer must rest on a card this long before its token data is prefetched (a sweep across the column costs nothing). */
const HOVER_INTENT_MS = 150;

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export interface PulseCardProps {
  item: PulseItem;
  column: PulseColumn;
  /** Market cap in USD (SOL readings converted by the column). */
  mcUsd?: number;
  /** Slide in on mount (tokens that arrive after the column first rendered). */
  animateIn: boolean;
}

function PulseCardView({ item, column, mcUsd, animateIn }: PulseCardProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [animate] = useState(animateIn);
  const flash = FLASH_CLASS[useFlash(mcUsd)] ?? '';
  const href = `/trade/${item.mint}`;
  const lp = item.launchpad;
  const migrated = column === 'migrated';
  const progress = lp.stage === 'bonding' ? lp.progressPct : undefined;
  const symbol = item.symbol ?? shortAddress(item.mint);
  const risk = item.risk ?? {};
  const badge = launchpadShort(lp.launchpad);
  const created = pulseTime(item);
  const createdTitle = item.createdAtApprox
    ? `Detected ${formatDateTime(created)} (PumpPortal receipt, within ~1 s of the create transaction)`
    : `Created ${formatDateTime(created)}`;

  const open = (event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('a,button,input,label')) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) {
      window.open(href, '_blank', 'noopener');
      return;
    }
    if (event.button === 0) router.push(href);
  };

  // Prefetch on hover only: New Pairs churns every few seconds, so viewport
  // prefetching would hit the route for cards nobody opens. The route is
  // prefetched at once; the token page queries (same keys as /trade/[mint])
  // wait for hover intent because each warm-up spends keyless budget.
  const onPointerEnter = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'mouse') return;
    router.prefetch(href);
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => prefetchTokenPage(queryClient, item.mint, capabilities), HOVER_INTENT_MS);
  };
  const onPointerLeave = () => clearTimeout(hoverTimer.current);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  return (
    <article
      onClick={open}
      onAuxClick={open}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={cn(
        'relative flex cursor-pointer flex-col gap-1.5 border-b border-line px-3 py-2 transition-colors duration-150 hover:bg-hover/60',
        animate && 'motion-safe:animate-slide-in',
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <TokenAvatar src={item.image} symbol={item.symbol} size={40} progress={migrated ? undefined : progress} />

        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <Link
              href={href}
              prefetch={false}
              title={item.name ? `${item.name} (${symbol})` : symbol}
              className="max-w-[55%] shrink-0 truncate text-[13px] leading-4 font-semibold text-fg hover:text-brand-strong"
            >
              {symbol}
            </Link>
            {item.name && (
              <span className="min-w-0 truncate text-xs leading-4 text-muted" title={item.name}>
                {item.name}
              </span>
            )}
          </div>

          <div className="mt-1 flex h-4 min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-muted">
            {migrated ? (
              <span className="inline-flex shrink-0 items-center gap-1" title={lp.graduatedAt ? `Migrated ${formatDateTime(lp.graduatedAt)}` : undefined}>
                <span>migrated</span>
                <Age from={lp.graduatedAt} approx={item.graduatedAtApprox} className="font-medium text-fg-dim" />
                <span>ago</span>
              </span>
            ) : (
              <Age from={created} className="shrink-0 font-medium text-fg-dim" title={createdTitle} />
            )}
            {migrated
              ? item.migratedDex && (
                  <>
                    <span aria-hidden className="text-faint">
                      ·
                    </span>
                    <span className="shrink-0 font-medium text-fg-dim">{item.migratedDex}</span>
                  </>
                )
              : badge && (
                  <span className="shrink-0 rounded-sm bg-panel-3 px-1 leading-4 font-medium text-fg-dim" title={`Launchpad: ${lp.launchpad}`}>
                    {badge}
                  </span>
                )}
            <SocialLinks socials={item.socials} />
          </div>

          <div className="mt-0.5 flex h-4 min-w-0 items-center gap-2 overflow-hidden text-2xs text-muted">
            <span className="inline-flex shrink-0 items-center gap-0.5 font-mono">
              <span title={item.mint}>{shortAddress(item.mint, 4, 4)}</span>
              <CopyButton value={item.mint} label="Copy mint address" className="size-4" />
            </span>
            {item.creator && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <span className="text-faint">Dev</span>
                <Link
                  href={`/wallet/${item.creator}`}
                  prefetch={false}
                  title={`Creator ${item.creator}`}
                  className="truncate font-mono text-fg-dim hover:text-brand-strong hover:underline"
                >
                  {shortAddress(item.creator, 4, 4)}
                </Link>
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-0.5 pt-0.5 text-right">
          <div className={cn('-mx-1 rounded px-1 leading-4', flash)}>
            <span className="mr-1 text-2xs text-muted">MC</span>
            <span className="font-display text-sm font-semibold text-fg tabular">{formatUsd(mcUsd)}</span>
          </div>
          <div className="text-2xs leading-4">
            <span className="text-muted">V</span> <span className="text-fg-dim tabular">{formatUsd(item.volumeUsd)}</span>
          </div>
          <div className="flex items-center gap-2 text-2xs leading-4">
            <span title={`24h: ${item.txns?.buys ?? 'unknown'} buys / ${item.txns?.sells ?? 'unknown'} sells`}>
              <span className="text-muted">TX</span>{' '}
              <span className={cn('tabular', item.txns?.buys === undefined ? 'text-faint' : 'text-up')}>{formatCompact(item.txns?.buys)}</span>
              <span className="text-faint">/</span>
              <span className={cn('tabular', item.txns?.sells === undefined ? 'text-faint' : 'text-down')}>{formatCompact(item.txns?.sells)}</span>
            </span>
            <span className="inline-flex items-center gap-0.5 text-fg-dim" title={`Holders: ${item.holders ?? 'unknown'}`}>
              <Users aria-hidden className="size-3 text-muted" />
              <span className="sr-only">Holders</span>
              <span className={cn('tabular', item.holders === undefined && 'text-faint')}>{formatCompact(item.holders)}</span>
            </span>
          </div>
        </div>
      </div>

      <div className="flex h-4 min-w-0 items-center gap-3 overflow-hidden text-2xs">
        {migrated ? (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-fg-dim tabular" title="Liquidity">
            <Droplets aria-hidden className="size-3 opacity-80" />
            <span className="sr-only">Liquidity</span>
            <span className={cn(item.liquidityUsd === undefined && 'text-faint')}>{formatUsd(item.liquidityUsd)}</span>
          </span>
        ) : (
          <Progress pct={progress} complete={item.curveComplete === true} />
        )}
        <span
          className={cn('inline-flex shrink-0 items-center gap-0.5 tabular', item.devBuySol === undefined ? 'text-faint' : 'text-fg-dim')}
          title={item.devBuySol === undefined ? 'Dev buy: unknown' : `Dev buy: ${formatAmount(item.devBuySol)} SOL spent by the creator at launch`}
        >
          <Coins aria-hidden className="size-3 opacity-80" />
          <span className="sr-only">Dev buy</span>
          {item.devBuySol === undefined ? DASH : `${formatAmount(item.devBuySol, { maxDecimals: item.devBuySol >= 10 ? 1 : 2 })}◎`}
        </span>
        <Stat icon={UserStar} label="Top 10 holders" value={risk.top10Pct} warnAbove={30} dangerAbove={50} />
        <Stat icon={ChefHat} label="Dev holding" value={risk.devHoldingPct} warnAbove={10} />
        <Stat icon={Crosshair} label="Snipers" value={risk.snipersPct} warnAbove={20} />
        <Stat icon={Ghost} label="Insiders" value={risk.insidersPct} warnAbove={20} />
        <Stat icon={Boxes} label="Bundlers" value={risk.bundlersPct} warnAbove={20} />
      </div>
    </article>
  );
}

/** Memoized: re-renders only when displayed data changes (merge bookkeeping is ignored). */
export const PulseCard = memo(
  PulseCardView,
  (a, b) => a.column === b.column && a.mcUsd === b.mcUsd && sameCardData(a.item, b.item),
);

export function PulseCardSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-2 border-b border-line px-3 py-2">
      <div className="flex items-start gap-2">
        <span className="block size-12 shrink-0 animate-pulse rounded-full bg-panel-3" />
        <div className="flex flex-1 flex-col gap-1.5 pt-1">
          <span className="block h-3 w-28 animate-pulse rounded bg-panel-3" />
          <span className="block h-2.5 w-40 animate-pulse rounded bg-panel-3" />
          <span className="block h-2.5 w-24 animate-pulse rounded bg-panel-3" />
        </div>
        <div className="flex flex-col items-end gap-1.5 pt-1">
          <span className="block h-3.5 w-16 animate-pulse rounded bg-panel-3" />
          <span className="block h-2.5 w-12 animate-pulse rounded bg-panel-3" />
          <span className="block h-2.5 w-20 animate-pulse rounded bg-panel-3" />
        </div>
      </div>
      <span className="block h-2.5 w-full animate-pulse rounded bg-panel-3" />
    </div>
  );
}
