/**
 * Aggregate stream health for header / status-bar badges, shaped for
 * `useSyncExternalStore`: `getSnapshot()` returns the same object until one
 * of the streams actually changes (message activity is throttled to ~1/s in
 * the socket layer, so badges re-render at most about once per second).
 */

import { pumpPortal, type PumpPortalClient } from './pumpportal';
import type { SocketState, SocketStatus } from './reconnecting-socket';
import { solanaWs, type SolanaWsClient } from './solana-ws';

/**
 * - `live`: connected and receiving
 * - `connecting` / `reconnecting`: attempting (reconnecting = after a drop)
 * - `offline`: wanted but unavailable (repeated failures, or no WebSocket)
 * - `idle`: nothing on the page uses this stream
 */
export type StreamBadge = 'live' | 'connecting' | 'reconnecting' | 'offline' | 'idle';

/** Consecutive failed attempts after which a retrying stream is shown as offline. */
export const OFFLINE_AFTER_ATTEMPTS = 3;

export interface StreamStatusEntry {
  badge: StreamBadge;
  status: SocketStatus;
  /** When the last frame arrived (ms). */
  lastMessageAt?: number;
  /** When the next reconnect attempt is due (ms). */
  nextRetryAt?: number;
  attempt: number;
  lastError?: string;
  consumers: number;
}

export interface StreamStatusSnapshot {
  pumpPortal: StreamStatusEntry;
  solanaWs: StreamStatusEntry;
}

export function streamBadge(state: Pick<SocketState, 'status' | 'attempt' | 'consumers'>): StreamBadge {
  switch (state.status) {
    case 'open':
      return 'live';
    case 'connecting':
      return 'connecting';
    case 'reconnecting':
      return state.attempt >= OFFLINE_AFTER_ATTEMPTS ? 'offline' : 'reconnecting';
    default:
      return state.consumers > 0 ? 'offline' : 'idle';
  }
}

export function toStreamStatusEntry(state: SocketState): StreamStatusEntry {
  const entry: StreamStatusEntry = {
    badge: streamBadge(state),
    status: state.status,
    attempt: state.attempt,
    consumers: state.consumers,
  };
  if (state.lastMessageAt !== undefined) entry.lastMessageAt = state.lastMessageAt;
  if (state.nextRetryAt !== undefined) entry.nextRetryAt = state.nextRetryAt;
  if (state.lastError !== undefined) entry.lastError = state.lastError;
  return entry;
}

const IDLE_ENTRY: StreamStatusEntry = { badge: 'idle', status: 'closed', attempt: 0, consumers: 0 };

/** Stable snapshot for SSR / hydration (no sockets exist on the server). */
export const SERVER_STREAM_STATUS: StreamStatusSnapshot = { pumpPortal: IDLE_ENTRY, solanaWs: IDLE_ENTRY };

export interface StreamStatusSources {
  pumpPortal: Pick<PumpPortalClient, 'getStatus' | 'onStatus'>;
  solanaWs: Pick<SolanaWsClient, 'getStatus' | 'onStatus'>;
}

export interface StreamStatusStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): StreamStatusSnapshot;
}

export function createStreamStatusStore(sources: StreamStatusSources): StreamStatusStore {
  let cached: StreamStatusSnapshot | null = null;
  let lastPump: SocketState | null = null;
  let lastSolana: SocketState | null = null;
  return {
    subscribe(listener) {
      const offPump = sources.pumpPortal.onStatus(() => listener());
      const offSolana = sources.solanaWs.onStatus(() => listener());
      return () => {
        offPump();
        offSolana();
      };
    },
    getSnapshot() {
      const pump = sources.pumpPortal.getStatus();
      const solana = sources.solanaWs.getStatus();
      if (cached && pump === lastPump && solana === lastSolana) return cached;
      lastPump = pump;
      lastSolana = solana;
      cached = { pumpPortal: toStreamStatusEntry(pump), solanaWs: toStreamStatusEntry(solana) };
      return cached;
    },
  };
}

/** Store over the tab-wide singletons (creating it opens no socket). */
export const streamStatusStore: StreamStatusStore = createStreamStatusStore({ pumpPortal, solanaWs });
