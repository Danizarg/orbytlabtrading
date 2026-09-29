import { describe, expect, it, vi } from 'vitest';
import type { ExecuteResult, SwapOrder, SwapResult } from '@/lib/swap';
import { SwapError } from '@/lib/swap/errors';
import { WalletError } from '@/lib/wallet/errors';
import {
  IDLE_TRADE,
  impactGate,
  isTradeCancellable,
  runTrade,
  tradeReducer,
  type TradeDeps,
  type TradeEvent,
  type TradePhase,
  type TradeRequest,
  type TradeState,
} from './execution';

/**
 * Abandoning a trade before the wallet signs (Cancel, leaving the page,
 * switching token) and the price-impact gate of the current form.
 */

const SOL = 'So11111111111111111111111111111111111111112';
const TOKEN = 'DKxXdaMC1so182urvrrnhs6V6fGTrttPS8br6JuEpump';
const TAKER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const UNSIGNED = new Uint8Array([1, 2, 3]);
const SIGNED = new Uint8Array([9, 9, 9]);

function order(patch: Partial<SwapOrder> = {}): SwapOrder {
  return {
    requestId: 'req-1',
    inputMint: SOL,
    outputMint: TOKEN,
    taker: TAKER,
    inAmountRaw: '100000000',
    outAmountRaw: '41665048348',
    minOutAmountRaw: '41248397865',
    slippageBps: 100,
    priceImpactPct: 0.4,
    route: ['Pump.fun Amm'],
    router: 'Jupiter Ultra',
    gasless: false,
    transaction: UNSIGNED,
    fetchedAt: 1_000,
    ...patch,
  };
}

const request = (patch: Partial<TradeRequest> = {}): TradeRequest => ({
  id: 1,
  side: 'buy',
  inputMint: SOL,
  outputMint: TOKEN,
  amountRaw: '100000000',
  taker: TAKER,
  slippageBps: 100,
  ...patch,
});

/** Mocked Jupiter + wallet; `swap` behaves like src/lib/swap (sign, then execute once). */
function harness(opts: { order?: SwapOrder; sign?: (tx: Uint8Array) => Promise<Uint8Array> } = {}) {
  const buildOrder = vi.fn<TradeDeps['buildOrder']>(async () => opts.order ?? order());
  const signTransaction = vi.fn<TradeDeps['signTransaction']>(opts.sign ?? (async () => SIGNED));
  const execute = vi.fn(async (): Promise<ExecuteResult> => ({ status: 'success', signature: SIG, code: 0 }));
  const swap = vi.fn<TradeDeps['swap']>(async (o, sign): Promise<SwapResult> => {
    try {
      await sign(o.transaction);
    } catch (e) {
      if (e instanceof WalletError && e.kind === 'rejected') return { status: 'rejected', message: e.message };
      throw new SwapError('sign_failed', 'Your wallet could not sign the swap.');
    }
    return execute();
  });
  const phases: TradePhase[] = [];
  let state: TradeState = IDLE_TRADE;
  const dispatch = (event: TradeEvent) => {
    const next = tradeReducer(state, event);
    if (next.phase !== state.phase) phases.push(next.phase);
    state = next;
  };
  return { deps: { buildOrder, swap, signTransaction } satisfies TradeDeps, execute, dispatch, phases, state: () => state };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('abandoning a trade before the wallet signs', () => {
  it('while the order is being built: aborts the request, never asks the wallet, resets quietly', async () => {
    const h = harness();
    let seen: AbortSignal | undefined;
    h.deps.buildOrder.mockImplementation(
      (_req, call) =>
        new Promise((_, reject) => {
          seen = call?.signal;
          call?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    const ctl = new AbortController();
    const running = runTrade(h.deps, request(), h.dispatch, { signal: ctl.signal });
    ctl.abort();

    expect(await running).toBe('cancelled');
    expect(seen).toBe(ctl.signal);
    expect(h.phases).toEqual(['building', 'idle']);
    expect(h.state()).toEqual({ phase: 'idle', id: 1 });
    expect(h.deps.swap).not.toHaveBeenCalled();
    expect(h.deps.signTransaction).not.toHaveBeenCalled();
  });

  it('an order that arrives after the cancel is dropped before the wallet prompt', async () => {
    const h = harness();
    const built = deferred<SwapOrder>();
    h.deps.buildOrder.mockImplementation(() => built.promise);
    const ctl = new AbortController();
    const running = runTrade(h.deps, request(), h.dispatch, { signal: ctl.signal });
    ctl.abort();
    built.resolve(order());

    expect(await running).toBe('cancelled');
    expect(h.deps.signTransaction).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.state().phase).toBe('idle');
  });

  it('while the wallet prompt is open: a signature given afterwards is never sent', async () => {
    const wallet = deferred<Uint8Array>();
    const h = harness({ sign: () => wallet.promise });
    const ctl = new AbortController();
    const running = runTrade(h.deps, request(), h.dispatch, { signal: ctl.signal });
    await vi.waitFor(() => expect(h.deps.signTransaction).toHaveBeenCalledTimes(1));
    expect(h.state().phase).toBe('signing');

    ctl.abort();
    wallet.resolve(SIGNED);

    expect(await running).toBe('cancelled');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.phases).toEqual(['building', 'signing', 'idle']);
  });

  it('a wallet that never answers cannot hold the panel: Cancel resets it at once', async () => {
    const h = harness({ sign: () => new Promise<Uint8Array>(() => {}) });
    const ctl = new AbortController();
    const running = runTrade(h.deps, request(), h.dispatch, { signal: ctl.signal });
    await vi.waitFor(() => expect(h.state().phase).toBe('signing'));

    ctl.abort();
    expect(await running).toBe('cancelled');
    expect(h.state()).toEqual({ phase: 'idle', id: 1 });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('a wallet rejection that is not an Error ({ code: 4001 }) still resets quietly, not as a failure', async () => {
    const h = harness();
    h.deps.swap.mockImplementation(async (o, sign) => {
      try {
        await sign(o.transaction);
      } catch (e) {
        // What src/lib/swap does: isUserRejection() on the untouched rejection value.
        const { isUserRejection } = await import('@/lib/wallet/errors');
        if (isUserRejection(e)) return { status: 'rejected', message: 'Request cancelled in your wallet.' };
        throw e;
      }
      return { status: 'success', signature: SIG, code: 0 };
    });
    h.deps.signTransaction.mockImplementation(() => Promise.reject({ code: 4001, message: 'User rejected the request.' }));
    const ctl = new AbortController();
    expect(await runTrade(h.deps, request(), h.dispatch, { signal: ctl.signal })).toBe('rejected');
    expect(h.phases).toEqual(['building', 'signing', 'idle']);
  });

  it('once signed, a cancel changes nothing: the transaction is sent and followed to its outcome', async () => {
    const landed = deferred<ExecuteResult>();
    const h = harness();
    let executeSignal: AbortSignal | undefined;
    h.deps.swap.mockImplementation(async (o, sign, call) => {
      await sign(o.transaction);
      executeSignal = call?.signal;
      return landed.promise;
    });
    const ctl = new AbortController();
    const running = runTrade(h.deps, request(), h.dispatch, { signal: ctl.signal });
    await vi.waitFor(() => expect(h.state().phase).toBe('submitting'));

    ctl.abort();
    // The signal /execute runs with is never aborted after the signature.
    expect(executeSignal?.aborted).toBe(false);
    landed.resolve({ status: 'success', signature: SIG, code: 0 });

    expect(await running).toBe('confirmed');
    expect(h.state()).toMatchObject({ phase: 'confirmed', signature: SIG });
  });

  it('an already-aborted signal never builds an order', async () => {
    const h = harness();
    const ctl = new AbortController();
    ctl.abort();
    expect(await runTrade(h.deps, request(), h.dispatch, { signal: ctl.signal })).toBe('cancelled');
    expect(h.deps.buildOrder).not.toHaveBeenCalled();
  });

  it('without a signal the flow is unchanged', async () => {
    const h = harness();
    expect(await runTrade(h.deps, request(), h.dispatch)).toBe('confirmed');
    expect(h.phases).toEqual(['building', 'signing', 'submitting', 'confirmed']);
  });

  it('the reducer only lets building / signing be cancelled, and only for the same attempt', () => {
    const signing: TradeState = { phase: 'signing', id: 5, side: 'buy' };
    expect(tradeReducer(signing, { type: 'cancelled', id: 5 })).toEqual({ phase: 'idle', id: 5 });
    expect(tradeReducer(signing, { type: 'cancelled', id: 4 })).toBe(signing);
    const submitting: TradeState = { phase: 'submitting', id: 5 };
    expect(tradeReducer(submitting, { type: 'cancelled', id: 5 })).toBe(submitting);
    const failed: TradeState = { phase: 'failed', id: 5, message: 'x' };
    expect(tradeReducer(failed, { type: 'cancelled', id: 5 })).toBe(failed);
    expect(isTradeCancellable('building') && isTradeCancellable('signing')).toBe(true);
    expect((['idle', 'submitting', 'confirmed', 'failed', 'unknown'] as const).some(isTradeCancellable)).toBe(false);
  });

  it('with the real Jupiter swap module: cancelled during the wallet prompt, /execute is never called', async () => {
    const kit = await import('@solana/kit');
    const { bytesToBase64 } = await import('@/lib/wallet/bytes');
    const { createJupiterSwap } = await import('@/lib/swap/jupiter');
    const keys = await kit.generateKeyPair();
    const taker = await kit.getAddressFromPublicKey(keys.publicKey);
    const unsigned = kit.compileTransaction(
      kit.pipe(
        kit.createTransactionMessage({ version: 0 }),
        (m) => kit.setTransactionMessageFeePayer(taker, m),
        (m) => kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: kit.blockhash('EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'), lastValidBlockHeight: 400n }, m),
        (m) => kit.appendTransactionMessageInstruction({ programAddress: kit.address('11111111111111111111111111111111'), accounts: [], data: new Uint8Array([2, 0, 0, 0]) }, m),
      ),
    );
    const encode = (tx: Parameters<ReturnType<typeof kit.getTransactionEncoder>['encode']>[0]) => new Uint8Array(kit.getTransactionEncoder().encode(tx));
    const calls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      calls.push(new URL(String(input)).pathname);
      const body = { inAmount: '100000000', outAmount: '41665048348', slippageBps: 100, priceImpact: -0.4, transaction: bytesToBase64(encode(unsigned)), taker, inputMint: SOL, outputMint: TOKEN, requestId: 'req-cancel' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const jup = createJupiterSwap({ fetch: fetchMock });
    const ctl = new AbortController();
    const h = harness();
    const signTransaction = vi.fn(async (tx: Uint8Array) => {
      ctl.abort(); // Cancel (or leaving the page) while the prompt is open …
      return encode(await kit.partiallySignTransaction([keys], kit.getTransactionDecoder().decode(tx))); // … then approved anyway
    });

    const outcome = await runTrade({ buildOrder: jup.buildOrder, swap: jup.swap, signTransaction }, request({ taker }), h.dispatch, { signal: ctl.signal });
    expect(outcome).toBe('cancelled');
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['/swap/v2/order']);
    expect(h.state().phase).toBe('idle');
  });
});

describe('impactGate (price-impact confirmation for the current form)', () => {
  const KEY = 'mint|buy|5|1000';
  const stopped = (key: string, impactPct: number): TradeState => ({ phase: 'failed', id: 3, key, impactPct, message: 'Price impact …' });

  it('the live quote’s danger-band impact needs a confirmation, which then covers it', () => {
    expect(impactGate({ quoteImpactPct: 3, trade: IDLE_TRADE, key: KEY, acceptedImpactPct: undefined })).toEqual({ needsConfirm: false });
    expect(impactGate({ quoteImpactPct: 22, trade: IDLE_TRADE, key: KEY, acceptedImpactPct: undefined })).toEqual({ impactPct: 22, needsConfirm: true });
    expect(impactGate({ quoteImpactPct: 22, trade: IDLE_TRADE, key: KEY, acceptedImpactPct: 22 })).toEqual({ impactPct: 22, needsConfirm: false });
  });

  it('an order stopped on its impact blocks the same form, at the higher of the two impacts', () => {
    expect(impactGate({ quoteImpactPct: 4, trade: stopped(KEY, 70), key: KEY, acceptedImpactPct: undefined })).toEqual({ impactPct: 70, needsConfirm: true });
    expect(impactGate({ quoteImpactPct: 20, trade: stopped(KEY, 70), key: KEY, acceptedImpactPct: 20 })).toEqual({ impactPct: 70, needsConfirm: true });
    expect(impactGate({ quoteImpactPct: 4, trade: stopped(KEY, 70), key: KEY, acceptedImpactPct: 70 }).needsConfirm).toBe(false);
  });

  it('a stop recorded for another amount, side, slippage or token never blocks the current form', () => {
    for (const other of ['mint|buy|50|1000', 'mint|sell|5|1000', 'mint|buy|5|500', 'other|buy|5|1000']) {
      expect(impactGate({ quoteImpactPct: 0.5, trade: stopped(other, 70), key: KEY, acceptedImpactPct: undefined })).toEqual({ needsConfirm: false });
    }
  });

  it('the attempt key is kept on the impact stop and on the settled result', async () => {
    const h = harness({ order: order({ priceImpactPct: 40 }) });
    await runTrade(h.deps, request({ key: KEY }), h.dispatch);
    expect(h.state()).toMatchObject({ phase: 'failed', key: KEY, impactPct: 40 });

    const ok = harness();
    await runTrade(ok.deps, request({ key: KEY }), ok.dispatch);
    expect(ok.state()).toMatchObject({ phase: 'confirmed', key: KEY });
  });
});
