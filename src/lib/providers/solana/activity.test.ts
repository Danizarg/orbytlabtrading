import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalletActivity } from '@/lib/core/types';
import { classifyWalletActivity } from '@/lib/analytics/swaps';
import type { RpcParsedTransaction } from '@/lib/analytics/tx-types';
import { createRpcActivityProvider, DEFAULT_ACTIVITY_LIMIT, MAX_STANDARD_ACTIVITY_LIMIT, resetActivityCache } from './activity';
import { createRpcClient, type RpcSignatureInfo } from './rpc';
import { fakeRpc, fixtureResult, fixtureTransaction, relabelTransaction, type RpcRequest } from './test-helpers';

vi.mock('@/lib/analytics/swaps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/analytics/swaps')>();
  return { ...actual, deriveTradeForMint: vi.fn(actual.deriveTradeForMint), classifyWalletActivity: vi.fn(actual.classifyWalletActivity) };
});

const actualSwaps = await vi.importActual<typeof import('@/lib/analytics/swaps')>('@/lib/analytics/swaps');

const WALLET = 'DHpRzLRuACd8i1BVGZh8rGQWaQsP7b4spBZFWbzW5WSb';
const MINT = '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump';
const buyV2 = fixtureTransaction('rpc_getTransaction_pumpfun_bondingcurve_buyV2_v0.json');
const sellV1 = fixtureTransaction('rpc_getTransaction_pumpfun_bondingcurve_sell_v1.json');
const buyV2Signature = buyV2.transaction.signatures[0] as string;

const succeeded = fixtureResult<RpcSignatureInfo[]>('solana-rpc/rpc_getSignaturesForAddress_bondingcurve.json');
const failed = fixtureResult<RpcSignatureInfo[]>('solana-rpc/rpc_getSignaturesForAddress_pumpfun_program.json');
/** 7 real signatures, newest first, two of them failed. */
const history: RpcSignatureInfo[] = [
  succeeded[0],
  failed[0] && { ...failed[0], blockTime: 1790628542 },
  succeeded[1],
  succeeded[2],
  failed[1] && { ...failed[1], blockTime: 1790628541 },
  succeeded[3],
  succeeded[4],
].filter((s): s is RpcSignatureInfo => s !== undefined);
const failedSigs = new Set(history.filter((s) => s.err !== null).map((s) => s.signature));

function fakeClassify(tx: RpcParsedTransaction, wallet: string): WalletActivity {
  return {
    signature: tx.transaction.signatures[0] as string,
    timestamp: (tx.blockTime ?? 0) * 1000,
    wallet,
    kind: 'buy',
    tokenMint: MINT,
    tokenAmount: 20682995.874269,
    solAmount: 1.000995698,
    legs: [{ mint: MINT, delta: 20682995.874269 }],
    program: 'pump.fun',
    feeSol: 0.001005,
    success: true,
    source: 'solana-rpc',
  };
}

function standardHandler(opts: { failOn?: Set<string> } = {}) {
  const times = new Map(history.map((s) => [s.signature, s.blockTime]));
  return (request: RpcRequest) => {
    if (request.method === 'getSignaturesForAddress') {
      const config = request.params[1] as { limit: number; before?: string };
      const start = config.before ? history.findIndex((s) => s.signature === config.before) + 1 : 0;
      return { result: history.slice(start, start + config.limit) };
    }
    const signature = request.params[0] as string;
    if (opts.failOn?.has(signature)) return { error: { code: 429, message: 'Too many requests for a specific RPC call' } };
    return { result: relabelTransaction(buyV2, signature, times.get(signature) ?? null) };
  };
}

function setup(handler: (r: RpcRequest) => unknown, opts: { helius?: boolean } = {}) {
  const rpc = fakeRpc(handler);
  const client = createRpcClient({ url: 'https://rpc.example.org', fetcher: rpc.fetcher, provider: opts.helius ? 'helius' : 'solana-rpc' });
  return { rpc, activity: createRpcActivityProvider({ rpc: client, useHeliusHistory: opts.helius }) };
}

beforeEach(() => {
  resetActivityCache();
  vi.mocked(classifyWalletActivity).mockReset();
  vi.mocked(classifyWalletActivity).mockImplementation((tx, wallet) => fakeClassify(tx, wallet));
});

describe('createRpcActivityProvider (standard path)', () => {
  it('lists signatures, skips failed transactions for parsing but counts them', async () => {
    const { rpc, activity } = setup(standardHandler());
    const result = await activity.getActivity(WALLET, { limit: 7 });

    expect(rpc.requestsFor('getSignaturesForAddress')[0]?.params).toEqual([WALLET, { commitment: 'confirmed', limit: 7 }]);
    const fetched = rpc.requestsFor('getTransaction').map((r) => r.params[0] as string);
    expect(fetched).toHaveLength(5);
    expect(fetched.some((s) => failedSigs.has(s))).toBe(false);
    expect(vi.mocked(classifyWalletActivity)).toHaveBeenCalledWith(expect.anything(), WALLET, { source: 'solana-rpc' });

    expect(result.source).toBe('solana-rpc');
    expect(result.freshness).toBe('realtime');
    expect(result.data.scanned).toBe(7);
    expect(result.data.items.map((i) => i.signature)).toEqual(succeeded.map((s) => s.signature));
    // A full page was returned, so older history may exist.
    expect(result.data.nextCursor).toBe(history[6]?.signature);
  });

  it('uses the default and maximum page sizes', async () => {
    const { rpc, activity } = setup(standardHandler());
    await activity.getActivity(WALLET, {});
    await activity.getActivity(WALLET, { limit: 500 });
    const limits = rpc.requestsFor('getSignaturesForAddress').map((r) => (r.params[1] as { limit: number }).limit);
    expect(limits).toEqual([DEFAULT_ACTIVITY_LIMIT, MAX_STANDARD_ACTIVITY_LIMIT]);
  });

  it('has no cursor when history is exhausted and pages with `before`', async () => {
    const { rpc, activity } = setup(standardHandler());
    const cursor = history[3]?.signature as string;
    const result = await activity.getActivity(WALLET, { before: cursor, limit: 10 });
    expect((rpc.requestsFor('getSignaturesForAddress')[0]?.params[1] as { before: string }).before).toBe(cursor);
    expect(result.data.scanned).toBe(3);
    expect(result.data.nextCursor).toBeUndefined();
  });

  it('rejects a non-signature cursor on the standard path', async () => {
    const { activity } = setup(standardHandler());
    await expect(activity.getActivity(WALLET, { before: '451430528:271' })).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('serves parsed activity from cache on the next poll', async () => {
    const { rpc, activity } = setup(standardHandler());
    await activity.getActivity(WALLET, { limit: 7 });
    await activity.getActivity(WALLET, { limit: 7 });
    expect(rpc.requestsFor('getTransaction')).toHaveLength(5);
  });

  it('stops at the first unloadable transaction and resumes from there', async () => {
    const blocked = history[3]?.signature as string;
    const { activity } = setup(standardHandler({ failOn: new Set([blocked]) }));
    const result = await activity.getActivity(WALLET, { limit: 7 });
    expect(result.data.items.map((i) => i.signature)).toEqual([history[0]?.signature, history[2]?.signature]);
    expect(result.data.scanned).toBe(3);
    expect(result.data.nextCursor).toBe(history[2]?.signature);
    expect(result.notes?.[0]).toMatch(/RPC rate limit/);
  });

  it('throws when nothing could be loaded', async () => {
    const { activity } = setup(standardHandler({ failOn: new Set(history.map((s) => s.signature)) }));
    await expect(activity.getActivity(WALLET, { limit: 7 })).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('drops transactions the wallet was not part of (classifier returns null)', async () => {
    vi.mocked(classifyWalletActivity).mockImplementation(() => null);
    const { activity } = setup(standardHandler());
    const result = await activity.getActivity(WALLET, { limit: 7 });
    expect(result.data.items).toEqual([]);
    expect(result.data.scanned).toBe(7);
  });

  it('rejects invalid wallets without calling the RPC', async () => {
    const { rpc, activity } = setup(standardHandler());
    await expect(activity.getActivity('nope', {})).rejects.toMatchObject({ code: 'not_found' });
    expect(rpc.calls).toHaveLength(0);
  });
});

describe('createRpcActivityProvider (Helius history)', () => {
  const page = [relabelTransaction(buyV2, succeeded[0]?.signature as string, 1790628543), sellV1];
  const heliusHandler = (request: RpcRequest) => {
    if (request.method === 'getTransactionsForAddress') return { result: { data: page, paginationToken: '451430528:271' } };
    return standardHandler()(request);
  };

  it('uses getTransactionsForAddress and never refetches the included transactions', async () => {
    const { rpc, activity } = setup(heliusHandler, { helius: true });
    const result = await activity.getActivity(WALLET, { limit: 500, before: '451430600:12' });
    expect(rpc.requestsFor('getTransactionsForAddress')[0]?.params).toEqual([
      WALLET,
      {
        transactionDetails: 'full',
        sortOrder: 'desc',
        limit: 100,
        commitment: 'confirmed',
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 1,
        paginationToken: '451430600:12',
        filters: { status: 'succeeded' },
      },
    ]);
    expect(rpc.requestsFor('getTransaction')).toHaveLength(0);
    expect(result.source).toBe('helius');
    expect(result.data.items).toHaveLength(2);
    expect(result.data.scanned).toBe(2);
    expect(result.data.nextCursor).toBe('451430528:271');
  });

  it('ends pagination when Helius returns no token', async () => {
    const { activity } = setup(
      (request) => (request.method === 'getTransactionsForAddress' ? { result: { data: page } } : standardHandler()(request)),
      { helius: true },
    );
    expect((await activity.getActivity(WALLET, {})).data.nextCursor).toBeUndefined();
  });

  it('pages by signature when handed a signature cursor', async () => {
    const { rpc, activity } = setup(heliusHandler, { helius: true });
    await activity.getActivity(WALLET, { before: history[1]?.signature });
    expect(rpc.requestsFor('getTransactionsForAddress')).toHaveLength(0);
    expect(rpc.requestsFor('getSignaturesForAddress')).toHaveLength(1);
  });
});

describe('getTransaction (single)', () => {
  it('parses one transaction for a wallet and caches it', async () => {
    const { rpc, activity } = setup(() => ({ result: buyV2 }));
    const first = await activity.getTransaction?.(buyV2Signature, WALLET);
    expect(first?.data?.signature).toBe(buyV2Signature);
    expect(first?.freshness).toBe('realtime');
    await activity.getTransaction?.(buyV2Signature, WALLET);
    expect(rpc.requestsFor('getTransaction')).toHaveLength(1);
  });

  it('returns null (uncached) when the node does not have it yet', async () => {
    const { rpc, activity } = setup(() => ({ result: null }));
    expect((await activity.getTransaction?.(buyV2Signature, WALLET))?.data).toBeNull();
    await activity.getTransaction?.(buyV2Signature, WALLET);
    expect(rpc.requestsFor('getTransaction')).toHaveLength(2);
  });

  it('validates its inputs', async () => {
    const { activity } = setup(() => ({ result: buyV2 }));
    await expect(activity.getTransaction?.('bad', WALLET)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('createRpcActivityProvider (real classifier)', () => {
  it('classifies the live BuyV2 transaction for its trader', async () => {
    vi.mocked(classifyWalletActivity).mockImplementation(actualSwaps.classifyWalletActivity);
    const { activity } = setup(() => ({ result: buyV2 }));
    const result = await activity.getTransaction?.(buyV2Signature, WALLET);
    const item = result?.data;
    expect(item?.kind).toBe('buy');
    expect(item?.success).toBe(true);
    expect(item?.tokenMint).toBe(MINT);
    expect(item?.timestamp).toBe(1790628401000);
    expect(item?.solAmount).toBeCloseTo(1.000995698, 6);
    expect(item?.source).toBe('solana-rpc');
  });
});
