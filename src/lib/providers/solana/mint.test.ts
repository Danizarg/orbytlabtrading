import { describe, expect, it } from 'vitest';
import { getAddressDecoder } from '@solana/kit';
import { PROGRAMS } from '@/lib/core/solana';
import { getMintInfo, getMintInfos, parseMintAccount } from './mint';
import { createRpcClient, type RpcAccountInfo } from './rpc';
import { fakeRpc, loadFixture, type RpcRequest } from './test-helpers';

const MINT = '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump';
const TOKEN_ACCOUNT = '5R4MoQJCn3NDtMCzTNeJi6mFKB5cfTvyehFQcudPhWCU';
const CURVE = '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A';
const fixture = loadFixture<{ response: { result: { value: RpcAccountInfo[] } } }>(
  'solana-rpc/rpc_getMultipleAccounts_jsonParsed_mint_tokenacct_curve.json',
);
const [mintAccount, tokenAccount, curveAccount] = fixture.response.result.value;

/** Legacy SPL mint with live authorities (shape of a jsonParsed Tokenkeg mint). */
const splMint: RpcAccountInfo = {
  owner: PROGRAMS.TOKEN,
  lamports: 1461600,
  executable: false,
  space: 82,
  data: {
    program: 'spl-token',
    space: 82,
    parsed: {
      type: 'mint',
      info: {
        decimals: 5,
        supply: '8799437915923265810',
        mintAuthority: 'DHpRzLRuACd8i1BVGZh8rGQWaQsP7b4spBZFWbzW5WSb',
        freezeAuthority: null,
        isInitialized: true,
      },
    },
  },
};

describe('parseMintAccount', () => {
  it('parses a Token-2022 pump.fun mint with on-chain metadata', () => {
    const info = parseMintAccount(MINT, mintAccount, 42);
    expect(info).toEqual({
      mint: MINT,
      decimals: 6,
      supply: 1_000_000_000,
      tokenProgram: 'token-2022',
      mintAuthority: null,
      freezeAuthority: null,
      metadata: {
        name: 'Corgi Capital',
        symbol: 'CC',
        uri: 'https://gateway.pinata.cloud/ipfs/bafkreiayapwpeno6y5lcw2csdodxotsbtzrklxosixwiej3sk72ous32ku',
      },
      fetchedAt: 42,
    });
  });

  it('parses an SPL mint with a live authority and a supply above 2^53', () => {
    const info = parseMintAccount('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', splMint, 1);
    expect(info?.tokenProgram).toBe('spl-token');
    expect(info?.mintAuthority).toBe('DHpRzLRuACd8i1BVGZh8rGQWaQsP7b4spBZFWbzW5WSb');
    expect(info?.freezeAuthority).toBeNull();
    expect(info?.supply).toBe(87994379159232.6581);
    expect(info?.metadata).toBeUndefined();
  });

  it('returns null for token accounts, program accounts and missing accounts', () => {
    expect(parseMintAccount(TOKEN_ACCOUNT, tokenAccount)).toBeNull();
    expect(parseMintAccount(CURVE, curveAccount)).toBeNull();
    expect(parseMintAccount(MINT, null)).toBeNull();
  });

  it('refuses to guess authorities that are absent from the payload', () => {
    const broken = structuredClone(splMint);
    if (!Array.isArray(broken.data)) delete (broken.data.parsed as { info: Record<string, unknown> }).info.mintAuthority;
    expect(parseMintAccount('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', broken)).toBeNull();
  });
});

describe('getMintInfo / getMintInfos', () => {
  const table: Record<string, RpcAccountInfo | undefined> = { [MINT]: mintAccount, [TOKEN_ACCOUNT]: tokenAccount, [CURVE]: curveAccount };
  const handler = (request: RpcRequest) => {
    if (request.method === 'getAccountInfo') return { result: { context: { slot: 1 }, value: table[request.params[0] as string] ?? null } };
    const addresses = request.params[0] as string[];
    return { result: { context: { slot: 1 }, value: addresses.map((a) => table[a] ?? null) } };
  };

  it('reads one mint with jsonParsed', async () => {
    const rpc = fakeRpc(handler);
    const client = createRpcClient({ url: 'https://rpc.example.org', fetcher: rpc.fetcher });
    const info = await getMintInfo(client, MINT);
    expect(info.metadata?.symbol).toBe('CC');
    expect(rpc.requestsFor('getAccountInfo')[0]?.params).toEqual([MINT, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  });

  it('throws not_found for non-mints and invalid addresses', async () => {
    const rpc = fakeRpc(handler);
    const client = createRpcClient({ url: 'https://rpc.example.org', fetcher: rpc.fetcher });
    await expect(getMintInfo(client, TOKEN_ACCOUNT)).rejects.toMatchObject({ code: 'not_found' });
    await expect(getMintInfo(client, 'nope')).rejects.toMatchObject({ code: 'not_found' });
    expect(rpc.calls).toHaveLength(1);
  });

  it('batches many mints, dropping non-mints and duplicates', async () => {
    const rpc = fakeRpc(handler);
    const client = createRpcClient({ url: 'https://rpc.example.org', fetcher: rpc.fetcher });
    const infos = await getMintInfos(client, [MINT, MINT, TOKEN_ACCOUNT, CURVE, 'bogus']);
    expect(Object.keys(infos)).toEqual([MINT]);
    expect(rpc.requestsFor('getMultipleAccounts')[0]?.params[0]).toEqual([MINT, TOKEN_ACCOUNT, CURVE]);
  });

  it('chunks more than 100 mints', async () => {
    const rpc = fakeRpc(handler);
    const client = createRpcClient({ url: 'https://rpc.example.org', fetcher: rpc.fetcher });
    const decoder = getAddressDecoder();
    const many = Array.from({ length: 150 }, (_, i) => decoder.decode(new Uint8Array(32).fill(i + 1)));
    expect(new Set(many).size).toBe(150);
    await getMintInfos(client, [MINT, ...many]);
    expect(rpc.requestsFor('getMultipleAccounts').map((r) => (r.params[0] as string[]).length)).toEqual([100, 51]);
  });
});
