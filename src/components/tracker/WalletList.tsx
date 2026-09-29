'use client';

import { Check, ExternalLink, Pencil, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { memo, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNow } from '@/client/hooks/useNow';
import { MAX_TRACKED_WALLETS, usePreferences, type TrackedWallet } from '@/client/store/preferences';
import { CopyButton } from '@/components/ui/CopyButton';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/components/ui/cn';
import type { TrackerFeedView } from '@/data/hooks/useTrackerFeed';
import { BTN, BTN_DANGER, BTN_PRIMARY, INPUT } from '@/components/wallet/styles';
import { formatAge } from '@/lib/core/format';
import { explorer, shortAddress } from '@/lib/core/solana';
import { LIVE_LABEL, TRACKER_POLL_MS, type TrackerLive, type TrackerWalletStatus } from '@/lib/services/wallet';

const DOT: Record<TrackerLive, string> = { subscribed: 'bg-up', polling: 'bg-warn', error: 'bg-down' };

function statusText(status: TrackerWalletStatus | undefined, live: TrackerLive, pollMs: number, now: number): string {
  if (!status) return 'Starting';
  if (live === 'error') return status.backfillError ?? status.pollError ?? 'Error';
  const parts: string[] = [LIVE_LABEL[live]];
  const liveFound = status.streamEvents + (status.hintedFound ?? 0);
  if (liveFound > 0) parts.push(`${liveFound} live`);
  if (status.missedByStream) parts.push(`${status.missedByStream} via poll`);
  if (pollMs < TRACKER_POLL_MS) parts.push(`every ${pollMs / 1000} s`);
  const last = Math.max(status.lastPollAt ?? 0, status.backfilledAt ?? 0);
  if (last > 0 && now) parts.push(`checked ${formatAge(last, now)} ago`);
  else if (status.backfilledAt === undefined && !status.backfillError) parts.push('loading recent activity');
  if (status.pollError) parts.push('last poll failed');
  return parts.join(' · ');
}

/** Address + optional label; validation messages come from the preferences store. */
function AddWalletForm() {
  const id = useId();
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const count = usePreferences((s) => s.trackedWallets.length);
  const full = count >= MAX_TRACKED_WALLETS;

  function submit(e: FormEvent) {
    e.preventDefault();
    const result = usePreferences.getState().addWallet(address, label);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setAddress('');
    setLabel('');
    setError(null);
  }

  return (
    <form onSubmit={submit} className="flex shrink-0 flex-col gap-1.5 border-b border-line px-3 py-2" aria-labelledby={`${id}-title`}>
      <span id={`${id}-title`} className="sr-only">
        Track a wallet
      </span>
      <div className="flex gap-1.5">
        <input
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            if (error) setError(null);
          }}
          placeholder="Wallet address"
          aria-label="Wallet address"
          autoComplete="off"
          spellCheck={false}
          className={cn(INPUT, 'flex-1 font-mono')}
        />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" aria-label="Label (optional)" maxLength={32} autoComplete="off" className={cn(INPUT, 'w-24')} />
        <button type="submit" disabled={!address.trim() || full} className={cn(BTN_PRIMARY, 'h-7')} title={full ? `Up to ${MAX_TRACKED_WALLETS} wallets` : 'Add to the tracker'}>
          <Plus aria-hidden className="size-3" strokeWidth={1.75} /> Add
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-2xs text-warn">
          {error}
        </p>
      ) : (
        <p className="text-2xs text-faint">
          {count}/{MAX_TRACKED_WALLETS} wallets · saved in this browser
        </p>
      )}
    </form>
  );
}

const WalletRow = memo(function WalletRow({
  wallet,
  status,
  live,
  pollMs,
}: {
  wallet: TrackedWallet;
  status: TrackerWalletStatus | undefined;
  live: TrackerLive;
  pollMs: number;
}) {
  const now = useNow();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(wallet.label);
  const [confirming, setConfirming] = useState(false);
  // Escape cancels; some browsers fire blur while the input unmounts, which must not commit the draft.
  const cancelled = useRef(false);

  function commit() {
    if (cancelled.current) return;
    cancelled.current = true;
    usePreferences.getState().renameWallet(wallet.address, draft);
    setEditing(false);
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') {
      cancelled.current = true;
      setDraft(wallet.label);
      setEditing(false);
    }
  }

  const text = statusText(status, live, pollMs, now);
  return (
    <li className="group flex items-center gap-2 border-b border-line px-3 py-1.5 transition-colors hover:bg-hover">
      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', DOT[live], live === 'subscribed' && 'animate-pulse-dot')} title={LIVE_LABEL[live]} />
      <div className="min-w-0 flex-1">
        <div className="flex h-5 min-w-0 items-center gap-1">
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              onBlur={commit}
              maxLength={32}
              aria-label="Wallet label"
              className={cn(INPUT, 'h-5 w-40 px-1')}
            />
          ) : (
            <>
              <span className="truncate text-xs font-semibold text-fg" title={wallet.label}>
                {wallet.label}
              </span>
              <button
                type="button"
                onClick={() => {
                  cancelled.current = false;
                  setDraft(wallet.label);
                  setEditing(true);
                }}
                aria-label={`Rename ${wallet.label}`}
                title="Rename"
                className="inline-flex size-5 items-center justify-center rounded text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-panel-3 hover:text-fg focus-visible:opacity-100"
              >
                <Pencil aria-hidden className="size-3" strokeWidth={1.75} />
              </button>
            </>
          )}
        </div>
        <div className="flex h-4 min-w-0 items-center gap-1 text-2xs text-muted">
          <Link href={`/wallet/${wallet.address}`} prefetch={false} title={`Open wallet analytics for ${wallet.address}`} className="font-mono text-fg-dim hover:text-brand-strong hover:underline">
            {shortAddress(wallet.address, 4, 4)}
          </Link>
          <span className="-my-1 inline-flex">
            <CopyButton value={wallet.address} label="Copy address" className="size-4" />
          </span>
          <a href={explorer.account(wallet.address)} target="_blank" rel="noopener noreferrer" aria-label="View on Solscan" title="Solscan" className="text-muted hover:text-fg">
            <ExternalLink className="size-2.5" strokeWidth={1.75} />
          </a>
          <span aria-hidden className="text-faint">
            ·
          </span>
          <span className={cn('truncate', live === 'error' && 'text-down')} title={text}>
            {text}
          </span>
        </div>
      </div>
      {confirming ? (
        <span className="flex shrink-0 items-center gap-1">
          <span className="text-2xs text-muted">Remove?</span>
          <button type="button" onClick={() => usePreferences.getState().removeWallet(wallet.address)} className={BTN_DANGER}>
            <Check aria-hidden className="size-3" strokeWidth={1.75} /> Yes
          </button>
          <button type="button" onClick={() => setConfirming(false)} className={BTN}>
            No
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label={`Remove ${wallet.label} from the tracker`}
          title="Remove"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-panel-3 hover:text-down focus-visible:opacity-100"
        >
          <X aria-hidden className="size-3.5" strokeWidth={1.75} />
        </button>
      )}
    </li>
  );
});

/** Left panel: add form and the tracked wallets with inline rename, confirm-in-place removal and live status. */
export function WalletList({ wallets, feed, hydrated }: { wallets: readonly TrackedWallet[]; feed: TrackerFeedView; hydrated: boolean }) {
  return (
    <section aria-label="Tracked wallets" className="flex min-h-0 flex-col bg-panel">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="text-xs font-semibold tracking-wide text-fg-dim uppercase">Wallets</h2>
        {hydrated && (
          <span className="text-2xs tabular text-muted">
            {wallets.length}/{MAX_TRACKED_WALLETS}
          </span>
        )}
        <span className="ml-auto text-2xs text-faint" title={`Reconciled every ${TRACKER_POLL_MS / 1000} s per wallet`}>
          {TRACKER_POLL_MS / 1000} s reconciliation
        </span>
      </header>
      <AddWalletForm />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!hydrated ? (
          <div aria-busy="true" className="px-3 py-2">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex items-center gap-2 py-1.5">
                <Skeleton className="size-1.5 rounded-full" />
                <div className="flex flex-col gap-1.5">
                  <Skeleton className="h-2.5 w-24" />
                  <Skeleton className="h-2 w-40" />
                </div>
              </div>
            ))}
          </div>
        ) : wallets.length === 0 ? (
          <p className="px-3 py-4 text-2xs text-muted">No wallets yet. Paste an address above.</p>
        ) : (
          <ul>
            {wallets.map((w) => (
              <WalletRow key={w.address} wallet={w} status={feed.status[w.address]} live={feed.live[w.address] ?? 'polling'} pollMs={feed.pollMs[w.address] ?? TRACKER_POLL_MS} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
