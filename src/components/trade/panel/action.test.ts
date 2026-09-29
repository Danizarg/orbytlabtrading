import { describe, expect, it } from 'vitest';
import { primaryAction, quoteStatus, type PrimaryInput, type QuoteStatusInput } from './action';

describe('quoteStatus', () => {
  const live: QuoteStatusInput = { tradable: true, isSolMint: false, hasRequest: true, busy: false, loading: false, hasQuote: true, failed: false };

  it('a live quote refreshes every 10 s', () => {
    expect(quoteStatus(live)).toEqual({ text: 'Refreshes every 10 s', showError: false });
  });

  it('a failed refresh keeps the last quote but says so and shows the provider error', () => {
    expect(quoteStatus({ ...live, failed: true })).toEqual({ text: 'Update failed · last quote shown', showError: true });
  });

  it('a failed first quote shows the error', () => {
    expect(quoteStatus({ ...live, hasQuote: false, failed: true })).toEqual({ text: '', showError: true });
  });

  it('while a new amount / slippage is quoted, an older error is not shown', () => {
    expect(quoteStatus({ ...live, loading: true, failed: true })).toEqual({ text: 'Quoting…', showError: false });
  });

  it('no request, no token decimals, or a trade in flight', () => {
    expect(quoteStatus({ ...live, hasRequest: false, failed: true })).toEqual({ text: 'Enter an amount for a live quote', showError: false });
    expect(quoteStatus({ ...live, tradable: false })).toEqual({ text: 'Waiting for token decimals', showError: false });
    expect(quoteStatus({ ...live, tradable: false, isSolMint: true }).text).toBe('Pick a token to trade against SOL');
    expect(quoteStatus({ ...live, busy: true }).text).toBe('Quote paused while the trade runs');
  });
});

const ready: PrimaryInput = {
  walletStatus: 'connected',
  connected: true,
  walletName: 'Phantom',
  canSignTransaction: true,
  phase: 'idle',
  side: 'buy',
  symbol: 'BONK',
  tradable: true,
  hasAmount: true,
  balance: 'ok',
  needsImpactConfirm: false,
};

describe('primaryAction', () => {
  it('disconnected: "Connect wallet" opens the dialog', () => {
    expect(primaryAction({ ...ready, connected: false, walletStatus: 'idle' })).toEqual({ kind: 'connect', label: 'Connect wallet', disabled: false });
    expect(primaryAction({ ...ready, connected: false, walletStatus: 'error' }).kind).toBe('connect');
    expect(primaryAction({ ...ready, connected: false, walletStatus: 'connecting' })).toMatchObject({ kind: 'connecting', disabled: true });
  });

  it('connected: "Buy <SYMBOL>" / "Sell <SYMBOL>"', () => {
    expect(primaryAction(ready)).toEqual({ kind: 'trade', label: 'Buy BONK', disabled: false });
    expect(primaryAction({ ...ready, side: 'sell' })).toEqual({ kind: 'trade', label: 'Sell BONK', disabled: false });
    // A low fee reserve warns but does not block.
    expect(primaryAction({ ...ready, balance: 'low_reserve' }).disabled).toBe(false);
    expect(primaryAction({ ...ready, balance: 'unknown' }).disabled).toBe(false);
  });

  it('disabled while a trade is in flight, naming the step', () => {
    expect(primaryAction({ ...ready, phase: 'building' })).toEqual({ kind: 'busy', label: 'Preparing order…', disabled: true });
    expect(primaryAction({ ...ready, phase: 'signing' })).toEqual({ kind: 'busy', label: 'Approve in Phantom…', disabled: true });
    expect(primaryAction({ ...ready, phase: 'submitting' })).toEqual({ kind: 'busy', label: 'Submitting…', disabled: true });
    // Even if the wallet disconnects mid-flight, the button stays locked.
    expect(primaryAction({ ...ready, phase: 'submitting', connected: false }).disabled).toBe(true);
  });

  it('blocks with a reason', () => {
    expect(primaryAction({ ...ready, canSignTransaction: false })).toMatchObject({ kind: 'blocked', label: 'Phantom cannot sign swaps' });
    expect(primaryAction({ ...ready, tradable: false })).toMatchObject({ kind: 'blocked', label: 'Loading token…' });
    expect(primaryAction({ ...ready, hasAmount: false })).toMatchObject({ kind: 'blocked', label: 'Enter an amount' });
    expect(primaryAction({ ...ready, balance: 'insufficient' })).toMatchObject({ kind: 'blocked', label: 'Insufficient SOL' });
    expect(primaryAction({ ...ready, side: 'sell', balance: 'insufficient' })).toMatchObject({ kind: 'blocked', label: 'Insufficient BONK' });
    expect(primaryAction({ ...ready, needsImpactConfirm: true })).toMatchObject({ kind: 'blocked', label: 'Confirm the price impact', disabled: true });
  });

  it('finished trades return to the trade button', () => {
    for (const phase of ['confirmed', 'failed', 'unknown'] as const) expect(primaryAction({ ...ready, phase }).kind).toBe('trade');
  });
});
