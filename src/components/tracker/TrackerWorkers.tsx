'use client';

import { useTrackerWallet } from '@/data/hooks/useTrackerFeed';

/**
 * Headless worker: one per tracked wallet, so each wallet gets its own
 * backfill query, log subscription and reconciliation timer (React hooks
 * cannot be called a variable number of times from one component).
 */
export function TrackerWalletWorker({ wallet, index }: { wallet: string; index: number }) {
  useTrackerWallet(wallet, index);
  return null;
}
