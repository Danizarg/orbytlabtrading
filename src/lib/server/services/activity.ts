import 'server-only';
import type { WalletActivityProvider } from '@/lib/core/providers';
import type { Sourced, WalletActivity, WalletActivityPage } from '@/lib/core/types';
import { CACHE, type CachePolicy } from '@/lib/server/respond';
import { NotConfiguredError } from './errors';
import { ROUTE_CACHE } from './envelope';

/**
 * /api/v1/wallet/[address]/activity and /api/v1/tx/[signature]: parsed wallet
 * activity from the server RPC (Helius indexed history when available).
 */

export const ACTIVITY_DEFAULT_LIMIT = 15;
/** Standard RPC path: getSignaturesForAddress + one getTransaction per signature. */
export const ACTIVITY_MAX_LIMIT_STANDARD = 25;
/** Helius getTransactionsForAddress returns full transactions, 100 per page. */
export const ACTIVITY_MAX_LIMIT_HELIUS = 100;

export interface ActivityDeps {
  activity: WalletActivityProvider;
  /** Helius indexed history is active (opaque cursors, larger pages). */
  heliusHistory: boolean;
}

export function activityLimitBounds(heliusHistory: boolean): { fallback: number; max: number } {
  return { fallback: ACTIVITY_DEFAULT_LIMIT, max: heliusHistory ? ACTIVITY_MAX_LIMIT_HELIUS : ACTIVITY_MAX_LIMIT_STANDARD };
}

/**
 * The newest page changes with every new transaction; older pages are
 * immutable once complete. A page with caveats (transactions the node could
 * not return yet, parse failures) may still change, so it is cached briefly.
 */
export function activityCachePolicy(before: string | undefined, result: Sourced<WalletActivityPage>): CachePolicy {
  if (!before) return ROUTE_CACHE.activityFirstPage;
  return result.notes?.length ? ROUTE_CACHE.activityFirstPage : ROUTE_CACHE.activityOlderPage;
}

/**
 * A parsed transaction is immutable. `null` with a note means "not found or
 * no block time yet" (a live subscription can ask before the RPC node has
 * it), which must not be cached; `null` without a note means the wallet's
 * balances did not change in that transaction, which is final.
 */
export function transactionCachePolicy(result: Sourced<WalletActivity | null>): CachePolicy {
  if (result.data === null && result.notes?.length) return CACHE.none;
  return ROUTE_CACHE.transaction;
}

export function loadActivity(address: string, opts: { before?: string; limit: number }, deps: ActivityDeps): Promise<Sourced<WalletActivityPage>> {
  return deps.activity.getActivity(address, { before: opts.before, limit: opts.limit });
}

export function loadTransaction(signature: string, wallet: string, deps: ActivityDeps): Promise<Sourced<WalletActivity | null>> {
  const { activity } = deps;
  if (!activity.getTransaction) throw new NotConfiguredError('Transaction parsing is not available from the configured RPC.');
  return activity.getTransaction(signature, wallet);
}
