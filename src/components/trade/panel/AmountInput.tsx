'use client';

import { Check, Pencil, RotateCcw } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { formatUsd } from '@/lib/core/format';
import { SELL_PCT_PRESETS, sanitizeAmountInput, type QuoteSide } from '@/lib/services/token';
import { Chip } from '../parts';
import { formatPreset, invalidPresetDraft } from './amounts';

/** "You pay / You sell" field with the wallet balance of the input asset and an optional Max. */
export function AmountBox({
  side,
  unit,
  amount,
  onAmount,
  amountUsd,
  balance,
  onMax,
  maxTitle,
}: {
  side: QuoteSide;
  /** Input asset shown next to the field: SOL for buys, the token symbol for sells. */
  unit: string;
  amount: string;
  onAmount: (value: string) => void;
  amountUsd: number | undefined;
  /** Balance line (hidden while no wallet is connected). */
  balance?: ReactNode;
  /** Present on buys: fills the balance minus the fee reserve; undefined disables Max. */
  onMax?: (() => void) | null;
  maxTitle?: string;
}) {
  return (
    <div className="mt-2 rounded-md border border-line bg-panel-2 px-2.5 py-2 focus-within:border-line-strong">
      <div className="flex h-4 items-center justify-between gap-2 text-2xs text-muted">
        <span>{side === 'buy' ? 'You pay' : 'You sell'}</span>
        {balance !== undefined && (
          <span className="flex min-w-0 items-center gap-1.5">
            {balance}
            {onMax !== undefined && (
              <button
                type="button"
                onClick={onMax ?? undefined}
                disabled={!onMax}
                title={maxTitle}
                className="rounded px-1 font-semibold text-brand-strong transition-colors hover:bg-brand-soft disabled:text-faint disabled:hover:bg-transparent"
              >
                Max
              </button>
            )}
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <input
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          aria-label={side === 'buy' ? 'SOL amount' : `${unit} amount`}
          placeholder="0.0"
          value={amount}
          onChange={(e) => onAmount(sanitizeAmountInput(e.target.value))}
          className="h-7 min-w-0 flex-1 bg-transparent font-display text-lg font-semibold tabular text-fg outline-none placeholder:text-faint"
        />
        <span className="max-w-24 shrink-0 truncate text-xs font-semibold text-fg-dim" title={unit}>
          {unit}
        </span>
      </div>
      <div className="mt-0.5 h-4 text-2xs text-faint tabular">{amountUsd === undefined ? '' : `≈ ${formatUsd(amountUsd, { compact: false })}`}</div>
    </div>
  );
}

/** Buy preset chips (SOL); the pencil turns them into inputs saved in this browser. */
export function BuyPresets({
  presets,
  amount,
  onPick,
  onSave,
  onReset,
}: {
  presets: readonly number[];
  amount: string;
  onPick: (value: string) => void;
  /** Returns false when the text is not a valid SOL amount. */
  onSave: (index: number, text: string) => boolean;
  onReset: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<string[]>([]);
  const [invalid, setInvalid] = useState<number | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);

  const start = () => {
    setDrafts(presets.map(formatPreset));
    setInvalid(null);
    setEditing(true);
  };
  const finish = () => {
    // All or nothing: one invalid draft saves none of them (no half-edited set).
    const bad = invalidPresetDraft(drafts);
    if (bad !== undefined) {
      setInvalid(bad);
      return;
    }
    for (let i = 0; i < drafts.length; i++) {
      const draft = drafts[i] ?? '';
      if (draft !== formatPreset(presets[i] ?? NaN)) onSave(i, draft);
    }
    setEditing(false);
    requestAnimationFrame(() => editButton.current?.focus());
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') finish();
    else if (e.key === 'Escape') {
      setEditing(false);
      requestAnimationFrame(() => editButton.current?.focus());
    }
  };

  return (
    <div className="mt-1.5 flex items-center gap-1">
      <div className="grid flex-1 grid-cols-4 gap-1">
        {editing
          ? drafts.map((draft, i) => (
              <label
                key={i}
                className={cn('flex h-7 items-center rounded bg-panel-2 px-1.5 text-2xs ring-1', invalid === i ? 'text-down ring-down/60' : 'text-fg ring-brand/40')}
              >
                <input
                  inputMode="decimal"
                  aria-label={`Buy preset ${i + 1} in SOL`}
                  aria-invalid={invalid === i || undefined}
                  autoFocus={i === 0}
                  value={draft}
                  onChange={(e) => {
                    const next = [...drafts];
                    next[i] = sanitizeAmountInput(e.target.value);
                    setDrafts(next);
                    if (invalid === i) setInvalid(null);
                  }}
                  onKeyDown={onKey}
                  className="w-full min-w-0 bg-transparent text-center tabular outline-none"
                />
              </label>
            ))
          : presets.map((v, i) => {
              const text = formatPreset(v);
              return (
                <Chip key={i} active={amount === text} onClick={() => onPick(text)} className="h-7 bg-panel-2" title={`${text} SOL`}>
                  {text} SOL
                </Chip>
              );
            })}
      </div>
      {editing ? (
        <>
          <button type="button" aria-label="Reset buy presets" title="Reset to 0.1 / 0.5 / 1 / 5 SOL" onClick={() => { onReset(); setEditing(false); }} className="inline-flex size-7 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-fg">
            <RotateCcw aria-hidden className="size-3" />
          </button>
          <button type="button" aria-label="Save buy presets" onClick={finish} className="inline-flex size-7 shrink-0 items-center justify-center rounded text-up transition-colors hover:bg-up-soft">
            <Check aria-hidden className="size-3.5" />
          </button>
        </>
      ) : (
        <button
          ref={editButton}
          type="button"
          aria-label="Edit buy presets"
          title="Edit buy presets (saved in this browser)"
          onClick={start}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <Pencil aria-hidden className="size-3" />
        </button>
      )}
    </div>
  );
}

/** 25 / 50 / 75 / 100 % of the wallet's token balance. */
export function SellPresets({
  amount,
  amountFor,
  disabledTitle,
  onPick,
}: {
  amount: string;
  /** Field text for a percentage; undefined while the balance is unknown or empty. */
  amountFor: (pct: number) => string | undefined;
  disabledTitle: string;
  onPick: (value: string) => void;
}) {
  return (
    <div className="mt-1.5 grid grid-cols-4 gap-1">
      {SELL_PCT_PRESETS.map((pct) => {
        const value = amountFor(pct);
        return (
          <Chip
            key={pct}
            tone="down"
            disabled={value === undefined}
            active={value !== undefined && amount === value}
            onClick={value === undefined ? undefined : () => onPick(value)}
            className="h-7 bg-panel-2"
            title={value === undefined ? disabledTitle : `${pct}% of your balance`}
          >
            {pct}%
          </Chip>
        );
      })}
    </div>
  );
}
