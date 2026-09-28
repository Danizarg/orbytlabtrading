import { describe, expect, it, vi } from 'vitest';
import type { WalletActivityProvider } from '@/lib/core/providers';
import type { Sourced, WalletActivity, WalletActivityPage } from '@/lib/core/types';
import { CACHE } from '@/lib/server/respond';
import {
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_MAX_LIMIT_HELIUS,
  ACTIVITY_MAX_LIMIT_STANDARD,
  activityCachePolicy,
  activityLimitBounds,
  loadActivity,
  loadTransaction,
  transactionCachePolicy,
} from './activity';
import { ROUTE_CACHE } from './envelope';
import { NotConfiguredError } from './errors';

const WALLET = '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A';
const SIG = '5vkeqCReatk7bXc41f2WXfJGLacAo8ZkcJNqQfCNr1jQAovwJ6P8cuqg4TW6Hi3My4nszgpcBC4TkdmP8CAsSchk';

function page(notes?: string[]): Sourced<WalletActivityPage> {
  return { data: { items: [], scanned: 15 }, source: 'solana-rpc', fetchedAt: 1, freshness: 'realtime', ...(notes ? { notes } : {}) };
}

function tx(data: WalletActivity | null, notes?: string[]): Sourced<WalletActivity | null> {
  return { data, source: 'solana-rpc', fetchedAt: 1, freshness: 'realtime', ...(notes ? { notes } : {}) };
}

const ACTIVITY: WalletActivity = {
  signature: SIG,
  timestamp: 1_759_000_000_000,
  wallet: WALLET,
  kind: 'buy',
  legs: [],
  success: true,
  source: 'solana-rpc',
};

describe('activity limits', () => {
  it('allows larger pages only on the Helius indexed history', () => {
    expect(activityLimitBounds(false)).toEqual({ fallback: ACTIVITY_DEFAULT_LIMIT, max: ACTIVITY_MAX_LIMIT_STANDARD });
    expect(activityLimitBounds(true)).toEqual({ fallback: ACTIVITY_DEFAULT_LIMIT, max: ACTIVITY_MAX_LIMIT_HELIUS });
    expect(ACTIVITY_DEFAULT_LIMIT).toBe(15);
    expect(ACTIVITY_MAX_LIMIT_STANDARD).toBe(25);
    expect(ACTIVITY_MAX_LIMIT_HELIUS).toBe(100);
  });
});

describe('activityCachePolicy', () => {
  it('caches the newest page briefly and complete older pages long', () => {
    expect(activityCachePolicy(undefined, page())).toBe(ROUTE_CACHE.activityFirstPage);
    expect(activityCachePolicy(SIG, page())).toBe(ROUTE_CACHE.activityOlderPage);
    expect(ROUTE_CACHE.activityFirstPage.sMaxAge).toBe(5);
    expect(ROUTE_CACHE.activityOlderPage.sMaxAge).toBe(300);
  });

  it('keeps an older page with caveats short-lived (it may still change)', () => {
    expect(activityCachePolicy(SIG, page(['1 transaction(s) were not yet available from the RPC node.']))).toBe(ROUTE_CACHE.activityFirstPage);
  });
});

describe('transactionCachePolicy', () => {
  it('caches parsed transactions for an hour', () => {
    expect(transactionCachePolicy(tx(ACTIVITY))).toBe(ROUTE_CACHE.transaction);
    expect(ROUTE_CACHE.transaction.sMaxAge).toBe(3_600);
  });

  it('caches a final "no balance change" answer but never a not-yet-available one', () => {
    expect(transactionCachePolicy(tx(null))).toBe(ROUTE_CACHE.transaction);
    expect(transactionCachePolicy(tx(null, ['Transaction not found at confirmed commitment.']))).toBe(CACHE.none);
  });
});

describe('loadActivity / loadTransaction', () => {
  it('passes cursor and limit to the provider', async () => {
    const getActivity = vi.fn(async () => page());
    const provider: WalletActivityProvider = { id: 'solana-rpc', getActivity };
    await loadActivity(WALLET, { before: SIG, limit: 20 }, { activity: provider, heliusHistory: false });
    expect(getActivity).toHaveBeenCalledWith(WALLET, { before: SIG, limit: 20 });
  });

  it('parses one transaction for a wallet', async () => {
    const getTransaction = vi.fn(async () => tx(ACTIVITY));
    const provider: WalletActivityProvider = { id: 'helius', getActivity: async () => page(), getTransaction };
    const result = await loadTransaction(SIG, WALLET, { activity: provider, heliusHistory: true });
    expect(getTransaction).toHaveBeenCalledWith(SIG, WALLET);
    expect(result.data).toEqual(ACTIVITY);
  });

  it('is not configured when the provider cannot parse single transactions', () => {
    const provider: WalletActivityProvider = { id: 'solana-rpc', getActivity: async () => page() };
    expect(() => loadTransaction(SIG, WALLET, { activity: provider, heliusHistory: false })).toThrow(NotConfiguredError);
  });
});
