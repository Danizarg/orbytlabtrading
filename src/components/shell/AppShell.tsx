import type { ReactNode } from 'react';
import { DepositButton } from './DepositDialog';
import { Logo } from './Logo';
import { NavLinks } from './NavLinks';

/**
 * Application frame: sticky header, scrollable content, footer disclaimer.
 * (Global search, SOL price and connection status are mounted into the header
 * by the shell feature module.)
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center gap-4 border-b border-line bg-panel/95 px-3 backdrop-blur sm:px-4">
        <Logo />
        <NavLinks />
        <div className="ml-auto flex items-center gap-2">
          <DepositButton />
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-2xs text-faint">
        <span>© {new Date().getFullYear()} Orbyt AI Trading · Independent market terminal · Not affiliated with Axiom, GMGN or data providers</span>
        <span>Market data only · No custody · No trade execution · Not financial advice</span>
      </footer>
    </div>
  );
}
