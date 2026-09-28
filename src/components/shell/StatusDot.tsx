import { cn } from '@/components/ui/cn';
import type { HealthLevel } from './health';

const DOT: Record<HealthLevel, string> = {
  ok: 'bg-up',
  degraded: 'bg-warn',
  offline: 'bg-down',
  idle: 'bg-faint',
};

export const LEVEL_TEXT: Record<HealthLevel, string> = {
  ok: 'text-fg-dim',
  degraded: 'text-warn',
  offline: 'text-down',
  idle: 'text-muted',
};

/** Health indicator dot. Colour is never the only signal: callers pair it with text or a title. */
export function StatusDot({
  level,
  pulse = false,
  size = 'sm',
  className,
}: {
  level: HealthLevel;
  pulse?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn('inline-block shrink-0 rounded-full', size === 'md' ? 'size-2' : 'size-1.5', DOT[level], pulse && level === 'ok' && 'motion-safe:animate-pulse-dot', className)}
    />
  );
}
