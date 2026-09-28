/**
 * DEX Screener adapter (keyless, isomorphic; normally run in the browser so
 * each visitor spends their own per-IP quota — CORS is `*`).
 *
 * Role: SECONDARY enrichment only. The API terms forbid building a product
 * whose primary purpose competes with DEX Screener and forbid re-exposing the
 * API, so ORBYT uses it to enrich rows/pages with fallbacks elsewhere and must
 * never serve its raw payloads through a public proxy.
 *
 * Verified limits (2026-09-28): 300 req/min on pairs/tokens/token-pairs/search,
 * edge-cached 30 s (search 60 s) → freshness `indexed`. Batch endpoints take at
 * most 30 addresses: 31 pair addresses return HTTP 400 with an HTML string
 * body, and /tokens/v1 silently truncates its output at 30 — so always chunk.
 */

import { chunk } from '@/lib/core/chain';
import type {
  LiquidityProvider,
  MarketDataProvider,
  TokenMetadataProvider,
  TokenRowsProvider,
  TokenSearchProvider,
} from '@/lib/core/providers';
import { isSolanaAddress } from '@/lib/core/solana';
import type { LaunchpadState, PoolInfo, SearchHit, Sourced, TokenMarket, TokenMeta, TokenRow } from '@/lib/core/types';
import { describeError, isAbortError, ProviderError } from '@/lib/net/errors';
import type { JsonFetcher, JsonRequest } from '@/lib/net/types';
import {
  comparePools,
  compact,
  deriveLaunch,
  hasSocials,
  mainPairLaunch,
  parsePairs,
  toPoolInfo,
  toTokenMarket,
  type DsPair,
} from './parse';

export const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com';
/** Max addresses per batch call (pairs and tokens endpoints). */
export const DEXSCREENER_BATCH_LIMIT = 30;

const PROVIDER = 'dexscreener' as const;
/** Upstream edge cache is 30 s; re-reading faster gains nothing. */
const LOOKUP_CACHE_MS = 15_000;
const SEARCH_CACHE_MS = 30_000;
const MAX_QUERY_LENGTH = 100;

export interface DexScreenerOptions {
  fetcher: JsonFetcher;
  /** Defaults to https://api.dexscreener.com. */
  baseUrl?: string;
}

export interface DexScreenerAdapter
  extends LiquidityProvider,
    MarketDataProvider,
    TokenRowsProvider,
    TokenSearchProvider,
    TokenMetadataProvider {
  readonly id: 'dexscreener';
  /** Pools by pair address (batched by 30); unknown pairs are absent. Input order is kept. */
  getPairs(pairAddresses: string[], signal?: AbortSignal): Promise<Sourced<PoolInfo[]>>;
  /** Launch stage derived from the token's pairs; never reports curve progress. */
  getLaunchpadState(mint: string, signal?: AbortSignal): Promise<Sourced<LaunchpadState>>;
}

interface Fetched {
  pairs: DsPair[];
  fetchedAt: number;
  notes?: string[];
}

function sourced<T>(data: T, fetchedAt: number, notes?: string[]): Sourced<T> {
  const out: Sourced<T> = { data, source: PROVIDER, fetchedAt, freshness: 'indexed' };
  if (notes?.length) out.notes = notes;
  return out;
}

function malformed(what: string): ProviderError {
  return new ProviderError(PROVIDER, 'malformed', `dexscreener ${what}: unexpected response shape`);
}

/** Bare-array endpoints (/tokens/v1, /token-pairs/v1). */
function expectArray(body: unknown, what: string): unknown[] {
  if (!Array.isArray(body)) throw malformed(what);
  return body;
}

/** `{ schemaVersion, pairs }` envelope; `pairs: null` means no matches (not an error). */
function expectPairsEnvelope(body: unknown, what: string): unknown[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || !('pairs' in body)) throw malformed(what);
  const { pairs } = body as { pairs: unknown };
  if (pairs === null) return [];
  if (!Array.isArray(pairs)) throw malformed(what);
  return pairs;
}

/**
 * Parse pair items. Items lacking identity fields are dropped, but a non-empty
 * payload in which NO item parses is a schema change, not "no pairs": it must
 * not surface as a genuine empty result.
 */
function parseItems(items: unknown[], what: string): DsPair[] {
  const pairs = parsePairs(items);
  if (items.length > 0 && pairs.length === 0) throw malformed(what);
  return pairs;
}

/** Chain-scoped endpoints only return Solana; tolerate a missing chainId there. */
function onSolana(p: DsPair): boolean {
  return p.chainId === undefined || p.chainId === 'solana';
}

/** Trimmed, valid, de-duplicated addresses (they are placed in URL paths). */
function uniqueAddresses(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    const t = typeof v === 'string' ? v.trim() : '';
    if (isSolanaAddress(t)) out.add(t);
  }
  return [...out];
}

function requireAddress(mint: string): string {
  const t = typeof mint === 'string' ? mint.trim() : '';
  if (!isSolanaAddress(t)) throw new ProviderError(PROVIDER, 'not_found', 'dexscreener: invalid Solana address');
  return t;
}

/**
 * Run one request per chunk of ≤30 addresses. Partial failure keeps the
 * successful chunks and adds a note (missing items are then simply absent);
 * if every chunk fails the first error is thrown; aborts propagate.
 */
async function batched(addresses: string[], load: (group: string[]) => Promise<Fetched>): Promise<Fetched> {
  const groups = chunk(addresses, DEXSCREENER_BATCH_LIMIT);
  if (!groups.length) return { pairs: [], fetchedAt: Date.now() };
  const settled = await Promise.allSettled(groups.map(load));
  const pairs: DsPair[] = [];
  const errors: unknown[] = [];
  let fetchedAt = Number.POSITIVE_INFINITY;
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      pairs.push(...r.value.pairs);
      fetchedAt = Math.min(fetchedAt, r.value.fetchedAt);
    } else {
      if (isAbortError(r.reason)) throw r.reason;
      errors.push(r.reason);
    }
  }
  if (errors.length === groups.length) throw errors[0];
  const notes = errors.length
    ? [`DEX Screener: ${errors.length} of ${groups.length} batches failed (${describeError(errors[0])}); affected items are missing.`]
    : undefined;
  return { pairs, fetchedAt, notes };
}

/** Pick the main pair when upstream returns several for one token (skip a graduated curve). */
function selectMain(mint: string, list: DsPair[]): DsPair | undefined {
  if (list.length <= 1) return list[0];
  const { frozenPairs } = deriveLaunch(mint, list);
  return list.find((p) => !frozenPairs.has(p.pairAddress)) ?? list[0];
}

function bestForSearch(group: DsPair[], frozen: ReadonlySet<string>): DsPair {
  const candidates = group.filter((p) => !frozen.has(p.pairAddress));
  const pool = candidates.length ? candidates : group;
  return pool.reduce((best, p) => {
    const bl = best.liquidityUsd ?? -1;
    const pl = p.liquidityUsd ?? -1;
    if (pl !== bl) return pl > bl ? p : best;
    return (p.volume.h24 ?? -1) > (best.volume.h24 ?? -1) ? p : best;
  });
}

export function createDexScreener(opts: DexScreenerOptions): DexScreenerAdapter {
  const { fetcher } = opts;
  const base = (opts.baseUrl ?? DEXSCREENER_BASE_URL).replace(/\/+$/, '');

  const req = (what: string, cacheMs: number, signal?: AbortSignal): JsonRequest => ({
    label: `dexscreener ${what}`,
    cacheMs,
    signal,
  });

  /** /tokens/v1 → main pair per requested mint (mint must be the BASE token). */
  async function mainPairs(mints: string[], signal?: AbortSignal) {
    const wanted = uniqueAddresses(mints);
    const res = await batched(wanted, async (group) => {
      const body = await fetcher<unknown>(PROVIDER, `${base}/tokens/v1/solana/${group.join(',')}`, req('tokens', LOOKUP_CACHE_MS, signal));
      return { pairs: parseItems(expectArray(body, 'tokens'), 'tokens').filter(onSolana), fetchedAt: Date.now() };
    });
    const byMint = new Map<string, DsPair[]>();
    const wantedSet = new Set(wanted);
    for (const p of res.pairs) {
      // A pair where the mint is only the QUOTE describes another token's price: skip it.
      if (!wantedSet.has(p.base.address)) continue;
      const list = byMint.get(p.base.address);
      if (list) list.push(p);
      else byMint.set(p.base.address, [p]);
    }
    const main: Array<[string, DsPair]> = [];
    for (const mint of wanted) {
      const pair = selectMain(mint, byMint.get(mint) ?? []);
      if (pair) main.push([mint, pair]);
    }
    return { main, fetchedAt: res.fetchedAt, notes: res.notes };
  }

  /** /token-pairs/v1 → every pair listing the mint (base OR quote side). */
  async function tokenPairs(mint: string, signal?: AbortSignal): Promise<Fetched> {
    const address = requireAddress(mint);
    const body = await fetcher<unknown>(PROVIDER, `${base}/token-pairs/v1/solana/${address}`, req('token-pairs', LOOKUP_CACHE_MS, signal));
    return { pairs: parseItems(expectArray(body, 'token-pairs'), 'token-pairs').filter(onSolana), fetchedAt: Date.now() };
  }

  return {
    id: PROVIDER,

    async getPairs(pairAddresses, signal) {
      const wanted = uniqueAddresses(pairAddresses);
      const res = await batched(wanted, async (group) => {
        const body = await fetcher<unknown>(
          PROVIDER,
          `${base}/latest/dex/pairs/solana/${group.join(',')}`,
          req('pairs', LOOKUP_CACHE_MS, signal),
        );
        return { pairs: parseItems(expectPairsEnvelope(body, 'pairs'), 'pairs').filter(onSolana), fetchedAt: Date.now() };
      });
      const byAddress = new Map(res.pairs.map((p) => [p.pairAddress, p] as const));
      const pools: PoolInfo[] = [];
      for (const address of wanted) {
        const p = byAddress.get(address);
        if (p) pools.push(toPoolInfo(p));
      }
      return sourced(pools, res.fetchedAt, res.notes);
    },

    /**
     * Pools where the mint is the BASE token, most liquid first and bonding
     * curves last. Pools that merely quote the mint (other tokens paired
     * against it) are excluded: their prices describe the other token.
     */
    async getPools(mint, signal) {
      const { pairs, fetchedAt } = await tokenPairs(mint, signal);
      const address = mint.trim();
      const own = pairs.filter((p) => p.base.address === address);
      const { frozenPairs } = deriveLaunch(address, own);
      const pools = own.map((p) => toPoolInfo(p, frozenPairs.has(p.pairAddress))).sort(comparePools);
      const notes = frozenPairs.size
        ? ['Graduated bonding-curve pair is listed for reference; its price is frozen at migration and omitted.']
        : undefined;
      return sourced(pools, fetchedAt, notes);
    },

    async getLaunchpadState(mint, signal) {
      const { pairs, fetchedAt } = await tokenPairs(mint, signal);
      const { state } = deriveLaunch(mint.trim(), pairs);
      const notes =
        state.stage === 'graduated'
          ? ['Graduation time is approximated by the migration pool creation time.']
          : state.stage === 'bonding'
            ? ['DEX Screener does not report bonding-curve progress.']
            : undefined;
      return sourced(state, fetchedAt, notes);
    },

    async getMarkets(mints, signal) {
      const { main, fetchedAt, notes } = await mainPairs(mints, signal);
      const data: Record<string, TokenMarket> = {};
      for (const [mint, p] of main) data[mint] = toTokenMarket(p, fetchedAt);
      return sourced(data, fetchedAt, notes);
    },

    /** One row per known mint, in request order. `createdAt` is the main pair's creation time. */
    async getRows(mints, signal) {
      const { main, fetchedAt, notes } = await mainPairs(mints, signal);
      const rows: TokenRow[] = main.map(([mint, p]) => ({
        token: compact<TokenRow['token']>({
          mint,
          symbol: p.base.symbol,
          name: p.base.name,
          image: p.imageUrl,
          createdAt: p.createdAt,
          socials: hasSocials(p.socials) ? p.socials : undefined,
          launchpad: mainPairLaunch(p),
        }),
        market: toTokenMarket(p, fetchedAt),
        pool: compact<NonNullable<TokenRow['pool']>>({
          address: p.pairAddress,
          dex: p.venue.dex,
          dexLabel: p.venue.label,
          quoteSymbol: p.quote?.symbol,
        }),
      }));
      return sourced(rows, fetchedAt, notes);
    },

    /**
     * Identity, logo and links from the main pair's profile (`info`). Only a
     * bonding-curve main pair dates the token itself (the curve is created
     * with the mint), so `createdAt` is set only then.
     */
    async getMetadata(mints, signal) {
      const { main, fetchedAt, notes } = await mainPairs(mints, signal);
      const data: Record<string, TokenMeta> = {};
      for (const [mint, p] of main) {
        data[mint] = compact<TokenMeta>({
          mint,
          symbol: p.base.symbol,
          name: p.base.name,
          image: p.imageUrl,
          socials: { ...p.socials },
          createdAt: p.venue.isBondingCurve ? p.createdAt : undefined,
          launchpad: mainPairLaunch(p),
        });
      }
      return sourced(data, fetchedAt, notes);
    },

    /**
     * Search is cross-chain and capped at 30 pairs: keep Solana pairs, one hit
     * per base token (its most liquid pair), in upstream relevance order. An
     * address query returns only that token (or the token of that pair).
     */
    async search(query, signal) {
      const q = (typeof query === 'string' ? query : '').trim().slice(0, MAX_QUERY_LENGTH);
      if (!q) return sourced<SearchHit[]>([], Date.now());
      const body = await fetcher<unknown>(
        PROVIDER,
        `${base}/latest/dex/search?q=${encodeURIComponent(q)}`,
        req('search', SEARCH_CACHE_MS, signal),
      );
      const fetchedAt = Date.now();
      let pairs = parseItems(expectPairsEnvelope(body, 'search'), 'search').filter((p) => p.chainId === 'solana');

      if (isSolanaAddress(q)) {
        const direct = pairs.filter((p) => p.base.address === q || p.pairAddress === q);
        if (!direct.length) {
          // Listed only as the QUOTE of other pairs: identity is known, its price is not.
          const quoted = pairs.find((p) => p.quote?.address === q);
          const hits = quoted
            ? [compact<SearchHit>({ mint: q, symbol: quoted.quote?.symbol, name: quoted.quote?.name, source: PROVIDER })]
            : [];
          return sourced(hits, fetchedAt);
        }
        pairs = direct;
      }

      const groups = new Map<string, DsPair[]>();
      for (const p of pairs) {
        const list = groups.get(p.base.address);
        if (list) list.push(p);
        else groups.set(p.base.address, [p]);
      }
      const hits: SearchHit[] = [];
      for (const [mint, group] of groups) {
        const { state, frozenPairs } = deriveLaunch(mint, group);
        const best = bestForSearch(group, frozenPairs);
        hits.push(
          compact<SearchHit>({
            mint,
            symbol: best.base.symbol,
            name: best.base.name,
            image: best.imageUrl ?? group.find((p) => p.imageUrl)?.imageUrl,
            priceUsd: best.priceUsd,
            marketCapUsd: best.marketCapUsd,
            liquidityUsd: best.liquidityUsd,
            volume24hUsd: best.volume.h24,
            launchpad: state.stage === 'bonding' || state.stage === 'graduated' ? state : undefined,
            source: PROVIDER,
          }),
        );
      }
      return sourced(hits, fetchedAt);
    },
  };
}
