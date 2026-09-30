'use client';

import { LoaderCircle } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useHydrated } from '@/client/hooks/useHydrated';
import { useWalletConnected } from '@/lib/wallet/store';
import { DiscoverLanding } from './DiscoverLanding';
import { DiscoverView } from './DiscoverView';

/**
 * /discover entry point. A first-time visitor sees the landing page; from
 * there they either connect a wallet or skip, which reveals the live token
 * terminal (`DiscoverView`). The choice is remembered so returning visitors —
 * and anyone with a connected wallet — land straight in the terminal.
 */

const ENTERED_KEY = 'orbyt-entered-v1';

function readEntered(): boolean {
  try {
    return window.localStorage.getItem(ENTERED_KEY) === '1';
  } catch {
    return false;
  }
}

export function DiscoverGate() {
  // False during SSR and the hydration render, so the server and first client
  // render agree; localStorage is only read once mounted, below the guard.
  const hydrated = useHydrated();
  const connected = useWalletConnected();
  const [skipped, setSkipped] = useState(false);

  const enter = useCallback(() => {
    try {
      window.localStorage.setItem(ENTERED_KEY, '1');
    } catch {
      /* storage blocked: the terminal still shows for this session */
    }
    setSkipped(true);
  }, []);

  if (!hydrated) {
    return (
      <div className="flex flex-1 items-center justify-center" aria-hidden>
        <LoaderCircle className="size-5 animate-spin text-muted motion-reduce:animate-none" />
      </div>
    );
  }

  if (skipped || connected || readEntered()) return <DiscoverView />;
  return <DiscoverLanding onEnter={enter} />;
}
