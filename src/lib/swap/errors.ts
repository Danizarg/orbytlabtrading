/**
 * Errors raised before a swap reaches the chain. Once a signed transaction
 * has been handed to Jupiter, outcomes are reported as ExecuteResult values
 * instead (success / failed / unknown), never thrown, so the UI cannot lose
 * track of a transaction that may have landed.
 */

export type SwapErrorCode =
  /** Bad input (mint, amount, taker, slippage). */
  | 'invalid_request'
  /** Jupiter answered 429. */
  | 'rate_limited'
  /** Jupiter quoted but could not build a transaction for this wallet (errorCode/errorMessage). */
  | 'unbuildable'
  /** Jupiter refused the order request (HTTP 4xx/5xx with an error body). */
  | 'order_rejected'
  /** Jupiter's response did not match the documented contract. */
  | 'malformed'
  /** The order does not belong to the connected wallet or request. */
  | 'mismatch'
  /** The quote expired before it was signed. */
  | 'expired'
  /** The wallet failed to sign (not a user rejection). */
  | 'sign_failed'
  /** Jupiter could not be reached while building the order. */
  | 'network';

export class SwapError extends Error {
  readonly code: SwapErrorCode;
  /** Jupiter's numeric errorCode / code, when it gave one. */
  readonly jupiterCode?: number;
  readonly retryAfterMs?: number;

  constructor(code: SwapErrorCode, message: string, opts: { jupiterCode?: number; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'SwapError';
    this.code = code;
    this.jupiterCode = opts.jupiterCode;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export function isSwapError(e: unknown): e is SwapError {
  return e instanceof SwapError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'SwapError');
}

const URL_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/**
 * Upstream text shown to users verbatim but safely: no URLs, no markup,
 * single line, bounded length.
 */
export function safeUpstreamText(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(URL_TEXT, '[link]').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
