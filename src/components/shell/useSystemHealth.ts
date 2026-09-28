'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { useNow } from '@/client/hooks/useNow';
import { useStreamStatus } from '@/client/hooks/useStreamStatus';
import { useProviderHealth } from '@/data/hooks/useProviderHealth';
import { browserHealth, subscribeBrowserHealth, type BrowserProviderHealth } from '@/lib/net/browser';
import { isProviderError } from '@/lib/net/errors';
import { buildSystemHealth, type SystemHealth } from './health';

// --- Browser transport health (budgets, cooldowns) --------------------------

const EMPTY: BrowserProviderHealth[] = [];
let snapshot: BrowserProviderHealth[] = EMPTY;
let snapshotKey = '[]';

/** Stable snapshot: a new array only when something actually changed. */
function readBrowserHealth(): BrowserProviderHealth[] {
  const next = browserHealth();
  const key = JSON.stringify(next);
  if (key !== snapshotKey) {
    snapshotKey = key;
    snapshot = next;
  }
  return snapshot;
}

function subscribeBrowser(listener: () => void): () => void {
  const off = subscribeBrowserHealth(listener);
  // Cooldown expiry and some error updates do not emit; re-read periodically.
  const timer = setInterval(listener, 5_000);
  return () => {
    off();
    clearInterval(timer);
  };
}

export function useBrowserHealth(): BrowserProviderHealth[] {
  return useSyncExternalStore(subscribeBrowser, readBrowserHealth, () => EMPTY);
}

// --- navigator.onLine --------------------------------------------------------

function subscribeOnline(listener: () => void): () => void {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

// --- Composition -------------------------------------------------------------

/**
 * Streams (PumpPortal, Solana WS) + keyless browser providers + ORBYT server
 * health, reduced to rows and an overall level. Shared by the header status
 * popover and the status bar (the health request itself is one React Query).
 */
export function useSystemHealth(): SystemHealth {
  const now = useNow();
  const streams = useStreamStatus();
  const browser = useBrowserHealth();
  const online = useOnline();
  const health = useProviderHealth();

  const report = health.data?.data;
  const hasData = health.data !== undefined;
  const updatedAt = hasData ? health.dataUpdatedAt : undefined;
  const failed = health.isError;
  const errorCode = isProviderError(health.error) ? health.error.code : undefined;

  return useMemo(
    () => buildSystemHealth({ now, online, streams, browser, report, api: { hasData, updatedAt, failed, errorCode } }),
    [now, online, streams, browser, report, hasData, updatedAt, failed, errorCode],
  );
}
