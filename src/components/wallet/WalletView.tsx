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

function Count({ n }: { n: number | undefined }) {
  if (n === undefined) return null;
  return <span className="rounded bg-panel-3 px-1 text-2xs tabular text-muted">{n}</span>;
}

/**
 * /wallet/[address]: header, PnL summary strip and the Holdings / Activity /
 * PnL tabs. Portfolio and activity requests start together on mount; PnL
 * shares the activity page cache, so switching tabs costs nothing.
 */
export function WalletView({ address }: { address: string }) {
  const portfolio = usePortfolio(address);
  const pnl = useWalletPnl(address);
  const [tab, setTab] = useState<Tab>('holdings');

  const items = [
    { value: 'holdings' as const, label: 'Holdings', badge: <Count n={portfolio.portfolio ? portfolio.portfolio.tokens.length : undefined} /> },
    { value: 'activity' as const, label: 'Activity', badge: <Count n={pnl.activity.infinite.data ? pnl.activity.items.length : undefined} /> },
    { value: 'pnl' as const, label: 'PnL', badge: <Count n={pnl.report?.tokens.length} /> },
  ];

  return (
    <div className="flex h-[calc(100dvh-76px)] min-h-[32rem] flex-col">
      <ErrorBoundary label="Wallet header" resetKeys={[address]} className="flex h-11 items-center justify-center bg-panel text-xs text-muted">
        <WalletHeader address={address} view={portfolio} />
      </ErrorBoundary>
      <ErrorBoundary label="PnL summary" resetKeys={[address]} className="flex h-16 items-center justify-center border-b border-line bg-panel text-xs text-muted">
        <PnlSummary pnl={pnl} />
      </ErrorBoundary>
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <Tabs ariaLabel="Wallet sections" items={items} value={tab} onChange={setTab} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col bg-panel">
        <ErrorBoundary label={tab === 'holdings' ? 'Holdings' : tab === 'activity' ? 'Activity' : 'PnL'} resetKeys={[address, tab]} className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
          {tab === 'holdings' && <HoldingsTable view={portfolio} />}
          {tab === 'activity' && <ActivityFeed activity={pnl.activity} solPriceUsd={pnl.solPriceUsd} />}
          {tab === 'pnl' && <PnlTable pnl={pnl} />}
        </ErrorBoundary>
      </div>
    </div>
  );
}
