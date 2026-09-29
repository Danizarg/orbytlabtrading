'use client';

import { Radio } from 'lucide-react';
import { useHydrated } from '@/client/hooks/useHydrated';
import { usePreferences, type TrackedWallet } from '@/client/store/preferences';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import { useTrackerFeed } from '@/data/hooks/useTrackerFeed';
import { TRACKER_POLL_MS } from '@/lib/services/wallet';
import { TrackerFeed } from './TrackerFeed';
import { TrackerWalletWorker } from './TrackerWorkers';
import { WalletList } from './WalletList';

const NONE: readonly TrackedWallet[] = [];

/**
 * /tracker: tracked wallets (left) and their merged live feed (right).
 * Tracked wallets are browser-local, so workers and lists render only after
 * hydration; the feed store keeps entries while navigating within the tab.
 */
export function TrackerView() {
  const hydrated = useHydrated();
  const stored = usePreferences((s) => s.trackedWallets);
  const wallets = hydrated ? stored : NONE;
  const feed = useTrackerFeed(wallets);

  const lastAt = wallets.reduce((max, w) => {
    const s = feed.status[w.address];
    return Math.max(max, s?.lastStreamAt ?? 0, s?.lastPollAt ?? 0, s?.backfilledAt ?? 0);
  }, 0);
  const wsLive = feed.ws.status === 'open' && feed.ws.subscriptions > 0 && feed.ws.confirmed >= feed.ws.subscriptions;
  const failing = wallets.filter((w) => feed.live[w.address] === 'error').length;

  return (
    <div className="flex h-[calc(100dvh-76px)] min-h-[32rem] flex-col">
      {wallets.map((w, i) => (
        <TrackerWalletWorker key={w.address} wallet={w.address} index={i} />
      ))}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel px-3 lg:px-4">
        <h1 className="flex items-center gap-2 font-display text-sm font-semibold tracking-tight text-fg">
          <Radio aria-hidden className="size-3.5 text-muted" strokeWidth={1.75} />
          Tracker
        </h1>
        {hydrated && (
          <span className="text-2xs tabular text-muted">
            {wallets.length} wallet{wallets.length === 1 ? '' : 's'}
          </span>
        )}
        <span className="hidden text-2xs text-faint md:inline">Log subscriptions + {TRACKER_POLL_MS / 1000} s reconciliation</span>
        <span className="ml-auto">
          <FreshnessBadge
            updatedAt={lastAt > 0 ? lastAt : undefined}
            live={wsLive}
            liveWindowMs={TRACKER_POLL_MS + 15_000}
            staleAfterMs={TRACKER_POLL_MS * 2 + 15_000}
            error={failing > 0 ? `${failing} wallet${failing === 1 ? '' : 's'} failing` : wallets.length === 0 && hydrated ? 'No wallets tracked' : null}
          />
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-px bg-line lg:grid-cols-[336px_minmax(0,1fr)] lg:grid-rows-1">
        <ErrorBoundary label="Tracked wallets" className="flex max-h-72 min-h-0 flex-col items-center justify-center gap-2 bg-panel p-4 text-center lg:max-h-none">
          <div className="flex max-h-72 min-h-0 flex-col lg:max-h-none">
            <WalletList wallets={wallets} feed={feed} hydrated={hydrated} />
          </div>
        </ErrorBoundary>
        <ErrorBoundary label="Live feed" className="flex min-h-0 flex-col items-center justify-center gap-2 bg-panel p-4 text-center">
          <TrackerFeed wallets={wallets} feed={feed} hydrated={hydrated} />
        </ErrorBoundary>
      </div>
    </div>
  );
}
