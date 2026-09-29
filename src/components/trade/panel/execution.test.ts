import { describe, expect, it, vi } from 'vitest';
import type { ExecuteResult, SwapOrder, SwapResult } from '@/lib/swap';
import { SwapError } from '@/lib/swap/errors';
import { WalletError } from '@/lib/wallet/errors';
import {
  IDLE_TRADE,
  impactStillAccepted,
  isTradeBusy,
  needsImpactConfirmation,
  runTrade,
  tradeReducer,
  type TradeDeps,
  type TradeEvent,
  type TradePhase,
  type TradeRequest,
  type TradeState,
} from './execution';

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

/**
 * Mocked Jupiter + wallet. `swap` behaves like src/lib/swap: it asks the
 * wallet to sign, maps a rejection to { status: 'rejected' } and otherwise
 * resolves with the (mocked) execute outcome.
 */
function harness(opts: { order?: SwapOrder | Error; execute?: ExecuteResult; sign?: (tx: Uint8Array) => Promise<Uint8Array> } = {}) {
  const buildOrder = vi.fn<TradeDeps['buildOrder']>(async () => {
    if (opts.order instanceof Error) throw opts.order;
    return opts.order ?? order();
  });
  const signTransaction = vi.fn<TradeDeps['signTransaction']>(opts.sign ?? (async () => SIGNED));
  const execute = vi.fn(async (): Promise<ExecuteResult> => opts.execute ?? { status: 'success', signature: SIG, code: 0, inputAmountResultRaw: '100000000', outputAmountResultRaw: '41600000000' });
  const swap = vi.fn<TradeDeps['swap']>(async (o, sign): Promise<SwapResult> => {
    try {
      await sign(o.transaction);
    } catch (e) {
      if (e instanceof WalletError && e.kind === 'rejected') return { status: 'rejected', message: e.message };
      throw new SwapError('sign_failed', `Your wallet could not sign the swap. (${(e as Error).message})`);
    }
    return execute();
  });
  const events: TradeEvent[] = [];
  const phases: TradePhase[] = [];
  let state: TradeState = IDLE_TRADE;
  const dispatch = (event: TradeEvent) => {
    events.push(event);
    const next = tradeReducer(state, event);
    if (next.phase !== state.phase) phases.push(next.phase);
    state = next;
  };
  return { deps: { buildOrder, swap, signTransaction } satisfies TradeDeps, execute, dispatch, events, phases, state: () => state };
}

describe('runTrade (mocked wallet + mocked execute)', () => {
  it('building → signing → submitting → confirmed, with the Solscan signature', async () => {
    const h = harness();
    const outcome = await runTrade(h.deps, request(), h.dispatch);

    expect(outcome).toBe('confirmed');
    expect(h.phases).toEqual(['building', 'signing', 'submitting', 'confirmed']);
    expect(h.deps.buildOrder).toHaveBeenCalledWith({ inputMint: SOL, outputMint: TOKEN, amountRaw: '100000000', taker: TAKER, slippageBps: 100 });
    expect(h.deps.signTransaction).toHaveBeenCalledWith(UNSIGNED);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.state()).toMatchObject({ phase: 'confirmed', signature: SIG, side: 'buy', result: { status: 'success' } });
    expect(h.state().order?.requestId).toBe('req-1');
  });

  it('a wallet rejection resets quietly to idle and sends nothing', async () => {
    const h = harness({
      sign: async () => {
        throw new WalletError('rejected', 'Request cancelled in your wallet.');
      },
    });
    const outcome = await runTrade(h.deps, request(), h.dispatch);

    expect(outcome).toBe('rejected');
    expect(h.phases).toEqual(['building', 'signing', 'idle']);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.state()).toEqual({ phase: 'idle', id: 1 });
  });

  it('shows Jupiter’s error text when the order cannot be built, without asking the wallet', async () => {
    const h = harness({ order: new SwapError('unbuildable', 'Jupiter: Insufficient funds: need 0.1 SOL', { jupiterCode: 1 }) });
    const outcome = await runTrade(h.deps, request(), h.dispatch);

    expect(outcome).toBe('not_sent');
    expect(h.phases).toEqual(['building', 'failed']);
    expect(h.state().message).toBe('Jupiter: Insufficient funds: need 0.1 SOL');
    expect(h.deps.signTransaction).not.toHaveBeenCalled();
    expect(h.deps.swap).not.toHaveBeenCalled();
  });

  it('never leaks unexpected error text', async () => {
    const h = harness({ order: new Error('<script>https://evil.example</script>') });
    await runTrade(h.deps, request(), h.dispatch);
    expect(h.state().message).toBe('Jupiter could not build this swap. Nothing was sent.');
  });

  it('reports a failed execute with Jupiter’s error text and the signature, once (no retry)', async () => {
    const h = harness({ execute: { status: 'failed', code: -1000, error: 'Jupiter: Failed to land', signature: SIG } });
    const outcome = await runTrade(h.deps, request(), h.dispatch);

    expect(outcome).toBe('failed');
    expect(h.phases).toEqual(['building', 'signing', 'submitting', 'failed']);
    expect(h.state()).toMatchObject({ phase: 'failed', message: 'Jupiter: Failed to land', signature: SIG });
    expect(h.deps.buildOrder).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps an unknown outcome distinct from success', async () => {
    const h = harness({ execute: { status: 'unknown', error: 'Lost contact with Jupiter while sending.', signature: SIG } });
    const outcome = await runTrade(h.deps, request(), h.dispatch);
    expect(outcome).toBe('unknown');
    expect(h.state()).toMatchObject({ phase: 'unknown', signature: SIG, message: 'Lost contact with Jupiter while sending.' });
  });

  it('a wallet failure after signing started ends in failed with the wallet text', async () => {
    const h = harness({
      sign: async () => {
        throw new Error('Wallet locked');
      },
    });
    const outcome = await runTrade(h.deps, request(), h.dispatch);
    expect(outcome).toBe('not_sent');
    expect(h.phases).toEqual(['building', 'signing', 'failed']);
    expect(h.state().message).toBe('Your wallet could not sign the swap. (Wallet locked)');
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('stops before signing when the order’s price impact is above 15 % and unconfirmed', async () => {
    const h = harness({ order: order({ priceImpactPct: 22.5 }) });
    const outcome = await runTrade(h.deps, request(), h.dispatch);

    expect(outcome).toBe('not_sent');
    expect(h.phases).toEqual(['building', 'failed']);
    expect(h.state()).toMatchObject({ phase: 'failed', impactPct: 22.5 });
    expect(h.state().message).toMatch(/22\.5 %/);
    expect(h.deps.signTransaction).not.toHaveBeenCalled();
  });

  it('proceeds when the user confirmed that impact (small drift tolerated), stops when it grew', async () => {
    const ok = harness({ order: order({ priceImpactPct: 23 }) });
    expect(await runTrade(ok.deps, request({ acceptedImpactPct: 22 }), ok.dispatch)).toBe('confirmed');

    const worse = harness({ order: order({ priceImpactPct: 40 }) });
    expect(await runTrade(worse.deps, request({ acceptedImpactPct: 22 }), worse.dispatch)).toBe('not_sent');
    expect(worse.deps.signTransaction).not.toHaveBeenCalled();
  });
});

describe('tradeReducer', () => {
  const building: TradeState = { phase: 'building', id: 2, side: 'sell' };

  it('never starts a second trade while one is in flight', () => {
    expect(tradeReducer(building, { type: 'start', id: 3, side: 'buy' })).toBe(building);
    const signing = tradeReducer(building, { type: 'built', id: 2, order: order() });
    expect(tradeReducer(signing, { type: 'start', id: 3, side: 'buy' })).toBe(signing);
  });

  it('starts a new trade from a finished one', () => {
    const done: TradeState = { phase: 'confirmed', id: 2, signature: SIG };
    expect(tradeReducer(done, { type: 'start', id: 3, side: 'buy' })).toEqual({ phase: 'building', id: 3, side: 'buy' });
  });

  it('ignores events of another attempt and out-of-order events', () => {
    expect(tradeReducer(building, { type: 'built', id: 1, order: order() })).toBe(building);
    expect(tradeReducer(building, { type: 'signed', id: 2 })).toBe(building);
    expect(tradeReducer(IDLE_TRADE, { type: 'settled', id: 0, result: { status: 'success', signature: SIG, code: 0 } })).toBe(IDLE_TRADE);
    expect(tradeReducer(IDLE_TRADE, { type: 'error', id: 0, message: 'x' })).toBe(IDLE_TRADE);
  });

  it('dismiss clears a finished trade but never an in-flight one', () => {
    expect(tradeReducer({ phase: 'failed', id: 4, message: 'x' }, { type: 'dismiss' })).toEqual({ phase: 'idle', id: 4 });
    expect(tradeReducer(building, { type: 'dismiss' })).toBe(building);
  });

  it('busy phases', () => {
    expect((['building', 'signing', 'submitting'] as const).every(isTradeBusy)).toBe(true);
    expect((['idle', 'confirmed', 'failed', 'unknown'] as const).some(isTradeBusy)).toBe(false);
  });
});

describe('price-impact confirmation', () => {
  it('only the danger band (> 15 %) needs a confirmation', () => {
    expect(needsImpactConfirmation(undefined, undefined)).toBe(false);
    expect(needsImpactConfirmation(4, undefined)).toBe(false);
    expect(needsImpactConfirmation(12, undefined)).toBe(false);
    expect(needsImpactConfirmation(15.1, undefined)).toBe(true);
    expect(needsImpactConfirmation(15.1, 15.1)).toBe(false);
  });

  it('tolerates 10 % relative drift (at least 1 point) over the confirmed impact', () => {
    expect(impactStillAccepted(16, 15.5)).toBe(true);
    expect(impactStillAccepted(17.1, 15.5)).toBe(false);
    expect(impactStillAccepted(54, 50)).toBe(true);
    expect(impactStillAccepted(56, 50)).toBe(false);
    expect(impactStillAccepted(20, undefined)).toBe(false);
  });
});

describe('runTrade with the real Jupiter swap module (mocked HTTP + a key-holding test wallet)', () => {
  async function setup() {
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
    const orderBody = {
      inAmount: '100000000',
      outAmount: '41665048348',
      otherAmountThreshold: '41248397865',
      slippageBps: 100,
      priceImpact: -0.42,
      routePlan: [{ swapInfo: { label: 'Pump.fun Amm' } }],
      feeBps: 10,
      transaction: bytesToBase64(encode(unsigned)),
      lastValidBlockHeight: '400',
      taker,
      inputMint: SOL,
      outputMint: TOKEN,
      router: 'metis',
      requestId: 'req-live-shape',
    };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const calls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      calls.push(new URL(url).pathname);
      if (url.includes('/swap/v2/order')) return json(orderBody);
      return json({ status: 'Success', signature: SIG, code: 0, slot: '1', inputAmountResult: '100000000', outputAmountResult: '41600000000' });
    });
    const jup = createJupiterSwap({ fetch: fetchMock });
    const wallet = {
      signTransaction: vi.fn(async (tx: Uint8Array) => encode(await kit.partiallySignTransaction([keys], kit.getTransactionDecoder().decode(tx)))),
    };
    return { taker, jup, wallet, calls };
  }

  it('orders for the connected wallet, signs once, executes once', async () => {
    const { taker, jup, wallet, calls } = await setup();
    const h = harness();
    const outcome = await runTrade({ buildOrder: jup.buildOrder, swap: jup.swap, signTransaction: wallet.signTransaction }, request({ taker }), h.dispatch);

    expect(outcome).toBe('confirmed');
    expect(h.phases).toEqual(['building', 'signing', 'submitting', 'confirmed']);
    expect(calls).toEqual(['/swap/v2/order', '/swap/v2/execute']);
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(h.state()).toMatchObject({ signature: SIG, order: { requestId: 'req-live-shape', router: 'Jupiter Ultra', minOutAmountRaw: '41248397865' } });
  });

  it('a 4001 rejection from the wallet resets to idle and never calls execute', async () => {
    const { taker, jup, calls } = await setup();
    const h = harness();
    const reject = vi.fn(async () => {
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
    });
    const outcome = await runTrade({ buildOrder: jup.buildOrder, swap: jup.swap, signTransaction: reject }, request({ taker }), h.dispatch);

    expect(outcome).toBe('rejected');
    expect(h.state().phase).toBe('idle');
    expect(calls).toEqual(['/swap/v2/order']);
  });
});

describe('trade token capture', () => {
  it('keeps the traded token with the result', async () => {
    const h = harness();
    await runTrade(h.deps, request({ symbol: 'PUMP', tokenDecimals: 6 }), h.dispatch);
    expect(h.state().token).toEqual({ mint: TOKEN, symbol: 'PUMP', decimals: 6 });

    const sell = harness({ order: order({ inputMint: TOKEN, outputMint: SOL }) });
    await runTrade(sell.deps, request({ side: 'sell', inputMint: TOKEN, outputMint: SOL }), sell.dispatch);
    expect(sell.state().token).toEqual({ mint: TOKEN });
  });

  it('dismiss on an idle panel changes nothing', () => {
    expect(tradeReducer(IDLE_TRADE, { type: 'dismiss' })).toBe(IDLE_TRADE);
  });
});
