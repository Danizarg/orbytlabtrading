'use client';

import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { ATTRIBUTION } from './StatusBar';

/**
 * Keeps one failing header widget from taking the shell down: an error that
 * escaped into the root layout would replace every page with global-error.
 * The fallback is a compact retry control in the widget's slot.
 */
export function ShellBoundary({
  label,
  className,
  children,
}: {
  label: string;
  /** Display utilities for the fallback, matching the widget's own (e.g. "hidden sm:flex"). */
  className?: string;
  children: ReactNode;
}) {
  return (
    <ErrorBoundary
      label={label}
      fallback={(reset) => (
        <button
          type="button"
          onClick={reset}
          title={`${label} failed to render. Retry.`}
          className={cn('h-8 shrink-0 items-center rounded-md px-2 text-2xs font-medium whitespace-nowrap text-warn hover:bg-hover', className ?? 'flex')}
        >
          {label} unavailable
        </button>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

/** The status bar degrades to its static attribution and disclaimer, which must always be shown. */
export function StatusBarBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      label="Status bar"
      fallback={() => (
        <footer className="sticky bottom-0 z-30 flex h-7 shrink-0 items-center gap-4 overflow-x-auto border-t border-line bg-panel px-3 text-2xs whitespace-nowrap text-faint scrollbar-none lg:overflow-hidden lg:px-4">
          <p className="lg:min-w-0 lg:truncate" title={ATTRIBUTION}>
            {ATTRIBUTION}
          </p>
        </footer>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
