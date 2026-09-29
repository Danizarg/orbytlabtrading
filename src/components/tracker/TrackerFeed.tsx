'use client';

import { Pause } from 'lucide-react';
import Link from 'next/link';
import { memo, useEffect, useMemo, useState, type FocusEvent, type PointerEvent, type ReactNode } from 'react';
import { useNow } from '@/client/hooks/useNow';
import type { TrackedWallet } from '@/client/store/preferences';
import { TxLink } from '@/components/ui/AddressLink';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs } from '@/components/ui/Tabs';
import { cn } from '@/components/ui/cn';
import { AmountCell, KindBadge, ProgramCell, SolCell, TimeCell, TokenCell, UsdCell } from '@/components/wallet/cells';
import { FOOTER, INPUT, TD, TD_STICKY, TH, TH_STICKY } from '@/components/wallet/styles';
import type { MintIdentities } from '@/data/hooks/usePortfolio';
import type { TrackerFeedView } from '@/data/hooks/useTrackerFeed';
import { formatAge } from '@/lib/core/format';
import { shortAddress } from '@/lib/core/solana';
import {
  filterTrackerEntries,
  signedSol,
  TRACKER_BACKFILL_LIMIT,
  TRACKER_KIND_FILTERS,
  TRACKER_POLL_MS,
  usdEstimate,
  type TrackerEntry,
  type TrackerKindFilter,
} from '@/lib/services/wallet';

const COLS: ReadonlyArray<{ id: string; label: string; width: string; align: 'left' | 'right' }> = [
  { id: 'time', label: 'Time', width: 'w-20', align: 'left' },
  { id: 'wallet', label: 'Wallet', width: 'w-32', align: 'left' },
  { id: 'kind', label: 'Kind', width: 'w-24', align: 'left' },
  { id: 'token', label: 'Token', width: 'w-48', align: 'left' },
  { id: 'amount', label: 'Amount', width: 'w-28', align: 'right' },
  { id: 'sol', label: 'SOL', width: 'w-28', align: 'right' },
  { id: 'usd', label: 'USD ≈', width: 'w-24', align: 'right' },
  { id: 'program', label: 'Program', width: 'w-28', align: 'left' },
  { id: 'tx', label: 'Tx', width: 'w-20', align: 'right' },
];

const VIA_TITLE = {
  backfill: 'Loaded from history',
  stream: 'Received live from the Solana log subscription',
  account: 'Read right after the wallet balance changed (Solana account subscription)',
  poll: 'Found by the reconciliation poll',
} as const;

/** Rows slide in only while new; a row re-mounted later (filter change) must not animate again. */
const FRESH_MS = 3_000;

const TrackerRow = memo(function TrackerRow({
  entry,
  label,
  identities,
  solPriceUsd,
  fresh,
}: {
  entry: TrackerEntry;
  label: string;
  identities: MintIdentities;
  solPriceUsd?: number;
  fresh: boolean;
}) {
  const a = entry.activity;
  const identity = a.tokenMint ? identities.byMint[a.tokenMint] : undefined;
  return (
    <tr className={cn('group h-8', fresh && 'motion-safe:animate-slide-in', !a.success && 'opacity-60')} title={VIA_TITLE[entry.via]}>
      <td className={TD_STICKY}>
        <TimeCell at={a.timestamp} />
      </td>
      <td className={TD}>
        <Link href={`/wallet/${entry.wallet}`} prefetch={false} title={entry.wallet} className="block truncate font-medium text-fg-dim hover:text-brand-strong">
          {label}
        </Link>
      </td>
      <td className={TD}>
        <KindBadge kind={a.kind} failed={!a.success} />
      </td>
      <td className={TD}>
        <TokenCell mint={a.tokenMint} identity={identity} symbol={a.tokenSymbol} />
      </td>
      <td className={cn(TD, 'text-right')}>
        <AmountCell value={a.tokenAmount} symbol={identity?.symbol ?? a.tokenSymbol} />
      </td>
      <td className={cn(TD, 'text-right')}>
        <SolCell value={signedSol(a)} />
      </td>
      <td className={cn(TD, 'text-right')}>
        <UsdCell estimate={usdEstimate(a, solPriceUsd)} />
      </td>
      <td className={TD}>
        <ProgramCell program={a.program} />
      </td>
      <td className={cn(TD, 'text-right')}>
        <TxLink signature={a.signature} className="text-2xs" />
      </td>
    </tr>
  );
});

function SkeletonRow() {
  return (
    <tr className="h-8" aria-hidden>
      {COLS.map((c) => (
        <td key={c.id} className={c.id === 'time' ? TD_STICKY : TD}>
          <Skeleton className={cn('h-2.5', c.align === 'right' ? 'ml-auto w-3/5' : 'w-3/4')} />
        </td>
      ))}
    </tr>
  );
}

function wsLabel(status: TrackerFeedView['ws']): { text: string; tone: string } {
  switch (status.status) {
    case 'open':
      return status.subscriptions > 0 && status.confirmed < status.subscriptions
        ? { text: `WS open · ${status.confirmed}/${status.subscriptions} subscriptions confirmed`, tone: 'text-warn' }
        : { text: 'WS live', tone: 'text-up' };
    case 'connecting':
      return { text: 'WS connecting', tone: 'text-muted' };
    case 'reconnecting':
      return { text: `WS reconnecting${status.lastError ? ` · ${status.lastError}` : ''}`, tone: 'text-warn' };
    default:
      return status.consumers > 0 ? { text: 'WS offline · polling only', tone: 'text-warn' } : { text: 'WS idle', tone: 'text-faint' };
  }
}

/**
 * Right panel: merged live feed across tracked wallets, newest first, with
 * wallet and kind filters. Hovering (or keyboard focus inside) pauses
 * insertion so rows do not move under the pointer; new rows slide in.
 */
export function TrackerFeed({ wallets, feed, hydrated }: { wallets: readonly TrackedWallet[]; feed: TrackerFeedView; hydrated: boolean }) {
  const { entries, status, identities, solPriceUsd, ws, backfilled } = feed;
  const [walletFilter, setWalletFilter] = useState<string>('');
  const [kind, setKind] = useState<TrackerKindFilter>('all');
  const [frozen, setFrozen] = useState<{ entries: TrackerEntry[]; at: number } | null>(null);
  const [mountedAt, setMountedAt] = useState(0);
  const now = useNow();

  // Rows that arrive after the first paint slide in; the initial batch does not.
  useEffect(() => {
    const id = requestAnimationFrame(() => setMountedAt(Date.now()));
    return () => cancelAnimationFrame(id);
  }, []);

  const labels = useMemo(() => Object.fromEntries(wallets.map((w) => [w.address, w.label])) as Record<string, string>, [wallets]);
  const wallet = walletFilter && labels[walletFilter] ? walletFilter : null;
  const source = frozen ? frozen.entries : entries;
  const shown = useMemo(() => filterTrackerEntries(source, wallet, kind), [source, wallet, kind]);
  const held = frozen ? entries.filter((e) => e.seenAt > frozen.at).length : 0;

  const pause = () => setFrozen((f) => f ?? { entries, at: Date.now() });
  const resume = () => setFrozen(null);
  const onPointerEnter = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') pause();
  };
  const onPointerLeave = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') resume();
  };
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    let keyboard = false;
    try {
      keyboard = e.target.matches(':focus-visible');
    } catch {
      keyboard = false;
    }
    if (keyboard) pause();
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    resume();
  };

  const errors = useMemo(() => {
    const out = new Set<string>();
    for (const w of wallets) {
      const s = status[w.address];
      if (s?.backfillError && s.backfilledAt === undefined) out.add(`${w.label}: ${s.backfillError}`);
      if (s?.pollError && s.lastPollAt === undefined) out.add(`${w.label}: ${s.pollError}`);
    }
    return [...out];
  }, [wallets, status]);

  // Transactions delivered live: log notifications plus reads triggered by a balance change.
  const liveFound = wallets.reduce((sum, w) => sum + (status[w.address]?.streamEvents ?? 0) + (status[w.address]?.hintedFound ?? 0), 0);
  const missed = wallets.reduce((sum, w) => sum + (status[w.address]?.missedByStream ?? 0), 0);
  const lastEvent = wallets.reduce((max, w) => Math.max(max, status[w.address]?.lastStreamAt ?? 0, status[w.address]?.lastPollAt ?? 0), 0);
  const wsView = wsLabel(ws);

  let empty: ReactNode = null;
  if (hydrated && wallets.length === 0) {
    empty = (
      <EmptyState title="No wallets tracked">
        Add an address in the wallet panel, or press Track on any wallet page. Its latest {TRACKER_BACKFILL_LIMIT} transactions load immediately; new ones stream in as they confirm.
      </EmptyState>
    );
  } else if (hydrated && backfilled && shown.length === 0) {
    empty = (
      <EmptyState title={entries.length === 0 ? 'No recent activity' : 'Nothing matches these filters'} tone={errors.length ? 'warn' : 'neutral'}>
        {entries.length === 0 ? (
          <p>The tracked wallets have no parsed activity in their latest transactions yet. New transactions appear here as they confirm.</p>
        ) : (
          <button type="button" onClick={() => (setWalletFilter(''), setKind('all'))} className="text-brand-strong hover:underline">
            Reset filters
          </button>
        )}
        {errors.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-warn">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </EmptyState>
    );
  }

  const loading = hydrated && wallets.length > 0 && !backfilled && entries.length === 0;

  return (
    <section aria-label="Live feed" className="flex min-h-0 flex-col bg-panel">
      <header className="flex h-9 shrink-0 items-center gap-2 overflow-x-auto border-b border-line px-3 scrollbar-none">
        <h2 className="text-xs font-semibold tracking-wide text-fg-dim uppercase">Feed</h2>
        <select value={walletFilter} onChange={(e) => setWalletFilter(e.target.value)} aria-label="Filter by wallet" className={cn(INPUT, 'h-6 w-36 text-2xs')} disabled={!hydrated || wallets.length === 0}>
          <option value="">All wallets</option>
          {wallets.map((w) => (
            <option key={w.address} value={w.address}>
              {w.label} · {shortAddress(w.address, 4, 4)}
            </option>
          ))}
        </select>
        <Tabs ariaLabel="Filter by kind" items={TRACKER_KIND_FILTERS} value={kind} onChange={setKind} size="xs" />
        <span className="ml-auto flex shrink-0 items-center gap-2 text-2xs text-muted">
          {frozen ? (
            <span className="inline-flex items-center gap-1 text-warn" role="status">
              <Pause aria-hidden className="size-3" strokeWidth={1.75} />
              Paused{held > 0 ? ` · ${held} new` : ''}
            </span>
          ) : (
            <span className="tabular">
              {shown.length} entr{shown.length === 1 ? 'y' : 'ies'}
              {shown.length !== entries.length && <span className="text-faint"> of {entries.length}</span>}
            </span>
          )}
        </span>
      </header>
      <div
        className="relative min-h-0 flex-1 overflow-auto"
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onFocus={onFocus}
        onBlur={onBlur}
        aria-busy={loading || undefined}
      >
        <table className="w-full min-w-[980px] table-fixed border-separate border-spacing-0 text-xs">
          <caption className="sr-only">Live activity across tracked wallets</caption>
          <colgroup>
            {COLS.map((c) => (
              <col key={c.id} className={c.width} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.id} scope="col" className={cn(c.id === 'time' ? TH_STICKY : TH, c.align === 'right' ? 'text-right' : 'text-left')}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((entry) => (
              <TrackerRow
                key={entry.key}
                entry={entry}
                label={labels[entry.wallet] ?? shortAddress(entry.wallet)}
                identities={identities}
                solPriceUsd={solPriceUsd}
                fresh={mountedAt > 0 && entry.seenAt > mountedAt && entry.via !== 'backfill' && now - entry.seenAt < FRESH_MS}
              />
            ))}
            {(loading || !hydrated) && Array.from({ length: 8 }, (_, i) => <SkeletonRow key={i} />)}
          </tbody>
        </table>
        {empty && <div className="sticky left-0 w-full">{empty}</div>}
      </div>
      <footer className={FOOTER}>
        <span>Live via Solana log subscriptions (best effort) + reconciliation every {TRACKER_POLL_MS / 1000} s</span>
        <span aria-hidden className="text-faint">
          ·
        </span>
        <span
          className={wsView.tone}
          title="Wallet log notifications are best effort (the public endpoint confirms them but may deliver none). Balance-change notifications trigger an immediate read, and reconciliation stays the source of truth."
        >
          {wsView.text}
        </span>
        {liveFound > 0 && (
          <>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <span className="tabular" title="Transactions surfaced by a log notification or read right after a balance change">
              {liveFound} live
            </span>
          </>
        )}
        {missed > 0 && (
          <>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <span className="tabular text-warn" title="Transactions neither live path surfaced, found by reconciliation. Affected wallets are re-checked more often (30 s up to 5 wallets, 60 s up to 12) until a live path delivers again.">
              {missed} caught by polling
            </span>
          </>
        )}
        {lastEvent > 0 && now > 0 && (
          <>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <span>last check {formatAge(lastEvent, now)} ago</span>
          </>
        )}
        {errors.length > 0 && (
          <>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <span className="text-warn" title={errors.join('\n')}>
              {errors.length} wallet{errors.length === 1 ? '' : 's'} failing
            </span>
          </>
        )}
        <span className="ml-auto pl-3 text-faint">USD ≈ now (SOL × current SOL price)</span>
      </footer>
    </section>
  );
}
