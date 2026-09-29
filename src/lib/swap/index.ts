/**
 * Non-custodial swap execution via Jupiter Swap API V2 ("Jupiter Ultra"):
 * the visitor's wallet signs, ORBYT never holds keys or funds.
 */
export {
  buildOrder,
  createJupiterSwap,
  executeOrder,
  JUPITER_SWAP_BASE_URL,
  swap,
  SWAP_ROUTER_LABEL,
  type CallOptions,
  type ExecuteResult,
  type JupiterSwap,
  type JupiterSwapOptions,
  type OrderRequest,
  type SwapOrder,
  type SwapResult,
} from './jupiter';
export { isSwapError, safeUpstreamText, SwapError, type SwapErrorCode } from './errors';
export { inspectTransaction, transactionId, type InspectedTransaction } from './transaction';
export { useSwap, type SwapPhase, type SwapState, type UseSwapOptions } from './useSwap';
