import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProviderId } from '@/lib/core/providers';
import { isSolanaAddress } from '@/lib/core/solana';
import { isProviderError, ProviderError } from '@/lib/net/errors';
import type { JsonFetcher, JsonRequest } from '@/lib/net/types';
import { createHelius, HELIUS_ASSET_BATCH_LIMIT, isProgramDerivedOwner, pumpBondingCurvePda } from './index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_KEY = 'test-helius-key-5f3c9a';
const MINT = '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump';
const CURVE_PDA = '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A';
const RAYDIUM_AUTHORITY = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
const WALLET = 'DHpRzLRuACd8i1BVGZh8rGQWaQsP7b4spBZFWbzW5WSb';

function load(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures', rel), 'utf8')) as Record<string, unknown>;
}

/** Doc-example files wrap the payload in `response`. */
function docResponse(name: string): unknown {
  return load(`doc-examples/helius/${name}`).response;
}

const LARGEST = docResponse('getTokenLargestAccounts.doc-example.json');
const OWNERS = docResponse('getMultipleAccounts.doc-example.json');
const ASSETS = docResponse('getAssetBatch.doc-example.json');
/** Live capture (public mainnet RPC, identical JSON-RPC shape on Helius). */
const SUPPLY = load('solana-rpc/rpc_getTokenSupply_pumpfun_token2022.json').response;

interface Call {
  provider: ProviderId;
  url: string;
  init?: JsonRequest;
  method: string;
  params: unknown;
}

type Responder = (params: unknown) => unknown;

/** Fake JSON-RPC transport: all calls share one URL, so routes match on the JSON-RPC method. */
function fakeRpc(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetcher: JsonFetcher = async <T>(provider: ProviderId, url: string, init?: JsonRequest): Promise<T> => {
    const body = (init?.body ?? {}) as { method?: string; params?: unknown };
    const method = body.method ?? '';
    calls.push({ provider, url, init, method, params: body.params });
    if (!url.includes('mainnet.helius-rpc.com')) throw new Error('unexpected host');
    if (!(method in routes)) throw new Error(`unexpected method ${method}`);
    const route = routes[method];
    const value: unknown = typeof route === 'function' ? (route as Responder)(body.params) : route;
    if (value instanceof Error) throw value;
    return structuredClone(value) as T;
  };
  return { fetcher, calls };
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Deterministic valid 32-byte base58 address. */
function fakeAddress(i: number): string {
  const bytes = new Uint8Array(32).fill(9);
  bytes[0] = (i % 250) + 1;
  bytes[30] = Math.floor(i / 256) % 256;
  bytes[31] = i % 256;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58.charAt(Number(n % 58n)) + s;
    n /= 58n;
  }
  return s;
}

async function rejectionOf(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (isProviderError(error)) return error;
    throw new Error(`expected ProviderError, got ${String(error)}`);
  }
  throw new Error('expected rejection');
}

const HOLDER_ROUTES = { getTokenLargestAccounts: LARGEST, getTokenSupply: SUPPLY, getMultipleAccounts: OWNERS };

// ---------------------------------------------------------------------------
// Holders
// ---------------------------------------------------------------------------

describe('helius getHolders', () => {
  it('derives the pump.fun bonding-curve PDA that owns the vault in the live fixture', async () => {
    await expect(pumpBondingCurvePda(MINT)).resolves.toBe(CURVE_PDA);
    expect(isProgramDerivedOwner(CURVE_PDA)).toBe(true);
    expect(isProgramDerivedOwner(WALLET)).toBe(false);
    expect(isProgramDerivedOwner('not-an-address')).toBeUndefined();
  });

  it('resolves token accounts to owners, computes % of supply and labels program accounts', async () => {
    const { fetcher, calls } = fakeRpc(HOLDER_ROUTES);
    const helius = createHelius({ apiKey: API_KEY, fetcher, knownPools: { [RAYDIUM_AUTHORITY]: 'Raydium AMM' } });
    const before = Date.now();
    const res = await helius.getHolders(MINT);

    expect(res.source).toBe('helius');
    expect(res.freshness).toBe('realtime');
    expect(res.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(res.data.mint).toBe(MINT);
    expect(res.data.supply).toBe(1_000_000_000);
    expect(res.data.totalHolders).toBeUndefined();
    expect('totalHolders' in res.data).toBe(false);

    // 4 non-zero accounts, one of them closed (null) → 3 holders.
    expect(res.data.top).toHaveLength(3);
    const [curve, wallet, pool] = res.data.top;
    expect(curve).toEqual({
      owner: CURVE_PDA,
      tokenAccount: '5R4MoQJCn3NDtMCzTNeJi6mFKB5cfTvyehFQcudPhWCU',
      amount: 603185974.343956,
      pctOfSupply: expect.closeTo(60.3185974343956, 9),
      label: 'Bonding curve',
      isProgramAccount: true,
    });
    expect(wallet?.owner).toBe(WALLET);
    expect(wallet?.pctOfSupply).toBeCloseTo(2, 10);
    expect(wallet?.isProgramAccount).toBe(false);
    expect(wallet && 'label' in wallet).toBe(false);
    expect(pool?.owner).toBe(RAYDIUM_AUTHORITY);
    expect(pool?.label).toBe('Raydium AMM');
    expect(pool?.isProgramAccount).toBe(true);

    expect(res.data.distribution?.top10Pct).toBeCloseTo(60.3185974343956 + 2 + 0.5, 9);
    expect(res.data.distribution && 'top11to20Pct' in res.data.distribution).toBe(false);

    // Owners are resolved only for the non-zero accounts, in upstream order, jsonParsed.
    const owners = calls.find((c) => c.method === 'getMultipleAccounts');
    expect(owners?.params).toEqual([
      [
        '5R4MoQJCn3NDtMCzTNeJi6mFKB5cfTvyehFQcudPhWCU',
        'FYjHNoFtSQ5uijKrZFyYAxvEr87hsKXkXcxkcmkBAf4r',
        'HdmGPmTkBgsiJcyVDgiGkYdTZr4h5XmpjYoUjU2rapf4',
        'EauuZAnB7CcnCrwvCMcnb2Rjk12Ecs13ycAZQBb5tLYM',
      ],
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
  });

  it('sends the key only in the URL and always labels requests', async () => {
    const { fetcher, calls } = fakeRpc(HOLDER_ROUTES);
    await createHelius({ apiKey: API_KEY, fetcher }).getHolders(MINT);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.provider).toBe('helius');
      expect(call.url).toBe(`https://mainnet.helius-rpc.com/?api-key=${API_KEY}`);
      expect(call.init?.label).toBe('helius');
      expect(call.init?.method).toBe('POST');
      expect(JSON.stringify(call.init?.body)).not.toContain(API_KEY);
    }
  });

  it('respects the limit (max 20) without changing the distribution math', async () => {
    const { fetcher } = fakeRpc(HOLDER_ROUTES);
    const helius = createHelius({ apiKey: API_KEY, fetcher });
    const res = await helius.getHolders(MINT, 1);
    expect(res.data.top).toHaveLength(1);
    expect(res.data.distribution?.top10Pct).toBeCloseTo(62.8185974343956, 9);
  });

  it('omits percentages (with a note) when the supply call fails', async () => {
    const { fetcher } = fakeRpc({ ...HOLDER_ROUTES, getTokenSupply: new ProviderError('helius', 'timeout', 'helius: timeout') });
    const res = await createHelius({ apiKey: API_KEY, fetcher }).getHolders(MINT);
    expect(res.data.top).toHaveLength(3);
    for (const entry of res.data.top) expect('pctOfSupply' in entry).toBe(false);
    expect('supply' in res.data).toBe(false);
    expect('distribution' in res.data).toBe(false);
    expect(res.notes?.[0]).toMatch(/supply unavailable/i);
  });

  it('returns an honest empty list when the mint has no funded accounts', async () => {
    const { fetcher, calls } = fakeRpc({ ...HOLDER_ROUTES, getTokenLargestAccounts: { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [] } } });
    const res = await createHelius({ apiKey: API_KEY, fetcher }).getHolders(MINT);
    expect(res.data.top).toEqual([]);
    expect(calls.some((c) => c.method === 'getMultipleAccounts')).toBe(false);
  });

  it('rejects malformed payloads instead of returning empty data', async () => {
    const { fetcher } = fakeRpc({ ...HOLDER_ROUTES, getTokenLargestAccounts: { jsonrpc: '2.0', id: 1, result: { value: 'nope' } } });
    const err = await rejectionOf(createHelius({ apiKey: API_KEY, fetcher }).getHolders(MINT));
    expect(err.code).toBe('malformed');
  });

  it('maps JSON-RPC errors and redacts an echoed key', async () => {
    const { fetcher } = fakeRpc({
      ...HOLDER_ROUTES,
      getTokenLargestAccounts: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: `Invalid param: not a Token mint (api-key=${API_KEY})` } },
    });
    const err = await rejectionOf(createHelius({ apiKey: API_KEY, fetcher }).getHolders(MINT));
    expect(err.code).toBe('not_found');
    expect(err.message).toContain('-32602');
    expect(err.message).not.toContain(API_KEY);
  });

  it('rejects an invalid mint without calling upstream', async () => {
    const { fetcher, calls } = fakeRpc(HOLDER_ROUTES);
    const err = await rejectionOf(createHelius({ apiKey: API_KEY, fetcher }).getHolders('not-a-mint'));
    expect(err.code).toBe('not_found');
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('helius error mapping', () => {
  it('maps HTTP 401 to not_configured and 403 to http', async () => {
    const unauthorized = fakeRpc({ getTokenLargestAccounts: new ProviderError('helius', 'http', 'helius: HTTP 401', { status: 401 }), getTokenSupply: SUPPLY });
    const e401 = await rejectionOf(createHelius({ apiKey: API_KEY, fetcher: unauthorized.fetcher }).getHolders(MINT));
    expect(e401.code).toBe('not_configured');
    expect(e401.status).toBe(401);

    const forbidden = fakeRpc({ getAssetBatch: new ProviderError('helius', 'http', 'helius: HTTP 403', { status: 403 }) });
    const e403 = await rejectionOf(createHelius({ apiKey: API_KEY, fetcher: forbidden.fetcher }).getMetadata([MINT]));
    expect(e403.code).toBe('http');
    expect(e403.status).toBe(403);
  });

  it('passes rate limits through for the transport cooldown', async () => {
    const { fetcher } = fakeRpc({ getAssetBatch: new ProviderError('helius', 'rate_limited', 'helius: HTTP 429', { status: 429, retryAfterMs: 2_000 }) });
    const err = await rejectionOf(createHelius({ apiKey: API_KEY, fetcher }).getMetadata([MINT]));
    expect(err.code).toBe('rate_limited');
    expect(err.retryAfterMs).toBe(2_000);
  });

  it('never leaks the key from unknown transport errors', async () => {
    const leaky = new Error(`fetch failed: https://mainnet.helius-rpc.com/?api-key=${API_KEY}`);
    const { fetcher } = fakeRpc({ getAssetBatch: leaky });
    const err = await rejectionOf(createHelius({ apiKey: API_KEY, fetcher }).getMetadata([MINT]));
    expect(err.provider).toBe('helius');
    expect(err.code).toBe('network');
    expect(err.message).not.toContain(API_KEY);
    expect(String(err.cause ?? '')).not.toContain(API_KEY);
  });

  it('redacts the key from ProviderError messages built with the URL', async () => {
    const { fetcher } = fakeRpc({
      getAssetBatch: new ProviderError('helius', 'timeout', `https://mainnet.helius-rpc.com/?api-key=${API_KEY}: timeout`),
    });
    const err = await rejectionOf(createHelius({ apiKey: API_KEY, fetcher }).getMetadata([MINT]));
    expect(err.code).toBe('timeout');
    expect(err.message).not.toContain(API_KEY);
  });

  it('reports a missing key as not_configured', async () => {
    const { fetcher, calls } = fakeRpc({});
    const err = await rejectionOf(createHelius({ apiKey: '', fetcher }).getMetadata([MINT]));
    expect(err.code).toBe('not_configured');
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Metadata (DAS)
// ---------------------------------------------------------------------------

describe('helius getMetadata', () => {
  it('maps DAS assets, preferring content metadata and falling back to the Token-2022 extension', async () => {
    const { fetcher, calls } = fakeRpc({ getAssetBatch: ASSETS });
    const ids = ['F9Lw3ki3hJ7PF9HQXsBzoY8GyE6sPoEZZdXJBsTTD2rk', MINT, 'So11111111111111111111111111111111111111112'];
    const res = await createHelius({ apiKey: API_KEY, fetcher }).getMetadata([...ids, MINT, 'garbage']);

    expect(res.source).toBe('helius');
    expect(res.freshness).toBe('indexed');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual({ ids, options: { showFungible: true } });

    // null asset (unknown id) is simply absent.
    expect(Object.keys(res.data).sort()).toEqual(['7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump', 'F9Lw3ki3hJ7PF9HQXsBzoY8GyE6sPoEZZdXJBsTTD2rk']);

    expect(res.data[MINT]).toEqual({
      mint: MINT,
      name: 'Corgi Capital',
      symbol: 'CC',
      // ipfs:// file skipped, first https image file used.
      image: 'https://gateway.pinata.cloud/ipfs/bafkreiexampleimagecid',
      decimals: 6,
      tokenProgram: 'token-2022',
      totalSupply: 1_000_000_000,
      socials: {},
    });
    // DAS price_info is cached up to 10 min: never surfaced.
    expect(JSON.stringify(res.data[MINT])).not.toContain('0.0000123');

    const nft = res.data.F9Lw3ki3hJ7PF9HQXsBzoY8GyE6sPoEZZdXJBsTTD2rk;
    expect(nft?.name).toBe('Mad Lads #8420');
    expect(nft?.symbol).toBe('MAD');
    expect(nft?.image).toBe('https://madlads.s3.us-west-2.amazonaws.com/images/8420.png');
    expect(nft?.decimals).toBe(0);
    expect(nft?.totalSupply).toBe(1);
    expect(nft?.tokenProgram).toBe('spl-token');
    expect(nft?.description).toBe('Fock it.');
    expect(nft?.socials).toEqual({ website: 'https://madlads.com' });
  });

  it('chunks requests at the 1,000-id DAS limit', async () => {
    const ids = Array.from({ length: HELIUS_ASSET_BATCH_LIMIT + 5 }, (_, i) => fakeAddress(i));
    expect(ids.every((id) => isSolanaAddress(id))).toBe(true);
    const { fetcher, calls } = fakeRpc({ getAssetBatch: { jsonrpc: '2.0', id: 1, result: [] } });
    const res = await createHelius({ apiKey: API_KEY, fetcher }).getMetadata(ids);
    expect(res.data).toEqual({});
    expect(calls).toHaveLength(2);
    expect((calls[0]?.params as { ids: string[] }).ids).toHaveLength(HELIUS_ASSET_BATCH_LIMIT);
    expect((calls[1]?.params as { ids: string[] }).ids).toHaveLength(5);
  });

  it('accepts the bare result array shown in the DAS OpenAPI schema', async () => {
    const bare = (ASSETS as { result: unknown[] }).result;
    const { fetcher } = fakeRpc({ getAssetBatch: bare });
    const res = await createHelius({ apiKey: API_KEY, fetcher }).getMetadata([MINT]);
    expect(res.data[MINT]?.symbol).toBe('CC');
  });

  it('maps DAS error codes', async () => {
    const { fetcher } = fakeRpc({ getAssetBatch: { jsonrpc: '2.0', id: 1, error: { code: -32029, message: 'Rate limit exceeded' } } });
    const err = await rejectionOf(createHelius({ apiKey: API_KEY, fetcher }).getMetadata([MINT]));
    expect(err.code).toBe('rate_limited');
  });

  it('makes no call for an empty or invalid mint list', async () => {
    const { fetcher, calls } = fakeRpc({});
    const res = await createHelius({ apiKey: API_KEY, fetcher }).getMetadata(['x', '']);
    expect(res.data).toEqual({});
    expect(calls).toHaveLength(0);
  });
});
