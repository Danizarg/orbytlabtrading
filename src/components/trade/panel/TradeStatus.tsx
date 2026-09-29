'use client';

import { CircleCheck, CircleX, ExternalLink, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { formatAmount, formatSol } from '@/lib/core/format';
import { explorer, LAMPORTS_PER_SOL } from '@/lib/core/solana';
import { SOL_DECIMALS } from '@/lib/services/token';
import type { SwapOrder } from '@/lib/swap';
import { rawToDecimal } from './amounts';
import type { TradePhase, TradeState } from './execution';

const STEPS: ReadonlyArray<{ phase: TradePhase; label: string }> = [
  { phase: 'building', label: 'Order' },
  { phase: 'signing', label: 'Sign' },
  { phase: 'submitting', label: 'Submit' },
];

/** Raw amount string → UI number (display only). */
function ui(raw: string | undefined, decimals: number | undefined): number | undefined {
  if (raw === undefined || decimals === undefined || !/^\d+$/.test(raw)) return undefined;
  const n = Number(rawToDecimal(BigInt(raw), decimals));
  return Number.isFinite(n) ? n : undefined;
}

/** Decimals of the order's input / output asset. */
function sides(state: TradeState, tokenDecimals: number | undefined): { inDecimals?: number; outDecimals?: number } {
  return state.side === 'sell' ? { inDecimals: tokenDecimals, outDecimals: SOL_DECIMALS } : { inDecimals: SOL_DECIMALS, outDecimals: tokenDecimals };
}

function networkFeeSol(order: SwapOrder): number | undefined {
  const parts = [order.signatureFeeLamports, order.prioritizationFeeLamports].filter((v): v is number => v !== undefined);
  return parts.length ? parts.reduce((a, b) => a + b, 0) / LAMPORTS_PER_SOL : undefined;
}

function SolscanLink({ signature, label = 'View on Solscan' }: { signature: string; label?: string }) {
  return (
    <a href={explorer.tx(signature)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-medium underline-offset-2 hover:underline">
      {label}
      <ExternalLink aria-hidden className="size-2.5" />
    </a>
  );
}

function Dismiss({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" aria-label="Dismiss" onClick={onClick} className="-mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded opacity-70 hover:bg-hover hover:opacity-100">
      <X aria-hidden className="size-3" />
    </button>
  );
}

/**
 * Execution progress (Order → Sign → Submit) and the outcome: confirmed with
 * the Solscan link, failed with Jupiter's error text, or unknown with the
 * transaction to check. Nothing here ever claims success without Jupiter's
 * "Success" answer.
 */
export function TradeStatus({
  state,
  symbol: symbolProp,
  tokenDecimals,
  walletName,
  onDismiss,
  onCancel,
}: {
  state: TradeState;
  symbol: string;
  tokenDecimals: number | undefined;
  walletName: string | null;
  onDismiss: () => void;
  /** Present while the trade can still be abandoned (no signature yet). */
  onCancel?: () => void;
}) {
  const { phase } = state;
  if (phase === 'idle') return null;
  // The token captured when the trade started (the page may have moved on to another token since).
  const symbol = state.token?.symbol ?? symbolProp;
  const { inDecimals, outDecimals } = sides(state, state.token ? state.token.decimals : tokenDecimals);
  const inSymbol = state.side === 'sell' ? symbol : 'SOL';
  const outSymbol = state.side === 'sell' ? 'SOL' : symbol;

  if (phase === 'building' || phase === 'signing' || phase === 'submitting') {
    const current = STEPS.findIndex((s) => s.phase === phase);
    const order = state.order;
    const minOut = ui(order?.minOutAmountRaw, outDecimals);
    const fee = order ? networkFeeSol(order) : undefined;
    return (
      <div role="status" aria-live="polite" className="mt-2 rounded-md border border-line bg-panel-2 px-2.5 py-2 text-2xs">
        <ol className="flex items-center gap-1.5" aria-label="Trade progress">
          {STEPS.map((s, i) => (
            <li key={s.phase} className={cn('flex items-center gap-1', i < current ? 'text-up' : i === current ? 'text-fg' : 'text-faint')} aria-current={i === current ? 'step' : undefined}>
              {i === current ? <LoaderCircle aria-hidden className="size-3 motion-safe:animate-spin" /> : <span aria-hidden className={cn('size-1.5 rounded-full', i < current ? 'bg-up' : 'bg-line-strong')} />}
              {s.label}
              {i < STEPS.length - 1 && <span aria-hidden className="ml-0.5 text-faint">›</span>}
            </li>
          ))}
        </ol>
        <div className="mt-1.5 flex items-start justify-between gap-2">
          <p className="text-muted">
            {phase === 'building' && 'Requesting the order from Jupiter for your wallet.'}
            {phase === 'signing' && `Approve the transaction in ${walletName ?? 'your wallet'}.`}
            {phase === 'submitting' && 'Jupiter is landing the transaction.'}
          </p>
          {onCancel && (phase === 'building' || phase === 'signing') && (
            <button
              type="button"
              onClick={onCancel}
              title={phase === 'signing' ? 'Stop here: a signature given after this is not sent' : 'Stop before the wallet is asked'}
              className="-my-0.5 shrink-0 rounded px-1 py-0.5 font-medium text-fg-dim transition-colors hover:bg-hover hover:text-fg"
            >
              Cancel
            </button>
          )}
        </div>
        {order && (minOut !== undefined || fee !== undefined) && (
          <p className="mt-0.5 text-faint tabular">
            {minOut !== undefined && `Min. ${formatAmount(minOut)} ${outSymbol}`}
            {minOut !== undefined && fee !== undefined && ' · '}
            {fee !== undefined && `network fee ${formatSol(fee, { maxDecimals: 6 })}`}
          </p>
        )}
      </div>
    );
  }

  if (phase === 'confirmed') {
    const r = state.result?.status === 'success' ? state.result : undefined;
    const spent = ui(r?.inputAmountResultRaw ?? r?.totalInputAmountRaw, inDecimals);
    const got = ui(r?.outputAmountResultRaw ?? r?.totalOutputAmountRaw, outDecimals);
    return (
      <div role="status" aria-live="polite" className="mt-2 flex items-start gap-2 rounded-md bg-up-soft px-2.5 py-2 text-2xs text-up">
        <CircleCheck aria-hidden className="mt-px size-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            {spent !== undefined && got !== undefined
              ? `${state.side === 'sell' ? 'Sold' : 'Bought'} ${formatAmount(state.side === 'sell' ? spent : got)} ${symbol} for ${formatAmount(state.side === 'sell' ? got : spent)} SOL`
              : 'Swap confirmed'}
          </p>
          {state.signature && <SolscanLink signature={state.signature} />}
        </div>
        <Dismiss onClick={onDismiss} />
      </div>
    );
  }

  const unknown = phase === 'unknown';
  // Stopped before signing on the order's price impact: a request for confirmation, not a failed swap.
  const impactStop = phase === 'failed' && state.impactPct !== undefined;
  const title = unknown ? 'Swap outcome unknown' : impactStop ? 'Price impact needs your confirmation' : `${inSymbol} → ${outSymbol} swap failed`;
  return (
    <div role="alert" className={cn('mt-2 flex items-start gap-2 rounded-md px-2.5 py-2 text-2xs', unknown ? 'bg-warn-soft text-warn' : 'bg-down-soft text-down')}>
      {unknown || impactStop ? <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" /> : <CircleX aria-hidden className="mt-px size-3.5 shrink-0" />}
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {state.message && <p className="mt-0.5 break-words">{state.message}</p>}
        {state.signature && <SolscanLink signature={state.signature} label={unknown ? 'Check the transaction on Solscan' : 'View on Solscan'} />}
      </div>
      <Dismiss onClick={onDismiss} />
    </div>
  );
}
