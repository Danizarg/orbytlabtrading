'use client';

import { useEffect, type CSSProperties } from 'react';
import './globals.css';

const FONT_FALLBACKS = {
  '--font-dm-sans': 'ui-sans-serif',
  '--font-space-grotesk': 'ui-sans-serif',
  '--font-jetbrains-mono': 'ui-monospace',
} as CSSProperties;

/**
 * Last-resort boundary for errors in the root layout. It replaces the whole
 * document, so it renders its own <html>/<body> and imports the global styles
 * (the layout's web fonts are not available here; system fallbacks apply).
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error('[ORBYT] application error', error);
  }, [error]);

  return (
    // The layout's next/font variables are absent here; without values the theme's font stacks
    // (`var(--font-dm-sans), …`) would be invalid and fall back to the browser serif.
    <html lang="en" style={FONT_FALLBACKS}>
      <body className="min-h-dvh bg-bg text-fg">
        <title>ORBYT · Error</title>
        <main className="flex min-h-dvh items-center justify-center px-4">
          <section role="alert" aria-labelledby="global-error-title" className="w-full max-w-md rounded-lg border border-line bg-panel">
            <header className="flex h-10 items-center gap-3 border-b border-line px-4">
              <span className="font-display text-sm font-bold tracking-tight text-fg">ORBYT</span>
              <h1 id="global-error-title" className="text-xs font-semibold tracking-wide text-fg-dim uppercase">
                Application error
              </h1>
            </header>
            <div className="space-y-2 px-4 py-4 text-[13px] text-fg-dim">
              <p>The terminal failed to start. Retry, or reopen Discover.</p>
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
                className="inline-flex h-8 items-center rounded-md bg-brand px-3 text-xs font-bold text-bg hover:bg-brand-strong"
              >
                Retry
              </button>
              {/* A full document load: the client router may be what failed. */}
              <a href="/discover" className="inline-flex h-8 items-center rounded-md border border-line-strong px-3 text-xs text-fg-dim hover:bg-hover hover:text-fg">
                Go to Discover
              </a>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
