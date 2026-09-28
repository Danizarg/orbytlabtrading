'use client';

import { RotateCw } from 'lucide-react';
import Link from 'next/link';
import { useEffect } from 'react';

/**
 * Route-level error boundary (inside the app shell, so header, search and
 * status bar keep working). Server error details stay on the server; only
 * the digest is shown for support.
 */
export default function RouteError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error('[ORBYT] route error', error);
  }, [error]);

  const devMessage = process.env.NODE_ENV !== 'production' && error.message ? error.message : null;

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <section role="alert" aria-labelledby="route-error-title" className="w-full max-w-md rounded-lg border border-line bg-panel">
        <header className="flex h-10 items-center gap-3 border-b border-line px-4">
          <span className="size-1.5 rounded-full bg-down" aria-hidden />
          <h1 id="route-error-title" className="text-xs font-semibold tracking-wide text-fg-dim uppercase">
            View failed to load
          </h1>
        </header>
        <div className="space-y-2 px-4 py-4 text-[13px] text-fg-dim">
          <p>This view failed to render. Navigation, search and the status bar still work.</p>
          {devMessage && <p className="font-mono text-2xs break-words text-down">{devMessage}</p>}
          {error.digest && (
            <p className="text-2xs text-faint">
              Reference <span className="font-mono text-muted">{error.digest}</span>
            </p>
          )}
        </div>
        <div className="flex gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={() => retry()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand px-3 text-xs font-bold text-bg hover:bg-brand-strong"
          >
            <RotateCw className="size-3.5" aria-hidden />
            Retry
          </button>
          <Link href="/discover" className="inline-flex h-8 items-center rounded-md border border-line-strong px-3 text-xs text-fg-dim hover:bg-hover hover:text-fg">
            Go to Discover
          </Link>
        </div>
      </section>
    </div>
  );
}
