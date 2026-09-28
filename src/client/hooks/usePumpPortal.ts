'use client';

import { useCallback, useEffect, useEffectEvent, useSyncExternalStore } from 'react';
import {
  pumpPortal,
  type MigrationEvent,
  type NewTokenEvent,
  type PumpPortalClient,
  type PumpPortalStatus,
} from '@/lib/streams/pumpportal';

/**
 * PumpPortal stream hooks. All components share the tab-wide connection;
 * callbacks may change identity every render (the latest one is always
 * called) without resubscribing. Events arrive at ~42/min, so batch or
 * throttle state updates in the consumer.
 */

export interface PumpPortalHookOptions {
  /** Subscribe only while true (default true). */
  enabled?: boolean;
  /** Injected client (tests); defaults to the tab-wide singleton. */
  client?: PumpPortalClient;
}

export function usePumpPortalNewTokens(onEvent: (event: NewTokenEvent) => void, options: PumpPortalHookOptions = {}): void {
  const { enabled = true, client = pumpPortal } = options;
  const handle = useEffectEvent(onEvent);
  useEffect(() => {
    if (!enabled) return;
    return client.onNewToken((event) => handle(event));
  }, [enabled, client]);
}

export function usePumpPortalMigrations(onEvent: (event: MigrationEvent) => void, options: PumpPortalHookOptions = {}): void {
  const { enabled = true, client = pumpPortal } = options;
  const handle = useEffectEvent(onEvent);
  useEffect(() => {
    if (!enabled) return;
    return client.onMigration((event) => handle(event));
  }, [enabled, client]);
}

const SERVER_STATUS: PumpPortalStatus = {
  status: 'closed',
  attempt: 0,
  consumers: 0,
  subscribed: { newToken: false, migration: false },
};
const getServerStatus = () => SERVER_STATUS;

/** Connection status of the shared PumpPortal stream (re-renders at most ~1/s from traffic). */
export function usePumpPortalStatus(client: PumpPortalClient = pumpPortal): PumpPortalStatus {
  const subscribe = useCallback((onChange: () => void) => client.onStatus(() => onChange()), [client]);
  const getSnapshot = useCallback(() => client.getStatus(), [client]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerStatus);
}
