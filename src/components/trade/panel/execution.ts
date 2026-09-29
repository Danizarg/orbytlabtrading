/**
 * In-app trade execution for the trade panel, as a pure reducer plus a
 * runner (unit tested with a mocked wallet and a mocked Jupiter in
 * execution.test.ts):
 *
 *   idle → building (Jupiter /swap/v2/order for the connected wallet)
 *        → signing (wallet prompt) → submitting (Jupiter /swap/v2/execute)
 *        → confirmed | failed | unknown
 *
 * A user rejection in the wallet resets quietly to idle. Nothing is retried
 * automatically: a retried flow could buy twice. Only one trade runs at a
 * time; events from a superseded attempt are ignored.
 *
 * A trade can be abandoned (Cancel, leaving the page, switching token) until
 * the wallet has returned its signature: the wallet is then never asked, or
 * its late signature is never sent. Once signed, the transaction is sent and
 * followed to its outcome.
 */

import { priceImpactTone, type QuoteSide } from '@/lib/services/token';
import type { CallOptions, ExecuteResult, OrderRequest, SwapOrder, SwapResult } from '@/lib/swap';
import { isSwapError } from '@/lib/swap/errors';
import { isWalletError } from '@/lib/wallet/errors';

export type TradePhase = 'idle' | 'building' | 'signing' | 'submitting' | 'confirmed' | 'failed' | 'unknown';

export interface TradeState {
  phase: TradePhase;
  /** Attempt number; late events from an older attempt are ignored. */
  id: number;
  side?: QuoteSide;
  /** The traded token and how it is displayed, captured when the trade starts. */
  token?: TradeToken;
  /** The order Jupiter built for the connected wallet (from `signing` on). */
  order?: SwapOrder;
  /** Transaction signature once known (confirmed, and failed / unknown when Jupiter or the wallet produced one). */
  signature?: string;
  /** Jupiter's execute outcome. */
  result?: ExecuteResult;
  /** User-facing text for failed / unknown. */
  message?: string;
  /** Set when the trade stopped before signing because the order's price impact needs a new confirmation. */
  impactPct?: number;
  /** The panel's form key (mint, side, amount, slippage) the attempt was made with. */
  key?: string;
}

export interface TradeToken {
  mint: string;
  symbol?: string;
  decimals?: number;
}

export type TradeEvent =
  | { type: 'start'; id: number; side: QuoteSide; token?: TradeToken; key?: string }
  | { type: 'built'; id: number; order: SwapOrder }
  | { type: 'signed'; id: number }
  | { type: 'settled'; id: number; result: SwapResult }
  | { type: 'error'; id: number; message: string; impactPct?: number }
  /** Abandoned before the wallet signed: nothing was sent. */
  | { type: 'cancelled'; id: number }
  | { type: 'dismiss' };

export const IDLE_TRADE: TradeState = { phase: 'idle', id: 0 };

const BUSY: ReadonlySet<TradePhase> = new Set<TradePhase>(['building', 'signing', 'submitting']);

/** A trade is in flight (the primary button stays disabled). */
export function isTradeBusy(phase: TradePhase): boolean {
  return BUSY.has(phase);
}

/** The trade can still be abandoned without anything being sent (no signature yet). */
export function isTradeCancellable(phase: TradePhase): boolean {
  return phase === 'building' || phase === 'signing';
}

export function tradeReducer(state: TradeState, event: TradeEvent): TradeState {
  switch (event.type) {
    case 'start':
      // Never two trades at once.
      if (isTradeBusy(state.phase)) return state;
      return {
        phase: 'building',
        id: event.id,
        side: event.side,
        ...(event.token ? { token: event.token } : {}),
        ...(event.key !== undefined ? { key: event.key } : {}),
      };
    case 'built':
      if (event.id !== state.id || state.phase !== 'building') return state;
      return { ...state, phase: 'signing', order: event.order };
    case 'signed':
      if (event.id !== state.id || state.phase !== 'signing') return state;
      return { ...state, phase: 'submitting' };
    case 'settled': {
      if (event.id !== state.id || !isTradeBusy(state.phase)) return state;
      const { result } = event;
      // The user said no in their wallet: back to the form, no banner.
      if (result.status === 'rejected') return { phase: 'idle', id: state.id };
      const base = { id: state.id, side: state.side, token: state.token, key: state.key, order: state.order, result };
      if (result.status === 'success') return { ...base, phase: 'confirmed', signature: result.signature };
      return { ...base, phase: result.status, message: result.error, ...(result.signature ? { signature: result.signature } : {}) };
    }
    case 'error':
      if (event.id !== state.id || !isTradeBusy(state.phase)) return state;
      return {
        phase: 'failed',
        id: state.id,
        side: state.side,
        token: state.token,
        key: state.key,
        order: state.order,
        message: event.message,
        ...(event.impactPct !== undefined ? { impactPct: event.impactPct } : {}),
      };
    case 'cancelled':
      if (event.id !== state.id || !isTradeCancellable(state.phase)) return state;
      return { phase: 'idle', id: state.id };
    case 'dismiss':
      return isTradeBusy(state.phase) || state.phase === 'idle' ? state : { phase: 'idle', id: state.id };
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface TradeDeps {
  buildOrder: (request: OrderRequest, call?: CallOptions) => Promise<SwapOrder>;
  /** Signs with `sign` and executes once (src/lib/swap `swap`). */
  swap: (order: SwapOrder, sign: (transaction: Uint8Array) => Promise<Uint8Array>, call?: CallOptions) => Promise<SwapResult>;
  /** The connected wallet's solana:signTransaction. */
  signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>;
}

export interface TradeRequest {
  id: number;
  side: QuoteSide;
  inputMint: string;
  outputMint: string;
  /** Input amount in raw base units (lamports for buys). */
  amountRaw: string;
  /** The connected wallet. */
  taker: string;
  slippageBps: number;
  /** Highest price impact (percent) the user explicitly confirmed, if any. */
  acceptedImpactPct?: number;
  /** Display details of the traded token (kept with the result). */
  symbol?: string;
  tokenDecimals?: number;
  /** The panel's form key for this attempt (see TradeState.key). */
  key?: string;
}

/**
 * Tolerance on a confirmed impact: the order may come back slightly worse
 * than the quote the user confirmed (10 % relative, at least 1 point).
 */
export function impactStillAccepted(orderImpactPct: number, acceptedImpactPct: number | undefined): boolean {
  if (acceptedImpactPct === undefined || !Number.isFinite(acceptedImpactPct)) return false;
  return Math.abs(orderImpactPct) <= Math.abs(acceptedImpactPct) + Math.max(1, Math.abs(acceptedImpactPct) * 0.1);
}

/** An order whose price impact is in the danger band (> 15 %) and not covered by the user's confirmation. */
export function needsImpactConfirmation(orderImpactPct: number | undefined, acceptedImpactPct: number | undefined): boolean {
  if (orderImpactPct === undefined || priceImpactTone(orderImpactPct) !== 'danger') return false;
  return !impactStillAccepted(orderImpactPct, acceptedImpactPct);
}

/**
 * Price-impact gate for the panel's current form (`key`): the highest
 * danger-band impact known for it (the live quote's, and the order's when
 * the last attempt with this same form stopped on it) and whether the
 * user's confirmation still covers it. A stop recorded for another amount,
 * side, slippage or token never blocks the current form.
 */
export function impactGate(input: {
  quoteImpactPct: number | undefined;
  trade: Pick<TradeState, 'phase' | 'impactPct' | 'key'>;
  key: string;
  acceptedImpactPct: number | undefined;
}): { impactPct?: number; needsConfirm: boolean } {
  const { quoteImpactPct, trade, key, acceptedImpactPct } = input;
  const fromQuote = quoteImpactPct !== undefined && priceImpactTone(quoteImpactPct) === 'danger' ? Math.abs(quoteImpactPct) : undefined;
  const fromOrder = trade.phase === 'failed' && trade.key === key && trade.impactPct !== undefined ? Math.abs(trade.impactPct) : undefined;
  const impactPct = fromQuote === undefined ? fromOrder : fromOrder === undefined ? fromQuote : Math.max(fromQuote, fromOrder);
  if (impactPct === undefined) return { needsConfirm: false };
  return { impactPct, needsConfirm: !impactStillAccepted(impactPct, acceptedImpactPct) };
}

function errorText(e: unknown, fallback: string): string {
  if (isSwapError(e) || isWalletError(e)) return e.message;
  return fallback;
}

export type TradeOutcome = 'confirmed' | 'failed' | 'unknown' | 'rejected' | 'not_sent' | 'cancelled';

export interface RunOptions {
  /** Abandons the trade while the wallet has not signed yet (see the module note). */
  signal?: AbortSignal;
}

function cancelledError(): Error {
  const error = new Error('Trade cancelled before signing.');
  error.name = 'AbortError';
  return error;
}

/**
 * The wallet's answer, or a rejection as soon as `signal` aborts: a wallet
 * prompt left open (or a wallet that never answers) cannot hold the panel.
 * A late answer is dropped.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        // Passed through untouched: wallets reject with non-Error shapes ({ code: 4001 }) that mean "rejected".
        reject(error as Error);
      },
    );
  });
}

/**
 * One trade: order → price-impact guard → wallet signature → execute.
 * Resolves with what happened on chain: `not_sent` when it stopped before a
 * signed transaction reached Jupiter, `cancelled` when it was abandoned
 * before the wallet signed (nothing sent, the panel resets quietly).
 */
export async function runTrade(deps: TradeDeps, req: TradeRequest, dispatch: (event: TradeEvent) => void, opts: RunOptions = {}): Promise<TradeOutcome> {
  const { id } = req;
  const { signal } = opts;
  const token: TradeToken = { mint: req.side === 'buy' ? req.outputMint : req.inputMint };
  if (req.symbol !== undefined) token.symbol = req.symbol;
  if (req.tokenDecimals !== undefined) token.decimals = req.tokenDecimals;
  dispatch({ type: 'start', id, side: req.side, token, ...(req.key !== undefined ? { key: req.key } : {}) });
  const cancelled = (): TradeOutcome => {
    dispatch({ type: 'cancelled', id });
    return 'cancelled';
  };
  if (signal?.aborted) return cancelled();

  let order: SwapOrder;
  try {
    const orderRequest: OrderRequest = {
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amountRaw: req.amountRaw,
      taker: req.taker,
      slippageBps: req.slippageBps,
    };
    order = await (signal ? deps.buildOrder(orderRequest, { signal }) : deps.buildOrder(orderRequest));
  } catch (e) {
    if (signal?.aborted) return cancelled();
    dispatch({ type: 'error', id, message: errorText(e, 'Jupiter could not build this swap. Nothing was sent.') });
    return 'not_sent';
  }
  if (signal?.aborted) return cancelled();

  if (needsImpactConfirmation(order.priceImpactPct, req.acceptedImpactPct)) {
    const impact = Math.abs(order.priceImpactPct ?? 0);
    dispatch({
      type: 'error',
      id,
      message: `Price impact on this order is ${impact.toFixed(impact >= 100 ? 0 : 1)} %. Confirm the high impact to continue. Nothing was sent.`,
      impactPct: impact,
    });
    return 'not_sent';
  }

  dispatch({ type: 'built', id, order });

  // Abandoning is honoured only until the wallet has signed. `presend` is
  // aborted only while unsigned, so it can never cut /execute short once the
  // signed transaction is on its way (that would turn a sent swap into an
  // unknown one); src/lib/swap also refuses to send on an aborted signal.
  const presend = new AbortController();
  let signed = false;
  const abandon = () => {
    if (!signed) presend.abort();
  };
  signal?.addEventListener('abort', abandon, { once: true });
  if (signal?.aborted) abandon();
  let result: SwapResult;
  try {
    result = await deps.swap(
      order,
      async (transaction) => {
        if (presend.signal.aborted) throw cancelledError();
        // Cancelled while the wallet prompt is open: stop waiting now, and never send a late signature.
        const signedTx = await untilAborted(deps.signTransaction(transaction), presend.signal);
        if (presend.signal.aborted) throw cancelledError();
        signed = true;
        dispatch({ type: 'signed', id });
        return signedTx;
      },
      { signal: presend.signal },
    );
  } catch (e) {
    if (presend.signal.aborted) return cancelled();
    dispatch({ type: 'error', id, message: errorText(e, 'The swap could not be sent. Nothing was sent.') });
    return 'not_sent';
  } finally {
    signal?.removeEventListener('abort', abandon);
  }
  if (!signed && presend.signal.aborted) return cancelled();
  dispatch({ type: 'settled', id, result });
  return result.status === 'success' ? 'confirmed' : result.status;
}
