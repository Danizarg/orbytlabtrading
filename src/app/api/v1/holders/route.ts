import type { NextRequest } from 'next/server';
import { CACHE } from '@/lib/server/respond';
import { holdersDeps } from '@/lib/server/services/deps';
import { handle, sendSourced, withCache } from '@/lib/server/services/envelope';
import { HOLDERS_DEFAULT_LIMIT, HOLDERS_MAX_LIMIT, loadHolders } from '@/lib/server/services/holders';
import { parseLimit, requireAddress } from '@/lib/server/services/params';

export const maxDuration = 20;

/** GET /api/v1/holders?mint=&limit= → HolderSnapshot (top holders, labelled launchpad accounts, summary). */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const params = request.nextUrl.searchParams;
    const mint = requireAddress(params.get('mint'), 'mint');
    const limit = parseLimit(params.get('limit'), { fallback: HOLDERS_DEFAULT_LIMIT, max: HOLDERS_MAX_LIMIT });
    const { value, stale } = await withCache(`holders:${mint}:${limit}`, 30_000, 10 * 60_000, () => loadHolders(mint, limit, holdersDeps()));
    return sendSourced(value, CACHE.holders, { stale });
  });
}
