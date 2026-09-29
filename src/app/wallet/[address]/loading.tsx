import { Skeleton } from '@/components/ui/Skeleton';

const TILES = 7;
const ROWS = 12;

/** Route transition placeholder in the wallet page's own geometry: header, PnL strip, tabs and table rows. */
export default function Loading() {
  return (
    <div role="status" aria-busy="true" className="flex min-h-0 flex-1 flex-col lg:h-[calc(100dvh-var(--shell-header-h)-var(--shell-footer-h))] lg:flex-none">
      <span className="sr-only">Loading wallet</span>
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel px-3 lg:px-4">
        <Skeleton className="h-3.5 w-16" />
        <Skeleton className="h-3 w-40 md:w-80" />
        <Skeleton className="h-6 w-16" />
        <span className="ml-auto hidden items-center gap-4 lg:flex">
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-5 w-16" />
        </span>
      </div>
      <div className="grid shrink-0 grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-4 xl:grid-cols-7">
        {Array.from({ length: TILES }, (_, i) => (
          <div key={i} className={i === TILES - 1 ? 'col-span-2 flex flex-col gap-1.5 bg-panel px-3 py-2 xl:col-span-1' : 'flex flex-col gap-1.5 bg-panel px-3 py-2'}>
            <Skeleton className="h-2 w-12" />
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-2 w-14" />
          </div>
        ))}
      </div>
      <div className="flex h-7 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <Skeleton className="h-2.5 w-72" />
      </div>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-panel px-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-6 w-20" />
        ))}
      </div>
      <div className="h-[60dvh] min-h-0 overflow-hidden bg-panel lg:h-auto lg:flex-1">
        <div className="h-7 border-b border-line" />
        {Array.from({ length: ROWS }, (_, i) => (
          <div key={i} className="flex h-8 items-center gap-4 border-b border-line px-2" style={{ opacity: Math.max(0.15, 1 - i * 0.07) }}>
            <span className="size-5 shrink-0 overflow-hidden rounded-full">
              <Skeleton className="size-full" />
            </span>
            <Skeleton className="h-2.5 w-28" />
            <Skeleton className="ml-auto h-2.5 w-16" />
            <Skeleton className="h-2.5 w-14" />
            <Skeleton className="hidden h-2.5 w-16 sm:block" />
            <Skeleton className="hidden h-2.5 w-24 md:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
