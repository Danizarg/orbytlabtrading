'use client';

import { Check, ExternalLink, Plus, Wallet } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useHydrated } from '@/client/hooks/useHydrated';
import { usePreferences } from '@/client/store/preferences';
import { CopyButton } from '@/components/ui/CopyButton';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import { cn } from '@/components/ui/cn';
import type { PortfolioView } from '@/data/hooks/usePortfolio';
import { formatSol, formatUsd } from '@/lib/core/format';
import { describeError } from '@/lib/net/errors';
import { explorer, shortAddress } from '@/lib/core/solana';
import { Dash } from './cells';
import { BTN, BTN_PRIMARY } from './styles';

/** Track / untrack toggle backed by the browser-local tracker store (hydration-safe). */
function TrackToggle({ address }: { address: string }) {
  const hydrated = useHydrated();
  const tracked = usePreferences((s) => s.trackedWallets.some((w) => w.address === address));
  const [reason, setReason] = useState<string | null>(null);
  const on = hydrated && tracked;

  function toggle() {
    const prefs = usePreferences.getState();
    if (on) {
      prefs.removeWallet(address);
      setReason(null);
      return;
    }
    const result = prefs.addWallet(address);
    setReason(result.ok ? null : result.reason);
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" aria-pressed={on} onClick={toggle} disabled={!hydrated} className={on ? BTN : BTN_PRIMARY} title={on ? 'Stop tracking this wallet' : 'Add to the live tracker'}>
        {on ? <Check aria-hidden className="size-3" strokeWidth={1.75} /> : <Plus aria-hidden className="size-3" strokeWidth={1.75} />}
        {on ? 'Tracking' : 'Track'}
      </button>
      {reason && (
        <span role="alert" className="text-2xs text-warn">
          {reason}
        </span>
      )}
    </span>
  );
}

function Stat({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap" title={title}>
      <span className="text-2xs text-muted">{label}</span>
      <span className="font-display text-sm font-semibold tabular text-fg">{children}</span>
    </span>
  );
}

/**
 * Wallet page header: address (mono, copy, Solscan), track toggle, SOL
 * balance, portfolio value with the unpriced count, and freshness.
 */
export function WalletHeader({ address, view }: { address: string; view: PortfolioView }) {
  const { query, portfolio, prices, skippedPricing, pricingPending } = view;
  const result = query.data;
  const placeholder = query.isPlaceholderData;
  const error = query.isError ? describeError(query.error) : prices.isError && !prices.data ? `prices: ${describeError(prices.error)}` : null;
  const unpriced = portfolio ? portfolio.unpricedCount : undefined;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-panel px-3 py-2 lg:h-11 lg:flex-nowrap lg:px-4 lg:py-0">
      <h1 className="flex min-w-0 items-center gap-2 font-display text-sm font-semibold tracking-tight text-fg">
        <Wallet aria-hidden className="size-3.5 text-muted" strokeWidth={1.75} />
        <span>Wallet</span>
        <span className="hidden font-mono text-xs font-normal text-fg-dim md:inline" title={address}>
          {address}
        </span>
        <span className="font-mono text-xs font-normal text-fg-dim md:hidden" title={address}>
          {shortAddress(address, 6, 6)}
        </span>
        <span className="-my-1 inline-flex">
          <CopyButton value={address} label="Copy wallet address" />
        </span>
        <a href={explorer.account(address)} target="_blank" rel="noopener noreferrer" aria-label="View on Solscan" title="Solscan" className="text-muted hover:text-fg">
          <ExternalLink className="size-3" strokeWidth={1.75} />
        </a>
      </h1>
      <TrackToggle address={address} />
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 lg:ml-auto">
        <Stat label="SOL">{portfolio ? formatSol(portfolio.sol) : <Dash />}</Stat>
        <Stat
          label="Value"
          title={
            portfolio?.totalUsd !== undefined
              ? `SOL ${formatUsd(portfolio.solValueUsd)} + tokens ${formatUsd(portfolio.tokenValueUsd)} · ${portfolio.pricedCount} priced`
              : portfolio
                ? 'Total omitted: SOL or every token could not be priced right now'
                : undefined
          }
        >
          {portfolio?.totalUsd !== undefined ? formatUsd(portfolio.totalUsd, { compact: false }) : <Dash />}
          {unpriced !== undefined && unpriced > 0 && (
            <span className={cn('ml-1.5 text-2xs font-normal', pricingPending ? 'text-faint' : 'text-muted')} title={skippedPricing > 0 ? `${skippedPricing} beyond the 150-token browser pricing budget` : undefined}>
              {pricingPending ? 'pricing…' : `${unpriced} unpriced`}
            </span>
          )}
        </Stat>
        <FreshnessBadge updatedAt={placeholder ? undefined : result?.fetchedAt} error={error} staleAfterMs={90_000} />
      </div>
    </div>
  );
}
