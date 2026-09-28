'use client';

import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';

/** Column selections re-evaluate age windows on this step (ms). */
export const PULSE_CLOCK_STEP_MS = 5_000;

function subscribeClock(onChange: () => void): () => void {
  const id = setInterval(onChange, 1_000);
  return () => clearInterval(id);
}
const getClock = () => Math.floor(Date.now() / PULSE_CLOCK_STEP_MS) * PULSE_CLOCK_STEP_MS;
const getServerClock = () => 0;

/**
 * Coarse clock for column selection (3 h / 24 h windows): re-renders every
 * 5 s instead of every second. Returns 0 during SSR and hydration.
 */
export function usePulseClock(): number {
  return useSyncExternalStore(subscribeClock, getClock, getServerClock);
}

/**
 * setInterval that only runs while the tab is visible (hidden tabs stop
 * polling); `onVisible` runs once when the tab becomes visible again.
 */
export function useVisibleInterval(callback: () => void, intervalMs: number, opts: { runOnVisible?: boolean } = {}): void {
  const tick = useEffectEvent(callback);
  const { runOnVisible = false } = opts;
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      timer ??= setInterval(() => tick(), intervalMs);
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
        return;
      }
      if (runOnVisible) tick();
      start();
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, runOnVisible]);
}
