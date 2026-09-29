import { Skeleton } from '@/components/ui/Skeleton';

const ROWS = 12;

/** Route transition placeholder in the tracker's own geometry: title bar, wallet list and feed table. */
export default function Loading() {
  return (
    <div role="status" aria-busy="true" className="flex h-[calc(100dvh-var(--shell-header-h)-var(--shell-footer-h))] min-h-[32rem] flex-col">
      <span className="sr-only">Loading tracker</span>
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel px-3 lg:px-4">
        <Skeleton className="h-3.5 w-16" />
        <Skeleton className="h-2.5 w-14" />
        <span className="ml-auto">
          <Skeleton className="h-5 w-16" />
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-px bg-line lg:grid-cols-[336px_minmax(0,1fr)] lg:grid-rows-1">
        <div className="flex max-h-72 min-h-0 flex-col bg-panel lg:max-h-none">
          <div className="flex h-9 items-center border-b border-line px-3">
            <Skeleton className="h-3 w-16" />
          </div>
          <div className="flex h-[58px] items-center gap-1.5 border-b border-line px-3">
            <Skeleton className="h-7 flex-1" />
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-7 w-12" />
          </div>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex items-center gap-2 border-b border-line px-3 py-2">
              <Skeleton className="size-1.5 rounded-full" />
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-2.5 w-24" />
                <Skeleton className="h-2 w-40" />
              </div>
            </div>
          ))}
        </div>
        <div className="flex min-h-0 flex-col overflow-hidden bg-panel">
          <div className="flex h-9 items-center gap-2 border-b border-line px-3">
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-6 w-36" />
            <Skeleton className="h-6 w-64" />
          </div>
          <div className="h-7 border-b border-line" />
          {Array.from({ length: ROWS }, (_, i) => (
            <div key={i} className="flex h-8 items-center gap-4 border-b border-line px-2" style={{ opacity: Math.max(0.15, 1 - i * 0.07) }}>
              <Skeleton className="h-2.5 w-10" />
              <Skeleton className="h-2.5 w-20" />
              <Skeleton className="h-5 w-14" />
              <Skeleton className="h-2.5 w-24" />
              <Skeleton className="ml-auto h-2.5 w-16" />
              <Skeleton className="hidden h-2.5 w-14 sm:block" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
