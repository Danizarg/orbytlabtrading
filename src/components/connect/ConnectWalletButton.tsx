'use client';

import { LoaderCircle, Wallet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useWallet } from '@/lib/wallet/store';
import { AccountMenu } from './AccountMenu';
import { WalletDialog, type WalletDialogStep } from './WalletDialog';

/**
 * Header wallet control (left of Deposit). Disconnected: an outline
 * "Connect" button opening the wallet dialog. Connected: the account pill.
 *
 * Hydration-safe: the server and the first client render both show
 * "Connect" (the store starts idle); discovery and silent reconnect of the
 * last-used wallet start after mount.
 */
export function ConnectWalletButton() {
  const status = useWallet((s) => s.status);
  const address = useWallet((s) => s.address);
  const [dialog, setDialog] = useState<WalletDialogStep | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => useWallet.getState().init(), []);

  const connected = address !== null && (status === 'connected' || status === 'signing');
  const reconnecting = status === 'connecting' && dialog === null;

  // Disconnect unmounts the focused account pill: hand focus to the Connect
  // button instead of dropping it on <body> (never steal it from elsewhere).
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (wasConnected.current && !connected && dialog === null) {
      const focused = document.activeElement;
      if (!focused || focused === document.body) triggerRef.current?.focus();
    }
    wasConnected.current = connected;
  }, [connected, dialog]);

  function onDialogClose() {
    setDialog(null);
    // The trigger may have changed (Connect → account pill) while the dialog was open.
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) triggerRef.current?.focus();
    });
  }

  return (
    <>
      {connected ? (
        <AccountMenu buttonRef={triggerRef} onSignIn={() => setDialog('sign')} />
      ) : (
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-label={reconnecting ? 'Reconnecting wallet' : 'Connect wallet'}
          onClick={() => setDialog('list')}
          className="flex h-8 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-xs font-semibold text-fg transition-colors hover:bg-hover sm:px-3"
        >
          {reconnecting ? <LoaderCircle className="size-3.5 animate-spin text-muted" /> : <Wallet className="size-3.5" />}
          <span className="hidden sm:inline">Connect</span>
        </button>
      )}
      {dialog && <WalletDialog initialStep={dialog} onClose={onDialogClose} />}
    </>
  );
}
