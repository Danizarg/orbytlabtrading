'use client';

import { useSyncExternalStore } from 'react';

/**
 * One shared ticking clock for relative-time labels ("Updated 3s ago",
 * token ages). A single interval drives every subscriber instead of one
 * timer per row.
 */
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 1_000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const getSnapshot = () => now;
// Server render and hydration use a stable value; the clock starts ticking after mount.
const getServerSnapshot = () => 0;

/** Current time in ms, updated once per second. Returns 0 during SSR. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
