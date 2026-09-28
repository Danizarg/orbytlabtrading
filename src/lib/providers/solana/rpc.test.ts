import { describe, expect, it } from 'vitest';
import { PROGRAMS } from '@/lib/core/solana';
import { ProviderError } from '@/lib/net/errors';
import { accountBytes, accountParsedInfo, createRpcClient, mapRpcError, TRANSACTION_REQUEST_CONFIG } from './rpc';
import { fakeRpc, fixtureResponse, fixtureResult, fixtureTransaction, type RpcRequest } from './test-helpers';

const PRIVATE_URL = 'https://rpc.example.org/';
const HELIUS_URL = 'https://mainnet.helius-rpc.com/?api-key=SECRET-KEY-123';
const WALLET = 'DHpRzLRuACd8i1BVGZh8rGQWaQsP7b4spBZFWbzW5WSb';
const CURVE = '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A';
const MINT = '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump';

const buyV2 = fixtureTransaction('rpc_getTransaction_pumpfun_bondingcurve_buyV2_v0.json');
const sell = fixtureTransaction('rpc_getTransaction_pumpfun_bondingcurve_sell_v1.json');
const pumpswap = fixtureTransaction('rpc_getTransaction_pumpswap_sell_token2022_v0.json');
const TXS = new Map([buyV2, sell, pumpswap].map((tx) => [tx.transaction.signatures[0] as string, tx]));

async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error('expected rejection');
}

describe('createRpcClient requests', () => {
  it('POSTs a JSON-RPC 2.0 body with a label that never contains the URL', async () => {
    const rpc = fakeRpc(() => fixtureResponse('solana-rpc/rpc_getBalance_wallet.json'));
    const client = createRpcClient({ url: HELIUS_URL, fetcher: rpc.fetcher, provider: 'helius' });
    expect(await client.getBalance(WALLET)).toBe(9759034646);
    const call = rpc.calls[0];
    expect(call?.provider).toBe('helius');
    expect(call?.url).toBe(HELIUS_URL);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.label).toBe('Helius RPC getBalance');
    expect(call?.init.label).not.toContain('SECRET');
    expect(call?.init.body).toEqual({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [WALLET, { commitment: 'confirmed' }] });
  });

  it('decodes getMultipleAccounts (base64) aligned with the request order', async () => {
    const rpc = fakeRpc(() => fixtureResponse('solana-rpc/publicnode_getMultipleAccounts_base64_mint_bondingcurve.json'));
    const client = createRpcClient({ url: 'https://solana-rpc.publicnode.com', fetcher: rpc.fetcher, label: 'publicnode' });
    const accounts = await client.getMultipleAccounts([MINT, CURVE], { encoding: 'base64' });
    expect(rpc.requestsFor('getMultipleAccounts')[0]?.params).toEqual([[MINT, CURVE], { encoding: 'base64', commitment: 'confirmed' }]);
    expect(accounts).toHaveLength(2);
    expect(accounts[0]?.owner).toBe(PROGRAMS.TOKEN_2022);
    expect(accounts[1]?.owner).toBe(PROGRAMS.PUMP);
    expect(accounts[1]?.lamports).toBe(17948426726);
    const bytes = accountBytes(accounts[1]);
    expect(bytes?.length).toBe(151);
    expect([...(bytes ?? []).slice(0, 8)]).toEqual([23, 183, 248, 55, 96, 216, 172, 96]);
  });

  it('keeps jsonParsed accounts parsed and program-owned ones as base64 fallback', async () => {
    const rpc = fakeRpc(() => fixtureResponse('solana-rpc/rpc_getMultipleAccounts_jsonParsed_mint_tokenacct_curve.json'));
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    const [mint, tokenAccount, curve] = await client.getMultipleAccounts([MINT, '5R4MoQJCn3NDtMCzTNeJi6mFKB5cfTvyehFQcudPhWCU', CURVE], {
      encoding: 'jsonParsed',
    });
    expect(accountParsedInfo(mint)?.type).toBe('mint');
    expect(accountParsedInfo(tokenAccount)?.info.owner).toBe(CURVE);
    expect(accountParsedInfo(curve)).toBeUndefined();
    expect(accountBytes(curve)?.length).toBe(151);
  });

  it('returns null for missing accounts and [] without a call for empty input', async () => {
    const rpc = fakeRpc(() => ({ result: { context: { slot: 1 }, value: [null] } }));
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    expect(await client.getMultipleAccounts([MINT])).toEqual([null]);
    expect(await client.getMultipleAccounts([])).toEqual([]);
    expect(rpc.calls).toHaveLength(1);
  });

  it('rejects a getMultipleAccounts result not aligned with the request', async () => {
    const rpc = fakeRpc(() => ({ result: { context: { slot: 1 }, value: [null] } }));
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    expect((await rejection(client.getMultipleAccounts([MINT, CURVE]))).code).toBe('malformed');
  });

  it('refuses more than 100 addresses per getMultipleAccounts without calling', async () => {
    const rpc = fakeRpc(() => ({ result: { value: [] } }));
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    const error = await rejection(client.getMultipleAccounts(Array.from({ length: 101 }, () => MINT)));
    expect(error.code).toBe('unsupported');
    expect(rpc.calls).toHaveLength(0);
  });

  it('parses getSignaturesForAddress and forwards paging options', async () => {
    const rpc = fakeRpc(() => fixtureResponse('solana-rpc/rpc_getSignaturesForAddress_bondingcurve.json'));
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    const sigs = await client.getSignaturesForAddress(CURVE, { limit: 5, before: 'BEFORE', until: 'UNTIL' });
    expect(rpc.requestsFor('getSignaturesForAddress')[0]?.params).toEqual([
      CURVE,
      { commitment: 'confirmed', limit: 5, before: 'BEFORE', until: 'UNTIL' },
    ]);
    expect(sigs).toHaveLength(5);
    expect(sigs[0]).toEqual({
      signature: '5vkeqCReatk7bXc41f2WXfJGLacAo8ZkcJNqQfCNr1jQAovwJ6P8cuqg4TW6Hi3My4nszgpcBC4TkdmP8CAsSchk',
      slot: 451431054,
      blockTime: 1790628543,
      err: null,
      memo: null,
      confirmationStatus: 'finalized',
    });
  });

  it('keeps failed signatures with their err object', async () => {
    const rpc = fakeRpc(() => fixtureResponse('solana-rpc/rpc_getSignaturesForAddress_pumpfun_program.json'));
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    const sigs = await client.getSignaturesForAddress(PROGRAMS.PUMP, { limit: 5 });
    expect(sigs.every((s) => s.err !== null)).toBe(true);
  });

  it('reads token accounts for one program with jsonParsed', async () => {
    const rpc = fakeRpc(() => fixtureResponse('solana-rpc/rpc_getTokenAccountsByOwner_token2022.json'));
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    const accounts = await client.getTokenAccountsByOwner(WALLET, PROGRAMS.TOKEN_2022);
    expect(rpc.requestsFor('getTokenAccountsByOwner')[0]?.params).toEqual([
      WALLET,
      { programId: PROGRAMS.TOKEN_2022 },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    expect(accounts).toHaveLength(3);
    expect(accounts[0]?.pubkey).toBe('Wz7SUAzCmjNrZxpUp5zwMeKdkMUgzpHWYCR54WiqUzU');
    expect(accountParsedInfo(accounts[0]?.account)?.info.mint).toBe('jxEwNi2DqURYYrpzbzdhMUEg8SZdJpbUDPyEn9Rpump');
  });

  it('reads getTokenSupply with the raw amount kept as a string', async () => {
    const rpc = fakeRpc(() => fixtureResponse('solana-rpc/rpc_getTokenSupply_BONK.json'));
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    const supply = await client.getTokenSupply('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    expect(typeof supply.amount).toBe('string');
    expect(BigInt(supply.amount) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(supply.decimals).toBe(5);
  });

  it('requests transactions with maxSupportedTransactionVersion 1, jsonParsed, confirmed', async () => {
    const rpc = fakeRpc(() => fixtureResponse('solana-rpc/rpc_getTransaction_pumpfun_bondingcurve_sell_v1.json'));
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    const signature = sell.transaction.signatures[0] as string;
    const tx = await client.getTransaction(signature);
    expect(rpc.requestsFor('getTransaction')[0]?.params).toEqual([
      signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
    ]);
    expect(tx?.version).toBe(1);
    expect(tx?.blockTime).toBe(1790628401);
    expect(TRANSACTION_REQUEST_CONFIG.maxSupportedTransactionVersion).toBe(1);
  });

  it('returns null for an unknown transaction', async () => {
    const rpc = fakeRpc(() => ({ result: null }));
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    expect(await client.getTransaction('1111')).toBeNull();
  });

  it('flags a structurally wrong response as malformed', async () => {
    const rpc = fakeRpc(() => ({ nope: true }));
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    expect((await rejection(client.getBalance(WALLET))).code).toBe('malformed');
    const rpc2 = fakeRpc(() => ({ result: { transaction: 'x' } }));
    const client2 = createRpcClient({ url: PRIVATE_URL, fetcher: rpc2.fetcher });
    expect((await rejection(client2.getTransaction('sig'))).code).toBe('malformed');
  });
});

describe('createRpcClient error mapping', () => {
  it('maps -32015 (unsupported transaction version) to unsupported', async () => {
    const rpc = fakeRpc(() => fixtureResponse('solana-rpc/rpc_getTransaction_error_v1_not_supported.json'));
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    const error = await rejection(client.getTransaction('HrZ6CFEg9rzqG6ernMN2dwxyyvUCswL8NQtYWGqJ8PVJixyxEcDD6jSHVUeguaBiyQCRkN6dcsPkWZmdBdDAhUX'));
    expect(error.code).toBe('unsupported');
    expect(error.provider).toBe('solana-rpc');
  });

  it('maps a JSON-RPC 429 body to rate_limited', async () => {
    const rpc = fakeRpc(() => fixtureResponse('solana-rpc/rpc_getTokenLargestAccounts_BONK_mainnetbeta_429_blocked.json'));
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    const error = await rejection(client.getTokenLargestAccounts('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'));
    expect(error.code).toBe('rate_limited');
    expect(error.status).toBe(429);
  });

  it("maps publicnode's indexed-method refusal to unsupported", async () => {
    const rpc = fakeRpc(() => fixtureResponse('solana-rpc/publicnode_getTokenSupply_blocked_indexed.json'));
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    expect((await rejection(client.getTokenSupply(MINT))).code).toBe('unsupported');
  });

  it('maps the browser-origin 403 body to unsupported', async () => {
    const rpc = fakeRpc(() => fixtureResponse('solana-rpc/rpc_mainnetbeta_browser_origin_403_forbidden.json'));
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    expect((await rejection(client.getBalance(WALLET))).code).toBe('unsupported');
  });

  it('maps other JSON-RPC errors to http and scrubs credentials from messages', () => {
    const error = mapRpcError('helius', 'Helius RPC', 'getBalance', { code: -32603, message: 'boom at https://x/?api-key=SECRET-KEY-123' });
    expect(error.code).toBe('http');
    expect(error.message).not.toContain('SECRET');
    expect(mapRpcError('helius', 'Helius RPC', 'getBalance', { code: -32401, message: 'missing api key' }).code).toBe('not_configured');
    expect(mapRpcError('solana-rpc', 'RPC', 'foo', { code: -32601, message: 'Method not found' }).code).toBe('unsupported');
    expect(mapRpcError('solana-rpc', 'RPC', 'foo', 'garbage').code).toBe('http');
  });

  it('re-labels transport 401/403 and passes rate limits through', async () => {
    const make = (status: number, code: 'http' | 'rate_limited') =>
      createRpcClient({
        url: HELIUS_URL,
        provider: 'helius',
        fetcher: fakeRpc(() => {
          throw new ProviderError('helius', code, `Helius RPC getBalance: HTTP ${status}`, { status });
        }).fetcher,
      });
    const e401 = await rejection(make(401, 'http').getBalance(WALLET));
    expect(e401.code).toBe('not_configured');
    const e403 = await rejection(make(403, 'http').getBalance(WALLET));
    expect(e403.code).toBe('unsupported');
    const e429 = await rejection(make(429, 'rate_limited').getBalance(WALLET));
    expect(e429.code).toBe('rate_limited');
    const e500 = await rejection(make(500, 'http').getBalance(WALLET));
    expect(e500.code).toBe('http');
    for (const e of [e401, e403, e429, e500]) expect(e.message).not.toContain('SECRET');
  });

  it('fails fast on methods the public endpoints are known to block', async () => {
    const rpc = fakeRpc(() => ({ result: { value: [] } }));
    const mainnet = createRpcClient({ url: 'https://api.mainnet-beta.solana.com', fetcher: rpc.fetcher });
    expect((await rejection(mainnet.getTokenLargestAccounts(MINT))).code).toBe('unsupported');
    const publicnode = createRpcClient({ url: 'https://solana-rpc.publicnode.com', fetcher: rpc.fetcher });
    expect((await rejection(publicnode.getTokenAccountsByOwner(WALLET, PROGRAMS.TOKEN))).code).toBe('unsupported');
    expect((await rejection(publicnode.getTokenSupply(MINT))).code).toBe('unsupported');
    expect(rpc.calls).toHaveLength(0);
  });

  it('treats getTransactionsForAddress as Helius-only', async () => {
    const rpc = fakeRpc(() => ({ result: { data: [] } }));
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    expect((await rejection(client.getTransactionsForAddress(WALLET))).code).toBe('unsupported');
    expect(rpc.calls).toHaveLength(0);
  });

  it('parses getTokenLargestAccounts where the endpoint supports it', async () => {
    const rpc = fakeRpc(() => ({
      result: {
        context: { slot: 1 },
        value: [{ address: '5R4MoQJCn3NDtMCzTNeJi6mFKB5cfTvyehFQcudPhWCU', amount: '603185974343956', decimals: 6, uiAmount: 603185974.343956 }],
      },
    }));
    const client = createRpcClient({ url: HELIUS_URL, fetcher: rpc.fetcher, provider: 'helius' });
    const top = await client.getTokenLargestAccounts(MINT);
    expect(top).toEqual([
      { address: '5R4MoQJCn3NDtMCzTNeJi6mFKB5cfTvyehFQcudPhWCU', amount: '603185974343956', decimals: 6, uiAmount: 603185974.343956, uiAmountString: undefined },
    ]);
  });
});

describe('getTransactions', () => {
  const txHandler = (request: RpcRequest) => {
    const tx = TXS.get(request.params[0] as string);
    return { result: tx ?? null };
  };

  it('uses one JSON-RPC batch per 100 signatures on Helius and matches results by id', async () => {
    const rpc = fakeRpc(txHandler, { reverseBatch: true });
    const client = createRpcClient({ url: HELIUS_URL, fetcher: rpc.fetcher, provider: 'helius' });
    const signatures = [...TXS.keys(), 'missing-signature'];
    const results = await client.getTransactions(signatures);
    expect(rpc.calls).toHaveLength(1);
    expect(rpc.calls[0]?.batch).toBe(true);
    expect(rpc.calls[0]?.requests.map((r) => r.params[1])).toEqual(signatures.map(() => ({ ...TRANSACTION_REQUEST_CONFIG })));
    expect(results.map((r) => r.signature)).toEqual(signatures);
    results.slice(0, 3).forEach((r, i) => {
      expect(r.ok && r.tx?.transaction.signatures[0]).toBe(signatures[i]);
    });
    expect(results[3]).toEqual({ signature: 'missing-signature', ok: true, tx: null });
  });

  it('splits more than 100 signatures into several batches', async () => {
    const rpc = fakeRpc(() => ({ result: null }));
    const client = createRpcClient({ url: HELIUS_URL, fetcher: rpc.fetcher, provider: 'helius' });
    const signatures = Array.from({ length: 150 }, (_, i) => `sig-${i}`);
    const results = await client.getTransactions(signatures);
    expect(rpc.calls.map((c) => c.requests.length)).toEqual([100, 50]);
    expect(results).toHaveLength(150);
  });

  it('reports per-item batch errors without failing the others', async () => {
    const rpc = fakeRpc((request) =>
      request.params[0] === 'bad' ? { error: { code: -32015, message: 'Transaction version (1) is not supported' } } : txHandler(request),
    );
    const client = createRpcClient({ url: HELIUS_URL, fetcher: rpc.fetcher, provider: 'helius' });
    const good = [...TXS.keys()][0] as string;
    const [a, b] = await client.getTransactions([good, 'bad']);
    expect(a?.ok).toBe(true);
    expect(b?.ok === false && b.error.code).toBe('unsupported');
  });

  it('marks a whole batch failed on a transport rate limit', async () => {
    const rpc = fakeRpc(() => {
      throw new ProviderError('helius', 'rate_limited', 'Helius RPC getTransaction: HTTP 429', { status: 429 });
    });
    const client = createRpcClient({ url: HELIUS_URL, fetcher: rpc.fetcher, provider: 'helius' });
    const results = await client.getTransactions(Array.from({ length: 120 }, (_, i) => `sig-${i}`));
    expect(results.every((r) => !r.ok && r.error.code === 'rate_limited')).toBe(true);
    expect(rpc.calls).toHaveLength(1);
  });

  it('calls individually with at most 3 in flight on non-Helius endpoints', async () => {
    const rpc = fakeRpc(txHandler, { delayMs: 5 });
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    const signatures = [...TXS.keys(), 'x1', 'x2', 'x3', 'x4'];
    const results = await client.getTransactions(signatures);
    expect(rpc.calls.every((c) => !c.batch)).toBe(true);
    expect(rpc.calls).toHaveLength(signatures.length);
    expect(rpc.maxInFlight).toBeLessThanOrEqual(3);
    expect(rpc.maxInFlight).toBeGreaterThan(1);
    expect(results.filter((r) => r.ok && r.tx).length).toBe(3);
  });

  it('stops issuing requests after a rate limit', async () => {
    let n = 0;
    const rpc = fakeRpc(() => {
      n++;
      if (n === 2) return fixtureResponse('solana-rpc/rpc_getTokenLargestAccounts_BONK_mainnetbeta_429_blocked.json');
      return { result: null };
    });
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    const signatures = Array.from({ length: 12 }, (_, i) => `sig-${i}`);
    const results = await client.getTransactions(signatures);
    expect(rpc.calls.length).toBeLessThanOrEqual(4);
    expect(results.filter((r) => !r.ok).length).toBeGreaterThanOrEqual(8);
    expect(results.every((r) => r.ok || r.error.code === 'rate_limited')).toBe(true);
  });

  it('propagates aborts', async () => {
    const controller = new AbortController();
    const rpc = fakeRpc(() => {
      throw new ProviderError('solana-rpc', 'aborted', 'aborted');
    });
    const client = createRpcClient({ url: PRIVATE_URL, fetcher: rpc.fetcher });
    controller.abort();
    expect((await rejection(client.getTransactions(['a', 'b'], controller.signal))).code).toBe('aborted');
  });
});

describe('getTransactionsForAddress (Helius)', () => {
  it('sends full jsonParsed v1 history params and returns the page', async () => {
    const rpc = fakeRpc(() => ({ result: { data: [buyV2, sell], paginationToken: '451430528:271' } }));
    const client = createRpcClient({ url: HELIUS_URL, fetcher: rpc.fetcher, provider: 'helius' });
    const page = await client.getTransactionsForAddress(WALLET, {
      transactionDetails: 'full',
      sortOrder: 'desc',
      limit: 50,
      paginationToken: '1:2',
      status: 'succeeded',
    });
    expect(rpc.requestsFor('getTransactionsForAddress')[0]?.params).toEqual([
      WALLET,
      {
        transactionDetails: 'full',
        sortOrder: 'desc',
        limit: 50,
        commitment: 'confirmed',
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 1,
        paginationToken: '1:2',
        filters: { status: 'succeeded' },
      },
    ]);
    expect(page.data).toHaveLength(2);
    expect(page.paginationToken).toBe('451430528:271');
  });

  it('supports signatures mode and an exhausted history', async () => {
    const sigs = fixtureResult<unknown[]>('solana-rpc/rpc_getSignaturesForAddress_bondingcurve.json');
    const rpc = fakeRpc(() => ({ result: { data: sigs } }));
    const client = createRpcClient({ url: HELIUS_URL, fetcher: rpc.fetcher, provider: 'helius' });
    const page = await client.getTransactionsForAddress(CURVE, { transactionDetails: 'signatures', limit: 5 });
    const params = rpc.requestsFor('getTransactionsForAddress')[0]?.params[1] as Record<string, unknown>;
    expect(params.encoding).toBeUndefined();
    expect(page.data[0]?.signature).toBe('5vkeqCReatk7bXc41f2WXfJGLacAo8ZkcJNqQfCNr1jQAovwJ6P8cuqg4TW6Hi3My4nszgpcBC4TkdmP8CAsSchk');
    expect(page.paginationToken).toBeUndefined();
  });
});
