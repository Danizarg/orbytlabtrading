'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useRef } from 'react';

export const tradeHref = (mint: string) => `/trade/${mint}`;

/**
 * Warm the token page on hover intent: the route segment is prefetched once
 * per mint for this view. Row links keep viewport prefetching off (hundreds
 * of rows would otherwise each request the route), so hover is the trigger.
 */
export function usePrefetchTrade(): (mint: string) => void {
  const router = useRouter();
  const done = useRef(new Set<string>());
  return useCallback(
    (mint: string) => {
      if (done.current.has(mint)) return;
      done.current.add(mint);
      try {
        router.prefetch(tradeHref(mint));
      } catch {
        /* prefetch is best effort */
      }
    },
    [router],
  );
}
