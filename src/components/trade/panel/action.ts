/**
 * Primary trade button: what it says and whether it can be pressed (pure;
 * tested in action.test.ts).
 */

import type { QuoteSide } from '@/lib/services/token';
import type { WalletStatus } from '@/lib/wallet/store';
import type { BalanceCheck } from './amounts';
import type { TradePhase } from './execution';

export type PrimaryKind = 'connect' | 'connecting' | 'busy' | 'blocked' | 'trade';

export interface PrimaryAction {
  kind: PrimaryKind;
  label: string;
  disabled: boolean;
}

export interface PrimaryInput {
  walletStatus: WalletStatus;
  /** A wallet account is connected. */
  connected: boolean;
  walletName: string | null;
  /** The connected wallet supports solana:signTransaction. */
  canSignTransaction: boolean;
  phase: TradePhase;
  side: QuoteSide;
  symbol: string;
  /** Token decimals are known and the pair can be quoted. */
  tradable: boolean;
  /** The amount field holds a positive amount. */
  hasAmount: boolean;
  balance: BalanceCheck;
  /** Price impact is above 15 % and not yet confirmed. */
  needsImpactConfirm: boolean;
}

export function primaryAction(input: PrimaryInput): PrimaryAction {
  const { phase } = input;
  if (phase === 'building') return { kind: 'busy', label: 'Preparing order…', disabled: true };
  if (phase === 'signing') return { kind: 'busy', label: `Approve in ${input.walletName ?? 'your wallet'}…`, disabled: true };
  if (phase === 'submitting') return { kind: 'busy', label: 'Submitting…', disabled: true };
  if (!input.connected) {
    return input.walletStatus === 'connecting'
      ? { kind: 'connecting', label: 'Connecting wallet…', disabled: true }
      : { kind: 'connect', label: 'Connect wallet', disabled: false };
  }
  const blocked = (label: string): PrimaryAction => ({ kind: 'blocked', label, disabled: true });
  if (!input.canSignTransaction) return blocked(`${input.walletName ?? 'This wallet'} cannot sign swaps`);
  if (!input.tradable) return blocked('Loading token…');
  if (!input.hasAmount) return blocked('Enter an amount');
  if (input.balance === 'insufficient') return blocked(input.side === 'buy' ? 'Insufficient SOL' : `Insufficient ${input.symbol}`);
  if (input.needsImpactConfirm) return blocked('Confirm the price impact');
  return { kind: 'trade', label: `${input.side === 'buy' ? 'Buy' : 'Sell'} ${input.symbol}`, disabled: false };
}

export interface QuoteStatusInput {
  /** Token decimals known and the mint is not SOL itself. */
  tradable: boolean;
  isSolMint: boolean;
  /** The (debounced) amount makes a valid quote request. */
  hasRequest: boolean;
  /** A trade is in flight (quote refresh paused). */
  busy: boolean;
  /** Debouncing, first load, or a placeholder quote for a previous amount / slippage. */
  loading: boolean;
  hasQuote: boolean;
  /** The last quote request failed. */
  failed: boolean;
}

/**
 * Status line under the quote rows and whether the provider error is shown.
 * A failed refresh keeps the last quote on screen with its age, but never
 * hides the error behind "Refreshes every 10 s".
 */
export function quoteStatus(input: QuoteStatusInput): { text: string; showError: boolean } {
  const showError = input.failed && input.hasRequest && !input.loading;
  if (!input.tradable) return { text: input.isSolMint ? 'Pick a token to trade against SOL' : 'Waiting for token decimals', showError: false };
  if (!input.hasRequest) return { text: 'Enter an amount for a live quote', showError: false };
  if (input.busy) return { text: 'Quote paused while the trade runs', showError };
  if (input.loading) return { text: 'Quoting…', showError: false };
  if (input.hasQuote) return { text: input.failed ? 'Update failed · last quote shown' : 'Refreshes every 10 s', showError };
  return { text: '', showError };
}
