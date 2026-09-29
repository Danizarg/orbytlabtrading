import type { CSSProperties } from 'react';
import { cn } from './cn';

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden className={cn('block animate-pulse rounded bg-panel-3', className)} style={style} />;
}
