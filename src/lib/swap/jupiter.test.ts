import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPair,
  getAddressFromPublicKey,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Transaction,
} from '@solana/kit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { bytesToBase64 } from '@/lib/wallet/bytes';
import { WalletError } from '@/lib/wallet/errors';
import { SwapError } from './errors';
import { createJupiterSwap, SWAP_ROUTER_LABEL, type SwapOrder } from './jupiter';
import { inspectTransaction } from './transaction';

const SOL = 'So11111111111111111111111111111111111111112';
const TOKEN = 'DKxXdaMC1so182urvrrnhs6V6fGTrttPS8br6JuEpump';
const OTHER_WALLET = '8dbTV2UQXUbhAjpQ8Hf9mcpuJX7LaBWs3FDAqC2rTfc3';
const SYSTEM = address('11111111111111111111111111111111');
/** A well-formed base58 transaction signature as Jupiter would return it. */
const REMOTE_SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

let keys: CryptoKeyPair;
let taker: string;
let unsigned: Transaction;
let unsignedBytes: Uint8Array;

function encode(tx: Transaction): Uint8Array {
  return new Uint8Array(getTransactionEncoder().encode(tx));
}

function txFor(feePayer: string): Transaction {
  return compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(address(feePayer), m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash('EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'), lastValidBlockHeight: 400n }, m),
      (m) => appendTransactionMessageInstruction({ programAddress: SYSTEM, accounts: [], data: new Uint8Array([2, 0, 0, 0]) }, m),
    ),
  );
}

beforeAll(async () => {
  keys = await generateKeyPair();
  taker = await getAddressFromPublicKey(keys.publicKey);
  unsigned = txFor(taker);
  unsignedBytes = encode(unsigned);
});

/** A real /swap/v2/order response shape (tests/fixtures/jupiter/swap_v2_order_quote_no_taker.json) with a taker. */
function orderBody(patch: Record<string, unknown> = {}) {
  return {
    swapType: 'aggregator',
    inAmount: '100000000',
    outAmount: '41665048348',
    otherAmountThreshold: '41248397865',
    swapMode: 'ExactIn',
    slippageBps: 100,
    priceImpactPct: '-0.0042',
    routePlan: [{ percent: 100, bps: 10000, usdValue: 11.87, swapInfo: { ammKey: 'A8mMNioRKoRXcb8nVVRy9KV7ZSPyfTTm13ye4bSgHw7F', label: 'Pump.fun Amm', inputMint: SOL, outputMint: TOKEN, inAmount: '100000000', outAmount: '41706755103' } }],
    feeMint: SOL,
    feeBps: 10,
    platformFee: { feeBps: 10, feeMint: SOL, amount: '100000' },
    signatureFeeLamports: 5000,
    prioritizationFeeLamports: 12000,
    rentFeeLamports: 2039280,
    transaction: bytesToBase64(unsignedBytes),
    lastValidBlockHeight: '400',
    gasless: false,
    taker,
    inputMint: SOL,
    outputMint: TOKEN,
    router: 'metis',
    requestId: '01a0e9c6-fcab-75ab-b27f-c8d3326c641e',
    inUsdValue: 11.87,
    outUsdValue: 11.82,
    priceImpact: -0.42,
    mode: 'manual',
    ...patch,
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const request = () => ({ inputMint: SOL, outputMint: TOKEN, amountRaw: 100_000_000n, taker, slippageBps: 100 });

async function signWithKeys(tx: Uint8Array): Promise<Uint8Array> {
  const inspected = inspectTransaction(tx);
  expect(inspected?.signers).toContain(taker);
  return encode(await partiallySignTransaction([keys], unsigned));
}

describe('buildOrder', () => {
  it('requests /swap/v2/order for the taker and returns a typed order', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(orderBody()));
    const jup = createJupiterSwap({ fetch: fetchMock, now: () => 1_000 });
    const order = await jup.buildOrder(request());

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe('https://api.jup.ag/swap/v2/order');
    expect(Object.fromEntries(url.searchParams)).toEqual({ inputMint: SOL, outputMint: TOKEN, amount: '100000000', taker, slippageBps: '100' });
    expect(fetchMock.mock.calls[0]![1]?.headers).not.toHaveProperty('x-api-key');

    expect(order).toMatchObject({
      requestId: '01a0e9c6-fcab-75ab-b27f-c8d3326c641e',
      inAmountRaw: '100000000',
      outAmountRaw: '41665048348',
      minOutAmountRaw: '41248397865',
      slippageBps: 100,
      priceImpactPct: 0.42,
      route: ['Pump.fun Amm'],
      router: 'Jupiter Ultra',
      routerId: 'metis',
      feeBps: 10,
      feeMint: SOL,
      gasless: false,
      signatureFeeLamports: 5000,
      prioritizationFeeLamports: 12000,
      rentFeeLamports: 2039280,
      lastValidBlockHeight: '400',
      fetchedAt: 1_000,
    });
    expect(SWAP_ROUTER_LABEL).toBe('Jupiter Ultra');
    expect(order.transaction).toEqual(unsignedBytes);
  });

  it('surfaces an unbuildable quote (HTTP 200 with errorCode) verbatim but safely', async () => {
    const body = orderBody({ transaction: '', errorCode: 1, errorMessage: 'Insufficient funds: need 0.1 SOL, see https://jup.ag/x <b>' });
    const jup = createJupiterSwap({ fetch: async () => json(body) });
    const error = await jup.buildOrder(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SwapError);
    expect(error).toMatchObject({ code: 'unbuildable', jupiterCode: 1 });
    expect((error as SwapError).message).toBe('Jupiter: Insufficient funds: need 0.1 SOL, see [link] b');
  });

  it('falls back to a router- and code-specific message when Jupiter gives no text', async () => {
    const cases: Array<[string, number, string]> = [
      ['metis', 2, 'Not enough SOL to pay the network fees for this swap.'],
      ['metis', 3, 'This swap is below the minimum size for a gasless swap.'],
      ['jupiterz', 2, 'A token account this swap needs is missing.'],
      ['jupiterz', 3, 'Jupiter could not build a transaction for this quote.'],
      ['okx', 1, 'Insufficient balance for this swap.'],
      ['dflow', 99, 'Jupiter could not build a transaction for this swap.'],
    ];
    for (const [router, errorCode, message] of cases) {
      const jup = createJupiterSwap({ fetch: async () => json(orderBody({ transaction: '', router, errorCode })) });
      await expect(jup.buildOrder(request())).rejects.toMatchObject({ code: 'unbuildable', jupiterCode: errorCode, message });
    }
  });

  it('maps HTTP 400 { error } and 429 with the reset header', async () => {
    const rejected = createJupiterSwap({ fetch: async () => json({ requestId: 'x', error: 'Invalid outputMint' }, 400) });
    await expect(rejected.buildOrder(request())).rejects.toMatchObject({ code: 'order_rejected', message: 'Jupiter: Invalid outputMint' });

    const limited = createJupiterSwap({
      fetch: async () => json({ code: 429, message: '[API Gateway] Too many requests' }, 429, { 'x-ratelimit-reset': '105' }),
      now: () => 100_000,
    });
    await expect(limited.buildOrder(request())).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: 5_000 });
  });

  it('rejects orders that are not for this wallet or this request', async () => {
    const otherWallet = createJupiterSwap({ fetch: async () => json(orderBody({ taker: OTHER_WALLET })) });
    await expect(otherWallet.buildOrder(request())).rejects.toMatchObject({ code: 'mismatch' });

    const otherPayer = createJupiterSwap({ fetch: async () => json(orderBody({ taker: undefined, transaction: bytesToBase64(encode(txFor(OTHER_WALLET))) })) });
    await expect(otherPayer.buildOrder(request())).rejects.toMatchObject({ code: 'mismatch', message: 'The swap transaction does not require your wallet to sign.' });

    const overspend = createJupiterSwap({ fetch: async () => json(orderBody({ inAmount: '100000001' })) });
    await expect(overspend.buildOrder(request())).rejects.toMatchObject({ code: 'mismatch' });

    const otherToken = createJupiterSwap({ fetch: async () => json(orderBody({ outputMint: OTHER_WALLET })) });
    await expect(otherToken.buildOrder(request())).rejects.toMatchObject({ code: 'mismatch' });
  });

  it('rejects malformed responses and invalid input without calling Jupiter', async () => {
    const garbage = createJupiterSwap({ fetch: async () => json(orderBody({ transaction: 'AAAA' })) });
    await expect(garbage.buildOrder(request())).rejects.toMatchObject({ code: 'malformed' });

    const fetchMock = vi.fn<typeof fetch>();
    const jup = createJupiterSwap({ fetch: fetchMock });
    await expect(jup.buildOrder({ ...request(), amountRaw: '0' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(jup.buildOrder({ ...request(), amountRaw: '1.5' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(jup.buildOrder({ ...request(), outputMint: SOL })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(jup.buildOrder({ ...request(), taker: 'nope' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(jup.buildOrder({ ...request(), slippageBps: 10_001 })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a network failure while ordering', async () => {
    const jup = createJupiterSwap({ fetch: async () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(jup.buildOrder(request())).rejects.toMatchObject({ code: 'network' });
  });
});

describe('swap (sign + execute)', () => {
  async function order(): Promise<SwapOrder> {
    return createJupiterSwap({ fetch: async () => json(orderBody()) }).buildOrder(request());
  }

  it('signs with the wallet and executes once, returning the signature', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json({ status: 'Success', signature: '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW', slot: '323598314', code: 0, totalInputAmount: '100000000', totalOutputAmount: '41600000000', inputAmountResult: '99900000', outputAmountResult: '41650000000' }),
    );
    const jup = createJupiterSwap({ fetch: fetchMock });
    const signer = vi.fn(signWithKeys);
    const result = await jup.swap(await order(), signer);

    expect(signer).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.jup.ag/swap/v2/execute');
    const sent = JSON.parse(String(init?.body)) as { signedTransaction: string; requestId: string; lastValidBlockHeight: string };
    expect(sent.requestId).toBe('01a0e9c6-fcab-75ab-b27f-c8d3326c641e');
    expect(sent.lastValidBlockHeight).toBe('400');
    const signedTx = inspectTransaction(new Uint8Array(Buffer.from(sent.signedTransaction, 'base64')));
    expect(signedTx?.signatures[taker]).toBeTruthy();

    expect(result).toEqual({
      status: 'success',
      code: 0,
      signature: '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW',
      slot: '323598314',
      totalInputAmountRaw: '100000000',
      totalOutputAmountRaw: '41600000000',
      inputAmountResultRaw: '99900000',
      outputAmountResultRaw: '41650000000',
    });
  });

  it('resolves to rejected when the user declines, without calling execute', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const jup = createJupiterSwap({ fetch: fetchMock });
    const result = await jup.swap(await order(), async () => {
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
    });
    expect(result).toEqual({ status: 'rejected', message: 'Request cancelled in your wallet.' });
    expect(fetchMock).not.toHaveBeenCalled();

    const viaWalletError = await jup.swap(await order(), async () => {
      throw new WalletError('rejected', 'Request cancelled in your wallet.');
    });
    expect(viaWalletError.status).toBe('rejected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to send a transaction the wallet did not sign', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const jup = createJupiterSwap({ fetch: fetchMock });
    await expect(jup.swap(await order(), async (tx) => tx)).rejects.toMatchObject({ code: 'sign_failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an expired RFQ quote before asking the wallet', async () => {
    const jup = createJupiterSwap({ fetch: async () => json(orderBody({ expireAt: '1000' })), now: () => 2_000_000 });
    const expired = await jup.buildOrder(request());
    expect(expired.expiresAt).toBe(1_000_000);
    const signer = vi.fn(signWithKeys);
    await expect(jup.swap(expired, signer)).rejects.toMatchObject({ code: 'expired' });
    expect(signer).not.toHaveBeenCalled();
  });

  it('maps an execute failure (status Failed) and never retries', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ status: 'Failed', signature: REMOTE_SIG, code: -1000, error: 'Failed to land' }));
    const jup = createJupiterSwap({ fetch: fetchMock });
    const result = await jup.swap(await order(), signWithKeys);
    expect(result).toMatchObject({ status: 'failed', code: -1000, error: 'Jupiter: Failed to land', signature: REMOTE_SIG });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports "Failed" with an unknown-error code (-1001 / -2001) as unknown, not as a definite failure', async () => {
    for (const code of [-1001, -2001]) {
      const fetchMock = vi.fn<typeof fetch>(async () => json({ status: 'Failed', signature: REMOTE_SIG, code, error: 'Unknown error' }));
      const result = await createJupiterSwap({ fetch: fetchMock }).swap(await order(), signWithKeys);
      expect(result).toMatchObject({ status: 'unknown', signature: REMOTE_SIG, error: expect.stringMatching(/^Jupiter: Unknown error\. .*may still land/) });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('ignores a signature from Jupiter that is not a base58 transaction signature', async () => {
    const local = inspectTransaction(await signWithKeys(unsignedBytes))!.signatures[taker];
    const jup = createJupiterSwap({ fetch: async () => json({ status: 'Success', signature: 'javascript:alert(1)', code: 0 }) });
    expect(await jup.swap(await order(), signWithKeys)).toMatchObject({ status: 'success', signature: local });
  });

  it('maps HTTP 400 from execute to failed', async () => {
    const jup = createJupiterSwap({ fetch: async () => json({ error: 'Missing cached order', code: -1 }, 400) });
    const result = await jup.swap(await order(), signWithKeys);
    expect(result).toMatchObject({ status: 'failed', code: -1, error: 'Jupiter: Missing cached order' });
  });

  it('treats a 500 or a lost connection as unknown and keeps the local transaction id', async () => {
    const serverError = createJupiterSwap({ fetch: async () => json({ signature: REMOTE_SIG, error: 'internal' }, 500) });
    const r1 = await serverError.swap(await order(), signWithKeys);
    expect(r1).toMatchObject({ status: 'unknown', signature: REMOTE_SIG });

    const fetchMock = vi.fn<typeof fetch>(async () => Promise.reject(new TypeError('network')));
    const lost = createJupiterSwap({ fetch: fetchMock });
    const r2 = await lost.swap(await order(), signWithKeys);
    const local = inspectTransaction(await signWithKeys(unsignedBytes))!.signatures[taker];
    expect(r2).toMatchObject({ status: 'unknown', signature: local });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('wraps other wallet failures as sign_failed', async () => {
    const jup = createJupiterSwap({ fetch: vi.fn<typeof fetch>() });
    await expect(
      jup.swap(await order(), async () => {
        throw new Error('Wallet locked');
      }),
    ).rejects.toMatchObject({ code: 'sign_failed', message: 'Your wallet could not sign the swap. (Wallet locked)' });
  });
});
