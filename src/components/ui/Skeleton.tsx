import { cn } from './cn';

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn('block animate-pulse rounded bg-panel-3', className)} />;
}
