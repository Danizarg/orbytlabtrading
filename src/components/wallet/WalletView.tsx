'use client';

import { useState } from 'react';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { Tabs } from '@/components/ui/Tabs';
import { usePortfolio } from '@/data/hooks/usePortfolio';
import { useWalletPnl } from '@/data/hooks/useWalletPnl';
import { ActivityFeed } from './ActivityFeed';
import { HoldingsTable } from './HoldingsTable';
import { PnlSummary } from './PnlSummary';
import { PnlTable } from './PnlTable';
import { WalletHeader } from './WalletHeader';

type Tab = 'holdings' | 'activity' | 'pnl';

const TAB_LABEL: Record<Tab, string> = { holdings: 'Holdings', activity: 'Activity', pnl: 'PnL' };

function Count({ n }: { n: number | undefined }) {
  if (n === undefined) return null;
  return <span className="rounded bg-panel-3 px-1 text-2xs tabular text-muted">{n}</span>;
}

/**
 * /wallet/[address]: header, PnL summary strip and the Holdings / Activity /
 * PnL tabs. Portfolio and activity requests start together on mount; PnL
 * shares the activity page cache (switching tabs costs nothing) and reuses
 * the holdings' prices for open positions, so each Jupiter quote is fetched
 * once per page.
 */
export function WalletView({ address }: { address: string }) {
  const portfolio = usePortfolio(address);
  const pnl = useWalletPnl(address, {
    knownPricesUsd: portfolio.priceMap,
    knownPricesSettled: portfolio.pricesSettled,
    knownPricesUpdatedAt: portfolio.pricesUpdatedAt,
    attemptedMints: portfolio.attemptedMints,
  });
  const [tab, setTab] = useState<Tab>('holdings');

  const items = [
    { value: 'holdings' as const, label: TAB_LABEL.holdings, badge: <Count n={portfolio.portfolio ? portfolio.portfolio.tokens.length : undefined} /> },
    { value: 'activity' as const, label: TAB_LABEL.activity, badge: <Count n={pnl.activity.infinite.data ? pnl.activity.items.length : undefined} /> },
    { value: 'pnl' as const, label: TAB_LABEL.pnl, badge: <Count n={pnl.report?.tokens.length} /> },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:h-[calc(100dvh-var(--shell-header-h)-var(--shell-footer-h))] lg:min-h-[32rem] lg:flex-none">
      <ErrorBoundary label="Wallet header" resetKeys={[address]} className="flex h-11 items-center justify-center border-b border-line bg-panel text-xs text-muted">
        <WalletHeader address={address} view={portfolio} />
      </ErrorBoundary>
      <ErrorBoundary label="PnL summary" resetKeys={[address]} className="flex h-16 items-center justify-center border-b border-line bg-panel text-xs text-muted">
        <PnlSummary pnl={pnl} />
      </ErrorBoundary>
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <Tabs ariaLabel="Wallet sections" items={items} value={tab} onChange={setTab} />
      </div>
      {/* Phones: a fixed-height panel keeps sticky table headers and horizontal scroll inside it. */}
      <div role="tabpanel" aria-label={TAB_LABEL[tab]} className="flex h-[75dvh] min-h-[24rem] flex-col bg-panel lg:h-auto lg:min-h-0 lg:flex-1">
        <ErrorBoundary label={TAB_LABEL[tab]} resetKeys={[address, tab]} className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
          {tab === 'holdings' && <HoldingsTable view={portfolio} />}
          {tab === 'activity' && <ActivityFeed activity={pnl.activity} solPriceUsd={pnl.solPriceUsd} />}
          {tab === 'pnl' && <PnlTable pnl={pnl} />}
        </ErrorBoundary>
      </div>
    </div>
  );
}
