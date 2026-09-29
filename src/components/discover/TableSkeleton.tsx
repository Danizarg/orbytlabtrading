import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/components/ui/cn';
import type { DiscoverWindow } from '@/lib/core/providers';
import { DEFAULT_WINDOW } from '@/lib/services/discover';
import { COLUMNS, TABLE_MIN_WIDTH } from './columns';
import { ROW_H, TD, TD_RANK, TD_TOKEN, TH, TH_RANK, TH_TOKEN } from './tableStyles';

/*
 * Server-safe skeletons (no hooks): used by the table while rows load and by
 * the /discover and /watchlist route loading states, so the first paint
 * already has the final geometry.
 */

const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

/** One 32 px placeholder row in the table's exact column geometry. */
export function SkeletonRow() {
  return (
    <tr className={ROW_H} aria-hidden>
      {COLUMNS.map((c) => (
        <td key={c.id} className={c.id === 'rank' ? TD_RANK : c.id === 'token' ? TD_TOKEN : TD}>
          {c.id === 'token' ? (
            <div className="flex items-center gap-1.5">
              {/* TokenAvatar reserves 4 px around the 22 px image for the progress ring. */}
              <span className="flex size-[30px] shrink-0 items-center justify-center">
                <Skeleton className="size-[22px] rounded-full" />
              </span>
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="h-2 w-14" />
              </div>
            </div>
          ) : c.id === 'action' || c.id === 'rank' ? null : (
            <Skeleton className={cn('h-2.5', c.align === 'right' ? 'ml-auto w-3/5' : 'w-3/4')} />
          )}
        </td>
      ))}
    </tr>
  );
}

/** Route-level placeholder: title row, real column headers, skeleton rows and the footer strip. */
export function TokenTableSkeleton({ title, win = DEFAULT_WINDOW, rows = 18 }: { title: string; win?: DiscoverWindow; rows?: number }) {
  return (
    <div role="status" aria-busy="true" className="flex h-[calc(100dvh-var(--shell-header-h)-var(--shell-footer-h))] min-h-[460px] flex-col">
      <span className="sr-only">Loading {title}</span>
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <span className="font-display text-sm font-semibold tracking-tight text-fg">{title}</span>
        <Skeleton className="h-7 w-72 max-w-[40vw]" />
        <Skeleton className="h-6 w-32" />
        <span className="ml-auto">
          <Skeleton className="h-5 w-16" />
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden bg-panel">
        <table className={cn('w-full table-fixed border-separate border-spacing-0 text-xs', TABLE_MIN_WIDTH)}>
          <colgroup>
            {COLUMNS.map((c) => (
              <col key={c.id} className={c.width} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.id} scope="col" className={cn(c.id === 'rank' ? TH_RANK : c.id === 'token' ? TH_TOKEN : TH, ALIGN[c.align])}>
                  {c.label(win)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, i) => (
              <SkeletonRow key={i} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex h-7 shrink-0 items-center border-t border-line bg-panel px-3">
        <Skeleton className="h-2.5 w-56" />
      </div>
    </div>
  );
}
