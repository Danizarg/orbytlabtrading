'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fillMissing } from '@/lib/core/chain';
import type { ProviderId, TokenSearchProvider } from '@/lib/core/providers';
import { explorer, isSignature, isSolanaAddress, MINTS, PROGRAMS } from '@/lib/core/solana';
import type { LaunchpadState, SearchHit } from '@/lib/core/types';
import { isAbortError, isProviderError, type ProviderErrorCode } from '@/lib/net/errors';
import { accountParsedInfo, type RpcAccountInfo } from '@/lib/providers/solana/rpc';
import { browserRpc, dex, gecko, jup } from '../sources';

/**
 * Global token search.
 *
 * Keyless budgets drive the provider order: Jupiter answers first (fuzzy
 * symbol/name/mint, ≤ 20 hits). DEX Screener (generous 300/min budget) is
 * asked only when Jupiter fails or returns fewer than 5 hits. GeckoTerminal
 * (~8 calls/min per browser, shared with charts) is a last resort: only when
 * nothing else answered, or a ≥3-character text query found nothing at all.
 * A pasted address also costs one publicnode `getAccountInfo` to tell a
 * mint from a wallet, token account or pool.
 */

export const SEARCH_DEBOUNCE_MS = 300;
export const SEARCH_MIN_CHARS = 2;
/** Jupiter truncates longer queries upstream. */
export const SEARCH_MAX_CHARS = 64;
/** Below this many Jupiter hits, DEX Screener is consulted too. */
export const SEARCH_ENOUGH_HITS = 5;
export const SEARCH_MAX_RESULTS = 20;

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

export type ParsedQuery =
  | { kind: 'empty' }
  | { kind: 'short'; text: string }
  | { kind: 'address'; address: string; fromUrl: boolean }
  | { kind: 'signature'; signature: string; fromUrl: boolean }
  | { kind: 'text'; text: string };

export type SearchLookup = Extract<ParsedQuery, { kind: 'address' } | { kind: 'text' }>;

const QUOTE_MINTS: ReadonlySet<string> = new Set([MINTS.SOL, MINTS.USDC, MINTS.USDT]);

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** Query parameters that name the traded token in swap / terminal links (lower-case). */
const TOKEN_PARAMS: ReadonlySet<string> = new Set(['buy', 'outputmint', 'outputcurrency', 'output', 'token', 'tokenaddress', 'mint', 'address', 'ca']);

/** Last non-quote address among `parts`, else the last address (a quote asset itself). */
function pickAddress(parts: readonly string[]): string | undefined {
  const addresses = parts.filter((p) => isSolanaAddress(p));
  return addresses.filter((a) => !QUOTE_MINTS.has(a)).at(-1) ?? addresses.at(-1);
}

/**
 * Pull a mint / wallet / signature out of a pasted explorer or terminal link
 * (Solscan, DEX Screener, GeckoTerminal, pump.fun, GMGN, Birdeye, Photon,
 * Axiom, Raydium / Jupiter swap URLs…). Precedence: a token-naming query
 * parameter (`buy`, `outputMint`, `address`…), then the path, then any other
 * parameter, so `dexscreener.com/solana/<pair>?maker=<wallet>` resolves to
 * the pair, not the maker filter. Quote assets (SOL/USDC/USDT) lose to any
 * other address, so `jup.ag/swap/SOL-<mint>` resolves to the token.
 */
export function extractFromUrl(raw: string): { address?: string; signature?: string } | null {
  const text = raw.trim();
  const looksLikeUrl = /^https?:\/\//i.test(text) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(text);
  if (!looksLikeUrl || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const pathParts: string[] = [];
  for (const segment of url.pathname.split('/')) {
    if (!segment) continue;
    const decoded = safeDecode(segment);
    pathParts.push(decoded, ...decoded.split(/[-_:]/));
  }
  const tokenParams: string[] = [];
  const otherParams: string[] = [];
  for (const [name, value] of url.searchParams) {
    (TOKEN_PARAMS.has(name.toLowerCase()) ? tokenParams : otherParams).push(value, ...value.split(/[-_:,]/));
  }
  if (url.hash.length > 1) otherParams.push(safeDecode(url.hash.slice(1)));

  const signature = [...pathParts, ...tokenParams, ...otherParams].find((p) => isSignature(p));
  if (signature) return { signature };
  const address = pickAddress(tokenParams) ?? pickAddress(pathParts) ?? pickAddress(otherParams);
  return address ? { address } : {};
}

/** Classify raw search input. Pure; safe to call on every keystroke. */
export function parseSearchQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'empty' };
  // Plain booleans: the `value is string` guards would narrow `trimmed` to never below.
  const address: boolean = isSolanaAddress(trimmed);
  const signature: boolean = !address && isSignature(trimmed);
  if (address) return { kind: 'address', address: trimmed, fromUrl: false };
  if (signature) return { kind: 'signature', signature: trimmed, fromUrl: false };

  const fromUrl = extractFromUrl(trimmed);
  if (fromUrl?.signature) return { kind: 'signature', signature: fromUrl.signature, fromUrl: true };
  if (fromUrl?.address) return { kind: 'address', address: fromUrl.address, fromUrl: true };

  // Cashtags ("$BONK") are how traders write symbols.
  const text = trimmed.replace(/^\$+/, '').replace(/\s+/g, ' ').trim().slice(0, SEARCH_MAX_CHARS);
  if (text.length < SEARCH_MIN_CHARS) return { kind: 'short', text };
  return { kind: 'text', text };
}

export function isLookup(parsed: ParsedQuery): parsed is SearchLookup {
  return parsed.kind === 'address' || parsed.kind === 'text';
}

export function lookupValue(parsed: SearchLookup): string {
  return parsed.kind === 'address' ? parsed.address : parsed.text;
}

// ---------------------------------------------------------------------------
// Address shortcuts
// ---------------------------------------------------------------------------

export interface AddressAction {
  kind: 'token' | 'wallet' | 'tx' | 'account';
  label: string;
  /** In-app path, or an absolute explorer URL when `external`. */
  href: string;
  external: boolean;
  value: string;
}

/**
 * What an address is on-chain (one `getAccountInfo`, jsonParsed):
 * - `mint`: SPL / Token-2022 mint
 * - `token-account`: a token account; its mint and owner wallet are known
 * - `wallet`: System-owned account
 * - `empty`: no account exists (unfunded address; cannot be a mint)
 * - `program`: executable program
 * - `program-account`: owned by another program (AMM pool, bonding curve, PDA…)
 * - `unknown`: not classified (lookup failed or data not parseable)
 */
export type AccountClass =
  | { kind: 'mint' }
  | { kind: 'token-account'; mint: string; owner: string }
  | { kind: 'wallet' }
  | { kind: 'empty' }
  | { kind: 'program' }
  | { kind: 'program-account'; owner: string }
  | { kind: 'unknown' };

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAMS: ReadonlySet<string> = new Set([PROGRAMS.TOKEN, PROGRAMS.TOKEN_2022]);

/** Classify a jsonParsed `getAccountInfo` result (null = no account). Pure. */
export function classifyAccount(account: RpcAccountInfo | null): AccountClass {
  if (!account) return { kind: 'empty' };
  if (account.executable) return { kind: 'program' };
  if (account.owner === SYSTEM_PROGRAM) return { kind: 'wallet' };
  if (TOKEN_PROGRAMS.has(account.owner)) {
    const parsed = accountParsedInfo(account);
    if (parsed?.type === 'mint') return { kind: 'mint' };
    const { mint, owner } = parsed?.info ?? {};
    if (parsed?.type === 'account' && isSolanaAddress(mint) && isSolanaAddress(owner)) return { kind: 'token-account', mint, owner };
    // Token-program data the node did not parse: do not guess.
    return { kind: 'unknown' };
  }
  return { kind: 'program-account', owner: account.owner };
}

const openToken = (mint: string): AddressAction => ({ kind: 'token', label: 'Open token', href: `/trade/${mint}`, external: false, value: mint });
const openWallet = (address: string, label = 'Open wallet'): AddressAction => ({
  kind: 'wallet',
  label,
  href: `/wallet/${address}`,
  external: false,
  value: address,
});

/**
 * Shortcuts for an address or signature. Before the address is classified
 * (`account` undefined / unknown) both "Open token" and "Open wallet" are
 * offered immediately; once its on-chain type is known only the routes that
 * can work remain (a pool or program account links to the explorer instead,
 * and its token appears among the lookup hits).
 */
export function addressActions(parsed: ParsedQuery, account?: AccountClass): AddressAction[] {
  if (parsed.kind === 'signature') {
    return [{ kind: 'tx', label: 'View transaction on Solscan', href: explorer.tx(parsed.signature), external: true, value: parsed.signature }];
  }
  if (parsed.kind !== 'address') return [];
  const a = parsed.address;
  switch (account?.kind) {
    case 'mint':
      return [openToken(a)];
    case 'token-account':
      return [openToken(account.mint), openWallet(account.owner, 'Open owner wallet')];
    case 'wallet':
    case 'empty':
      return [openWallet(a)];
    case 'program':
      return [{ kind: 'account', label: 'View program on Solscan', href: explorer.account(a), external: true, value: a }];
    case 'program-account':
      return [{ kind: 'account', label: 'View account on Solscan', href: explorer.account(a), external: true, value: a }];
    default:
      return [openToken(a), openWallet(a)];
  }
}

/**
 * Whether results fetched for `previous` may stay on screen (dimmed) while
 * `next` loads: only when one query refines the other ("bon" → "bonk",
 * "bonk" → "bon"). Anything else would flash unrelated tokens.
 */
export function isRelatedQuery(previous: string, next: string): boolean {
  const a = previous.trim().toLowerCase();
  const b = next.trim().toLowerCase();
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
}

// ---------------------------------------------------------------------------
// Merge + rank
// ---------------------------------------------------------------------------

export interface RankedHit extends SearchHit {
  /** Every provider that returned this mint, primary first. */
  sources: ProviderId[];
}

function mergeLaunchpad(primary: LaunchpadState | undefined, other: LaunchpadState | undefined): LaunchpadState | undefined {
  if (!primary) return other;
  // Only enrich when both providers agree on the lifecycle stage.
  if (!other || other.stage !== primary.stage) return primary;
  return fillMissing(primary, other);
}

/**
 * Dedupe hits by mint across provider lists (given in priority order). The
 * first provider's values win; later providers only fill fields it left
 * undefined. Never invents values.
 */
export function mergeHits(lists: readonly (readonly SearchHit[])[]): RankedHit[] {
  const byMint = new Map<string, RankedHit>();
  for (const list of lists) {
    for (const hit of list) {
      if (!isSolanaAddress(hit.mint)) continue;
      const existing = byMint.get(hit.mint);
      if (!existing) {
        byMint.set(hit.mint, { ...hit, sources: [hit.source] });
        continue;
      }
      const launchpad = mergeLaunchpad(existing.launchpad, hit.launchpad);
      const merged = fillMissing<RankedHit>(existing, { ...hit, sources: existing.sources });
      if (launchpad) merged.launchpad = launchpad;
      if (!merged.sources.includes(hit.source)) merged.sources = [...merged.sources, hit.source];
      byMint.set(hit.mint, merged);
    }
  }
  return [...byMint.values()];
}

/** How well a hit's identity matches the query (0 = no textual match). */
export function relevance(hit: Pick<SearchHit, 'mint' | 'symbol' | 'name'>, query: string): number {
  const q = query.trim().replace(/^\$+/, '').toLowerCase();
  if (!q) return 0;
  if (hit.mint === query.trim()) return 10;
  const symbol = hit.symbol?.trim().toLowerCase();
  const name = hit.name?.trim().toLowerCase();
  if (symbol === q) return 4;
  if (name === q) return 3;
  if (symbol?.startsWith(q)) return 2;
  if (name?.startsWith(q)) return 1.5;
  if (symbol?.includes(q) || name?.includes(q)) return 1;
  return 0;
}

/**
 * Liquidity depth on a log scale (0 at $1, ~3.5 at $10M). Bonding-curve hits
 * often have no liquidity figure; their market cap stands in at 20% so live
 * launches are not buried. Ranking only; nothing here is displayed.
 */
function depthScore(hit: Pick<SearchHit, 'liquidityUsd' | 'marketCapUsd'>): number {
  const depth = hit.liquidityUsd ?? (hit.marketCapUsd !== undefined ? hit.marketCapUsd * 0.2 : undefined);
  if (depth === undefined || !Number.isFinite(depth) || depth <= 1) return 0;
  return Math.min(5, Math.log10(depth) * 0.5);
}

/** Relevance + verified (Jupiter) + liquidity depth. */
export function scoreHit(hit: SearchHit, query: string): number {
  return relevance(hit, query) + (hit.verified ? 3 : 0) + depthScore(hit);
}

/** Highest score first; ties by market cap, then original (provider) order. */
export function rankHits<T extends SearchHit>(hits: readonly T[], query: string): T[] {
  return hits
    .map((hit, index) => ({ hit, index, score: scoreHit(hit, query) }))
    .sort((a, b) => b.score - a.score || (b.hit.marketCapUsd ?? -1) - (a.hit.marketCapUsd ?? -1) || a.index - b.index)
    .map((entry) => entry.hit);
}

// ---------------------------------------------------------------------------
// Provider orchestration
// ---------------------------------------------------------------------------

export type SearchProviderId = 'jupiter' | 'dexscreener' | 'geckoterminal';
export type SearchSources = Record<SearchProviderId, Pick<TokenSearchProvider, 'search'>>;

export interface SearchAttempt {
  provider: SearchProviderId;
  ok: boolean;
  hits?: number;
  code?: ProviderErrorCode;
}

export interface SearchResult {
  query: string;
  kind: SearchLookup['kind'];
  hits: RankedHit[];
  attempts: SearchAttempt[];
  fetchedAt: number;
}

export class SearchError extends Error {
  readonly attempts: SearchAttempt[];
  constructor(attempts: SearchAttempt[]) {
    super(`search unavailable: ${attempts.map((a) => `${a.provider} ${a.code ?? 'error'}`).join(', ') || 'no provider'}`);
    this.name = 'SearchError';
    this.attempts = attempts;
  }
}

/**
 * Run the budget-aware provider sequence for one lookup and return merged,
 * ranked hits. Throws SearchError only when every attempted provider failed;
 * an honest empty answer resolves with `hits: []`.
 */
export async function searchTokens(parsed: SearchLookup, sources: SearchSources, signal?: AbortSignal): Promise<SearchResult> {
  const query = lookupValue(parsed);
  const lists: SearchHit[][] = [];
  const attempts: SearchAttempt[] = [];

  const run = async (provider: SearchProviderId) => {
    try {
      const result = await sources[provider].search(query, signal);
      const hits = result.data.filter((h) => isSolanaAddress(h.mint));
      lists.push(hits);
      attempts.push({ provider, ok: true, hits: hits.length });
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      attempts.push({ provider, ok: false, code: isProviderError(error) ? error.code : undefined });
    }
  };
  const anyOk = () => attempts.some((a) => a.ok);
  const count = () => mergeHits(lists).length;

  if (parsed.kind === 'address') {
    await run('jupiter');
    // DEX Screener also resolves pool/pair addresses to their base token.
    if (!mergeHits(lists).some((h) => h.mint === query)) await run('dexscreener');
    if (!anyOk()) await run('geckoterminal');
  } else {
    await run('jupiter');
    if (!anyOk() || count() < SEARCH_ENOUGH_HITS) {
      await run('dexscreener');
      if (!anyOk() || (count() === 0 && query.length >= 3)) await run('geckoterminal');
    }
  }

  if (!anyOk()) throw new SearchError(attempts);
  const ranked = rankHits(mergeHits(lists), query).slice(0, SEARCH_MAX_RESULTS);
  return { query, kind: parsed.kind, hits: ranked, attempts, fetchedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

const BROWSER_SOURCES: SearchSources = { jupiter: jup, dexscreener: dex, geckoterminal: gecko };

/** How long Enter waits for a pending lookup / address classification before using what is on screen. */
export const SEARCH_RESOLVE_WAIT_MS = 1_500;

const accountKey = (address: string) => ['search-account', address] as const;
const searchKey = (lookup: SearchLookup) => ['search', lookup.kind, lookupValue(lookup)] as const;
const ACCOUNT_QUERY = { staleTime: 60_000, gcTime: 5 * 60_000, retry: false } as const;
const SEARCH_QUERY = { staleTime: 60_000, gcTime: 5 * 60_000, retry: false } as const;

/** What the first option will be once pending work settles. */
export interface ResolvedSearch {
  actions: AddressAction[];
  hits: RankedHit[];
}

export interface ResolveDeps {
  classify: (address: string) => Promise<AccountClass>;
  lookup: (target: SearchLookup) => Promise<SearchResult>;
}

/**
 * Decide the options Enter should act on when it is pressed before the
 * lookup / classification settled. Everything shares one deadline:
 * - text: the lookup's hits; failed or too slow → none (Enter does nothing
 *   rather than open a stale row)
 * - address: shortcuts for its on-chain type (unclassified shortcuts when
 *   that fails or is too slow); a pool / curve account also waits for the
 *   token lookup, since the token it trades is what Enter should open
 */
export async function resolveSearch(parsed: ParsedQuery, deps: ResolveDeps, waitMs = SEARCH_RESOLVE_WAIT_MS): Promise<ResolvedSearch> {
  const deadline = Date.now() + waitMs;
  const within = async <T,>(promise: Promise<T>): Promise<T | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((done) => {
      timer = setTimeout(() => done(undefined), Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([promise, timeout]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  if (parsed.kind === 'text') return { actions: [], hits: (await within(deps.lookup(parsed)))?.hits ?? [] };
  if (parsed.kind !== 'address') return { actions: addressActions(parsed), hits: [] };

  const account = await within(deps.classify(parsed.address));
  const hits = account?.kind === 'program-account' ? ((await within(deps.lookup(parsed)))?.hits ?? []) : [];
  return { actions: addressActions(parsed, account), hits };
}

/** On-chain type of an address: one jsonParsed getAccountInfo over the keyless browser RPC. */
export async function loadAccountClass(address: string, signal?: AbortSignal): Promise<AccountClass> {
  return classifyAccount(await browserRpc.getAccountInfo(address, { encoding: 'jsonParsed' }, signal));
}

const NO_HITS: RankedHit[] = [];
const NO_ATTEMPTS: SearchAttempt[] = [];

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface UseSearchResult {
  /** Classification of the current (non-debounced) input. */
  parsed: ParsedQuery;
  /** Open token / Open wallet / View tx shortcuts, available immediately and refined once the address is classified. */
  actions: AddressAction[];
  /** On-chain type of the searched address (undefined until known, or when the input is not an address). */
  account?: AccountClass;
  /** The address is still being classified, so its shortcuts may still change. */
  accountPending: boolean;
  /** Ranked token hits for the current lookup (empty until it resolves). */
  hits: RankedHit[];
  attempts: SearchAttempt[];
  /** A lookup is pending (debounce or network) and nothing is shown for it yet. */
  isLoading: boolean;
  /** Hits on screen belong to a related previous query while the new one loads. */
  isStale: boolean;
  /** The lookup is paused because the browser is offline. */
  offline: boolean;
  /** The last lookup failed on every provider. */
  error: SearchError | null;
  /** When the displayed hits were fetched (ms). */
  fetchedAt?: number;
  /** Work that decides the first option is still pending (debounce, lookup or address classification). */
  resolving: boolean;
  /** Re-run the current lookup (after a failure). */
  retry: () => void;
  /**
   * Settle what the first option will be for the current input: joins the
   * in-flight lookup / classification (no extra requests when they are
   * already running). Waits at most SEARCH_RESOLVE_WAIT_MS: an address then
   * keeps its unclassified shortcuts, a text query resolves to no hits.
   */
  resolve: () => Promise<ResolvedSearch>;
}

/**
 * Token search over keyless browser providers: typed text is debounced
 * (300 ms, ≥ 2 chars); a pasted address is looked up at once and classified
 * on-chain in parallel (1 RPC call) so only the shortcuts that can work stay.
 * Results are cached per query for 60 s so retyping costs no requests.
 */
export function useSearch(input: string): UseSearchResult {
  const queryClient = useQueryClient();
  const parsed = useMemo(() => parseSearchQuery(input), [input]);
  const debouncedInput = useDebouncedValue(input, SEARCH_DEBOUNCE_MS);
  const debounced = useMemo(() => parseSearchQuery(debouncedInput), [debouncedInput]);
  // Nothing is looked up while the current input is not a lookup (empty, short, signature).
  const lookup: SearchLookup | null = !isLookup(parsed) ? null : parsed.kind === 'address' ? parsed : isLookup(debounced) ? debounced : null;
  const key = lookup ? lookupValue(lookup) : null;

  const address = parsed.kind === 'address' ? parsed.address : null;
  const accountQuery = useQuery({
    queryKey: accountKey(address ?? ''),
    queryFn: ({ signal }) => loadAccountClass(address as string, signal),
    enabled: address !== null,
    refetchOnWindowFocus: false,
    ...ACCOUNT_QUERY,
  });
  const account = address !== null ? accountQuery.data : undefined;
  const accountPending = address !== null && accountQuery.isPending && accountQuery.fetchStatus === 'fetching';
  const actions = useMemo(() => addressActions(parsed, account), [parsed, account]);

  const query = useQuery({
    queryKey: lookup ? searchKey(lookup) : ['search', 'none', null],
    queryFn: ({ signal }) => searchTokens(lookup as SearchLookup, BROWSER_SOURCES, signal),
    enabled: lookup !== null,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
    ...SEARCH_QUERY,
  });

  const current = isLookup(parsed) ? lookupValue(parsed) : null;
  const settled = current !== null && current === key;
  const fresh = settled && !query.isPlaceholderData;
  // Previous results stay visible (dimmed) only while the query is being refined.
  const data = current !== null && query.data && (fresh || isRelatedQuery(query.data.query, current)) ? query.data : undefined;
  const isStale = !!data && !fresh;
  const error = settled && query.error instanceof SearchError ? query.error : null;
  const offline = settled && query.fetchStatus === 'paused';
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);

  // fetchQuery joins an in-flight query with the same key (or returns its fresh cache): no extra requests.
  const resolve = useCallback(
    () =>
      resolveSearch(parsed, {
        classify: (target) =>
          queryClient.fetchQuery({ queryKey: accountKey(target), queryFn: ({ signal }) => loadAccountClass(target, signal), ...ACCOUNT_QUERY }),
        lookup: (target) =>
          queryClient.fetchQuery({ queryKey: searchKey(target), queryFn: ({ signal }) => searchTokens(target, BROWSER_SOURCES, signal), ...SEARCH_QUERY }),
      }),
    [parsed, queryClient],
  );

  const isLoading = current !== null && !error && !offline && (!data || isStale) && (!settled || query.isFetching);

  return {
    parsed,
    actions,
    account,
    accountPending,
    hits: data?.hits ?? NO_HITS,
    attempts: data?.attempts ?? (error ? error.attempts : NO_ATTEMPTS),
    isLoading,
    isStale,
    offline,
    error,
    fetchedAt: data?.fetchedAt,
    resolving: isLoading || accountPending,
    retry,
    resolve,
  };
}
