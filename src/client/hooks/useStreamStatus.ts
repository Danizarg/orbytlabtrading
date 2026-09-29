'use client';

import { useSyncExternalStore } from 'react';
import { SERVER_STREAM_STATUS, streamStatusStore, type StreamStatusSnapshot } from '@/lib/streams/status';

const getServerSnapshot = () => SERVER_STREAM_STATUS;

/**
 * Aggregate stream health `{ pumpPortal, solanaWs }` for header / status-bar
 * badges (LIVE / connecting / reconnecting / offline / idle, lastMessageAt).
 * Reading it never opens a socket; streams open when data hooks subscribe.
 */
export function useStreamStatus(): StreamStatusSnapshot {
  return useSyncExternalStore(streamStatusStore.subscribe, streamStatusStore.getSnapshot, getServerSnapshot);
}
