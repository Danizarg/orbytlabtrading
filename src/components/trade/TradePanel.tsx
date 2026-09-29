'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, LoaderCircle, Wallet } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { WalletDialog } from '@/components/connect/WalletDialog';
import { WalletIcon } from '@/components/connect/WalletIcon';
import { cn } from '@/components/ui/cn';
import { useQuote } from '@/data/hooks/useQuote';
import { useSolPrice } from '@/data/hooks/useSolPrice';
import { useWalletBalances } from '@/data/hooks/useWalletBalances';
import { formatAmount, formatSol } from '@/lib/core/format';
import { MINTS, shortAddress } from '@/lib/core/solana';
import { describeError } from '@/lib/net/errors';
import { buildQuoteRequest, errorLines, jupiterTokenUrl, parseAmount, providerLabel, SOL_DECIMALS, type QuoteSide } from '@/lib/services/token';
import { useWallet } from '@/lib/wallet/store';
import { primaryAction, quoteStatus } from './panel/action';
import { AmountBox, BuyPresets, SellPresets } from './panel/AmountInput';
import { checkBalance, decimalToRaw, FEE_RESERVE_LAMPORTS, maxBuyAmount, rawToDecimal, sellAmountForPercent, uiBalanceToRaw } from './panel/amounts';
import { impactGate } from './panel/execution';
import { PositionSummary } from './panel/PositionSummary';
import { ImpactConfirm, QuoteSummary, SlippageRow } from './panel/QuoteSummary';
import { TradeStatus } from './panel/TradeStatus';
import { positionKeys, usePositionCost } from './panel/usePositionCost';
import { useTradeExecution } from './panel/useTradeExecution';
import { Pane } from './parts';
import { useTradeSettings } from './tradeSettings';

/** Recent activity is indexed a few seconds after a swap lands: re-read the position after this long. */
const POSITION_REFRESH_MS = 8_000;
const RESERVE_SOL = rawToDecimal(FEE_RESERVE_LAMPORTS, SOL_DECIMALS);

/**
 * Axiom-style trade panel: Buy / Sell, amount with presets and the connected
 * wallet's balances, slippage, a live Jupiter Ultra quote (refreshed every
 * 10 s while visible) and in-app execution with the connected wallet:
 * Jupiter builds the order for the wallet, the wallet signs, Jupiter lands
 * it. Disconnected, the primary button opens the wallet dialog.
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
  /** Current token price (USD) for the sell-side USD estimate and the position value. */
  priceUsd?: number;
  className?: string;
}) {
  const side = useTradeSettings((s) => s.side);
  const setSideSetting = useTradeSettings((s) => s.setSide);
  const slippageBps = useTradeSettings((s) => s.slippageBps);
  const setSlippageBps = useTradeSettings((s) => s.setSlippageBps);
  const buyPresets = useTradeSettings((s) => s.buyPresets);
  const setBuyPreset = useTradeSettings((s) => s.setBuyPreset);
  const resetBuyPresets = useTradeSettings((s) => s.resetBuyPresets);

  const [amount, setAmount] = useState('');
  // A sell amount is in the token's own units: it never carries over to another token.
  const [amountMint, setAmountMint] = useState(mint);
  if (amountMint !== mint) {
    setAmountMint(mint);
    if (side === 'sell') setAmount('');
  }
  const [dialogOpen, setDialogOpen] = useState(false);
  const [impactAck, setImpactAck] = useState<{ key: string; pct: number } | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const positionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const client = useQueryClient();

  // Wallet discovery / silent reconnect (idempotent and ref-counted; the header starts it too).
  useEffect(() => useWallet.getState().init(), []);
  useEffect(() => () => clearTimeout(positionTimer.current), []);
  const address = useWallet((w) => w.address);
  const walletStatus = useWallet((w) => w.status);
  const walletName = useWallet((w) => w.walletName);
  const walletIcon = useWallet((w) => w.walletIcon);
  const canSignTransaction = useWallet((w) => w.wallets.find((o) => o.name === w.walletName)?.canSignTransaction ?? false);
  const connected = address !== null && (walletStatus === 'connected' || walletStatus === 'signing');
  const owner = connected ? address : null;

  const solPrice = useSolPrice();
  const solUsd = solPrice.data?.data.priceUsd;
  const label = symbol ?? shortAddress(mint);
  const isBuy = side === 'buy';

  const balances = useWalletBalances(owner, mint);
  const tokenDecimals = decimals ?? balances.token?.decimals;
  const position = usePositionCost(owner, mint, balances.token?.amount);

  const { refresh: refreshBalances } = balances;
  const onSent = useCallback(() => {
    refreshBalances();
    if (!owner) return;
    clearTimeout(positionTimer.current);
    positionTimer.current = setTimeout(() => void client.invalidateQueries({ queryKey: positionKeys.activity(owner) }), POSITION_REFRESH_MS);
  }, [refreshBalances, client, owner]);
  const trade = useTradeExecution({ onSent });
  // Switching token abandons a trade the wallet has not signed yet (no prompt for a token
  // no longer on screen) and clears a finished trade's result, which belongs to its own token.
  const { dismiss: dismissTrade, cancel: cancelTrade } = trade;
  useEffect(() => {
    cancelTrade();
    dismissTrade();
  }, [mint, cancelTrade, dismissTrade]);

  const q = useQuote({ mint, side, amount, tokenDecimals, slippageBps, paused: trade.busy });
  const { quote } = q;

  // Amounts in raw units of the input asset (lamports for buys).
  const inputDecimals = isBuy ? SOL_DECIMALS : tokenDecimals;
  const amountRaw = inputDecimals === undefined ? undefined : decimalToRaw(amount, inputDecimals);
  const token = balances.token;
  const tokenRaw = token?.amount === 0 ? 0n : uiBalanceToRaw(token?.amount, tokenDecimals);
  const balanceRaw = isBuy ? balances.sol?.lamports : tokenRaw;
  const balance = connected ? checkBalance({ side, amountRaw, balanceRaw }) : 'unknown';

  // Price impact above 15 % needs an explicit confirmation, tied to this exact token / side / amount / slippage;
  // an order stopped on its impact only counts for the form it was placed with.
  const ackKey = `${mint}|${side}|${amount}|${slippageBps}`;
  const accepted = impactAck?.key === ackKey ? impactAck.pct : undefined;
  const { impactPct: dangerImpact, needsConfirm: needsImpactConfirm } = impactGate({
    quoteImpactPct: quote?.priceImpactPct,
    trade: trade.state,
    key: ackKey,
    acceptedImpactPct: accepted,
  });

  // The order uses the amount as typed now (the quote may still be catching up with it).
  const request = buildQuoteRequest({ side, mint, amount, tokenDecimals, slippageBps });
  const tradable = tokenDecimals !== undefined && mint !== MINTS.SOL;
  const action = primaryAction({
    walletStatus,
    connected,
    walletName,
    canSignTransaction,
    phase: trade.state.phase,
    side,
    symbol: label,
    tradable,
    hasAmount: request !== undefined,
    balance,
    needsImpactConfirm,
  });

  const onPrimary = () => {
    if (action.kind === 'connect') {
      setDialogOpen(true);
      return;
    }
    if (action.kind !== 'trade' || !request) return;
    void trade.execute({
      side,
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amountRaw: request.amountRaw,
      slippageBps,
      symbol: label,
      key: ackKey,
      ...(tokenDecimals !== undefined ? { tokenDecimals } : {}),
      ...(accepted !== undefined ? { acceptedImpactPct: accepted } : {}),
    });
  };

  const closeDialog = () => {
    setDialogOpen(false);
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) primaryRef.current?.focus();
    });
  };

  // Amounts are per side (SOL for buys, tokens for sells): switching side starts from an empty field.
  const setSide = (next: QuoteSide) => {
    if (next === side) return;
    setSideSetting(next);
    setAmount('');
    trade.dismiss();
  };

  const amountNum = parseAmount(amount);
  const amountUsd = amountNum === undefined ? undefined : isBuy ? (solUsd === undefined ? undefined : amountNum * solUsd) : priceUsd === undefined ? undefined : amountNum * priceUsd;

  // A failed refresh keeps the last quote on screen (with its age) but never hides the provider error.
  const { text: status, showError } = quoteStatus({
    tradable,
    isSolMint: mint === MINTS.SOL,
    hasRequest: q.request !== undefined,
    busy: trade.busy,
    loading: q.debouncing || q.isPending || q.stale,
    hasQuote: quote !== undefined,
    failed: q.error !== undefined,
  });
  const quoteErrors = showError && q.error !== undefined ? errorLines(q.error) : [];

  // Balance line in the amount box (connected wallets only).
  let balanceNode: ReactNode | undefined;
  if (connected) {
    if (isBuy) {
      balanceNode = balances.sol ? (
        <span className="tabular text-fg-dim" title={`Source: ${providerLabel(balances.sol.source)}`}>
          {formatSol(balances.sol.sol, { maxDecimals: 4 })}
        </span>
      ) : balances.solError ? (
        <span className="text-faint" title={`Balance unavailable: ${describeError(balances.solError)}`}>
          —
        </span>
      ) : (
        <span className="text-faint">…</span>
      );
    } else {
      balanceNode =
        token?.amount !== undefined ? (
          <span className="tabular text-fg-dim" title={`Source: ${providerLabel(token.source)}`}>
            {formatAmount(token.amount)} {label}
          </span>
        ) : balances.tokenError || token ? (
          <span className="text-faint" title={balances.tokenError ? `Balance unavailable: ${describeError(balances.tokenError)}` : 'Balance not readable from the source'}>
            —
          </span>
        ) : (
          <span className="text-faint">…</span>
        );
    }
  }
  const maxAmount = connected && isBuy ? maxBuyAmount(balances.sol?.lamports) : undefined;

  const sellDisabledTitle = !connected
    ? 'Connect a wallet to sell a share of your balance'
    : balances.tokenPending
      ? 'Loading your balance'
      : token?.amount === 0
        ? `No ${label} in this wallet`
        : 'Balance unavailable';

  const primaryClass =
    action.kind === 'connect'
      ? 'bg-brand text-bg hover:bg-brand-strong'
      : action.kind === 'blocked' || action.kind === 'connecting'
        ? 'bg-panel-3 text-muted'
        : isBuy
          ? 'bg-up text-bg hover:bg-up/90'
          : 'bg-down text-bg hover:bg-down/90';

  return (
    <Pane className={cn('shrink-0', className)}>
      <div className="p-3">
        <div role="group" aria-label="Side" className="grid h-8 grid-cols-2 gap-px rounded-md bg-line p-px">
          {(['buy', 'sell'] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={side === s}
              onClick={() => setSide(s)}
              className={cn(
                'rounded-[5px] text-xs font-semibold transition-colors',
                side === s ? (s === 'buy' ? 'bg-up-soft text-up' : 'bg-down-soft text-down') : 'bg-panel text-muted hover:bg-hover hover:text-fg',
              )}
            >
              {s === 'buy' ? 'Buy' : 'Sell'}
            </button>
          ))}
        </div>

        <div className="mt-2 flex h-6 items-center justify-between">
          <span className="h-6 border-b-2 border-brand text-xs leading-6 font-medium text-fg">Market</span>
          {connected && address && (
            <span className="inline-flex min-w-0 items-center gap-1.5 text-2xs text-muted" title={`${walletName ?? 'Wallet'} ${address}`}>
              <WalletIcon icon={walletIcon} name={walletName} className="size-3.5 rounded-[3px]" />
              <span className="font-mono">{shortAddress(address)}</span>
            </span>
          )}
        </div>

        <AmountBox
          side={side}
          unit={isBuy ? 'SOL' : label}
          amount={amount}
          onAmount={setAmount}
          amountUsd={amountUsd}
          balance={balanceNode}
          onMax={connected && isBuy ? (maxAmount === undefined ? null : () => setAmount(maxAmount)) : undefined}
          maxTitle={
            maxAmount !== undefined
              ? `Balance minus ${RESERVE_SOL} SOL kept for network fees`
              : balances.sol
                ? `Balance is below the ${RESERVE_SOL} SOL kept for network fees`
                : 'Waiting for your SOL balance'
          }
        />

        {isBuy ? (
          <BuyPresets presets={buyPresets} amount={amount} onPick={setAmount} onSave={setBuyPreset} onReset={resetBuyPresets} />
        ) : (
          <SellPresets
            amount={amount}
            amountFor={(pct) => (tokenRaw && tokenRaw > 0n ? sellAmountForPercent(tokenRaw, tokenDecimals, pct) : undefined)}
            disabledTitle={sellDisabledTitle}
            onPick={setAmount}
          />
        )}

        {balance === 'low_reserve' && <p className="mt-1.5 text-2xs text-warn">Leaves less than {RESERVE_SOL} SOL in the wallet for network fees.</p>}

        <SlippageRow slippageBps={slippageBps} onChange={setSlippageBps} />

        <QuoteSummary
          quote={quote}
          side={side}
          symbol={label}
          slippageBps={slippageBps}
          priceUsd={priceUsd}
          solUsd={solUsd}
          status={status}
          fetching={q.isFetching}
          stale={q.stale}
          fetchedAt={q.result?.fetchedAt}
          errorLines={quoteErrors}
        />

        {dangerImpact !== undefined && connected && (
          <ImpactConfirm
            impactPct={dangerImpact}
            checked={!needsImpactConfirm}
            disabled={trade.busy}
            onChange={(checked) => setImpactAck(checked ? { key: ackKey, pct: dangerImpact } : null)}
          />
        )}

        <button
          ref={primaryRef}
          type="button"
          onClick={onPrimary}
          disabled={action.disabled}
          aria-haspopup={action.kind === 'connect' ? 'dialog' : undefined}
          aria-busy={action.kind === 'busy' || undefined}
          className={cn(
            'mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded-md text-sm font-semibold transition-colors disabled:cursor-not-allowed',
            primaryClass,
            action.kind === 'busy' && 'opacity-80',
          )}
        >
          {action.kind === 'connect' && <Wallet aria-hidden className="size-3.5 shrink-0" />}
          {(action.kind === 'busy' || action.kind === 'connecting') && <LoaderCircle aria-hidden className="size-3.5 shrink-0 motion-safe:animate-spin" />}
          <span className="max-w-60 truncate">{action.label}</span>
        </button>

        <TradeStatus
          state={trade.state}
          symbol={label}
          tokenDecimals={tokenDecimals}
          walletName={walletName}
          onDismiss={trade.dismiss}
          onCancel={trade.cancellable ? trade.cancel : undefined}
        />

        <div className="mt-1.5 flex justify-end text-2xs text-faint">
          <a href={jupiterTokenUrl(mint)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 hover:text-fg">
            Open in Jupiter
            <ExternalLink aria-hidden className="size-2.5" />
          </a>
        </div>

        {connected && (
          <PositionSummary
            symbol={label}
            token={token}
            tokenPending={balances.tokenPending}
            tokenError={balances.tokenError}
            priceUsd={priceUsd}
            solUsd={solUsd}
            cost={position.cost}
            costPending={position.isPending}
          />
        )}
      </div>
      {dialogOpen && <WalletDialog initialStep="list" onClose={closeDialog} />}
    </Pane>
  );
}
