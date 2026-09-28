'use client';

import { ExternalLink, Wallet, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { usePreferences } from '@/client/store/preferences';
import { useHydrated } from '@/client/hooks/useHydrated';
import { SITE } from '@/config/site';
import { explorer, isSolanaAddress } from '@/lib/core/solana';
import { CopyButton } from '@/components/ui/CopyButton';

/**
 * Deposit panel carried over from the original site: shows the configured
 * public receiving address (site default or a browser-local override).
 * ORBYT does not hold funds, verify deposits, or credit balances.
 */
export function DepositButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 items-center gap-2 rounded-md bg-brand px-3 text-xs font-bold text-bg hover:bg-brand-strong"
      >
        <Wallet className="size-3.5" />
        <span className="hidden sm:inline">Deposit</span>
      </button>
      {open && <DepositDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function DepositDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const hydrated = useHydrated();
  const override = usePreferences((s) => s.depositOverride);
  const setOverride = usePreferences((s) => s.setDepositOverride);
  const address = (hydrated && override) || SITE.depositAddress;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
      aria-labelledby="deposit-title"
      className="m-auto w-[min(440px,calc(100vw-2rem))] rounded-xl border border-line-strong bg-panel p-0 text-fg backdrop:bg-black/70"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <h2 id="deposit-title" className="font-display text-lg font-semibold">
          Deposit address
        </h2>
        <button type="button" aria-label="Close" onClick={() => ref.current?.close()} className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
          <X className="size-4" />
        </button>
      </div>
      <div className="space-y-4 p-5">
        <p className="text-xs text-muted">Receive SOL and SPL tokens on the Solana network at this public address.</p>
        <div className="rounded-lg border border-line bg-panel-2 p-3">
          <div className="mb-1 flex items-center justify-between text-2xs tracking-wide text-muted uppercase">
            <span>{override && hydrated ? 'This browser (override)' : 'Site default'}</span>
            <span className="flex items-center gap-1">
              <CopyButton value={address} label="Copy deposit address" />
              <a href={explorer.account(address)} target="_blank" rel="noopener noreferrer" aria-label="View on Solscan" className="text-muted hover:text-fg">
                <ExternalLink className="size-3" />
              </a>
            </span>
          </div>
          <p className="font-mono text-xs break-all text-fg">{address}</p>
        </div>

        {editing ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              const value = draft.trim();
              if (!isSolanaAddress(value)) {
                setError('Enter a valid 32-byte Solana public address.');
                return;
              }
              setOverride(value);
              setEditing(false);
              setError('');
            }}
          >
            <label htmlFor="deposit-input" className="text-xs text-fg-dim">
              Solana public address
            </label>
            <input
              id="deposit-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste a public Solana address"
              className="h-9 w-full rounded-md border border-line-strong bg-panel-2 px-3 font-mono text-xs outline-none focus:border-brand"
            />
            {error && (
              <p role="alert" className="text-xs text-down">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <button type="submit" className="h-8 rounded-md bg-brand px-3 text-xs font-bold text-bg hover:bg-brand-strong">
                Save on this browser
              </button>
              <button type="button" onClick={() => setEditing(false)} className="h-8 rounded-md px-3 text-xs text-muted hover:bg-hover">
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setDraft(address);
                setEditing(true);
              }}
              className="h-8 rounded-md border border-line-strong px-3 text-xs hover:bg-hover"
            >
              Edit for this browser
            </button>
            {override && hydrated && (
              <button type="button" onClick={() => setOverride(null)} className="h-8 rounded-md px-3 text-xs text-muted hover:bg-hover">
                Use site default
              </button>
            )}
          </div>
        )}

        <p className="rounded-md bg-warn-soft px-3 py-2 text-2xs leading-relaxed text-warn">
          Transfers go directly to this address. ORBYT does not hold funds, verify deposits, credit balances or execute trades. Never
          enter a seed phrase or private key anywhere on this site.
        </p>
      </div>
    </dialog>
  );
}
