import { isSignature, isSolanaAddress } from '@/lib/core/solana';
import { JUPITER_ROUTERS } from '@/lib/providers/jupiter/normalize';
import { base64ToBytes, bytesToBase64 } from '@/lib/wallet/bytes';
import { isUserRejection, REJECTED_MESSAGE, toWalletError } from '@/lib/wallet/errors';
import { isSwapError, safeUpstreamText, SwapError } from './errors';
import { inspectTransaction, transactionId } from './transaction';

/**
 * Non-custodial swap execution through Jupiter's Swap API V2 (the
 * meta-aggregator formerly called Ultra): GET /swap/v2/order with the
 * visitor's wallet as `taker` returns an unsigned transaction, the visitor's
 * wallet signs it, and POST /swap/v2/execute lands it. ORBYT never holds keys
 * or funds and never adds its own fee.
 *
 * Contract (developers.jup.ag/docs/swap/order-and-execute, checked 2026-09-29):
 * - /order: inputMint, outputMint, amount (raw), taker, optional slippageBps
 *   (0-10000). 200 carries `transaction` (base64) + `requestId`; when the
 *   quote cannot be built for this wallet `transaction` is "" and
 *   `errorCode`/`errorMessage` explain why. 400 carries `{ error }`.
 * - /execute: { signedTransaction (base64), requestId } → { status:
 *   "Success" | "Failed", signature, code (0 = success, negative = error),
 *   error, slot, amounts }. 400 → { error, code }; 500 → { signature, error }.
 *   Codes: -1..-3 order/transaction invalid, -1000 aggregator failed to land,
 *   -1001 aggregator unknown error, -1002..-1004 invalid / not fully signed /
 *   invalid block height, -2000..-2004 the RFQ equivalents (-2001 unknown).
 *   A "Failed" with an unknown-error code is reported as `unknown`.
 * - Aggregator routes expire at `lastValidBlockHeight`; RFQ (JupiterZ) at
 *   `expireAt`. Sign immediately after ordering.
 *
 * /execute is NEVER retried automatically: a retried signed transaction can
 * only land once, but a retried *flow* (new order) could buy twice.
 *
 * Licence (clause 2.3): orders are labelled "Jupiter Ultra" to end users.
 */

export const JUPITER_SWAP_BASE_URL = 'https://api.jup.ag';
/** Router label required by Jupiter's API licence for /swap/v2 orders. */
export const SWAP_ROUTER_LABEL = JUPITER_ROUTERS.ultra;

const ORDER_TIMEOUT_MS = 12_000;
/** /execute waits for the transaction to land; give it a generous budget. */
const EXECUTE_TIMEOUT_MS = 75_000;
const MAX_TRANSACTION_BYTES = 16_384;
const U64_MAX = 18_446_744_073_709_551_615n;
const RAW_AMOUNT_RE = /^\d{1,20}$/;

export interface OrderRequest {
  inputMint: string;
  outputMint: string;
  /** Input amount in base units (lamports for SOL). */
  amountRaw: string | bigint;
  /** The connected wallet: it signs and pays. */
  taker: string;
  /** Omit to let Jupiter pick slippage (its "ultra" mode). */
  slippageBps?: number;
}

export interface SwapOrder {
  requestId: string;
  inputMint: string;
  outputMint: string;
  taker: string;
  inAmountRaw: string;
  outAmountRaw: string;
  /** Minimum output after slippage (raw), when Jupiter reports it. */
  minOutAmountRaw?: string;
  slippageBps?: number;
  /** Price impact in percent; positive = worse than the USD reference (same convention as SwapQuote). */
  priceImpactPct?: number;
  inUsd?: number;
  outUsd?: number;
  /** DEX labels along the route. */
  route: string[];
  /** Licence label shown to users: "Jupiter Ultra". */
  router: string;
  /** Winning Jupiter router (metis | jupiterz | dflow | okx), informational. */
  routerId?: string;
  /** Total fee in bps as reported by Jupiter (never hardcoded). */
  feeBps?: number;
  feeMint?: string;
  gasless: boolean;
  signatureFeeLamports?: number;
  prioritizationFeeLamports?: number;
  rentFeeLamports?: number;
  /** Unsigned transaction bytes for the wallet. */
  transaction: Uint8Array;
  /** Hard expiry for aggregator routes. */
  lastValidBlockHeight?: string;
  /** Quote expiry (ms epoch) for RFQ routes. */
  expiresAt?: number;
  fetchedAt: number;
}

export type ExecuteResult =
  | {
      status: 'success';
      signature: string;
      code: 0;
      slot?: string;
      /** Raw amounts reported by Jupiter after landing. */
      totalInputAmountRaw?: string;
      totalOutputAmountRaw?: string;
      inputAmountResultRaw?: string;
      outputAmountResultRaw?: string;
    }
  /** Jupiter reports the swap did not land (or was refused). Funds did not move for this transaction. */
  | { status: 'failed'; code?: number; error: string; signature?: string }
  /** Outcome not known (timeout, network, server error): the transaction may still land. Check the signature before retrying. */
  | { status: 'unknown'; error: string; signature?: string };

export type SwapResult = ExecuteResult | { status: 'rejected'; message: string };

export interface JupiterSwapOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Jupiter Developer Platform key. Browser code should not pass one (it would be exposed). */
  apiKey?: string;
  now?: () => number;
}

export interface CallOptions {
  signal?: AbortSignal;
}

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const rawAmount = (v: unknown): string | undefined => (typeof v === 'string' && RAW_AMOUNT_RE.test(v) && BigInt(v) <= U64_MAX ? v : undefined);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : undefined);
const intLike = (v: unknown): string | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : typeof v === 'string' && /^\d{1,20}$/.test(v) ? v : undefined;

function normalizeAmount(value: string | bigint): string {
  const s = typeof value === 'bigint' ? value.toString() : String(value).trim();
  if (!RAW_AMOUNT_RE.test(s)) throw new SwapError('invalid_request', 'Amount must be a whole number of base units.');
  const n = BigInt(s);
  if (n <= 0n) throw new SwapError('invalid_request', 'Amount must be greater than zero.');
  if (n > U64_MAX) throw new SwapError('invalid_request', 'Amount is too large.');
  return n.toString();
}

function validateRequest(req: OrderRequest): { inputMint: string; outputMint: string; amount: string; taker: string; slippageBps?: number } {
  if (!isSolanaAddress(req.inputMint) || !isSolanaAddress(req.outputMint)) throw new SwapError('invalid_request', 'Both token mints must be Solana addresses.');
  if (req.inputMint === req.outputMint) throw new SwapError('invalid_request', 'Input and output tokens must differ.');
  if (!isSolanaAddress(req.taker)) throw new SwapError('invalid_request', 'Connect a wallet to trade.');
  if (req.slippageBps !== undefined && (!Number.isInteger(req.slippageBps) || req.slippageBps < 0 || req.slippageBps > 10_000)) {
    throw new SwapError('invalid_request', 'Slippage must be between 0 and 10000 bps.');
  }
  return {
    inputMint: req.inputMint,
    outputMint: req.outputMint,
    amount: normalizeAmount(req.amountRaw),
    taker: req.taker,
    ...(req.slippageBps !== undefined ? { slippageBps: req.slippageBps } : {}),
  };
}

function routeLabels(plan: unknown): string[] {
  if (!Array.isArray(plan)) return [];
  const labels: string[] = [];
  for (const step of plan) {
    const label = isRecord(step) && isRecord(step.swapInfo) ? safeUpstreamText(step.swapInfo.label, 40) : undefined;
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

function parseExpiry(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== 'string' || !value) return undefined;
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    return n < 1e12 ? n * 1000 : n;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Fallback text for an unbuildable order when Jupiter sends no errorMessage.
 * Codes depend on the router ("match on router + errorCode"):
 * aggregators (metis, dflow, okx) 1 insufficient funds, 2 insufficient SOL
 * for gas, 3 below the gasless minimum; JupiterZ 1 insufficient balance,
 * 2 missing token account, 3 quote could not be built.
 */
function unbuildableFallback(router: unknown, code: number | undefined): string {
  const rfq = router === 'jupiterz';
  if (code === 1) return 'Insufficient balance for this swap.';
  if (code === 2) return rfq ? 'A token account this swap needs is missing.' : 'Not enough SOL to pay the network fees for this swap.';
  if (code === 3) return rfq ? 'Jupiter could not build a transaction for this quote.' : 'This swap is below the minimum size for a gasless swap.';
  return 'Jupiter could not build a transaction for this swap.';
}

/**
 * /execute codes that do not prove the transaction stayed off-chain
 * (-1001 aggregator "Unknown error", -2001 RFQ "Unknown error"): reported
 * as `unknown`, never as a definite failure, so nobody re-buys blindly.
 */
const AMBIGUOUS_EXECUTE_CODES: ReadonlySet<number> = new Set([-1001, -2001]);

function rateLimitError(res: Response, now: number): SwapError {
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  const retryAfterMs = Number.isFinite(reset) && reset > 0 ? Math.max(1_000, reset * 1000 - now) : 10_000;
  return new SwapError('rate_limited', `Jupiter is rate limiting this browser. Try again in ${Math.ceil(retryAfterMs / 1000)} s.`, { retryAfterMs });
}

function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function createJupiterSwap(opts: JupiterSwapOptions = {}) {
  const base = (opts.baseUrl?.trim() || JUPITER_SWAP_BASE_URL).replace(/\/+$/, '');
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const now = opts.now ?? Date.now;
  const keyHeader: Record<string, string> = opts.apiKey?.trim() ? { 'x-api-key': opts.apiKey.trim() } : {};

  /** GET /swap/v2/order for the connected wallet. Throws SwapError. */
  async function buildOrder(request: OrderRequest, call: CallOptions = {}): Promise<SwapOrder> {
    const req = validateRequest(request);
    const params = new URLSearchParams({ inputMint: req.inputMint, outputMint: req.outputMint, amount: req.amount, taker: req.taker });
    if (req.slippageBps !== undefined) params.set('slippageBps', String(req.slippageBps));

    let res: Response;
    try {
      res = await doFetch(`${base}/swap/v2/order?${params.toString()}`, {
        method: 'GET',
        headers: { accept: 'application/json', ...keyHeader },
        signal: timeoutSignal(ORDER_TIMEOUT_MS, call.signal),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch (cause) {
      if (call.signal?.aborted) throw cause;
      const timedOut = cause instanceof DOMException && cause.name === 'TimeoutError';
      throw new SwapError('network', timedOut ? 'Jupiter did not answer in time. Try again.' : 'Jupiter could not be reached. Check your connection.', { cause });
    }
    if (res.status === 429) throw rateLimitError(res, now());

    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      throw new SwapError(res.ok ? 'malformed' : 'order_rejected', res.ok ? 'Jupiter returned an unreadable order.' : `Jupiter refused the order (HTTP ${res.status}).`, { cause });
    }
    if (!res.ok || !isRecord(body)) {
      const detail = isRecord(body) ? safeUpstreamText(body.error ?? body.errorMessage ?? body.message) : undefined;
      throw new SwapError('order_rejected', detail ? `Jupiter: ${detail}` : `Jupiter refused the order (HTTP ${res.status}).`, {
        jupiterCode: isRecord(body) ? finite(body.code ?? body.errorCode) : undefined,
      });
    }

    const errorCode = finite(body.errorCode);
    const transactionB64 = body.transaction;
    if (errorCode !== undefined || typeof transactionB64 !== 'string' || transactionB64 === '') {
      const detail = safeUpstreamText(body.errorMessage ?? body.error);
      const message = detail ? `Jupiter: ${detail}` : unbuildableFallback(body.router, errorCode);
      throw new SwapError('unbuildable', message, { jupiterCode: errorCode });
    }

    const requestId = text(body.requestId);
    const inAmountRaw = rawAmount(body.inAmount);
    const outAmountRaw = rawAmount(body.outAmount);
    const transaction = base64ToBytes(transactionB64, MAX_TRANSACTION_BYTES);
    if (!requestId || !inAmountRaw || !outAmountRaw || !transaction) throw new SwapError('malformed', 'Jupiter returned an incomplete order.');

    // The order must be exactly what was asked for, for this wallet.
    if ((body.inputMint !== undefined && body.inputMint !== req.inputMint) || (body.outputMint !== undefined && body.outputMint !== req.outputMint)) {
      throw new SwapError('mismatch', 'Jupiter returned an order for different tokens.');
    }
    if (body.taker !== undefined && body.taker !== null && body.taker !== req.taker) {
      throw new SwapError('mismatch', 'Jupiter returned an order for a different wallet.');
    }
    if (BigInt(inAmountRaw) > BigInt(req.amount)) throw new SwapError('mismatch', 'Jupiter returned an order that spends more than requested.');
    const inspected = inspectTransaction(transaction);
    if (!inspected) throw new SwapError('malformed', 'Jupiter returned a transaction ORBYT could not read.');
    if (!inspected.signers.includes(req.taker)) throw new SwapError('mismatch', 'The swap transaction does not require your wallet to sign.');

    const impact = finite(body.priceImpact);
    const platformFee = isRecord(body.platformFee) ? body.platformFee : {};
    const order: SwapOrder = {
      requestId,
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      taker: req.taker,
      inAmountRaw,
      outAmountRaw,
      route: routeLabels(body.routePlan),
      router: SWAP_ROUTER_LABEL,
      gasless: body.gasless === true,
      transaction,
      fetchedAt: now(),
    };
    const minOut = rawAmount(body.otherAmountThreshold);
    if (minOut) order.minOutAmountRaw = minOut;
    const slippage = finite(body.slippageBps);
    if (slippage !== undefined && (req.slippageBps !== undefined || slippage > 0)) order.slippageBps = slippage;
    if (impact !== undefined) order.priceImpactPct = impact === 0 ? 0 : -impact;
    const inUsd = finite(body.inUsdValue);
    const outUsd = finite(body.outUsdValue);
    if (inUsd !== undefined && inUsd >= 0) order.inUsd = inUsd;
    if (outUsd !== undefined && outUsd >= 0) order.outUsd = outUsd;
    const routerId = safeUpstreamText(body.router, 20);
    if (routerId) order.routerId = routerId;
    const feeBps = finite(body.feeBps) ?? finite(platformFee.feeBps);
    if (feeBps !== undefined && feeBps >= 0) order.feeBps = feeBps;
    const feeMint = body.feeMint ?? platformFee.feeMint;
    if (isSolanaAddress(feeMint)) order.feeMint = feeMint;
    for (const key of ['signatureFeeLamports', 'prioritizationFeeLamports', 'rentFeeLamports'] as const) {
      const v = finite(body[key]);
      if (v !== undefined && v >= 0) order[key] = v;
    }
    const lvbh = intLike(body.lastValidBlockHeight);
    if (lvbh) order.lastValidBlockHeight = lvbh;
    const expiresAt = parseExpiry(body.expireAt);
    if (expiresAt !== undefined) order.expiresAt = expiresAt;
    return order;
  }

  /**
   * POST /swap/v2/execute with a wallet-signed transaction. Never throws for
   * outcomes (see ExecuteResult) and never retries.
   */
  async function executeOrder(
    input: { signedTransaction: Uint8Array; requestId: string; lastValidBlockHeight?: string },
    call: CallOptions = {},
  ): Promise<ExecuteResult> {
    const inspected = inspectTransaction(input.signedTransaction);
    const localSignature = inspected ? transactionId(inspected) : undefined;
    const withSig = <T extends object>(r: T, sig = localSignature): T & { signature?: string } => (sig ? { ...r, signature: sig } : r);
    if (!text(input.requestId)) return { status: 'failed', error: 'Missing order id; request a new quote.' };
    if (!inspected) return { status: 'failed', error: 'The signed transaction could not be read; nothing was sent.' };
    if (call.signal?.aborted) return { status: 'failed', error: 'Cancelled before sending. Nothing was sent.' };

    let res: Response;
    try {
      res = await doFetch(`${base}/swap/v2/execute`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', ...keyHeader },
        body: JSON.stringify({
          signedTransaction: bytesToBase64(input.signedTransaction),
          requestId: input.requestId,
          ...(input.lastValidBlockHeight ? { lastValidBlockHeight: input.lastValidBlockHeight } : {}),
        }),
        signal: timeoutSignal(EXECUTE_TIMEOUT_MS, call.signal),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      // The request may have reached Jupiter: the transaction could still land.
      return withSig({
        status: 'unknown' as const,
        error: 'Lost contact with Jupiter while sending. The swap may still land: check the transaction before trying again.',
      });
    }

    if (res.status === 429) {
      return { status: 'failed', error: rateLimitError(res, now()).message };
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const b = isRecord(body) ? body : {};
    // Jupiter's id when it is a real base58 signature (gasless orders are fee-paid by Jupiter), else the local one.
    const remoteSignature = isSignature(b.signature) ? b.signature : undefined;
    const signature = remoteSignature ?? localSignature;
    const code = finite(b.code);
    const upstream = safeUpstreamText(b.error);

    if (res.ok && b.status === 'Success' && signature && (code === undefined || code === 0)) {
      const result: Extract<ExecuteResult, { status: 'success' }> = { status: 'success', signature, code: 0 };
      const slot = intLike(b.slot);
      if (slot) result.slot = slot;
      const amounts = [
        ['totalInputAmount', 'totalInputAmountRaw'],
        ['totalOutputAmount', 'totalOutputAmountRaw'],
        ['inputAmountResult', 'inputAmountResultRaw'],
        ['outputAmountResult', 'outputAmountResultRaw'],
      ] as const;
      for (const [from, to] of amounts) {
        const v = rawAmount(b[from]);
        if (v) result[to] = v;
      }
      return result;
    }
    if (res.ok && b.status === 'Failed' && (code === undefined || !AMBIGUOUS_EXECUTE_CODES.has(code))) {
      return withSig({ status: 'failed' as const, ...(code !== undefined ? { code } : {}), error: upstream ? `Jupiter: ${upstream}` : 'The swap did not land.' }, signature);
    }
    if (res.status >= 400 && res.status < 500) {
      // Refused before broadcast (invalid transaction, expired order, …).
      return withSig({ status: 'failed' as const, ...(code !== undefined ? { code } : {}), error: upstream ? `Jupiter: ${upstream}` : `Jupiter refused the swap (HTTP ${res.status}).` }, remoteSignature);
    }
    return withSig(
      {
        status: 'unknown' as const,
        error: `${upstream ? `Jupiter: ${upstream}. ` : ''}The swap outcome is unknown and it may still land: check the transaction before trying again.`,
      },
      signature,
    );
  }

  /**
   * Sign an order with the visitor's wallet and execute it once. A user
   * rejection resolves to `{ status: 'rejected' }`; other pre-send problems
   * throw SwapError; every post-send outcome resolves to an ExecuteResult.
   */
  async function swap(order: SwapOrder, signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>, call: CallOptions = {}): Promise<SwapResult> {
    if (order.expiresAt !== undefined && order.expiresAt <= now()) throw new SwapError('expired', 'This quote expired. Request a new one.');
    let signed: Uint8Array;
    try {
      signed = await signTransaction(order.transaction);
    } catch (e) {
      if (isUserRejection(e)) return { status: 'rejected', message: REJECTED_MESSAGE };
      if (isSwapError(e)) throw e;
      throw new SwapError('sign_failed', toWalletError(e, 'Your wallet could not sign the swap.').message, { cause: e });
    }
    const inspected = signed instanceof Uint8Array ? inspectTransaction(signed) : null;
    if (!inspected || !inspected.signatures[order.taker]) {
      throw new SwapError('sign_failed', 'Your wallet returned the swap without its signature. Nothing was sent.');
    }
    return executeOrder({ signedTransaction: signed, requestId: order.requestId, lastValidBlockHeight: order.lastValidBlockHeight }, call);
  }

  return { buildOrder, executeOrder, swap };
}

export type JupiterSwap = ReturnType<typeof createJupiterSwap>;

/** Keyless browser instance (each visitor uses their own Jupiter quota). */
const defaultSwap = createJupiterSwap();
export const buildOrder = defaultSwap.buildOrder;
export const executeOrder = defaultSwap.executeOrder;
export const swap = defaultSwap.swap;
