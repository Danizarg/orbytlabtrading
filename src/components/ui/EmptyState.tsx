import type { ReactNode } from 'react';
import { cn } from './cn';

export function EmptyState({
  title,
  children,
  tone = 'neutral',
  className,
}: {
  title: ReactNode;
  children?: ReactNode;
  tone?: 'neutral' | 'error' | 'warn';
  className?: string;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className={cn('flex flex-col items-center justify-center gap-1 px-4 py-10 text-center', className)}
    >
      <p className={cn('text-sm font-medium', tone === 'error' ? 'text-down' : tone === 'warn' ? 'text-warn' : 'text-fg-dim')}>{title}</p>
      {children && <div className="max-w-md text-xs text-muted">{children}</div>}
    </div>
  );
}
