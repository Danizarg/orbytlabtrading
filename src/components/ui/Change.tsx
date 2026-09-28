import { changeClass, formatPct } from '@/lib/core/format';
import { cn } from './cn';

/** Signed percentage change with market colours. */
export function Change({ value, className }: { value: number | null | undefined; className?: string }) {
  return <span className={cn('tabular', changeClass(value), className)}>{formatPct(value)}</span>;
}
