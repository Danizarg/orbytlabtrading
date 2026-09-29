import { Skeleton } from '@/components/ui/Skeleton';

const CARDS = 7;
const COLUMNS = ['New Pairs', 'Final Stretch', 'Migrated'] as const;

/** One ≈ 88 px card placeholder (same footprint as PulseCardSkeleton). */
function CardSkeleton({ fade }: { fade: number }) {
  return (
    <div className="flex flex-col gap-1 border-b border-line px-3 py-2" style={{ opacity: fade }}>
      <div className="flex h-[52px] items-start gap-2">
        <Skeleton className="m-1 size-10 shrink-0 rounded-full" />
        <div className="flex flex-1 flex-col gap-2.5">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-2.5 w-40" />
          <Skeleton className="h-2.5 w-24" />
        </div>
        <div className="flex flex-col items-end gap-2.5">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-2.5 w-12" />
          <Skeleton className="h-2.5 w-20" />
        </div>
      </div>
      <Skeleton className="my-0.5 h-3 w-full" />
    </div>
  );
}

/** Route transition placeholder in Pulse's geometry: toolbar and three edge-to-edge columns (one below 1024 px). */
export default function Loading() {
  return (
    <div role="status" aria-busy="true" className="flex h-[calc(100dvh-var(--shell-header-h)-var(--shell-footer-h))] min-h-[32rem] flex-col">
      <span className="sr-only">Loading Pulse</span>
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <span className="font-display text-sm font-semibold tracking-tight text-fg">Pulse</span>
        <Skeleton className="h-6 w-40 lg:hidden" />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-line lg:grid-cols-3">
        {COLUMNS.map((title, i) => (
          <div key={title} className={i === 0 ? 'flex min-h-0 flex-col bg-panel' : 'hidden min-h-0 flex-col bg-panel lg:flex'}>
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
              <span className="font-display text-[13px] font-semibold tracking-tight text-fg">{title}</span>
              <Skeleton className="h-5 w-16" />
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {Array.from({ length: CARDS }, (_, row) => (
                <CardSkeleton key={row} fade={Math.max(0.2, 1 - row * 0.12)} />
              ))}
            </div>
            <div className="h-7 shrink-0 border-t border-line" />
          </div>
        ))}
      </div>
    </div>
  );
}
