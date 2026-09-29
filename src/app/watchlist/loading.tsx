import { TokenTableSkeleton } from '@/components/discover/TableSkeleton';

/** Route transition placeholder in the watchlist table's exact geometry. */
export default function Loading() {
  return <TokenTableSkeleton title="Watchlist" win="24h" rows={10} />;
}
