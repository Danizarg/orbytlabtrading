'use client';

import { BadgeCheck, ExternalLink } from 'lucide-react';
import { useFlash } from '@/client/hooks/useFlash';
import { Change } from '@/components/ui/Change';
import { cn } from '@/components/ui/cn';
import { CopyButton } from '@/components/ui/CopyButton';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import { Skeleton } from '@/components/ui/Skeleton';
import { TokenAvatar } from '@/components/ui/TokenAvatar';
import type { TokenOverviewState } from '@/data/hooks/useTokenOverview';
import { formatAmount, formatCompact, formatPrice, formatUsd } from '@/lib/core/format';
import { shortAddress } from '@/lib/core/solana';
import { curveMarketCapUsd, describeAttempt, explorerLinks, isIndexedPool, providerLabel, visibleFailures } from '@/lib/services/token';
import { Age, Dash, SocialLinks, WatchStar } from './parts';

// Full class names so Tailwind generates them; motion-safe honours reduced motion.
const FLASH: Record<string, string> = {
  'animate-flash-up': 'motion-safe:animate-flash-up',
  'animate-flash-down': 'motion-safe:animate-flash-down',
};

function Pill({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-line bg-panel-2 px-1.5 text-2xs" title={title}>
      <span className="text-muted">{label}</span>
      <span className="tabular font-medium text-fg-dim">{children}</span>
    </span>
  );
}

export function TokenHeader({
  state,
  priceUsd,
  priceSource,
  fallbackMarketCapUsd,
}: {
  state: TokenOverviewState;
  priceUsd?: number;
  /** Set when no market provider prices the token yet and the price comes from the chain (e.g. "pump.fun curve"). */
  priceSource?: string;
  /** Market cap from the same on-chain observation as `priceSource`. */
  fallbackMarketCapUsd?: number;
}) {
  const { meta, market, mint, launchpad, curve, solUsd } = state;
  const symbol = meta.symbol ?? shortAddress(mint);
  const flash = useFlash(priceUsd);
  const mc = market?.marketCapUsd ?? fallbackMarketCapUsd ?? (curve && !curve.complete ? curveMarketCapUsd(curve, solUsd) : undefined);
  const progress = launchpad?.stage === 'bonding' ? launchpad.progressPct : undefined;
  const links = explorerLinks(mint, { pool: isIndexedPool(state.primaryPool) ? state.primaryPool?.address : undefined, launchpad: launchpad?.launchpad });
  const failures = visibleFailures(state.attempts);
  // The market row carries identity and price: keep the skeleton until it answers (mint info alone is not enough).
  const rowPending = state.queries.row.isPending;
  const loadingIdentity = rowPending && !meta.symbol;
  const sourceTitle = [
    state.source ? `Market data: ${providerLabel(state.source)}` : undefined,
    ...failures.map(describeAttempt),
    state.listed === false ? 'Not listed by Jupiter, GeckoTerminal or DEX Screener yet' : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-panel px-3 py-2 lg:h-14 lg:flex-nowrap lg:py-0">
      <div className="flex min-w-0 items-center gap-2.5">
        <TokenAvatar src={meta.image} symbol={meta.symbol} size={32} progress={progress} />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            {loadingIdentity ? (
              <Skeleton className="h-4 w-20" />
            ) : (
              <h1 className="truncate font-display text-sm font-semibold text-fg" title={meta.name ? `${symbol} · ${meta.name}` : symbol}>
                {symbol}
              </h1>
            )}
            {meta.verified && (
              <span title="Verified on Jupiter" className="inline-flex shrink-0 text-info">
                <BadgeCheck aria-hidden className="size-3.5" />
                <span className="sr-only">Verified</span>
              </span>
            )}
            {meta.name && (
              <span className="hidden min-w-0 truncate text-xs text-muted sm:inline" title={meta.name}>
                {meta.name}
              </span>
            )}
            {launchpad?.launchpad && (
              <span
                className={cn('shrink-0 rounded-sm border px-1 text-2xs leading-[14px] font-medium', launchpad.stage === 'bonding' ? 'border-line-strong text-fg-dim' : 'border-line text-muted')}
                title={`${launchpad.launchpad} · ${launchpad.stage}${launchpad.progressPct !== undefined ? ` · ${launchpad.progressPct.toFixed(1)}%` : ''}`}
              >
                {launchpad.launchpad}
              </span>
            )}
            <WatchStar mint={mint} symbol={meta.symbol} className="-my-1" />
          </div>
          <div className="flex h-4 min-w-0 items-center gap-1.5 text-2xs text-faint">
            <span className="font-mono" title={mint}>
              {shortAddress(mint, 6, 6)}
            </span>
            <span className="-my-1 inline-flex">
              <CopyButton value={mint} label="Copy mint address" />
            </span>
            {meta.createdAt !== undefined && (
              <span title="Token age">
                <Age from={meta.createdAt} />
              </span>
            )}
            <SocialLinks socials={meta.socials} />
            <span className="hidden items-center gap-1.5 xl:inline-flex">
              {links.map((l) => (
                <a key={l.id} href={l.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 hover:text-fg" title={l.href}>
                  {l.label}
                  <ExternalLink aria-hidden className="size-2.5" />
                </a>
              ))}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-baseline gap-2 lg:ml-2">
        {priceUsd === undefined && rowPending ? (
          <Skeleton className="h-5 w-24" />
        ) : (
          <span
            className={cn('rounded-sm px-0.5 font-display text-lg font-semibold tabular text-fg', FLASH[flash])}
            title={priceUsd === undefined ? 'No price reported' : priceSource ? `Price in USD from the ${priceSource}` : 'Price in USD'}
          >
            {priceUsd === undefined ? <Dash /> : formatPrice(priceUsd)}
          </span>
        )}
        {priceSource && priceUsd !== undefined && <span className="shrink-0 text-2xs text-faint">{priceSource}</span>}
        <Change value={market?.stats.h24?.priceChangePct} className="text-xs font-medium" />
        <span className="sr-only">24h change</span>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scrollbar-none lg:justify-end">
        <Pill label="MC" title={priceSource && market?.marketCapUsd === undefined ? `Market cap from the ${priceSource}` : 'Market cap'}>
          {mc === undefined ? <Dash /> : formatUsd(mc)}
        </Pill>
        <Pill label="FDV" title="Fully diluted valuation">
          {market?.fdvUsd === undefined ? <Dash /> : formatUsd(market.fdvUsd)}
        </Pill>
        <Pill label="Liq" title="Liquidity">
          {(market?.liquidityUsd ?? state.primaryPool?.liquidityUsd) === undefined ? <Dash /> : formatUsd(market?.liquidityUsd ?? state.primaryPool?.liquidityUsd)}
        </Pill>
        <Pill label="V 24h" title="24h volume">
          {market?.stats.h24?.volumeUsd === undefined ? <Dash /> : formatUsd(market.stats.h24.volumeUsd)}
        </Pill>
        <Pill label="Holders">{market?.holders === undefined ? <Dash /> : formatCompact(market.holders)}</Pill>
        <Pill label="Supply" title="On-chain supply">
          {state.supply === undefined ? <Dash /> : formatAmount(state.supply, { maxDecimals: 0 })}
        </Pill>
        <span title={sourceTitle || undefined} className="shrink-0">
          <FreshnessBadge updatedAt={state.fetchedAt} error={state.error && !state.market ? 'Market data unavailable' : undefined} stale={state.delayed || (failures.length > 0 && !state.market)} />
        </span>
      </div>
    </header>
  );
}
