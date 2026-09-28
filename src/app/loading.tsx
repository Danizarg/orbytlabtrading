import { Skeleton } from '@/components/ui/Skeleton';

const ROWS = 14;

/** Right-hand numeric columns: [width, responsive visibility wrapper]. */
const COLUMNS: readonly [string, string][] = [
  ['w-14', 'ml-auto'],
  ['w-12', ''],
  ['w-14', 'hidden sm:block'],
  ['w-14', 'hidden md:block'],
  ['w-16', 'hidden lg:block'],
  ['w-12', 'hidden xl:block'],
];

/** Route transition placeholder: a toolbar and table rows in the terminal's own geometry. */
export default function Loading() {
  return (
    <div role="status" aria-busy="true" className="flex min-h-0 flex-1 flex-col">
      <span className="sr-only">Loading</span>
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-3 lg:px-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-6 w-48" />
        <span className="hidden md:block">
          <Skeleton className="h-6 w-28" />
        </span>
        <span className="ml-auto">
          <Skeleton className="h-5 w-16" />
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {Array.from({ length: ROWS }, (_, i) => (
          <div key={i} className="flex h-9 items-center gap-4 border-b border-line/50 px-3 lg:px-4" style={{ opacity: Math.max(0.15, 1 - i * 0.065) }}>
            <span className="size-6 shrink-0 overflow-hidden rounded-full">
              <Skeleton className="size-full" />
            </span>
            <Skeleton className="h-3 w-28" />
            {COLUMNS.map(([width, wrapper], c) => (
              <span key={c} className={wrapper || undefined}>
                <Skeleton className={`h-3 ${width}`} />
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
