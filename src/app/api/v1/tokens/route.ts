import type { NextRequest } from 'next/server';
import { CACHE } from '@/lib/server/respond';
import { tokenRowsDeps } from '@/lib/server/services/deps';
import { loadTokenRows, TOKENS_MAX_MINTS } from '@/lib/server/services/discover';
import { handle, sendSourced, withCache } from '@/lib/server/services/envelope';
import { parseAddressList } from '@/lib/server/services/params';

export const maxDuration = 20;

/** GET /api/v1/tokens?mints=a,b (≤100) → TokenRow[] in request order (unknown mints absent). */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const mints = parseAddressList(request.nextUrl.searchParams.get('mints'), 'mints', TOKENS_MAX_MINTS);
    // Order matters for the response, so the key keeps the request order.
    const { value, stale } = await withCache(`tokens:${mints.join(',')}`, 5_000, 2 * 60_000, () => loadTokenRows(mints, tokenRowsDeps()));
    return sendSourced(value, CACHE.market, { stale });
  });
}
