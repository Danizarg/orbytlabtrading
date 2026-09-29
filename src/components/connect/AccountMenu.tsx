'use client';

import Link from 'next/link';
import { BadgeCheck, ChartLine, Check, ChevronDown, Copy, ExternalLink, KeyRound, LoaderCircle, LogOut, Radar } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { usePreferences } from '@/client/store/preferences';
import { cn } from '@/components/ui/cn';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatSol } from '@/lib/core/format';
import { explorer, shortAddress } from '@/lib/core/solana';
import { describeError } from '@/lib/net/errors';
import { useWallet } from '@/lib/wallet/store';
import { useSolBalance } from './useSolBalance';
import { WalletIcon } from './WalletIcon';

function focusTrigger(root: HTMLElement | null) {
  root?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.focus();
}

const ITEM =
  'flex h-8 w-full items-center gap-2.5 rounded px-2 text-left text-xs text-fg-dim outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg focus-visible:outline-none disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent';

/**
 * Connected-wallet pill (icon, short address, verified check) with a menu:
 * SOL balance, portfolio, track, copy, sign in, disconnect. Menu-button
 * pattern: arrow keys move, Esc closes and returns focus, Tab leaves.
 */
export function AccountMenu({ onSignIn, buttonRef }: { onSignIn: () => void; buttonRef?: Ref<HTMLButtonElement> }) {
  const address = useWallet((s) => s.address);
  const walletName = useWallet((s) => s.walletName);
  const walletIcon = useWallet((s) => s.walletIcon);
  const verified = useWallet((s) => s.verified);
  const session = useWallet((s) => s.session);
  const signing = useWallet((s) => s.status === 'signing');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node | null)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      focusTrigger(rootRef.current);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!address) return null;

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (e.key === 'ArrowDown') move(index + 1);
    else if (e.key === 'ArrowUp') move(index - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else if (e.key === 'Tab') setOpen(false);
  }

  const close = () => {
    setOpen(false);
    focusTrigger(rootRef.current);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Wallet ${shortAddress(address)}${verified ? ', signed in' : ''}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors',
          open ? 'border-line-strong bg-hover text-fg' : 'border-line-strong text-fg hover:bg-hover',
        )}
      >
        {signing ? <LoaderCircle className="size-4 animate-spin text-muted" /> : <WalletIcon icon={walletIcon} name={walletName} className="size-4 rounded-[4px]" />}
        <span className="font-mono tabular">{shortAddress(address)}</span>
        {verified && <BadgeCheck className="size-3.5 text-up" aria-hidden />}
        <ChevronDown className={cn('hidden size-3 text-muted transition-transform sm:block', open && 'rotate-180')} aria-hidden />
      </button>

      {open && (
        // Popover: the account summary (plain content) above the menu proper,
        // so role="menu" holds only menu items and a separator (ARIA menu pattern).
        <div
          ref={menuRef}
          onKeyDown={onMenuKey}
          className="fixed inset-x-2 top-[52px] z-50 overflow-hidden rounded-lg border border-line-strong bg-panel shadow-2xl shadow-black/60 sm:absolute sm:inset-x-auto sm:top-[calc(100%+6px)] sm:right-0 sm:w-[280px]"
        >
          <AccountSummary address={address} walletName={walletName} walletIcon={walletIcon} verified={verified} session={session} />
          <div id={menuId} role="menu" aria-label="Wallet actions" className="p-1">
            <Link role="menuitem" href={`/wallet/${address}`} onClick={() => setOpen(false)} className={ITEM}>
              <ChartLine className="size-3.5 text-muted" /> Portfolio
            </Link>
            <TrackItem address={address} />
            <CopyItem address={address} />
            <a role="menuitem" href={explorer.account(address)} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)} className={ITEM}>
              <ExternalLink className="size-3.5 text-muted" /> View on Solscan
            </a>
            {!verified && (
              <button
                role="menuitem"
                type="button"
                disabled={signing}
                onClick={() => {
                  setOpen(false);
                  onSignIn();
                }}
                className={ITEM}
              >
                <KeyRound className="size-3.5 text-muted" /> Sign in
              </button>
            )}
            <div role="separator" className="-mx-1 my-1 border-t border-line" />
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                close();
                void useWallet.getState().disconnect();
              }}
              className={cn(ITEM, 'text-down hover:text-down focus-visible:text-down')}
            >
              <LogOut className="size-3.5" /> Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AccountSummary({
  address,
  walletName,
  walletIcon,
  verified,
  session,
}: {
  address: string;
  walletName: string | null;
  walletIcon: string | null;
  verified: boolean;
  session: boolean;
}) {
  const balance = useSolBalance(address, true);
  return (
    <div className="border-b border-line px-3 py-2.5">
      <div className="flex items-center gap-2">
        <WalletIcon icon={walletIcon} name={walletName} className="size-4 rounded-[4px]" />
        <span className="truncate text-xs font-semibold text-fg">{walletName ?? 'Wallet'}</span>
        <span
          className={cn('ml-auto flex items-center gap-1 text-2xs font-medium', verified ? 'text-up' : 'text-muted')}
          title={verified ? (session ? 'Signature verified by ORBYT; session kept for 7 days' : 'Signature verified by ORBYT for this visit') : 'Connected without signing in'}
        >
          {verified ? <BadgeCheck className="size-3" /> : null}
          {verified ? 'Signed in' : 'Not signed in'}
        </span>
      </div>
      <p className="mt-1 font-mono text-2xs leading-relaxed break-all text-muted select-all">{address}</p>
      <div className="mt-2 flex items-center justify-between rounded-md border border-line bg-panel-2 px-2.5 py-1.5">
        <span className="text-2xs text-muted">Balance</span>
        {balance.data ? (
          <span className="text-xs font-semibold text-fg tabular" title={`Source: ${balance.data.source}`}>
            {formatSol(balance.data.sol, { maxDecimals: 4 })}
          </span>
        ) : balance.isError ? (
          <span className="text-xs text-faint" title={`Balance unavailable: ${describeError(balance.error)}`}>
            —
          </span>
        ) : (
          <Skeleton className="h-3.5 w-16" />
        )}
      </div>
    </div>
  );
}

function TrackItem({ address }: { address: string }) {
  const tracked = usePreferences((s) => s.trackedWallets.some((w) => w.address === address));
  const [reason, setReason] = useState<string | null>(null);
  return (
    <button
      role="menuitem"
      type="button"
      disabled={tracked}
      title={reason ?? undefined}
      onClick={() => {
        const res = usePreferences.getState().addWallet(address, 'My wallet');
        setReason(res.ok ? null : res.reason);
      }}
      className={ITEM}
    >
      {tracked ? <Check className="size-3.5 text-up" /> : <Radar className="size-3.5 text-muted" />}
      {tracked ? 'Tracked in Tracker' : reason ? reason : 'Track wallet'}
    </button>
  );
}

function CopyItem({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      role="menuitem"
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(address);
          setCopied(true);
        } catch {
          /* clipboard unavailable: the address above stays selectable */
        }
      }}
      className={ITEM}
    >
      {copied ? <Check className="size-3.5 text-up" /> : <Copy className="size-3.5 text-muted" />}
      {copied ? 'Copied' : 'Copy address'}
    </button>
  );
}
