import { Skeleton } from '@/components/ui/Skeleton';

/** Route transition placeholder in the token page's own geometry: header strip, chart, tabs and sidebar cards. */
export default function Loading() {
  return (
    <div role="status" aria-busy="true" className="flex min-h-0 flex-1 flex-col lg:h-[calc(100dvh-var(--shell-header-h)-var(--shell-footer-h))] lg:overflow-hidden">
      <span className="sr-only">Loading token</span>
      <div className="flex h-14 shrink-0 items-center gap-4 border-b border-line bg-panel px-3">
        <span className="size-8 shrink-0 overflow-hidden rounded-full">
          <Skeleton className="size-full" />
        </span>
        <div className="space-y-1.5">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-2.5 w-40" />
        </div>
        <Skeleton className="ml-2 h-5 w-24" />
        <span className="ml-auto hidden items-center gap-1.5 lg:flex">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-6 w-20" />
          ))}
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-line lg:grid-cols-[minmax(0,1fr)_336px] lg:grid-rows-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-h-[380px] flex-col bg-panel lg:min-h-0">
          <div className="flex h-8 items-center gap-1 border-b border-line px-2">
            {Array.from({ length: 9 }, (_, i) => (
              <Skeleton key={i} className="h-4 w-7" />
            ))}
          </div>
          <div className="flex flex-1 items-end gap-1 px-4 pb-8">
            {Array.from({ length: 28 }, (_, i) => (
              <Skeleton key={i} className="flex-1" style={{ height: `${25 + ((i * 37) % 55)}%` }} />
            ))}
          </div>
        </div>
        <div className="flex min-h-[420px] flex-col bg-panel lg:min-h-0">
          <div className="flex h-8 items-center gap-1 border-b border-line px-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-4 w-14" />
            ))}
          </div>
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="flex h-7 items-center gap-4 border-b border-line/50 px-3" style={{ opacity: Math.max(0.15, 1 - i * 0.09) }}>
              <Skeleton className="h-2.5 w-8" />
              <Skeleton className="h-2.5 w-8" />
              <Skeleton className="h-2.5 w-20" />
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-2.5 w-16" />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-px bg-line lg:col-start-2 lg:row-start-1 lg:row-span-2">
          <div className="space-y-2 bg-panel p-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
          <div className="space-y-2 bg-panel p-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-20 w-full" />
          </div>
          <div className="flex-1 bg-panel" />
        </div>
      </div>
    </div>
  );
}
