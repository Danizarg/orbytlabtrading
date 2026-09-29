'use client';

import { useCallback, useRef, useState } from 'react';
import { getWalletState } from '@/lib/wallet/store';
import { isSwapError, SwapError } from './errors';
import { buildOrder as defaultBuild, swap as defaultSwap, type ExecuteResult, type OrderRequest, type SwapOrder } from './jupiter';

/**
 * One-click swap flow for the trade panel: order → wallet signature →
 * execute, exactly once per click. A second click while a swap is in flight
 * is ignored (no double buys), and nothing is ever retried automatically.
 */

export type SwapPhase =
  | 'idle'
  /** Requesting the order (transaction) from Jupiter. */
  | 'building'
  /** Waiting for the wallet signature. */
  | 'signing'
  /** Sent to Jupiter; waiting for it to land. */
  | 'executing'
  | 'success'
  /** Jupiter reported the swap did not land. */
  | 'failed'
  /** Outcome unknown; the transaction may still land (check `result.signature`). */
  | 'unknown'
  /** The user declined in the wallet. */
  | 'rejected'
  /** Could not build or sign (nothing was sent). */
  | 'error';

export interface SwapState {
  phase: SwapPhase;
  order?: SwapOrder;
  result?: ExecuteResult;
  /** User-facing message for failed / unknown / rejected / error phases. */
  message?: string;
  error?: SwapError;
}

export interface UseSwapOptions {
  /** Injection point for tests. Defaults to the keyless browser Jupiter client. */
  buildOrder?: typeof defaultBuild;
  swap?: typeof defaultSwap;
}

const BUSY: ReadonlySet<SwapPhase> = new Set(['building', 'signing', 'executing']);

export function useSwap(opts: UseSwapOptions = {}) {
  const [state, setState] = useState<SwapState>({ phase: 'idle' });
  const busy = useRef(false);
  const build = opts.buildOrder ?? defaultBuild;
  const execute = opts.swap ?? defaultSwap;

  const run = useCallback(
    async (request: Omit<OrderRequest, 'taker'>): Promise<SwapState> => {
      if (busy.current) return { phase: 'error', message: 'A swap is already in progress.' };
      const wallet = getWalletState();
      if (!wallet.address) {
        const next: SwapState = { phase: 'error', message: 'Connect a wallet to trade.' };
        setState(next);
        return next;
      }
      busy.current = true;
      let order: SwapOrder | undefined;
      try {
        setState({ phase: 'building' });
        order = await build({ ...request, taker: wallet.address });
        setState({ phase: 'signing', order });
        const result = await execute(order, (tx) => {
          return wallet.signTransaction(tx).then((signed) => {
            setState({ phase: 'executing', order });
            return signed;
          });
        });
        const next: SwapState =
          result.status === 'rejected'
            ? { phase: 'rejected', order, message: result.message }
            : result.status === 'success'
              ? { phase: 'success', order, result }
              : { phase: result.status, order, result, message: result.error };
        setState(next);
        return next;
      } catch (e) {
        const error = isSwapError(e) ? e : new SwapError('sign_failed', 'The swap could not be started. Nothing was sent.', { cause: e });
        const next: SwapState = { phase: 'error', order, error, message: error.message };
        setState(next);
        return next;
      } finally {
        busy.current = false;
      }
    },
    [build, execute],
  );

  const reset = useCallback(() => {
    if (!busy.current) setState({ phase: 'idle' });
  }, []);

  return { ...state, busy: BUSY.has(state.phase), run, reset };
}
