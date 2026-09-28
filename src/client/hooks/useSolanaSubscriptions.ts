'use client';

import { useCallback, useEffect, useEffectEvent, useSyncExternalStore } from 'react';
import { isSolanaAddress } from '@/lib/core/solana';
import {
  solanaWs,
  type AccountEncoding,
  type AccountUpdate,
  type Commitment,
  type LogsNotification,
  type SolanaWsClient,
  type SolanaWsStatus,
} from '@/lib/streams/solana-ws';

/**
 * Solana PubSub hooks over the tab-wide connection. The public WS is
 * best-effort (it drops notifications), so treat updates as refresh hints
 * and keep polling as the source of truth. Invalid or null addresses
 * subscribe to nothing.
 */

export interface SolanaSubscriptionOptions {
  commitment?: Commitment;
  /** Subscribe only while true (default true). */
  enabled?: boolean;
  /** Injected client (tests); defaults to the tab-wide singleton. */
  client?: SolanaWsClient;
}

/** logsSubscribe({ mentions: [address] }); notifications include failed transactions (`err` non-null). */
export function useLogsSubscription(
  address: string | null | undefined,
  onNotification: (notification: LogsNotification) => void,
  options: SolanaSubscriptionOptions = {},
): void {
  const { commitment = 'confirmed', enabled = true, client = solanaWs } = options;
  const handle = useEffectEvent(onNotification);
  useEffect(() => {
    if (!enabled || !address || !isSolanaAddress(address)) return;
    return client.logsSubscribe(address, (notification) => handle(notification), { commitment });
  }, [address, commitment, enabled, client]);
}

export function useAccountSubscription(
  address: string | null | undefined,
  encoding: AccountEncoding,
  onUpdate: (update: AccountUpdate) => void,
  options: SolanaSubscriptionOptions = {},
): void {
  const { commitment = 'confirmed', enabled = true, client = solanaWs } = options;
  const handle = useEffectEvent(onUpdate);
  useEffect(() => {
    if (!enabled || !address || !isSolanaAddress(address)) return;
    return client.accountSubscribe(address, (update) => handle(update), { encoding, commitment });
  }, [address, encoding, commitment, enabled, client]);
}

const SERVER_STATUS: SolanaWsStatus = { status: 'closed', attempt: 0, consumers: 0, subscriptions: 0, confirmed: 0 };
const getServerStatus = () => SERVER_STATUS;

/** Connection status of the shared Solana WS (re-renders at most ~1/s from traffic). */
export function useSolanaWsStatus(client: SolanaWsClient = solanaWs): SolanaWsStatus {
  const subscribe = useCallback((onChange: () => void) => client.onStatus(() => onChange()), [client]);
  const getSnapshot = useCallback(() => client.getStatus(), [client]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerStatus);
}
