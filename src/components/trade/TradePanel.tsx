'use client';

import { ChevronDown, ExternalLink, Lock, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useNow } from '@/client/hooks/useNow';
import { cn } from '@/components/ui/cn';
import { useQuote } from '@/data/hooks/useQuote';
import { useSolPrice } from '@/data/hooks/useSolPrice';
import { DASH, formatAge, formatAmount, formatPct, formatPrice, formatUsd } from '@/lib/core/format';
import { shortAddress } from '@/lib/core/solana';
import {
  errorLines,
  formatSlippage,
  jupiterSwapUrl,
  parseAmount,
  parseSlippagePct,
  priceImpactTone,
  quoteRate,
  sanitizeAmountInput,
  SELL_PCT_PRESETS,
  SLIPPAGE_PRESETS_BPS,
  SOL_PRESETS,
} from '@/lib/services/token';
import { Chip, Dash, Pane } from './parts';
import { useTradeSettings } from './tradeSettings';

const IMPACT_CLASS = { ok: 'text-fg-dim', warn: 'text-warn', danger: 'text-down', unknown: 'text-faint' } as const;

function QuoteAge({ at }: { at?: number }) {
  const now = useNow();
  if (!at || !now) return null;
  return <span className="tabular">{formatAge(at, now)} ago</span>;
}

function Row({ label, children, title, className }: { label: string; children: React.ReactNode; title?: string; className?: string }) {
  return (
    <div className={cn('flex h-6 items-center justify-between gap-3 text-xs', className)} title={title}>
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 truncate text-right tabular text-fg-dim">{children}</span>
    </div>
  );
}

/**
 * Axiom-style trade panel, read-only: Buy / Sell, Market / Limit, amount with
 * presets, slippage, an informational Advanced section and a REAL Jupiter
 * quote refreshed every 10 s. The primary button opens the pair on Jupiter in
 * a new tab. ORBYT holds no wallet and never signs.
 */
export function TradePanel({
  mint,
  symbol,
  decimals,
  priceUsd,
  className,
}: {
  mint: string;
  symbol?: string;
  decimals?: number;
  /** Current token price (USD) for the sell-side USD estimate. */
  priceUsd?: number;
  className?: string;
}) {
  const s = useTradeSettings();
  const [amount, setAmount] = useState('');
  const [customSlippage, setCustomSlippage] = useState('');
  const solPrice = useSolPrice();
  const solUsd = solPrice.data?.data.priceUsd;
  const label = symbol ?? shortAddress(mint);
  const isBuy = s.side === 'buy';
  const market = s.orderMode === 'market';

  const { quote, result, request, debouncing, error, isPending, isFetching } = useQuote({
    mint,
    side: s.side,
    amount,
    tokenDecimals: decimals,
    slippageBps: s.slippageBps,
    enabled: market,
  });

  const amountNum = parseAmount(amount);
  const amountUsd = amountNum === undefined ? undefined : isBuy ? (solUsd === undefined ? undefined : amountNum * solUsd) : priceUsd === undefined ? undefined : amountNum * priceUsd;
  const rate = quote ? quoteRate(quote, s.side) : undefined;
  const impactTone = priceImpactTone(quote?.priceImpactPct);
  const slippageForMin = quote?.slippageBps ?? s.slippageBps;
  const minReceived = quote ? quote.outAmount * (1 - slippageForMin / 10_000) : undefined;
  const receiveSymbol = isBuy ? label : 'SOL';
  const outUsd = quote?.outUsd ?? (quote ? (isBuy ? (priceUsd === undefined ? undefined : quote.outAmount * priceUsd) : solUsd === undefined ? undefined : quote.outAmount * solUsd) : undefined);
  const customIsActive = !SLIPPAGE_PRESETS_BPS.includes(s.slippageBps);

  return (
    <Pane className={cn('shrink-0', className)}>
      <div className="p-3">
        <div role="tablist" aria-label="Side" className="grid h-8 grid-cols-2 gap-px rounded-md bg-line p-px">
          <button
            type="button"
            role="tab"
            aria-selected={isBuy}
            onClick={() => s.setSide('buy')}
            className={cn('rounded-[5px] text-xs font-semibold transition-colors', isBuy ? 'bg-up-soft text-up' : 'bg-panel text-muted hover:bg-hover hover:text-fg')}
          >
            Buy
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!isBuy}
            onClick={() => s.setSide('sell')}
            className={cn('rounded-[5px] text-xs font-semibold transition-colors', !isBuy ? 'bg-down-soft text-down' : 'bg-panel text-muted hover:bg-hover hover:text-fg')}
          >
            Sell
          </button>
        </div>

        <div className="mt-2 flex items-center justify-between">
          <div role="tablist" aria-label="Order type" className="flex items-center gap-2">
            {(['market', 'limit'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={s.orderMode === mode}
                onClick={() => s.setOrderMode(mode)}
                className={cn(
                  'h-6 border-b-2 text-xs font-medium capitalize transition-colors',
                  s.orderMode === mode ? 'border-brand text-fg' : 'border-transparent text-muted hover:text-fg',
                )}
              >
                {mode}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => s.setAdvancedOpen(!s.advancedOpen)}
            aria-expanded={s.advancedOpen}
            className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-2xs text-muted hover:bg-hover hover:text-fg"
            title="Slippage, priority fee, MEV protection"
          >
            Slip {formatSlippage(s.slippageBps)}
            <ChevronDown aria-hidden className={cn('size-3 transition-transform', s.advancedOpen && 'rotate-180')} />
          </button>
        </div>

        {market ? (
          <>
            <div className="mt-2 rounded-md border border-line bg-panel-2 px-2.5 py-2">
              <div className="flex items-center justify-between text-2xs text-muted">
                <span>{isBuy ? 'You pay' : 'You sell'}</span>
                <span title="Wallet balance is unavailable until a wallet is connected">
                  Balance <span className="text-faint">{DASH}</span>
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <input
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={isBuy ? 'SOL amount' : `${label} amount`}
                  placeholder="0.0"
                  value={amount}
                  onChange={(e) => setAmount(sanitizeAmountInput(e.target.value))}
                  className="h-7 min-w-0 flex-1 bg-transparent font-display text-lg font-semibold tabular text-fg outline-none placeholder:text-faint"
                />
                <span className="shrink-0 text-xs font-semibold text-fg-dim">{isBuy ? 'SOL' : label}</span>
              </div>
              <div className="mt-0.5 h-4 text-2xs text-faint tabular">{amountUsd === undefined ? '' : `≈ ${formatUsd(amountUsd, { compact: false })}`}</div>
            </div>

            <div className="mt-1.5 grid grid-cols-4 gap-1">
              {isBuy
                ? SOL_PRESETS.map((v) => (
                    <Chip key={v} active={amount === String(v)} onClick={() => setAmount(String(v))} className="h-7 bg-panel-2" title={`${v} SOL`}>
                      {v} SOL
                    </Chip>
                  ))
                : SELL_PCT_PRESETS.map((pct) => (
                    <Chip key={pct} disabled className="h-7 bg-panel-2" title="Percent of holdings needs a connected wallet">
                      {pct}%
                    </Chip>
                  ))}
            </div>

            {s.advancedOpen && (
              <div className="mt-2 space-y-2 rounded-md border border-line px-2.5 py-2">
                <div>
                  <div className="flex items-center justify-between text-2xs text-muted">
                    <span>Slippage</span>
                    <span className="tabular text-fg-dim">{formatSlippage(s.slippageBps)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1">
                    {SLIPPAGE_PRESETS_BPS.map((bps) => (
                      <Chip key={bps} active={s.slippageBps === bps} onClick={() => s.setSlippageBps(bps)} className="flex-1 bg-panel-2">
                        {formatSlippage(bps)}
                      </Chip>
                    ))}
                    <label className={cn('flex h-6 w-16 items-center rounded bg-panel-2 px-1.5 text-2xs', customIsActive ? 'text-brand-strong ring-1 ring-brand/50' : 'text-muted')}>
                      <input
                        inputMode="decimal"
                        aria-label="Custom slippage percent"
                        placeholder="Custom"
                        value={customSlippage}
                        onChange={(e) => {
                          const text = e.target.value.slice(0, 6);
                          setCustomSlippage(text);
                          const bps = parseSlippagePct(text);
                          if (bps !== undefined) s.setSlippageBps(bps);
                        }}
                        className="w-full bg-transparent tabular outline-none placeholder:text-faint"
                      />
                      %
                    </label>
                  </div>
                </div>
                <div className="flex items-center justify-between text-2xs">
                  <span className="text-muted">Priority fee</span>
                  <label className="flex h-6 items-center gap-1 rounded bg-panel-2 px-1.5 text-fg-dim">
                    <input
                      inputMode="decimal"
                      aria-label="Priority fee in SOL"
                      value={s.priorityFeeSol}
                      onChange={(e) => s.setPriorityFeeSol(sanitizeAmountInput(e.target.value))}
                      className="w-14 bg-transparent text-right tabular outline-none"
                    />
                    SOL
                  </label>
                </div>
                <label className="flex items-center justify-between text-2xs">
                  <span className="text-muted">MEV protection</span>
                  <span className="inline-flex items-center gap-1.5 text-fg-dim">
                    <input type="checkbox" checked={s.mevProtection} onChange={(e) => s.setMevProtection(e.target.checked)} className="size-3 accent-[var(--color-brand)]" />
                    {s.mevProtection ? 'On' : 'Off'}
                  </span>
                </label>
                <p className="text-2xs leading-4 text-faint">Priority fee and MEV protection are applied in your wallet or Jupiter; the swap link does not carry them.</p>
              </div>
            )}

            <div className="mt-2 border-t border-line pt-1.5">
              <Row label="You receive" title="Jupiter quote for the entered amount">
                {quote ? (
                  <>
                    <span className="text-fg">≈ {formatAmount(quote.outAmount, { maxDecimals: isBuy ? 2 : 4 })}</span> {receiveSymbol}
                    {outUsd !== undefined && <span className="ml-1 text-faint">({formatUsd(outUsd)})</span>}
                  </>
                ) : (
                  <Dash />
                )}
              </Row>
              <Row label="Rate">{rate === undefined ? <Dash /> : `1 ${label} = ${formatPrice(rate, { currency: false })} SOL`}</Row>
              <Row label="Price impact">
                <span className={IMPACT_CLASS[impactTone]}>{quote?.priceImpactPct === undefined ? <Dash /> : formatPct(quote.priceImpactPct, { signed: false })}</span>
              </Row>
              <Row label="Min. received" title="Quoted amount minus the slippage setting">
                {minReceived === undefined ? <Dash /> : `${formatAmount(minReceived, { maxDecimals: isBuy ? 2 : 4 })} ${receiveSymbol}`}
              </Row>
              <Row label="Route" title={quote?.route.join(' → ')}>
                {quote?.route.length ? quote.route.join(' → ') : <Dash />}
              </Row>
              <Row label="Router" title="Jupiter routing product that produced this quote">
                {quote?.router ?? <Dash />}
              </Row>
              <Row label="Fees">{quote?.feeBps === undefined ? <Dash /> : `${(quote.feeBps / 100).toFixed(2)}%`}</Row>
              <div className="flex h-5 items-center justify-between text-2xs text-faint">
                <span className="inline-flex items-center gap-1">
                  {isFetching && <RefreshCw aria-hidden className="size-3 animate-spin" />}
                  {request === undefined
                    ? decimals === undefined
                      ? 'Waiting for token decimals'
                      : 'Enter an amount for a live quote'
                    : debouncing || isPending
                      ? 'Quoting…'
                      : quote
                        ? 'Quote refreshes every 10 s'
                        : ''}
                </span>
                <QuoteAge at={result?.fetchedAt} />
              </div>
              {error !== undefined && !quote && request !== undefined && !isPending && (
                <ul role="alert" className="text-2xs text-down">
                  {errorLines(error).map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              )}
            </div>

            <a
              href={jupiterSwapUrl(mint, s.side)}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'mt-2 flex h-9 items-center justify-center gap-1.5 rounded-md text-sm font-semibold text-bg transition-colors',
                isBuy ? 'bg-up hover:bg-up/90' : 'bg-down hover:bg-down/90',
              )}
            >
              {isBuy ? 'Buy' : 'Sell'} {label}
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
            <p className="mt-1 text-center text-2xs text-faint">Opens Jupiter in a new tab · ORBYT never signs or holds funds</p>
          </>
        ) : (
          <div className="mt-2 rounded-md border border-line bg-panel-2 px-3 py-4 text-center">
            <Lock aria-hidden className="mx-auto size-4 text-muted" />
            <p className="mt-2 text-xs font-medium text-fg-dim">Limit orders require a connected wallet</p>
            <p className="mt-1 text-2xs text-muted">Trigger orders are placed through Jupiter with your own wallet. Market quotes stay available here.</p>
          </div>
        )}

        <div className="mt-2 grid grid-cols-3 gap-1 border-t border-line pt-2 text-2xs">
          {[
            ['SOL balance', 'Balance shows once a wallet is connected'],
            ['Position', 'Holdings show once a wallet is connected'],
            ['PnL', 'Profit and loss shows once a wallet is connected'],
          ].map(([name, title]) => (
            <div key={name} className="min-w-0" title={title}>
              <div className="truncate text-faint">{name}</div>
              <div className="tabular text-fg-dim">
                <Dash />
              </div>
            </div>
          ))}
        </div>
      </div>
      <p className="border-t border-line px-3 py-1.5 text-center text-2xs text-faint">Connect wallet to trade in-app — coming soon</p>
    </Pane>
  );
}
