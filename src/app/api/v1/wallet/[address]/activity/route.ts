import type { NextRequest } from 'next/server';
import { activityCachePolicy, activityLimitBounds, loadActivity } from '@/lib/server/services/activity';
import { activityDeps } from '@/lib/server/services/deps';
import { handle, sendSourced, withCache } from '@/lib/server/services/envelope';
import { parseActivityCursor, parseLimit, requireAddress } from '@/lib/server/services/params';

export const maxDuration = 30;

/** GET /api/v1/wallet/[address]/activity?before=&limit= → WalletActivityPage (newest first). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ address: string }> }) {
  return handle(async () => {
    const address = requireAddress((await params).address, 'address');
    const deps = activityDeps();
    const search = request.nextUrl.searchParams;
    const before = parseActivityCursor(search.get('before'), { allowOpaque: deps.heliusHistory });
    const limit = parseLimit(search.get('limit'), activityLimitBounds(deps.heliusHistory));
    const { value, stale } = await withCache(
      `activity:${address}:${before ?? ''}:${limit}`,
      before ? 60_000 : 3_000,
      2 * 60_000,
      () => loadActivity(address, { before, limit }, deps),
    );
    return sendSourced(value, activityCachePolicy(before, value), { stale });
  });
}
