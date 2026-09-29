import { describe, expect, it, vi } from 'vitest';
import { MINTS, PROGRAMS } from '@/lib/core/solana';
import type { SearchHit, Sourced } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import type { RpcAccountInfo } from '@/lib/providers/solana/rpc';
import {
  addressActions,
  classifyAccount,
  extractFromUrl,
  isRelatedQuery,
  mergeHits,
  parseSearchQuery,
  rankHits,
  relevance,
  resolveSearch,
  SEARCH_MAX_RESULTS,
  SearchError,
  searchTokens,
  type AccountClass,
  type ResolveDeps,
  type SearchProviderId,
  type SearchResult,
  type SearchSources,
} from './useSearch';

// Real, valid 32-byte base58 addresses (no network access in these tests).
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const PUMP_MINT = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump';
const SIGNATURE = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Deterministic valid 32-byte address for seeds 1..255. */
function address(seed: number): string {
  let n = 0n;
  for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(i === 0 ? seed : (seed * 7 + i) % 256);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}
const WALLET = address(201);

const hit = (mint: string, extra: Partial<SearchHit> = {}): SearchHit => ({ mint, source: 'jupiter', ...extra });

function sourced(data: SearchHit[], source: SearchHit['source'] = 'jupiter'): Sourced<SearchHit[]> {
  return { data, source, fetchedAt: 1, freshness: 'fast' };
}

type Behaviour = SearchHit[] | Error;

function fakeSources(behaviour: Partial<Record<SearchProviderId, Behaviour>>) {
  const calls: SearchProviderId[] = [];
  const make = (id: SearchProviderId) => ({
    search: vi.fn(async (query: string) => {
      calls.push(id);
      void query;
      const b = behaviour[id];
      if (b === undefined) throw new Error(`${id} should not be called`);
      if (b instanceof Error) throw b;
      return sourced(b, id);
    }),
  });
  const sources: SearchSources = { jupiter: make('jupiter'), dexscreener: make('dexscreener'), geckoterminal: make('geckoterminal') };
  return { sources, calls };
}

const rateLimited = (p: SearchProviderId) => new ProviderError(p, 'rate_limited', `${p}: HTTP 429`);

describe('parseSearchQuery', () => {
  it('classifies empty and too-short input', () => {
    expect(parseSearchQuery('')).toEqual({ kind: 'empty' });
    expect(parseSearchQuery('   ')).toEqual({ kind: 'empty' });
    expect(parseSearchQuery('b')).toEqual({ kind: 'short', text: 'b' });
    expect(parseSearchQuery('$')).toEqual({ kind: 'short', text: '' });
    expect(parseSearchQuery('$b')).toEqual({ kind: 'short', text: 'b' });
  });

  it('treats text as a symbol/name lookup, stripping cashtags and extra spaces', () => {
    expect(parseSearchQuery('bonk')).toEqual({ kind: 'text', text: 'bonk' });
    expect(parseSearchQuery('  $WIF ')).toEqual({ kind: 'text', text: 'WIF' });
    expect(parseSearchQuery('dog   wif  hat')).toEqual({ kind: 'text', text: 'dog wif hat' });
    expect(parseSearchQuery('x'.repeat(100))).toEqual({ kind: 'text', text: 'x'.repeat(64) });
  });

  it('detects valid Solana addresses (mint or wallet) exactly as typed', () => {
    expect(parseSearchQuery(` ${PUMP_MINT} `)).toEqual({ kind: 'address', address: PUMP_MINT, fromUrl: false });
    expect(parseSearchQuery(WALLET)).toEqual({ kind: 'address', address: WALLET, fromUrl: false });
  });

  it('does not treat invalid base58 or wrong-length strings as addresses', () => {
    // '0', 'O', 'I', 'l' are not base58.
    expect(parseSearchQuery('0ezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263').kind).toBe('text');
    // Truncated mint decodes to fewer than 32 bytes.
    expect(parseSearchQuery(BONK.slice(0, 30)).kind).toBe('text');
  });

  it('detects transaction signatures', () => {
    expect(parseSearchQuery(SIGNATURE)).toEqual({ kind: 'signature', signature: SIGNATURE, fromUrl: false });
  });

  it('extracts addresses and signatures from pasted links', () => {
    expect(parseSearchQuery(`https://dexscreener.com/solana/${BONK}`)).toEqual({ kind: 'address', address: BONK, fromUrl: true });
    expect(parseSearchQuery(`pump.fun/coin/${PUMP_MINT}`)).toEqual({ kind: 'address', address: PUMP_MINT, fromUrl: true });
    expect(parseSearchQuery(`https://solscan.io/tx/${SIGNATURE}?cluster=mainnet`)).toEqual({ kind: 'signature', signature: SIGNATURE, fromUrl: true });
    expect(parseSearchQuery(`https://gmgn.ai/sol/token/abc123_${WIF}`)).toEqual({ kind: 'address', address: WIF, fromUrl: true });
  });
});

describe('extractFromUrl', () => {
  it('prefers the traded token over quote assets in swap links', () => {
    expect(extractFromUrl(`https://jup.ag/swap?sell=${MINTS.SOL}&buy=${JUP}`)).toEqual({ address: JUP });
    expect(extractFromUrl(`https://jup.ag/swap/SOL-${JUP}`)).toEqual({ address: JUP });
    expect(extractFromUrl(`https://jup.ag/swap/${MINTS.USDC}-${MINTS.SOL}`)).toEqual({ address: MINTS.SOL });
  });

  it('prefers token parameters, then the path, over other query parameters', () => {
    // DEX Screener maker filter: the pair in the path, not the filtered wallet.
    expect(extractFromUrl(`https://dexscreener.com/solana/${BONK}?maker=${WALLET}`)).toEqual({ address: BONK });
    expect(extractFromUrl(`https://raydium.io/swap/?inputMint=sol&outputMint=${WIF}`)).toEqual({ address: WIF });
    expect(extractFromUrl(`https://neo.bullx.io/terminal?chainId=1399811149&address=${PUMP_MINT}`)).toEqual({ address: PUMP_MINT });
    expect(extractFromUrl(`https://photon-sol.tinyastro.io/en/lp/${BONK}?handle=abc`)).toEqual({ address: BONK });
    // Nothing in the path: other parameters still count.
    expect(extractFromUrl(`https://example.com/?ref=${WALLET}`)).toEqual({ address: WALLET });
  });

  it('returns null for non-links and an empty object for links without an address', () => {
    expect(extractFromUrl('bonk inu')).toBeNull();
    expect(extractFromUrl('bonk')).toBeNull();
    expect(extractFromUrl('https://example.com/tokens')).toEqual({});
  });
});

describe('addressActions', () => {
  it('offers token and wallet routes for any valid address', () => {
    const actions = addressActions(parseSearchQuery(WALLET));
    expect(actions.map((a) => [a.kind, a.href, a.external])).toEqual([
      ['token', `/trade/${WALLET}`, false],
      ['wallet', `/wallet/${WALLET}`, false],
    ]);
  });

  it('links signatures to the explorer and offers nothing for text', () => {
    const [tx] = addressActions(parseSearchQuery(SIGNATURE));
    expect(tx).toMatchObject({ kind: 'tx', external: true, href: `https://solscan.io/tx/${SIGNATURE}` });
    expect(addressActions(parseSearchQuery('bonk'))).toEqual([]);
    expect(addressActions(parseSearchQuery(''))).toEqual([]);
  });

  it('keeps only the routes that can work once the address is classified', () => {
    const parsed = parseSearchQuery(WALLET);
    const routes = (account: Parameters<typeof addressActions>[1]) => addressActions(parsed, account).map((a) => [a.kind, a.href]);
    expect(routes({ kind: 'mint' })).toEqual([['token', `/trade/${WALLET}`]]);
    expect(routes({ kind: 'wallet' })).toEqual([['wallet', `/wallet/${WALLET}`]]);
    expect(routes({ kind: 'empty' })).toEqual([['wallet', `/wallet/${WALLET}`]]);
    // A token account resolves to its mint and owner wallet.
    expect(routes({ kind: 'token-account', mint: BONK, owner: WIF })).toEqual([
      ['token', `/trade/${BONK}`],
      ['wallet', `/wallet/${WIF}`],
    ]);
    // Pools / curves / programs are neither a token page nor a wallet page.
    expect(routes({ kind: 'program-account', owner: PROGRAMS.PUMP_AMM })).toEqual([['account', `https://solscan.io/account/${WALLET}`]]);
    expect(routes({ kind: 'program' })).toEqual([['account', `https://solscan.io/account/${WALLET}`]]);
    // Unknown keeps both immediate shortcuts.
    expect(routes({ kind: 'unknown' })).toEqual([
      ['token', `/trade/${WALLET}`],
      ['wallet', `/wallet/${WALLET}`],
    ]);
  });
});

describe('classifyAccount', () => {
  const base = { lamports: 1_461_600, executable: false };
  const parsedData = (program: string, type: string, info: Record<string, unknown> = {}) => ({ program, parsed: { type, info }, space: 82 });

  it('recognises mints of both token programs', () => {
    expect(classifyAccount({ ...base, owner: PROGRAMS.TOKEN, data: parsedData('spl-token', 'mint', { decimals: 5 }) })).toEqual({ kind: 'mint' });
    expect(classifyAccount({ ...base, owner: PROGRAMS.TOKEN_2022, data: parsedData('spl-token-2022', 'mint') })).toEqual({ kind: 'mint' });
  });

  it('resolves token accounts to their mint and owner', () => {
    const account: RpcAccountInfo = { ...base, owner: PROGRAMS.TOKEN, data: parsedData('spl-token', 'account', { mint: BONK, owner: WIF }) };
    expect(classifyAccount(account)).toEqual({ kind: 'token-account', mint: BONK, owner: WIF });
    // Invalid parsed addresses are not trusted.
    expect(classifyAccount({ ...account, data: parsedData('spl-token', 'account', { mint: 'x', owner: WIF }) })).toEqual({ kind: 'unknown' });
  });

  it('never guesses for token-program data the node did not parse', () => {
    expect(classifyAccount({ ...base, owner: PROGRAMS.TOKEN, data: ['AAAA', 'base64'] })).toEqual({ kind: 'unknown' });
  });

  it('tells wallets, unused addresses, programs and program accounts apart', () => {
    expect(classifyAccount({ ...base, owner: '11111111111111111111111111111111', data: ['', 'base64'] })).toEqual({ kind: 'wallet' });
    expect(classifyAccount(null)).toEqual({ kind: 'empty' });
    expect(classifyAccount({ ...base, owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true, data: ['', 'base64'] })).toEqual({ kind: 'program' });
    expect(classifyAccount({ ...base, owner: PROGRAMS.PUMP_AMM, data: ['AAAA', 'base64'] })).toEqual({ kind: 'program-account', owner: PROGRAMS.PUMP_AMM });
  });
});

describe('isRelatedQuery', () => {
  it('keeps previous results only while a query is refined', () => {
    expect(isRelatedQuery('bon', 'bonk')).toBe(true);
    expect(isRelatedQuery('BONK', 'bon')).toBe(true);
    expect(isRelatedQuery('bonk', 'wif')).toBe(false);
    expect(isRelatedQuery('bonk', BONK)).toBe(false);
    expect(isRelatedQuery('', 'bonk')).toBe(false);
  });
});

describe('mergeHits', () => {
  it('dedupes by mint, keeps primary values and fills only missing fields', () => {
    const merged = mergeHits([
      [hit(BONK, { symbol: 'Bonk', verified: true, liquidityUsd: 5_000_000 })],
      [
        hit(BONK, { symbol: 'BONK', name: 'Bonk', liquidityUsd: 1, marketCapUsd: 2e9, source: 'dexscreener' }),
        hit(WIF, { symbol: 'WIF', source: 'dexscreener' }),
      ],
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({
      mint: BONK,
      symbol: 'Bonk',
      name: 'Bonk',
      verified: true,
      liquidityUsd: 5_000_000,
      marketCapUsd: 2e9,
      source: 'jupiter',
      sources: ['jupiter', 'dexscreener'],
    });
    expect(merged[1]?.sources).toEqual(['dexscreener']);
  });

  it('enriches launchpad state only when stages agree', () => {
    const [agree] = mergeHits([
      [hit(PUMP_MINT, { launchpad: { stage: 'bonding', launchpad: 'pump.fun' } })],
      [hit(PUMP_MINT, { launchpad: { stage: 'bonding', progressPct: 62 }, source: 'geckoterminal' })],
    ]);
    expect(agree?.launchpad).toEqual({ stage: 'bonding', launchpad: 'pump.fun', progressPct: 62 });

    const [disagree] = mergeHits([
      [hit(PUMP_MINT, { launchpad: { stage: 'graduated', launchpad: 'pump.fun' } })],
      [hit(PUMP_MINT, { launchpad: { stage: 'bonding', progressPct: 99 }, source: 'dexscreener' })],
    ]);
    expect(disagree?.launchpad).toEqual({ stage: 'graduated', launchpad: 'pump.fun' });

    const [filled] = mergeHits([[hit(PUMP_MINT)], [hit(PUMP_MINT, { launchpad: { stage: 'bonding' }, source: 'dexscreener' })]]);
    expect(filled?.launchpad).toEqual({ stage: 'bonding' });
  });

  it('drops hits whose mint is not a valid address', () => {
    expect(mergeHits([[hit('not-a-mint'), hit(BONK)]]).map((h) => h.mint)).toEqual([BONK]);
  });

  it('does not mutate its inputs', () => {
    const primary = hit(BONK, { symbol: 'BONK' });
    mergeHits([[primary], [hit(BONK, { name: 'Bonk', source: 'dexscreener' })]]);
    expect(primary).toEqual({ mint: BONK, source: 'jupiter', symbol: 'BONK' });
  });
});

describe('relevance', () => {
  it('orders exact mint > exact symbol > exact name > prefixes > substring > none', () => {
    const t = { mint: BONK, symbol: 'BONK', name: 'Bonk' };
    expect(relevance(t, BONK)).toBe(10);
    expect(relevance(t, 'bonk')).toBe(4);
    expect(relevance(t, '$BONK')).toBe(4);
    expect(relevance({ mint: WIF, symbol: 'WIF', name: 'dogwifhat' }, 'dogwifhat')).toBe(3);
    expect(relevance(t, 'bon')).toBe(2);
    expect(relevance({ mint: WIF, symbol: 'WIF', name: 'dogwifhat' }, 'dog')).toBe(1.5);
    expect(relevance({ mint: WIF, symbol: 'WIF', name: 'dogwifhat' }, 'wifh')).toBe(1);
    expect(relevance(t, 'zzz')).toBe(0);
    expect(relevance({ mint: BONK }, 'bonk')).toBe(0);
  });
});

describe('rankHits', () => {
  it('puts the verified token above same-symbol copies', () => {
    const ranked = rankHits(
      [
        hit(WIF, { symbol: 'BONK', liquidityUsd: 40_000 }),
        hit(BONK, { symbol: 'BONK', verified: true, liquidityUsd: 3_000_000 }),
        hit(JUP, { symbol: 'BONKFUN', liquidityUsd: 900_000 }),
      ],
      'bonk',
    );
    expect(ranked.map((h) => h.mint)).toEqual([BONK, WIF, JUP]);
  });

  it('lets a deep verified prefix match beat a thin unverified exact match', () => {
    const ranked = rankHits([hit(WIF, { symbol: 'PENG', liquidityUsd: 2_000 }), hit(BONK, { symbol: 'PENGU', verified: true, liquidityUsd: 20_000_000 })], 'peng');
    expect(ranked.map((h) => h.symbol)).toEqual(['PENGU', 'PENG']);
  });

  it('ranks by liquidity among equals and uses market cap when liquidity is unknown', () => {
    const ranked = rankHits(
      [
        hit(WIF, { symbol: 'CAT', liquidityUsd: 10_000 }),
        hit(BONK, { symbol: 'CAT', liquidityUsd: 1_000_000 }),
        hit(JUP, { symbol: 'CAT', marketCapUsd: 50_000_000 }),
      ],
      'cat',
    );
    expect(ranked.map((h) => h.mint)).toEqual([JUP, BONK, WIF]);
  });

  it('keeps provider order for exact ties and always ranks the exact mint first', () => {
    expect(rankHits([hit(WIF), hit(BONK), hit(JUP)], 'zzz').map((h) => h.mint)).toEqual([WIF, BONK, JUP]);
    const ranked = rankHits([hit(WIF, { symbol: 'X', verified: true, liquidityUsd: 1e9 }), hit(BONK)], BONK);
    expect(ranked[0]?.mint).toBe(BONK);
  });

  it('ignores non-finite numbers', () => {
    const ranked = rankHits([hit(WIF, { symbol: 'A', liquidityUsd: Number.NaN }), hit(BONK, { symbol: 'A', liquidityUsd: 100 })], 'a');
    expect(ranked.map((h) => h.mint)).toEqual([BONK, WIF]);
  });
});

describe('searchTokens (text)', () => {
  const lookup = { kind: 'text', text: 'bonk' } as const;
  const five = [BONK, WIF, JUP, PUMP_MINT, WALLET].map((m) => hit(m, { symbol: 'X' }));

  it('uses Jupiter alone when it returns enough hits', async () => {
    const { sources, calls } = fakeSources({ jupiter: five });
    const result = await searchTokens(lookup, sources);
    expect(calls).toEqual(['jupiter']);
    expect(result.hits).toHaveLength(5);
    expect(result.attempts).toEqual([{ provider: 'jupiter', ok: true, hits: 5 }]);
    expect(result.kind).toBe('text');
    expect(result.query).toBe('bonk');
  });

  it('adds DEX Screener when Jupiter returns fewer than 5 hits, without spending GeckoTerminal budget', async () => {
    const { sources, calls } = fakeSources({
      jupiter: [hit(BONK, { symbol: 'BONK', verified: true })],
      dexscreener: [hit(BONK, { symbol: 'BONK', liquidityUsd: 1e6, source: 'dexscreener' }), hit(WIF, { symbol: 'BONKY', source: 'dexscreener' })],
    });
    const result = await searchTokens(lookup, sources);
    expect(calls).toEqual(['jupiter', 'dexscreener']);
    expect(result.hits.map((h) => h.mint)).toEqual([BONK, WIF]);
    expect(result.hits[0]).toMatchObject({ verified: true, liquidityUsd: 1e6, sources: ['jupiter', 'dexscreener'] });
  });

  it('falls back to GeckoTerminal when Jupiter and DEX Screener both fail', async () => {
    const { sources, calls } = fakeSources({
      jupiter: rateLimited('jupiter'),
      dexscreener: new ProviderError('dexscreener', 'network', 'dexscreener: network error'),
      geckoterminal: [hit(BONK, { source: 'geckoterminal' })],
    });
    const result = await searchTokens(lookup, sources);
    expect(calls).toEqual(['jupiter', 'dexscreener', 'geckoterminal']);
    expect(result.hits.map((h) => h.sources)).toEqual([['geckoterminal']]);
    expect(result.attempts).toEqual([
      { provider: 'jupiter', ok: false, code: 'rate_limited' },
      { provider: 'dexscreener', ok: false, code: 'network' },
      { provider: 'geckoterminal', ok: true, hits: 1 },
    ]);
  });

  it('asks GeckoTerminal only when a 3+ char query found nothing anywhere', async () => {
    const empty = fakeSources({ jupiter: [], dexscreener: [], geckoterminal: [] });
    await searchTokens(lookup, empty.sources);
    expect(empty.calls).toEqual(['jupiter', 'dexscreener', 'geckoterminal']);

    const short = fakeSources({ jupiter: [], dexscreener: [] });
    const result = await searchTokens({ kind: 'text', text: 'bo' }, short.sources);
    expect(short.calls).toEqual(['jupiter', 'dexscreener']);
    expect(result.hits).toEqual([]);

    const some = fakeSources({ jupiter: [], dexscreener: [hit(BONK, { source: 'dexscreener' })] });
    await searchTokens(lookup, some.sources);
    expect(some.calls).toEqual(['jupiter', 'dexscreener']);
  });

  it('throws SearchError with every attempt when all providers fail', async () => {
    const { sources } = fakeSources({ jupiter: rateLimited('jupiter'), dexscreener: rateLimited('dexscreener'), geckoterminal: new Error('boom') });
    const error = await searchTokens(lookup, sources).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SearchError);
    expect((error as SearchError).attempts.map((a) => [a.provider, a.ok, a.code])).toEqual([
      ['jupiter', false, 'rate_limited'],
      ['dexscreener', false, 'rate_limited'],
      ['geckoterminal', false, undefined],
    ]);
  });

  it('propagates aborts instead of falling back', async () => {
    const aborted = new ProviderError('jupiter', 'aborted', 'jupiter: aborted');
    const { sources, calls } = fakeSources({ jupiter: aborted, dexscreener: [] });
    await expect(searchTokens(lookup, sources)).rejects.toBe(aborted);
    expect(calls).toEqual(['jupiter']);
  });

  it('caps results', async () => {
    const many = Array.from({ length: 30 }, (_, i) => hit(address(i + 1)));
    expect(new Set(mergeHits([many]).map((h) => h.mint)).size).toBe(30);
    const { sources } = fakeSources({ jupiter: many });
    const result = await searchTokens(lookup, sources);
    expect(result.hits).toHaveLength(SEARCH_MAX_RESULTS);
  });
});

describe('searchTokens (address)', () => {
  it('stops after Jupiter resolves the mint', async () => {
    const { sources, calls } = fakeSources({ jupiter: [hit(BONK, { symbol: 'Bonk' })] });
    const result = await searchTokens({ kind: 'address', address: BONK, fromUrl: false }, sources);
    expect(calls).toEqual(['jupiter']);
    expect(result.hits[0]?.mint).toBe(BONK);
    expect(result.kind).toBe('address');
  });

  it('asks DEX Screener when Jupiter does not know the address (e.g. a pool address)', async () => {
    const { sources, calls } = fakeSources({ jupiter: [], dexscreener: [hit(BONK, { source: 'dexscreener' })] });
    const result = await searchTokens({ kind: 'address', address: WALLET, fromUrl: false }, sources);
    expect(calls).toEqual(['jupiter', 'dexscreener']);
    expect(result.hits.map((h) => h.mint)).toEqual([BONK]);
  });

  it('never spends GeckoTerminal budget on a wallet address that both providers answered', async () => {
    const { sources, calls } = fakeSources({ jupiter: [], dexscreener: [] });
    const result = await searchTokens({ kind: 'address', address: WALLET, fromUrl: false }, sources);
    expect(calls).toEqual(['jupiter', 'dexscreener']);
    expect(result.hits).toEqual([]);
  });

  it('uses GeckoTerminal only when both keyless providers failed', async () => {
    const { sources, calls } = fakeSources({ jupiter: rateLimited('jupiter'), dexscreener: rateLimited('dexscreener'), geckoterminal: [] });
    const result = await searchTokens({ kind: 'address', address: WALLET, fromUrl: false }, sources);
    expect(calls).toEqual(['jupiter', 'dexscreener', 'geckoterminal']);
    expect(result.hits).toEqual([]);
  });

  it('passes the exact address (case preserved) to providers', async () => {
    const { sources } = fakeSources({ jupiter: [hit(PUMP_MINT)] });
    await searchTokens({ kind: 'address', address: PUMP_MINT, fromUrl: true }, sources);
    expect(sources.jupiter.search).toHaveBeenCalledWith(PUMP_MINT, undefined);
  });
});

describe('resolveSearch (Enter pressed before results settle)', () => {
  const never = <T,>() => new Promise<T>(() => {});
  const result = (hits: SearchHit[], query = 'bonk'): SearchResult => ({
    query,
    kind: 'text',
    hits: mergeHits([hits]),
    attempts: [{ provider: 'jupiter', ok: true, hits: hits.length }],
    fetchedAt: 1,
  });
  const deps = (patch: Partial<ResolveDeps>): ResolveDeps => ({
    classify: vi.fn(async (): Promise<AccountClass> => {
      throw new Error('classify should not be called');
    }),
    lookup: vi.fn(async (): Promise<SearchResult> => {
      throw new Error('lookup should not be called');
    }),
    ...patch,
  });
  const hrefs = (r: { actions: { href: string }[] }) => r.actions.map((a) => a.href);

  it('waits for a text lookup and returns its ranked hits', async () => {
    const d = deps({ lookup: vi.fn(async () => result([hit(BONK, { symbol: 'BONK' })])) });
    const r = await resolveSearch(parseSearchQuery('bonk'), d);
    expect(r.hits.map((h) => h.mint)).toEqual([BONK]);
    expect(d.lookup).toHaveBeenCalledWith({ kind: 'text', text: 'bonk' });
  });

  it('resolves a failed or too-slow text lookup to no hits (Enter does nothing)', async () => {
    expect((await resolveSearch(parseSearchQuery('bonk'), deps({ lookup: vi.fn(async () => Promise.reject(rateLimited('jupiter'))) }))).hits).toEqual([]);
    expect((await resolveSearch(parseSearchQuery('bonk'), deps({ lookup: vi.fn(never<SearchResult>) }), 5)).hits).toEqual([]);
  });

  it('opens a mint as a token and a wallet as a wallet without waiting for token hits', async () => {
    const mint = await resolveSearch(parseSearchQuery(BONK), deps({ classify: vi.fn(async (): Promise<AccountClass> => ({ kind: 'mint' })) }));
    expect(hrefs(mint)).toEqual([`/trade/${BONK}`]);
    const wallet = await resolveSearch(parseSearchQuery(WALLET), deps({ classify: vi.fn(async (): Promise<AccountClass> => ({ kind: 'wallet' })) }));
    expect(hrefs(wallet)).toEqual([`/wallet/${WALLET}`]);
    expect(wallet.hits).toEqual([]);
  });

  it('resolves a pool address to the token it trades', async () => {
    const d = deps({
      classify: vi.fn(async (): Promise<AccountClass> => ({ kind: 'program-account', owner: PROGRAMS.PUMP_AMM })),
      lookup: vi.fn(async () => result([hit(BONK, { source: 'dexscreener' })], WALLET)),
    });
    const r = await resolveSearch(parseSearchQuery(WALLET), d);
    expect(r.hits.map((h) => h.mint)).toEqual([BONK]);
    expect(r.actions.map((a) => a.external)).toEqual([true]);
  });

  it('keeps both unclassified shortcuts when classification fails or is too slow', async () => {
    const failed = await resolveSearch(parseSearchQuery(WALLET), deps({ classify: vi.fn(async (): Promise<AccountClass> => Promise.reject(new Error('rpc down'))) }));
    expect(hrefs(failed)).toEqual([`/trade/${WALLET}`, `/wallet/${WALLET}`]);
    const slow = await resolveSearch(parseSearchQuery(WALLET), deps({ classify: vi.fn(never<AccountClass>) }), 5);
    expect(hrefs(slow)).toEqual([`/trade/${WALLET}`, `/wallet/${WALLET}`]);
  });

  it('needs nothing for signatures', async () => {
    const r = await resolveSearch(parseSearchQuery(SIGNATURE), deps({}));
    expect(hrefs(r)).toEqual([`https://solscan.io/tx/${SIGNATURE}`]);
  });
});
