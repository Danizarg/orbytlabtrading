import type { RpcParsedTransaction } from '@/lib/analytics/tx-types';
import type { ProviderError } from '@/lib/net/errors';
import type { LruCache } from './lru';
import type { RpcClient, TxFetchResult } from './rpc';

/**
 * Shared "signatures → parsed items" pipeline for the trade feed and wallet
 * activity.
 *
 * - Failed transactions (err !== null) are counted but never fetched.
 * - Parsed results are cached by key (transactions are immutable), including
 *   negative results (`null` = nothing relevant in this tx).
 * - The walk is newest-first and stops at the first transaction that could
 *   not be fetched (e.g. the public RPC's 10 getTransaction / 10 s limit), so
 *   the returned window is always contiguous and a cursor taken from it never
 *   skips unseen history.
 * - Transactions without a block time are skipped (and counted), since every
 *   normalized item needs a timestamp.
 */

export interface PipelineEntry {
  signature: string;
  /** Upstream reported the transaction as failed. */
  failed: boolean;
}

export interface PipelineResult<T> {
  items: T[];
  /** Entries walked before stopping (failed ones included). */
  processed: number;
  /** Set when the walk stopped early because a transaction could not be fetched. */
  fetchError?: ProviderError;
  /** Transactions the parser threw on (skipped, not cached). */
  parseFailures: number;
  /** Transactions without a block time (skipped). */
  untimed: number;
  /** Signatures the node returned no transaction for (skipped). */
  missing: number;
  /** Transactions actually parsed in this call (not served from cache). */
  parsed: number;
}

export async function collectParsed<T>(opts: {
  rpc: RpcClient;
  entries: PipelineEntry[];
  cache: LruCache<string, T | null>;
  cacheKey: (signature: string) => string;
  parse: (tx: RpcParsedTransaction) => T | null;
  /** Transactions already in hand (e.g. from getTransactionsForAddress). */
  prefetched?: ReadonlyMap<string, RpcParsedTransaction>;
  signal?: AbortSignal;
}): Promise<PipelineResult<T>> {
  const { rpc, entries, cache, cacheKey, parse, prefetched } = opts;

  const toFetch = entries
    .filter((e) => !e.failed && !cache.has(cacheKey(e.signature)) && !prefetched?.has(e.signature))
    .map((e) => e.signature);
  const fetched = new Map<string, TxFetchResult>();
  if (toFetch.length > 0) {
    for (const result of await rpc.getTransactions(toFetch, opts.signal)) fetched.set(result.signature, result);
  }

  const out: PipelineResult<T> = { items: [], processed: 0, parseFailures: 0, untimed: 0, missing: 0, parsed: 0 };
  let stoppedAt = entries.length;
  for (const [index, entry] of entries.entries()) {
    if (entry.failed) {
      out.processed++;
      continue;
    }
    const key = cacheKey(entry.signature);
    if (cache.has(key)) {
      const cached = cache.get(key);
      if (cached) out.items.push(cached);
      out.processed++;
      continue;
    }
    let tx = prefetched?.get(entry.signature);
    if (!tx) {
      const result = fetched.get(entry.signature);
      if (!result || !result.ok) {
        if (result && !result.ok) out.fetchError = result.error;
        stoppedAt = index;
        break;
      }
      if (!result.tx) {
        out.missing++;
        out.processed++;
        continue;
      }
      tx = result.tx;
    }
    out.processed++;
    if (typeof tx.blockTime !== 'number' || !Number.isFinite(tx.blockTime) || tx.blockTime <= 0) {
      out.untimed++;
      continue;
    }
    let value: T | null;
    try {
      value = parse(tx);
    } catch {
      out.parseFailures++;
      continue;
    }
    out.parsed++;
    cache.set(key, value);
    if (value) out.items.push(value);
  }

  // Past the stop point: keep what was fetched anyway in the cache (not in the
  // result, which must stay contiguous) so the next poll spends fewer calls.
  for (const entry of entries.slice(stoppedAt + 1)) {
    const result = fetched.get(entry.signature);
    if (!result?.ok || !result.tx || typeof result.tx.blockTime !== 'number' || result.tx.blockTime <= 0) continue;
    try {
      cache.set(cacheKey(entry.signature), parse(result.tx));
    } catch {
      // Parsed again (and reported) on the next walk.
    }
  }
  return out;
}

/** Human-readable caveats for a partial pipeline result. */
export function pipelineNotes(result: PipelineResult<unknown>, total: number): string[] {
  const notes: string[] = [];
  if (result.fetchError) {
    notes.push(
      `Only the ${result.processed} most recent of ${total} transactions could be loaded (${result.fetchError.code === 'rate_limited' ? 'RPC rate limit' : 'RPC error'}).`,
    );
  }
  if (result.parseFailures > 0) notes.push(`${result.parseFailures} transaction(s) could not be parsed and were skipped.`);
  if (result.untimed > 0) notes.push(`${result.untimed} transaction(s) without a block time were skipped.`);
  if (result.missing > 0) notes.push(`${result.missing} transaction(s) were not yet available from the RPC node.`);
  return notes;
}
