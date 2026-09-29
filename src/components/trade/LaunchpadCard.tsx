'use client';

import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { WalletLink } from '@/components/ui/AddressLink';
import { cn } from '@/components/ui/cn';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import { formatAmount, formatPct, formatPrice, formatUsd } from '@/lib/core/format';
import { explorer, shortAddress } from '@/lib/core/solana';
import type { BondingCurveState, LaunchpadState, PoolInfo } from '@/lib/core/types';
import { curveMarketCapUsd, curveQuoteSymbol, quoteToGraduation, tokenTradeHref } from '@/lib/services/token';
import { Age, Dash, KV, Pane } from './parts';

export function LaunchpadCard({
  mint,
  launchpad,
  curve,
  curveFetchedAt,
  solUsd,
  creator,
  pools,
  className,
}: {
  mint: string;
  launchpad?: LaunchpadState;
  curve?: BondingCurveState | null;
  curveFetchedAt?: number;
  solUsd?: number;
  creator?: string;
  pools: readonly PoolInfo[];
  className?: string;
}) {
  const stage = launchpad?.stage ?? 'unknown';
  if (!launchpad || stage === 'amm' || (stage === 'unknown' && !curve)) return null;

  const onChain = !!curve;
  const progress = curve ? (curve.complete ? 100 : curve.progressPct) : launchpad.progressPct;
  const complete = curve ? curve.complete : stage === 'graduated';
  const toGraduation = curve ? quoteToGraduation(curve) : undefined;
  const quoteSymbol = curve ? (curveQuoteSymbol(curve) ?? 'quote') : 'SOL';
  const migrated = pools.find((p) => !p.isBondingCurve && (launchpad.migratedPool ? p.address === launchpad.migratedPool : true));
  const migratedKnown = migrated !== undefined && launchpad.migratedPool === migrated.address;
  const curveMc = curve ? curveMarketCapUsd(curve, solUsd) : undefined;

  return (
    <Pane
      title={launchpad.launchpad ?? 'Launchpad'}
      className={className}
      actions={
        <FreshnessBadge
          updatedAt={curveFetchedAt}
          live={onChain && !complete}
          liveWindowMs={8_000}
          className={!onChain ? 'hidden' : undefined}
        />
      }
    >
      <div className="px-3 py-2">
        <div className="flex items-center justify-between text-xs">
          <span className={cn('font-medium', complete ? 'text-warn' : 'text-fg-dim')}>
            {complete ? (stage === 'graduated' ? 'Migrated' : 'Curve complete') : 'Bonding'}
          </span>
          <span className="tabular text-fg-dim" title={onChain ? 'Decoded from the bonding-curve account on-chain' : 'Progress as reported by the provider'}>
            {progress === undefined ? <Dash /> : formatPct(progress, { signed: false, decimals: progress >= 99.95 ? 0 : 1 })}
            {onChain && <span className="ml-1 text-2xs text-faint">on-chain</span>}
          </span>
        </div>
        <div aria-hidden className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-line-strong">
          {progress !== undefined && (
            <div className={cn('h-full rounded-full', complete ? 'bg-warn' : progress >= 85 ? 'bg-warn' : 'bg-up')} style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
          )}
        </div>
        <div className="mt-1.5">
          {!complete && (
            <KV label="To graduation" title="Constant-product estimate from the curve's virtual reserves, before fees">
              {toGraduation === undefined ? <Dash /> : `≈ ${formatAmount(toGraduation, { maxDecimals: 2 })} ${quoteSymbol} (before fees)`}
            </KV>
          )}
          {curve && (
            <KV label={`${quoteSymbol} in curve`} title="Real quote reserves held by the bonding curve">
              {formatAmount(curve.realQuoteReserves, { maxDecimals: 2 })} {quoteSymbol}
              {curve.quoteMint !== curve.mint && solUsd !== undefined && quoteSymbol === 'SOL' && (
                <span className="ml-1 text-faint">({formatUsd(curve.realQuoteReserves * solUsd)})</span>
              )}
            </KV>
          )}
          {curveMc !== undefined && !complete && (
            <KV label="Curve MC" title="Virtual-reserve price × on-chain supply">
              {formatUsd(curveMc)}
            </KV>
          )}
          {complete && migrated && (
            // "Migrated to" only when the provider names the migration pool; otherwise it is just the most liquid AMM pool.
            <KV label={migratedKnown ? 'Migrated to' : 'Main pool'} title={migratedKnown ? 'Migration pool reported by the provider' : 'Most liquid AMM pool (the provider does not report the migration pool)'}>
              <Link href={tokenTradeHref(mint, migrated.address)} className="text-fg-dim hover:text-brand-strong hover:underline" title={migrated.address}>
                {migrated.dexLabel}
              </Link>
              {migratedKnown && launchpad.graduatedAt !== undefined && (
                <span className="ml-1 text-faint">
                  <Age from={launchpad.graduatedAt} /> ago
                </span>
              )}
            </KV>
          )}
          {complete && !migratedKnown && launchpad.graduatedAt !== undefined && (
            <KV label="Graduated">
              <Age from={launchpad.graduatedAt} /> ago
            </KV>
          )}
          {(creator ?? curve?.creator) && (
            <KV label="Creator">
              <WalletLink address={(creator ?? curve?.creator) as string} showTools />
            </KV>
          )}
          {curve && (
            <KV label="Curve account">
              <a href={explorer.account(curve.curve)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono hover:text-brand-strong" title={curve.curve}>
                {shortAddress(curve.curve)}
                <ExternalLink className="size-3" />
              </a>
            </KV>
          )}
          {curve?.isMayhemMode && (
            <p className="mt-1 text-2xs text-warn" title="Mayhem-mode curves start with a different virtual reserve and 2B supply">
              Mayhem mode curve
            </p>
          )}
          {curve && curve.priceQuote !== undefined && (
            <p className="mt-1 text-2xs text-faint" title="Spot price from virtual reserves">
              Curve price {formatPrice(curve.priceQuote, { currency: false })} {quoteSymbol}
            </p>
          )}
        </div>
      </div>
    </Pane>
  );
}
