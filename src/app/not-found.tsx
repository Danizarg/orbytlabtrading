import Link from 'next/link';
import { NAV_LINKS } from '@/components/shell/nav';

/** Unmatched routes and notFound() calls (rendered inside the app shell). */
export default function NotFound() {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <section aria-labelledby="not-found-title" className="w-full max-w-md rounded-lg border border-line bg-panel">
        <header className="flex h-10 items-center gap-3 border-b border-line px-4">
          <span className="font-mono text-xs font-semibold text-brand">404</span>
          <h1 id="not-found-title" className="text-xs font-semibold tracking-wide text-fg-dim uppercase">
            Not found
          </h1>
        </header>
        <div className="space-y-3 px-4 py-4 text-[13px] text-fg-dim">
          <p>This URL does not match a page, or the address in it is not a valid Solana address.</p>
          <p className="text-xs text-muted">
            To open a token or wallet, paste its address or a DEX Screener, pump.fun or Solscan link into search
            <span className="hidden lg:inline">
              {' '}
              (press{' '}
              <kbd className="rounded border border-line-strong px-1 font-sans text-2xs text-fg-dim">/</kbd>)
            </span>
            .
          </p>
        </div>
        <nav aria-label="Go to" className="flex flex-wrap gap-1.5 border-t border-line px-4 py-3">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium text-fg-dim hover:bg-hover hover:text-fg"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </section>
    </div>
  );
}
