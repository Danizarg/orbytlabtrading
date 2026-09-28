import type { CSSProperties, ReactNode } from 'react';
import { DepositButton } from './DepositDialog';
import { GlobalSearch, MobileSearch } from './GlobalSearch';
import { Logo } from './Logo';
import { NavLinks } from './NavLinks';
import { ShellBoundary, StatusBarBoundary } from './ShellBoundary';
import { SolPriceChip } from './SolPriceChip';
import { StatusBar } from './StatusBar';
import { StreamStatus } from './StreamStatus';

/**
 * Application frame: sticky 48 px header (logo, nav, search, SOL price,
 * connection status, deposit), the page, and a sticky 28 px status bar.
 * Feature pages that need a full-height terminal layout can size against
 * `--shell-header-h` / `--shell-footer-h`, e.g.
 * `h-[calc(100dvh-var(--shell-header-h)-var(--shell-footer-h))]`.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col" style={{ '--shell-header-h': '48px', '--shell-footer-h': '28px' } as CSSProperties}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-panel-3 focus:px-3 focus:py-1.5 focus:text-xs focus:text-fg"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 h-12 shrink-0 border-b border-line bg-panel">
        <div className="flex h-full items-center gap-2 pr-2 pl-3 sm:gap-3 lg:gap-4 lg:px-4">
          <Logo />
          <NavLinks />
          <div className="hidden min-w-0 flex-1 justify-center lg:flex">
            <ShellBoundary label="Search">
              <GlobalSearch />
            </ShellBoundary>
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
            <ShellBoundary label="Search" className="flex lg:hidden">
              <MobileSearch className="flex lg:hidden" />
            </ShellBoundary>
            <ShellBoundary label="SOL price" className="hidden sm:flex">
              <SolPriceChip className="hidden sm:flex" />
            </ShellBoundary>
            <ShellBoundary label="Status">
              <StreamStatus />
            </ShellBoundary>
            <DepositButton />
          </div>
        </div>
      </header>
      <main id="main" className="flex min-h-0 flex-1 flex-col">
        {children}
      </main>
      <StatusBarBoundary>
        <StatusBar />
      </StatusBarBoundary>
    </div>
  );
}
