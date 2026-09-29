import type { Sourced, WalletActivity, WalletActivityPage } from '@/lib/core/types';
import type { ProviderId, WalletActivityProvider } from '@/lib/core/providers';
import { isSignature, isSolanaAddress } from '@/lib/core/solana';
import { ProviderError } from '@/lib/net/errors';
import { classifyWalletActivity } from '@/lib/analytics/swaps';
import type { RpcParsedTransaction } from '@/lib/analytics/tx-types';
import { LruCache } from './lru';
import type { RpcClient } from './rpc';
import { collectParsed, pipelineNotes, type PipelineResult } from './tx-pipeline';
import { clampInt } from './units';

/**
 * Wallet activity from RPC.
 *
 * - Helius path (`useHeliusHistory`): getTransactionsForAddress with full
 *   jsonParsed transactions, newest first, succeeded only, ≤100 per page. It
 *   also sees ATA-only activity. The cursor is Helius' opaque paginationToken.
 * - Standard path: getSignaturesForAddress (≤25, default 15) then
 *   getTransaction per signature. Failed transactions are counted in
 *   `scanned` but not fetched. The cursor is the last signature walked.
 *   (getSignaturesForAddress only lists transactions where the wallet itself
 *   is an account key, so ATA-only activity is missed.)
 */

export const DEFAULT_ACTIVITY_LIMIT = 15;
export const MAX_STANDARD_ACTIVITY_LIMIT = 25;
export const DEFAULT_HELIUS_ACTIVITY_LIMIT = 50;
export const MAX_HELIUS_ACTIVITY_LIMIT = 100;

/** Parsed activity by `signature|wallet`. `null` = the wallet's balances did not change in that tx. */
const activityCache = new LruCache<string, WalletActivity | null>(2_000);

/** Drop cached parsed activity (tests / memory pressure). */
export function resetActivityCache(): void {
  activityCache.clear();
}

export function createRpcActivityProvider(opts: { rpc: RpcClient; useHeliusHistory?: boolean; provider?: ProviderId }): WalletActivityProvider {
  const { rpc } = opts;
  const id: ProviderId = opts.provider ?? rpc.provider;
  const useHelius = opts.useHeliusHistory === true;

  const cacheKey = (wallet: string) => (signature: string) => `${signature}|${wallet}`;
  const parser = (wallet: string) => (tx: RpcParsedTransaction) => classifyWalletActivity(tx, wallet, { source: id });

  function assertParsable(result: PipelineResult<WalletActivity>) {
    if (result.fetchError && result.processed === 0) throw result.fetchError;
    if (result.parseFailures > 0 && result.parsed === 0 && result.items.length === 0) {
      throw new ProviderError(id, 'malformed', `${rpc.label}: wallet transactions could not be parsed`);
    }
  }

  function sourced(page: WalletActivityPage, notes: string[]): Sourced<WalletActivityPage> {
    const out: Sourced<WalletActivityPage> = { data: page, source: id, fetchedAt: Date.now(), freshness: 'realtime' };
    if (notes.length > 0) out.notes = notes;
    return out;
  }

  async function standardPage(address: string, before: string | undefined, limit: number | undefined, signal?: AbortSignal) {
    if (before !== undefined && !isSignature(before)) {
      throw new ProviderError(id, 'unsupported', `${rpc.label}: cursor is not a transaction signature`);
    }
    const lim = clampInt(limit, 1, MAX_STANDARD_ACTIVITY_LIMIT, DEFAULT_ACTIVITY_LIMIT);
    const signatures = await rpc.getSignaturesForAddress(address, { limit: lim, before }, signal);
    const entries = signatures.map((s) => ({ signature: s.signature, failed: s.err !== null && s.err !== undefined }));
    const result = await collectParsed<WalletActivity>({
      rpc,
      entries,
      cache: activityCache,
      cacheKey: cacheKey(address),
      parse: parser(address),
      signal,
    });
    assertParsable(result);

    const page: WalletActivityPage = { items: result.items, scanned: result.processed };
    const last = entries[result.processed - 1];
    // Stopped early: resume right after the last walked signature. Full page: more history may exist.
    if (last && (result.processed < entries.length || entries.length === lim)) page.nextCursor = last.signature;
    return sourced(page, pipelineNotes(result, entries.length));
  }

  async function heliusPage(address: string, before: string | undefined, limit: number | undefined, signal?: AbortSignal) {
    const lim = clampInt(limit, 1, MAX_HELIUS_ACTIVITY_LIMIT, DEFAULT_HELIUS_ACTIVITY_LIMIT);
    const history = await rpc.getTransactionsForAddress(
      address,
      { transactionDetails: 'full', sortOrder: 'desc', limit: lim, paginationToken: before, status: 'succeeded' },
      signal,
    );
    const prefetched = new Map<string, RpcParsedTransaction>();
    const entries: Array<{ signature: string; failed: boolean }> = [];
    for (const tx of history.data) {
      const signature = tx.transaction.signatures[0];
      if (typeof signature !== 'string') continue;
      prefetched.set(signature, tx);
      entries.push({ signature, failed: tx.meta?.err !== null && tx.meta?.err !== undefined });
    }
    const result = await collectParsed<WalletActivity>({
      rpc,
      entries,
      cache: activityCache,
      cacheKey: cacheKey(address),
      parse: parser(address),
      prefetched,
      signal,
    });
    assertParsable(result);

    const page: WalletActivityPage = { items: result.items, scanned: history.data.length };
    if (history.paginationToken && history.data.length > 0) page.nextCursor = history.paginationToken;
    return sourced(page, pipelineNotes(result, entries.length));
  }

  async function getActivity(
    address: string,
    query: { before?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<Sourced<WalletActivityPage>> {
    if (!isSolanaAddress(address)) throw new ProviderError(id, 'not_found', `${rpc.label}: invalid wallet address`);
    const before = query.before || undefined;
    // A signature cursor (e.g. handed over from the standard path) pages via signatures even on Helius.
    if (useHelius && !(before && isSignature(before))) return heliusPage(address, before, query.limit, signal);
    return standardPage(address, before, query.limit, signal);
  }

  async function getTransaction(signature: string, wallet: string, signal?: AbortSignal): Promise<Sourced<WalletActivity | null>> {
    if (!isSignature(signature) || !isSolanaAddress(wallet)) {
      throw new ProviderError(id, 'not_found', `${rpc.label}: invalid signature or wallet address`);
    }
    const key = `${signature}|${wallet}`;
    if (activityCache.has(key)) {
      return { data: activityCache.get(key) ?? null, source: id, fetchedAt: Date.now(), freshness: 'realtime' };
    }
    const tx = await rpc.getTransaction(signature, signal);
    const fetchedAt = Date.now();
    if (!tx) return { data: null, source: id, fetchedAt, freshness: 'realtime', notes: ['Transaction not found at confirmed commitment.'] };
    if (typeof tx.blockTime !== 'number' || tx.blockTime <= 0) {
      return { data: null, source: id, fetchedAt, freshness: 'realtime', notes: ['Transaction has no block time yet.'] };
    }
    const activity = classifyWalletActivity(tx, wallet, { source: id });
    activityCache.set(key, activity);
    return { data: activity, source: id, fetchedAt, freshness: 'realtime' };
  }

  return { id, getActivity, getTransaction };
}
