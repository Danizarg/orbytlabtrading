import type { ReactNode } from 'react';
import { cn } from './cn';

export function Panel({
  title,
  icon,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('flex min-h-0 min-w-0 flex-col rounded-lg border border-line bg-panel', className)}>
      {(title || actions) && (
        <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
          <h2 className="flex min-w-0 items-center gap-2 truncate text-xs font-semibold tracking-wide text-fg-dim uppercase">
            {icon}
            {title}
          </h2>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  );
}
