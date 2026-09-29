import 'server-only';

/**
 * Helius adapter (SERVER-ONLY, keyed): top holders via standard RPC and token
 * metadata via DAS.
 *
 * The API key travels in the RPC URL (`?api-key=`), so every request carries
 * `label: 'helius'` and every error leaving this module is a fresh
 * ProviderError whose message never contains the URL or the key (transport
 * causes are dropped: they may embed the request URL).
 *
 * Holders: getTokenLargestAccounts returns the top 20 TOKEN ACCOUNTS (not
 * wallets). Owners are resolved with getMultipleAccounts (jsonParsed) and
 * percentages use getTokenSupply. The largest accounts are usually
 * bonding-curve / pool vaults, so they are labelled — the mint's pump.fun
 * curve PDA and program-wide vault authorities without a call, other
 * off-curve owners by their owning program (one more getMultipleAccounts,
 * zero-length data slice) — and left out of top-holder concentration.
 * Data is read from chain state (Helius standard RPC is uncached) →
 * freshness `realtime`. The total holder count is not available cheaply and
 * is omitted.
 */

import { address, isOffCurveAddress } from '@solana/kit';
import { chunk } from '@/lib/core/chain';
import type { HolderProvider, TokenMetadataProvider } from '@/lib/core/providers';
import { isSolanaAddress } from '@/lib/core/solana';
import type { HolderEntry, HolderSnapshot, Sourced, TokenMeta } from '@/lib/core/types';
import { isAbortError, isProviderError, ProviderError, type ProviderErrorCode } from '@/lib/net/errors';
import type { JsonFetcher } from '@/lib/net/types';
import { AMM_PROGRAM_LABELS, bondingCurvePdaOf, DISTRIBUTION_NOTE, holderDistribution, staticLiquidityLabel } from './labels';
import {
  assetToTokenMeta,
  parseAccountPrograms,
  parseLargestAccounts,
  parseTokenAccountOwners,
  parseTokenSupply,
  rec,
  text,
} from './parse';

export const HELIUS_RPC_URL = 'https://mainnet.helius-rpc.com/';
/** getTokenLargestAccounts never returns more than 20 accounts. */
export const HELIUS_MAX_HOLDERS = 20;
/** DAS getAssetBatch accepts at most 1,000 ids per call. */
export const HELIUS_ASSET_BATCH_LIMIT = 1_000;

const PROVIDER = 'helius' as const;

export interface HeliusOptions {
  apiKey: string;
  fetcher: JsonFetcher;
  /**
   * Static address → label map applied to holder owners (checked first) and
   * token accounts, e.g. known AMM vault authorities → 'Raydium pool'.
   * Entries labelled from this map count as liquidity accounts.
   */
  knownPools?: Record<string, string>;
  /** RPC base URL without the key (defaults to mainnet; e.g. the Gatekeeper beta host). */
  rpcUrl?: string;
}

export interface HeliusAdapter extends HolderProvider, TokenMetadataProvider {
  readonly id: 'helius';
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function redact(message: string, apiKey: string): string {
  let out = message;
  if (apiKey) {
    out = out.split(apiKey).join('***');
    const encoded = encodeURIComponent(apiKey);
    if (encoded !== apiKey) out = out.split(encoded).join('***');
  }
  return out.replace(/api-key=[^&\s"']*/gi, 'api-key=***').slice(0, 160);
}

/**
 * Normalize any transport failure into a key-free ProviderError. The original
 * error is never attached as `cause`: fetch failures can carry the request
 * URL, and this provider's URL contains the key.
 */
function mapTransportError(error: unknown, apiKey: string): unknown {
  if (isAbortError(error)) return error;
  if (isProviderError(error)) {
    if (error.status === 401) {
      return new ProviderError(PROVIDER, 'not_configured', `${PROVIDER}: API key rejected (HTTP 401)`, { status: 401 });
    }
    if (error.status === 403) {
      return new ProviderError(PROVIDER, 'http', `${PROVIDER}: access denied (HTTP 403)`, { status: 403 });
    }
    return new ProviderError(PROVIDER, error.code, redact(error.message, apiKey), { status: error.status, retryAfterMs: error.retryAfterMs });
  }
  return new ProviderError(PROVIDER, 'network', `${PROVIDER}: request failed`);
}

/**
 * JSON-RPC / DAS error → ProviderError code. Known codes first (Helius answers
 * -32401 for a missing key and -32029 for DAS rate limits; gateways may echo
 * HTTP 401/429), then the message for unnumbered errors. Solana's own -32001
 * (block cleaned up) is NOT an auth failure: a not_configured code would make
 * failover chains skip Helius silently.
 */
function rpcErrorCode(code: number | undefined, message: string | undefined, notFoundOnInvalidParams: boolean): ProviderErrorCode {
  switch (code) {
    case 429:
    case -32029:
      return 'rate_limited';
    case 401:
    case -32401:
      return 'not_configured';
    case -32004:
      return 'not_found';
    case -32602:
      // e.g. getTokenLargestAccounts on an address that is not a token mint.
      return notFoundOnInvalidParams ? 'not_found' : 'http';
    default:
      break;
  }
  if (message && /too many requests|rate.?limit/i.test(message)) return 'rate_limited';
  if (message && /api.?key|unauthori[sz]ed/i.test(message)) return 'not_configured';
  return 'http';
}

// ---------------------------------------------------------------------------
// PDA helpers
// ---------------------------------------------------------------------------

/** pump.fun bonding-curve PDA for a mint: seeds ['bonding-curve', mint] under the pump program. */
export function pumpBondingCurvePda(mint: string): Promise<string | undefined> {
  return bondingCurvePdaOf(mint);
}

/** True when the address is off the ed25519 curve, i.e. a PDA controlled by a program. */
export function isProgramDerivedOwner(owner: string): boolean | undefined {
  try {
    return isOffCurveAddress(address(owner));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function createHelius(opts: HeliusOptions): HeliusAdapter {
  const { apiKey, fetcher } = opts;
  const knownPools = opts.knownPools ?? {};
  const base = opts.rpcUrl ?? HELIUS_RPC_URL;
  const url = `${base}${base.includes('?') ? '&' : '?'}api-key=${encodeURIComponent(apiKey)}`;

  async function rpc(method: string, params: unknown, signal?: AbortSignal, notFoundOnInvalidParams = false): Promise<unknown> {
    if (!apiKey) throw new ProviderError(PROVIDER, 'not_configured', `${PROVIDER}: API key missing`);
    let body: unknown;
    try {
      body = await fetcher(PROVIDER, url, {
        method: 'POST',
        body: { jsonrpc: '2.0', id: method, method, params },
        label: PROVIDER,
        retries: 1,
        signal,
      });
    } catch (error) {
      throw mapTransportError(error, apiKey);
    }
    // Some DAS docs show the bare result array; accept it as well as the JSON-RPC envelope.
    if (Array.isArray(body)) return body;
    const envelope = rec(body);
    if (!envelope) throw new ProviderError(PROVIDER, 'malformed', `${PROVIDER}: ${method} returned an unexpected payload`);
    const rpcError = rec(envelope.error);
    if (rpcError) {
      const code = typeof rpcError.code === 'number' ? rpcError.code : undefined;
      const detail = text(rpcError.message);
      const message = `${PROVIDER}: ${method} RPC error${code !== undefined ? ` ${code}` : ''}${detail ? ` (${redact(detail, apiKey)})` : ''}`;
      throw new ProviderError(PROVIDER, rpcErrorCode(code, detail, notFoundOnInvalidParams), message);
    }
    if (!('result' in envelope)) throw new ProviderError(PROVIDER, 'malformed', `${PROVIDER}: ${method} response has no result`);
    return envelope.result;
  }

  /**
   * Owning program of each PDA owner (pool / curve accounts own their vaults).
   * Undefined when the lookup failed, so callers can stay honest about it.
   */
  async function ownerPrograms(owners: string[], signal?: AbortSignal): Promise<Map<string, string> | undefined> {
    if (!owners.length) return new Map();
    try {
      const result = await rpc('getMultipleAccounts', [owners, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }], signal);
      return parseAccountPrograms(result, owners);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return undefined;
    }
  }

  async function getHolders(mint: string, limit = HELIUS_MAX_HOLDERS, signal?: AbortSignal): Promise<Sourced<HolderSnapshot>> {
    if (!isSolanaAddress(mint)) throw new ProviderError(PROVIDER, 'not_found', `${PROVIDER}: invalid mint address`);
    const max = Math.max(1, Math.min(Math.floor(limit) || HELIUS_MAX_HOLDERS, HELIUS_MAX_HOLDERS));
    const config = { commitment: 'confirmed' };

    const [largestResult, supplyResult] = await Promise.allSettled([
      rpc('getTokenLargestAccounts', [mint, config], signal, true),
      rpc('getTokenSupply', [mint, config], signal, true),
    ]);
    if (largestResult.status === 'rejected') throw largestResult.reason;
    const accounts = parseLargestAccounts(largestResult.value);
    if (!accounts) throw new ProviderError(PROVIDER, 'malformed', `${PROVIDER}: getTokenLargestAccounts returned an unexpected payload`);
    const rows = rec(largestResult.value)?.value;
    // Fewer rows than the RPC cap means every funded token account is in the list.
    const complete = Array.isArray(rows) && rows.length < HELIUS_MAX_HOLDERS;

    const notes: string[] = [];
    let supply: number | undefined;
    if (supplyResult.status === 'fulfilled') {
      supply = parseTokenSupply(supplyResult.value);
    } else {
      if (isAbortError(supplyResult.reason)) throw supplyResult.reason;
      notes.push('Token supply unavailable; percentages omitted.');
    }

    let owners = new Map<string, string>();
    if (accounts.length) {
      const keys = accounts.map((a) => a.tokenAccount);
      const parsed = parseTokenAccountOwners(await rpc('getMultipleAccounts', [keys, { encoding: 'jsonParsed', ...config }], signal), keys);
      if (!parsed) throw new ProviderError(PROVIDER, 'malformed', `${PROVIDER}: getMultipleAccounts returned an unexpected payload`);
      owners = parsed;
    }
    const curvePda = accounts.length ? await pumpBondingCurvePda(mint) : undefined;

    const entries: HolderEntry[] = [];
    const liquidity = new Set<HolderEntry>();
    const unlabelledPdas = new Set<string>();
    for (const account of accounts) {
      const owner = owners.get(account.tokenAccount);
      // A token account closed between the two calls has no owner any more: skip it rather than guess.
      if (!owner) continue;
      const entry: HolderEntry = { owner, tokenAccount: account.tokenAccount, amount: account.amount };
      if (supply) entry.pctOfSupply = (account.amount / supply) * 100;
      const label = knownPools[owner] ?? knownPools[account.tokenAccount] ?? staticLiquidityLabel(owner, curvePda);
      if (label) {
        entry.label = label;
        liquidity.add(entry);
      }
      const isProgram = isProgramDerivedOwner(owner);
      if (isProgram !== undefined) entry.isProgramAccount = isProgram;
      if (!label && isProgram) unlabelledPdas.add(owner);
      entries.push(entry);
    }

    // Pool / curve accounts (PumpSwap, Raydium CLMM, Meteora DLMM, Orca, pump.fun) own their vaults.
    const programs = await ownerPrograms([...unlabelledPdas], signal);
    if (programs) {
      for (const entry of entries) {
        const program = entry.label ? undefined : programs.get(entry.owner);
        const label = program ? AMM_PROGRAM_LABELS[program] : undefined;
        if (!label) continue;
        entry.label = label;
        liquidity.add(entry);
      }
    }
    const fetchedAt = Date.now();

    const snapshot: HolderSnapshot = { mint, top: entries.slice(0, max), updatedAt: fetchedAt };
    if (supply) {
      snapshot.supply = supply;
      if (programs) {
        const distribution = holderDistribution(entries, (e) => liquidity.has(e), complete);
        if (distribution) snapshot.distribution = distribution;
        if (distribution && liquidity.size) notes.push(DISTRIBUTION_NOTE);
      } else {
        // Unidentified program owners might be pools: a concentration figure could count liquidity as holdings.
        notes.push('Pool detection unavailable; top-holder shares omitted.');
      }
    }

    const out: Sourced<HolderSnapshot> = { data: snapshot, source: PROVIDER, fetchedAt, freshness: 'realtime' };
    if (notes.length) out.notes = notes;
    return out;
  }

  async function getMetadata(mints: string[], signal?: AbortSignal): Promise<Sourced<Record<string, TokenMeta>>> {
    const ids = [...new Set(mints.filter((m) => isSolanaAddress(m)))];
    const record: Record<string, TokenMeta> = {};
    for (const batch of chunk(ids, HELIUS_ASSET_BATCH_LIMIT)) {
      const result = await rpc('getAssetBatch', { ids: batch, options: { showFungible: true } }, signal);
      if (!Array.isArray(result)) throw new ProviderError(PROVIDER, 'malformed', `${PROVIDER}: getAssetBatch returned an unexpected payload`);
      for (const asset of result) {
        const meta = assetToTokenMeta(asset);
        if (meta) record[meta.mint] = meta;
      }
    }
    // DAS is an indexer: metadata can trail chain state.
    return { data: record, source: PROVIDER, fetchedAt: Date.now(), freshness: 'indexed' };
  }

  return { id: PROVIDER, getHolders, getMetadata };
}
