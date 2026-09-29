'use client';

import Link from 'next/link';
import { memo, type MouseEvent } from 'react';
import { Change } from '@/components/ui/Change';
import { CopyButton } from '@/components/ui/CopyButton';
import { TokenAvatar } from '@/components/ui/TokenAvatar';
import { cn } from '@/components/ui/cn';
import { formatSol, formatUsd } from '@/lib/core/format';
import type { DiscoverWindow } from '@/lib/core/providers';
import { shortAddress } from '@/lib/core/solana';
import type { TokenRow } from '@/lib/core/types';
import { bondingProgress, flagReasons, launchpadVenue, windowStats } from '@/lib/services/discover';
import {
  AgeCell,
  CountCell,
  Dash,
  FlagMark,
  LaunchpadChip,
  PriceCell,
  RemoveButton,
  RiskCell,
  TxnsCell,
  UsdCell,
  VerifiedMark,
  WatchStar,
} from './cells';
import { tradeHref } from './prefetch';
import { SocialLinks } from './SocialLinks';
import { ROW_H, TD, TD_ACTION, TD_RANK, TD_TOKEN } from './tableStyles';

export type TableVariant = 'discover' | 'watchlist';

interface RowProps {
  row: TokenRow;
  win: DiscoverWindow;
  variant: TableVariant;
  /** Navigate to the token page (newTab for cmd/ctrl/shift or middle click). */
  onOpen: (mint: string, newTab: boolean) => void;
  /** Hover / focus intent: prefetch the token page. */
  onHover?: (mint: string) => void;
}

const INTERACTIVE = 'a,button,input,select,textarea,label';

/**
 * One Discover / watchlist row (32 px). Memoized: re-renders only when its
 * row object or the window changes; the age cell ticks on its own and the
 * watch star subscribes to its own mint.
 */
export const TokenTableRow = memo(function TokenTableRow({ row, win, variant, onOpen, onHover }: RowProps) {
  const { token, market, pool, risk } = row;
  const mint = token.mint;
  const stats = windowStats(row, win);
  const symbol = token.symbol ?? shortAddress(mint);
  const flags = flagReasons(row);
  // Without a pool from the providers, a bonding token's venue is its launchpad curve.
  const curveVenue = !pool && token.launchpad?.stage === 'bonding' ? launchpadVenue(token.launchpad.launchpad) : undefined;
  const dexLabel = pool?.dexLabel ?? curveVenue;
  const pair = pool?.quoteSymbol ? `${symbol}/${pool.quoteSymbol}` : undefined;
  const dexTitle = pool ? [pool.dexLabel, pair, pool.address].filter(Boolean).join(' · ') : curveVenue && `${curveVenue} bonding curve`;

  function handleClick(e: MouseEvent<HTMLTableRowElement>) {
    if (e.button !== 0 || e.defaultPrevented) return;
    if ((e.target as Element).closest(INTERACTIVE)) return;
    // Selecting text (e.g. copying a number) must not navigate.
    if (document.getSelection()?.toString()) return;
    onOpen(mint, e.metaKey || e.ctrlKey || e.shiftKey);
  }

  function handleAuxClick(e: MouseEvent<HTMLTableRowElement>) {
    if (e.button !== 1 || (e.target as Element).closest(INTERACTIVE)) return;
    e.preventDefault();
    onOpen(mint, true);
  }

  const hover = onHover ? () => onHover(mint) : undefined;

  return (
    <tr className={cn('group cursor-pointer', ROW_H)} onClick={handleClick} onAuxClick={handleAuxClick} onMouseEnter={hover} onFocus={hover}>
      <td className={cn(TD_RANK, 'text-right text-2xs tabular text-faint')}>{row.rank ?? ''}</td>

      <td className={TD_TOKEN}>
        <div className="flex min-w-0 items-center gap-1.5">
          <TokenAvatar src={token.image} symbol={token.symbol} size={22} progress={bondingProgress(row)} />
          <div className="min-w-0 flex-1">
            <div className="flex h-[14px] min-w-0 items-center gap-1 leading-[14px]">
              <Link
                href={tradeHref(mint)}
                prefetch={false}
                title={token.name ? `${symbol} · ${token.name}` : symbol}
                className="max-w-[55%] shrink-0 truncate font-semibold text-fg hover:text-brand-strong"
              >
                {symbol}
              </Link>
              {token.verified && <VerifiedMark />}
              <FlagMark reasons={flags} />
              {token.name && (
                <span className="min-w-0 truncate text-2xs text-muted" title={token.name}>
                  {token.name}
                </span>
              )}
              <span className="ml-auto flex shrink-0 pl-1">
                <LaunchpadChip launchpad={token.launchpad} />
              </span>
            </div>
            <div className="flex h-[14px] items-center gap-1 text-2xs leading-[14px] text-faint">
              <span className="font-mono" title={mint}>
                {shortAddress(mint)}
              </span>
              <span className="-my-1 inline-flex">
                <CopyButton value={mint} label="Copy mint address" />
              </span>
              <SocialLinks socials={token.socials} symbol={token.symbol} />
            </div>
          </div>
        </div>
      </td>

      <td className={cn(TD, 'text-right')}>
        <AgeCell createdAt={token.createdAt} />
      </td>
      <td className={cn(TD, 'text-right')} title={market.priceSol !== undefined ? formatSol(market.priceSol, { maxDecimals: 12 }) : undefined}>
        <PriceCell value={market.priceUsd} />
      </td>
      <td className={cn(TD, 'text-right')}>{stats?.priceChangePct === undefined ? <Dash /> : <Change value={stats.priceChangePct} />}</td>
      <td className={cn(TD, 'text-right')}>
        <UsdCell value={market.marketCapUsd} className="text-fg" title={market.fdvUsd !== undefined ? `FDV ${formatUsd(market.fdvUsd)}` : undefined} />
      </td>
      <td className={cn(TD, 'text-right')}>
        <UsdCell value={market.liquidityUsd} className="text-fg-dim" />
      </td>
      <td className={cn(TD, 'text-right')}>
        <UsdCell value={stats?.volumeUsd} className="text-fg-dim" />
      </td>
      <td className={cn(TD, 'text-right')}>
        <TxnsCell stats={stats} />
      </td>
      <td className={cn(TD, 'text-right')}>
        <CountCell value={stats?.traders} className="text-fg-dim" />
      </td>
      <td className={cn(TD, 'text-right')}>
        <CountCell value={market.holders} className="text-fg-dim" />
      </td>
      <td className={cn(TD, 'text-right')}>
        <RiskCell metric="top10" value={risk?.top10Pct} />
      </td>
      <td className={cn(TD, 'text-right')}>
        <RiskCell metric="dev" value={risk?.devHoldingPct} />
      </td>
      <td className={cn(TD, 'text-right')}>
        <RiskCell metric="snipers" value={risk?.snipersPct} />
      </td>
      <td className={cn(TD, 'text-right')}>
        <RiskCell metric="insiders" value={risk?.insidersPct} />
      </td>
      <td className={cn(TD, 'text-right')}>
        <RiskCell metric="bundlers" value={risk?.bundlersPct} />
      </td>
      <td className={TD}>
        {dexLabel ? (
          <span className="block truncate text-fg-dim" title={dexTitle}>
            {dexLabel}
          </span>
        ) : (
          <Dash />
        )}
      </td>
      <td className={TD_ACTION}>
        {variant === 'watchlist' ? <RemoveButton mint={mint} symbol={token.symbol} /> : <WatchStar mint={mint} symbol={token.symbol} />}
      </td>
    </tr>
  );
});
