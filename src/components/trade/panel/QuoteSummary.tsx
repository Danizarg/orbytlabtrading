'use client';

import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNow } from '@/client/hooks/useNow';
import { cn } from '@/components/ui/cn';
import { formatAge, formatAmount, formatPct, formatPrice, formatUsd } from '@/lib/core/format';
import type { SwapQuote } from '@/lib/core/types';
import { formatSlippage, parseSlippagePct, priceImpactTone, quoteRate, SLIPPAGE_PRESETS_BPS, type QuoteSide } from '@/lib/services/token';
import { Chip, Dash } from '../parts';
import { minReceived } from './amounts';

const IMPACT_CLASS = { ok: 'text-fg-dim', warn: 'text-warn', danger: 'text-down', unknown: 'text-faint' } as const;

/** Slippage presets 1 / 5 / 10 / 20 % plus a custom percentage (0.01–50 %). */
export function SlippageRow({ slippageBps, onChange }: { slippageBps: number; onChange: (bps: number) => void }) {
  const [custom, setCustom] = useState('');
  const customActive = !SLIPPAGE_PRESETS_BPS.includes(slippageBps);
  return (
    <div className="mt-2 flex items-center gap-1">
      <span className="w-14 shrink-0 text-2xs text-muted">Slippage</span>
      {SLIPPAGE_PRESETS_BPS.map((bps) => (
        <Chip
          key={bps}
          active={slippageBps === bps}
          onClick={() => {
            onChange(bps);
            setCustom('');
          }}
          className="flex-1 bg-panel-2"
        >
          {formatSlippage(bps)}
        </Chip>
      ))}
      <label className={cn('flex h-6 w-16 shrink-0 items-center rounded bg-panel-2 px-1.5 text-2xs', customActive ? 'text-brand-strong ring-1 ring-brand/50' : 'text-muted')}>
        <input
          inputMode="decimal"
          aria-label="Custom slippage percent"
          placeholder={customActive ? formatSlippage(slippageBps).replace('%', '') : 'Custom'}
          value={custom}
          onChange={(e) => {
            const text = e.target.value.slice(0, 6);
            setCustom(text);
            const bps = parseSlippagePct(text);
            if (bps !== undefined) onChange(bps);
          }}
          className="w-full min-w-0 bg-transparent tabular outline-none placeholder:text-faint"
        />
        %
      </label>
    </div>
  );
}

function Row({ label, children, title, className }: { label: string; children: ReactNode; title?: string; className?: string }) {
  return (
    <div className={cn('flex h-6 items-center justify-between gap-3 text-xs', className)} title={title}>
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 truncate text-right tabular text-fg-dim">{children}</span>
    </div>
  );
}

function QuoteAge({ at }: { at?: number }) {
  const now = useNow();
  if (!at || !now) return null;
  return <span className="tabular">{formatAge(at, now)} ago</span>;
}

/** Quote rows: you receive, rate, price impact, min received, route, router, fees; plus status and errors. */
export function QuoteSummary({
  quote,
  side,
  symbol,
  slippageBps,
  priceUsd,
  solUsd,
  status,
  fetching,
  stale,
  fetchedAt,
  errorLines,
}: {
  quote: SwapQuote | undefined;
  side: QuoteSide;
  symbol: string;
  slippageBps: number;
  priceUsd: number | undefined;
  solUsd: number | undefined;
  status: string;
  fetching: boolean;
  stale: boolean;
  fetchedAt: number | undefined;
  errorLines: readonly string[];
}) {
  const isBuy = side === 'buy';
  const receiveSymbol = isBuy ? symbol : 'SOL';
  const rate = quote ? quoteRate(quote, side) : undefined;
  const impactTone = priceImpactTone(quote?.priceImpactPct);
  const min = quote ? minReceived(quote.outAmount, quote.slippageBps ?? slippageBps) : undefined;
  const outUsd = quote?.outUsd ?? (quote ? (isBuy ? (priceUsd === undefined ? undefined : quote.outAmount * priceUsd) : solUsd === undefined ? undefined : quote.outAmount * solUsd) : undefined);

  return (
    <div className={cn('mt-2 border-t border-line pt-1.5 transition-opacity', stale && 'opacity-50')} aria-busy={stale || undefined}>
      <Row label="You receive" title="Jupiter quote for the entered amount">
        {quote ? (
          <>
            <span className="text-fg">≈ {formatAmount(quote.outAmount)}</span> {receiveSymbol}
            {outUsd !== undefined && <span className="ml-1 text-faint">({formatUsd(outUsd)})</span>}
          </>
        ) : (
          <Dash />
        )}
      </Row>
      <Row label="Rate">{rate === undefined ? <Dash /> : `1 ${symbol} = ${formatPrice(rate, { currency: false })} SOL`}</Row>
      <Row label="Price impact" title="Above 5 % is high; above 15 % needs your confirmation">
        <span className={cn('inline-flex items-center gap-1', IMPACT_CLASS[impactTone])}>
          {impactTone !== 'ok' && impactTone !== 'unknown' && <TriangleAlert aria-hidden className="size-3" />}
          {quote?.priceImpactPct === undefined ? <Dash /> : formatPct(quote.priceImpactPct, { signed: false })}
        </span>
      </Row>
      <Row label="Min. received" title={`Quoted amount minus ${formatSlippage(quote?.slippageBps ?? slippageBps)} slippage`}>
        {min === undefined ? <Dash /> : `${formatAmount(min)} ${receiveSymbol}`}
      </Row>
      <Row label="Route" title={quote?.route.join(' → ')}>
        {quote?.route.length ? quote.route.join(' → ') : <Dash />}
      </Row>
      <Row label="Router" title="Jupiter routing product that produced this quote">
        {quote?.router ?? <Dash />}
      </Row>
      <Row label="Fees" title="Jupiter's swap fee as quoted; network fees are set when the order is built">
        {quote?.feeBps === undefined ? <Dash /> : `${(quote.feeBps / 100).toFixed(2)}%`}
      </Row>
      <div className="flex h-5 items-center justify-between text-2xs text-faint">
        <span className="inline-flex items-center gap-1">
          {fetching && <RefreshCw aria-hidden className="size-3 motion-safe:animate-spin" />}
          {status}
        </span>
        <QuoteAge at={fetchedAt} />
      </div>
      {errorLines.length > 0 && (
        <ul role="alert" className="text-2xs text-down">
          {errorLines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Explicit confirmation for a price impact above 15 %. */
export function ImpactConfirm({ impactPct, checked, onChange, disabled }: { impactPct: number; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-md border border-down/40 bg-down-soft px-2.5 py-2 text-2xs leading-snug text-down">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-3.5 shrink-0 accent-[var(--color-down)]"
      />
      <span>
        Price impact is <span className="font-semibold tabular">{formatPct(impactPct, { signed: false })}</span>. You would receive much less than the market price.
        Tick to confirm this trade anyway.
      </span>
    </label>
  );
}
