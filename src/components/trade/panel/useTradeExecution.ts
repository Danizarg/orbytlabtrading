'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { buildOrder, swap } from '@/lib/swap/jupiter';
import { getWalletState } from '@/lib/wallet/store';
import { IDLE_TRADE, isTradeBusy, isTradeCancellable, runTrade, tradeReducer, type TradeDeps, type TradeOutcome, type TradeRequest } from './execution';

const DEFAULT_DEPS: TradeDeps = {
  buildOrder,
  swap,
  // Read the store at call time: the connected account may have changed since render.
  signTransaction: (transaction) => getWalletState().signTransaction(transaction),
};

export type TradeInput = Omit<TradeRequest, 'id' | 'taker'>;

/**
 * Trade-panel execution state. `execute` runs one trade for the connected
 * wallet (ignored while another is in flight or when no wallet is
 * connected) and calls `onSent` once a signed transaction reached Jupiter,
 * whatever the outcome, so balances refresh.
 *
 * `cancel` abandons the trade in flight while the wallet has not signed yet
 * (nothing is sent, the panel resets quietly); unmounting does the same, so
 * a wallet prompt never opens for a panel that is no longer on screen.
 */
export function useTradeExecution(opts: { deps?: TradeDeps; onSent?: (outcome: TradeOutcome) => void } = {}) {
  const [state, dispatch] = useReducer(tradeReducer, IDLE_TRADE);
  const inFlight = useRef(false);
  const seq = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const deps = opts.deps ?? DEFAULT_DEPS;
  const onSent = opts.onSent;

  useEffect(() => () => controller.current?.abort(), []);

  const execute = useCallback(
    async (input: TradeInput): Promise<TradeOutcome | undefined> => {
      if (inFlight.current) return undefined;
      const taker = getWalletState().address;
      if (!taker) return undefined;
      inFlight.current = true;
      const id = ++seq.current;
      const ctl = new AbortController();
      controller.current = ctl;
      try {
        const outcome = await runTrade(deps, { ...input, id, taker }, dispatch, { signal: ctl.signal });
        if (outcome === 'confirmed' || outcome === 'failed' || outcome === 'unknown') onSent?.(outcome);
        return outcome;
      } finally {
        inFlight.current = false;
        if (controller.current === ctl) controller.current = null;
      }
    },
    [deps, onSent],
  );

  const dismiss = useCallback(() => dispatch({ type: 'dismiss' }), []);
  /** Abandon the trade in flight if the wallet has not signed yet; a no-op otherwise. */
  const cancel = useCallback(() => controller.current?.abort(), []);

  return { state, busy: isTradeBusy(state.phase), cancellable: isTradeCancellable(state.phase), execute, dismiss, cancel };
}
