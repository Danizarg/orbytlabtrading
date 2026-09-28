import { describe, expect, it } from 'vitest';
import { PROGRAMS } from '@/lib/core/solana';
import { ProviderError } from '@/lib/net/errors';
import { createRpcPortfolioProvider } from './portfolio';
import { createRpcClient, type RpcKeyedAccount } from './rpc';
import { fakeRpc, fixtureResponse, fixtureResult, type RpcRequest } from './test-helpers';

const WALLET = 'DHpRzLRuACd8i1BVGZh8rGQWaQsP7b4spBZFWbzW5WSb';

function tokenAccount(pubkey: string, mint: string, amount: string, decimals: number, program: 'spl-token' | 'spl-token-2022'): RpcKeyedAccount {
  return {
    pubkey,
    account: {
      owner: program === 'spl-token' ? PROGRAMS.TOKEN : PROGRAMS.TOKEN_2022,
      lamports: 2039280,
      executable: false,
      data: {
        program,
        space: 165,
        parsed: { type: 'account', info: { mint, owner: WALLET, isNative: false, state: 'initialized', tokenAmount: { amount, decimals } } },
      },
    },
  };
}

function handlerWith(extra: { spl?: RpcKeyedAccount[]; t22?: RpcKeyedAccount[] } = {}) {
  return (request: RpcRequest) => {
    if (request.method === 'getBalance') return fixtureResponse('solana-rpc/rpc_getBalance_wallet.json');
    const programId = (request.params[1] as { programId: string }).programId;
    const file = programId === PROGRAMS.TOKEN ? 'rpc_getTokenAccountsByOwner_splToken.json' : 'rpc_getTokenAccountsByOwner_token2022.json';
    const result = fixtureResult<{ context: unknown; value: RpcKeyedAccount[] }>(`solana-rpc/${file}`);
    const more = programId === PROGRAMS.TOKEN ? (extra.spl ?? []) : (extra.t22 ?? []);
    return { result: { ...result, value: [...result.value, ...more] } };
  };
}

describe('createRpcPortfolioProvider', () => {
  it('combines native SOL with both token programs and drops zero balances', async () => {
    const rpc = fakeRpc(handlerWith());
    const provider = createRpcPortfolioProvider({ rpc: createRpcClient({ url: 'https://rpc.example.org', fetcher: rpc.fetcher }) });
    const before = Date.now();
    const result = await provider.getPortfolio(WALLET);

    expect(result.source).toBe('solana-rpc');
    expect(result.freshness).toBe('realtime');
    expect(result.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(result.data.address).toBe(WALLET);
    expect(result.data.sol).toBe(9.759034646);
    // Fixtures: 3 SPL accounts (one holds 200,000 tokens) and 3 Token-2022 accounts, all empty.
    expect(result.data.tokens).toEqual([{ mint: '4pLX2HLYn41zH4R8vCQnHEvXT5CPyPUYawXttX61TNyH', amount: 200000, decimals: 6, tokenProgram: 'spl-token' }]);
    expect(result.data.pricedCount).toBe(0);
    expect(result.data.unpricedCount).toBe(1);
    expect(result.data.totalUsd).toBeUndefined();
    expect(result.data.solPriceUsd).toBeUndefined();

    const programs = rpc.requestsFor('getTokenAccountsByOwner').map((r) => (r.params[1] as { programId: string }).programId);
    expect(programs.sort()).toEqual([PROGRAMS.TOKEN, PROGRAMS.TOKEN_2022].sort());
  });

  it('aggregates several accounts of one mint exactly (bigint) and tags Token-2022', async () => {
    const mint = 'jxEwNi2DqURYYrpzbzdhMUEg8SZdJpbUDPyEn9Rpump';
    const rpc = fakeRpc(
      handlerWith({
        t22: [
          tokenAccount('HyLdpofWEvWUD3QrMzJjDdfzX9bqzFQn6CqdT7fFNfFv', mint, '9007199254740993', 6, 'spl-token-2022'),
          tokenAccount('3qtUcwUYQ2aGoMwc8SDRsndJRmL712NXhaZ8YLWDQTbi', mint, '1', 6, 'spl-token-2022'),
        ],
      }),
    );
    const provider = createRpcPortfolioProvider({ rpc: createRpcClient({ url: 'https://rpc.example.org', fetcher: rpc.fetcher }) });
    const { data } = await provider.getPortfolio(WALLET);
    const t = data.tokens.find((x) => x.mint === mint);
    expect(t?.amount).toBe(9007199254.740994);
    expect(t?.tokenProgram).toBe('token-2022');
    expect(data.unpricedCount).toBe(2);
  });

  it('rejects invalid addresses without calling the RPC', async () => {
    const rpc = fakeRpc(handlerWith());
    const provider = createRpcPortfolioProvider({ rpc: createRpcClient({ url: 'https://rpc.example.org', fetcher: rpc.fetcher }) });
    await expect(provider.getPortfolio('nope')).rejects.toMatchObject({ code: 'not_found' });
    expect(rpc.calls).toHaveLength(0);
  });

  it('propagates upstream failures instead of returning an empty portfolio', async () => {
    const rpc = fakeRpc((request) => {
      if (request.method === 'getTokenAccountsByOwner') throw new ProviderError('solana-rpc', 'http', 'Solana RPC getTokenAccountsByOwner: HTTP 403', { status: 403 });
      return handlerWith()(request);
    });
    const provider = createRpcPortfolioProvider({ rpc: createRpcClient({ url: 'https://rpc.example.org', fetcher: rpc.fetcher }) });
    await expect(provider.getPortfolio(WALLET)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('refuses publicnode, which blocks token-account lookups', async () => {
    const rpc = fakeRpc(handlerWith());
    const provider = createRpcPortfolioProvider({ rpc: createRpcClient({ url: 'https://solana-rpc.publicnode.com', fetcher: rpc.fetcher }) });
    await expect(provider.getPortfolio(WALLET)).rejects.toMatchObject({ code: 'unsupported' });
  });
});
