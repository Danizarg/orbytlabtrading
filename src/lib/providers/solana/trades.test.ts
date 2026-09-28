import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MINTS } from '@/lib/core/solana';
import { deriveTradeForMint, type DerivedTrade } from '@/lib/analytics/swaps';
import type { RpcParsedTransaction } from '@/lib/analytics/tx-types';
import { createRpcClient, type RpcSignatureInfo } from './rpc';
import { createRpcTradesProvider, dexIdFromProgramLabel, MAX_RPC_TRADES, resetTradeCache, toTrade } from './trades';
import { fakeRpc, fixtureResult, fixtureTransaction, relabelTransaction, type RpcRequest } from './test-helpers';

vi.mock('@/lib/analytics/swaps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/analytics/swaps')>();
  return { ...actual, deriveTradeForMint: vi.fn(actual.deriveTradeForMint), classifyWalletActivity: vi.fn(actual.classifyWalletActivity) };
});

const actualSwaps = await vi.importActual<typeof import('@/lib/analytics/swaps')>('@/lib/analytics/swaps');

const MINT = '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump';
const POOL = '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A';
const buyV2 = fixtureTransaction('rpc_getTransaction_pumpfun_bondingcurve_buyV2_v0.json');
const buyV2Signature = buyV2.transaction.signatures[0] as string;

/** Real signatures of the curve (all succeeded) plus one real failed signature. */
const curveSignatures = fixtureResult<RpcSignatureInfo[]>('solana-rpc/rpc_getSignaturesForAddress_bondingcurve.json');
const failedSignature = fixtureResult<RpcSignatureInfo[]>('solana-rpc/rpc_getSignaturesForAddress_pumpfun_program.json')[0] as RpcSignatureInfo;
const signatures: RpcSignatureInfo[] = [
  ...curveSignatures.slice(0, 2),
  { ...failedSignature, blockTime: 1790628541 },
  ...curveSignatures.slice(2),
];

const realSwapsImplemented = (() => {
  try {
    actualSwaps.deriveTradeForMint(buyV2, MINT, { pool: POOL });
    return true;
  } catch (error) {
    return !/not implemented/i.test(String(error));
  }
})();

/** Deterministic stand-in for the swap derivation (the real one is exercised in the integration test). */
function fakeDerive(tx: RpcParsedTransaction): DerivedTrade {
  return {
    signature: tx.transaction.signatures[0] as string,
    timestamp: (tx.blockTime ?? 0) * 1000,
    side: 'buy',
    wallet: 'DHpRzLRuACd8i1BVGZh8rGQWaQsP7b4spBZFWbzW5WSb',
    tokenAmount: 20682995.874269,
    solAmount: 1.000995698,
    priceQuote: 1.000995698 / 20682995.874269,
    program: 'pump.fun',
  };
}

function txHandler(opts: { failOn?: Set<string>; blockTimeNull?: Set<string> } = {}) {
  const byTime = new Map(signatures.map((s) => [s.signature, s.blockTime]));
  return (request: RpcRequest) => {
    if (request.method === 'getSignaturesForAddress') {
      const limit = (request.params[1] as { limit: number }).limit;
      return { result: signatures.slice(0, limit) };
    }
    const signature = request.params[0] as string;
    if (opts.failOn?.has(signature)) return { error: { code: 429, message: 'Too many requests for a specific RPC call' } };
    const blockTime = opts.blockTimeNull?.has(signature) ? null : (byTime.get(signature) ?? null);
    return { result: relabelTransaction(buyV2, signature, blockTime) };
  };
}

function setup(handler: (r: RpcRequest) => unknown, provider: 'solana-rpc' | 'helius' = 'solana-rpc') {
  const rpc = fakeRpc(handler);
  const client = createRpcClient({ url: 'https://rpc.example.org', fetcher: rpc.fetcher, provider });
  return { rpc, trades: createRpcTradesProvider({ rpc: client }) };
}

beforeEach(() => {
  resetTradeCache();
  vi.mocked(deriveTradeForMint).mockReset();
  vi.mocked(deriveTradeForMint).mockImplementation((tx) => fakeDerive(tx));
});

describe('createRpcTradesProvider (orchestration)', () => {
  it('reads recent pool signatures, skips failed ones and returns newest-first trades', async () => {
    const { rpc, trades } = setup(txHandler());
    const result = await trades.getTrades({ mint: MINT, pool: POOL, limit: 10 });

    expect(rpc.requestsFor('getSignaturesForAddress')[0]?.params).toEqual([POOL, { commitment: 'confirmed', limit: 10 }]);
    const fetched = rpc.requestsFor('getTransaction').map((r) => r.params[0]);
    expect(fetched).not.toContain(failedSignature.signature);
    expect(fetched).toHaveLength(5);
    expect(vi.mocked(deriveTradeForMint)).toHaveBeenCalledWith(expect.anything(), MINT, { pool: POOL });

    expect(result.source).toBe('solana-rpc');
    expect(result.freshness).toBe('realtime');
    expect(result.notes).toBeUndefined();
    expect(result.data.map((t) => t.signature)).toEqual(curveSignatures.map((s) => s.signature));
    const timestamps = result.data.map((t) => t.timestamp);
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);

    const first = result.data[0];
    expect(first).toEqual({
      signature: curveSignatures[0]?.signature,
      timestamp: 1790628543000,
      side: 'buy',
      wallet: 'DHpRzLRuACd8i1BVGZh8rGQWaQsP7b4spBZFWbzW5WSb',
      tokenAmount: 20682995.874269,
      solAmount: 1.000995698,
      quoteAmount: 1.000995698,
      quoteSymbol: 'SOL',
      pool: POOL,
      dex: 'pumpfun',
      source: 'solana-rpc',
    });
    expect(first?.usdValue).toBeUndefined();
    expect(first?.priceUsd).toBeUndefined();
  });

  it('serves repeat polls from the parsed-trade cache', async () => {
    const { rpc, trades } = setup(txHandler());
    await trades.getTrades({ mint: MINT, pool: POOL });
    const firstRound = rpc.requestsFor('getTransaction').length;
    const again = await trades.getTrades({ mint: MINT, pool: POOL });
    expect(rpc.requestsFor('getTransaction').length).toBe(firstRound);
    expect(rpc.requestsFor('getSignaturesForAddress')).toHaveLength(2);
    expect(again.data).toHaveLength(5);
  });

  it('caches negative results (tx without a trade of the mint)', async () => {
    vi.mocked(deriveTradeForMint).mockImplementation(() => null);
    const { rpc, trades } = setup(txHandler());
    expect((await trades.getTrades({ mint: MINT, pool: POOL })).data).toEqual([]);
    await trades.getTrades({ mint: MINT, pool: POOL });
    expect(rpc.requestsFor('getTransaction')).toHaveLength(5);
  });

  it(`caps the signature page at ${MAX_RPC_TRADES}`, async () => {
    const { rpc, trades } = setup(txHandler());
    await trades.getTrades({ mint: MINT, pool: POOL, limit: 500 });
    expect((rpc.requestsFor('getSignaturesForAddress')[0]?.params[1] as { limit: number }).limit).toBe(MAX_RPC_TRADES);
  });

  it('keeps a contiguous newest window when the RPC rate-limits mid-way', async () => {
    const third = curveSignatures[2]?.signature as string;
    const { trades } = setup(txHandler({ failOn: new Set([third]) }));
    const result = await trades.getTrades({ mint: MINT, pool: POOL });
    expect(result.data.map((t) => t.signature)).toEqual(curveSignatures.slice(0, 2).map((s) => s.signature));
    expect(result.notes?.[0]).toMatch(/Only the 3 most recent of 6 transactions could be loaded \(RPC rate limit\)/);
  });

  it('caches transactions fetched past the stop point so the next poll only fetches the gap', async () => {
    const third = curveSignatures[2]?.signature as string;
    const failOn = new Set([third]);
    const { rpc, trades } = setup(txHandler({ failOn }));
    await trades.getTrades({ mint: MINT, pool: POOL });
    const firstRound = rpc.requestsFor('getTransaction').length;
    failOn.clear();
    const second = await trades.getTrades({ mint: MINT, pool: POOL });
    expect(rpc.requestsFor('getTransaction').slice(firstRound).map((r) => r.params[0])).toEqual([third]);
    expect(second.data).toHaveLength(5);
    expect(second.notes).toBeUndefined();
  });

  it('throws when not a single transaction could be loaded', async () => {
    const { trades } = setup(txHandler({ failOn: new Set(curveSignatures.map((s) => s.signature)) }));
    await expect(trades.getTrades({ mint: MINT, pool: POOL })).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('skips transactions without a block time and says so', async () => {
    const { trades } = setup(txHandler({ blockTimeNull: new Set([curveSignatures[1]?.signature as string]) }));
    const result = await trades.getTrades({ mint: MINT, pool: POOL });
    expect(result.data).toHaveLength(4);
    expect(result.notes).toContain('1 transaction(s) without a block time were skipped.');
  });

  it('surfaces a parser that fails on everything instead of returning an empty feed', async () => {
    vi.mocked(deriveTradeForMint).mockImplementation(() => {
      throw new Error('boom');
    });
    const { trades } = setup(txHandler());
    await expect(trades.getTrades({ mint: MINT, pool: POOL })).rejects.toMatchObject({ code: 'malformed' });
  });

  it('only returns trades newer than `since`', async () => {
    const { rpc, trades } = setup(txHandler());
    const result = await trades.getTrades({ mint: MINT, pool: POOL, since: 1790628541000 });
    expect(result.data.map((t) => t.timestamp)).toEqual([1790628543000, 1790628542000]);
    expect(rpc.requestsFor('getTransaction')).toHaveLength(2);
  });

  it('needs a valid pool and mint', async () => {
    const { rpc, trades } = setup(txHandler());
    await expect(trades.getTrades({ mint: MINT })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(trades.getTrades({ mint: 'bad', pool: POOL })).rejects.toMatchObject({ code: 'not_found' });
    expect(rpc.calls).toHaveLength(0);
  });

  it('fetches all transactions in one batch on Helius', async () => {
    const { rpc, trades } = setup(txHandler(), 'helius');
    const result = await trades.getTrades({ mint: MINT, pool: POOL });
    expect(trades.id).toBe('helius');
    expect(result.source).toBe('helius');
    const batches = rpc.calls.filter((c) => c.batch);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.requests).toHaveLength(5);
  });
});

describe('toTrade / dexIdFromProgramLabel', () => {
  const base: DerivedTrade = { signature: 's', timestamp: 1_790_628_401_000, side: 'sell', wallet: 'w', tokenAmount: 100 };

  it('values stablecoin-quoted trades in USD and leaves other quotes unpriced', () => {
    const usdc = toTrade({ ...base, quoteMint: MINTS.USDC, quoteAmount: 9.827851 }, 'p', 'solana-rpc');
    expect(usdc).toMatchObject({ quoteAmount: 9.827851, quoteSymbol: 'USDC', usdValue: 9.827851 });
    expect(usdc?.priceUsd).toBeCloseTo(0.09827851, 12);
    expect(usdc?.solAmount).toBeUndefined();
    const pump = toTrade({ ...base, quoteMint: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn', quoteAmount: 5 }, 'p', 'solana-rpc');
    expect(pump).toMatchObject({ quoteAmount: 5, quoteSymbol: 'PUMP' });
    expect(pump?.usdValue).toBeUndefined();
  });

  it('drops derived trades without a usable timestamp or amount', () => {
    expect(toTrade({ ...base, timestamp: Number.NaN }, 'p', 'solana-rpc')).toBeUndefined();
    expect(toTrade({ ...base, tokenAmount: 0 }, 'p', 'solana-rpc')).toBeUndefined();
  });

  it('maps venue labels to normalized dex ids', () => {
    expect(dexIdFromProgramLabel('pump.fun')).toBe('pumpfun');
    expect(dexIdFromProgramLabel('PumpSwap')).toBe('pumpswap');
    expect(dexIdFromProgramLabel('Raydium CPMM')).toBe('raydium-cpmm');
    expect(dexIdFromProgramLabel('Meteora DLMM')).toBe('meteora-dlmm');
    expect(dexIdFromProgramLabel('Jupiter')).toBe('jupiter');
    expect(dexIdFromProgramLabel('Some New Dex')).toBe('some-new-dex');
    expect(dexIdFromProgramLabel(undefined)).toBeUndefined();
  });
});

describe('createRpcTradesProvider (real swap derivation)', () => {
  it.skipIf(!realSwapsImplemented)('derives the live pump.fun BuyV2 trade from the captured transaction', async () => {
    vi.mocked(deriveTradeForMint).mockImplementation(actualSwaps.deriveTradeForMint);
    const handler = (request: RpcRequest) =>
      request.method === 'getSignaturesForAddress'
        ? { result: [{ signature: buyV2Signature, slot: buyV2.slot, blockTime: buyV2.blockTime, err: null, memo: null, confirmationStatus: 'confirmed' }] }
        : { result: buyV2 };
    const { trades } = setup(handler);
    const result = await trades.getTrades({ mint: MINT, pool: POOL });
    expect(result.data).toHaveLength(1);
    const trade = result.data[0];
    expect(trade?.signature).toBe(buyV2Signature);
    expect(trade?.side).toBe('buy');
    expect(trade?.wallet).toBe('DHpRzLRuACd8i1BVGZh8rGQWaQsP7b4spBZFWbzW5WSb');
    expect(trade?.timestamp).toBe(1790628401000);
    expect(trade?.tokenAmount).toBeCloseTo(20682995.874269, 6);
    expect(trade?.solAmount).toBeCloseTo(1.000995698, 6);
    expect(trade?.quoteSymbol).toBe('SOL');
    expect(trade?.pool).toBe(POOL);
  });
});
