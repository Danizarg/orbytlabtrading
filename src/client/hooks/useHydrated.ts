'use client';

import { useSyncExternalStore } from 'react';

const noop = () => () => {};

/** False during SSR/hydration, true after mount. Guards browser-only state (localStorage). */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}
