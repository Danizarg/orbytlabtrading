import type { NextRequest } from 'next/server';
import { CACHE } from '@/lib/server/respond';
import { discoverDeps } from '@/lib/server/services/deps';
import {
  DISCOVER_DEFAULT_LIMIT,
  DISCOVER_LISTS,
  DISCOVER_MAX_LIMIT,
  DISCOVER_WINDOWS,
  loadDiscover,
} from '@/lib/server/services/discover';
import { handle, sendSourced, withCache } from '@/lib/server/services/envelope';
import { parseEnum, parseLimit } from '@/lib/server/services/params';

export const maxDuration = 20;

/** GET /api/v1/discover?list=&window=&limit= → TokenRow[] from keyed discovery (Jupiter key → CoinGecko key). */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const params = request.nextUrl.searchParams;
    const list = parseEnum(params.get('list'), DISCOVER_LISTS, 'list', 'trending');
    const window = parseEnum(params.get('window'), DISCOVER_WINDOWS, 'window', '24h');
    const limit = parseLimit(params.get('limit'), { fallback: DISCOVER_DEFAULT_LIMIT, max: DISCOVER_MAX_LIMIT });
    const { value, stale } = await withCache(`discover:${list}:${window}:${limit}`, 8_000, 5 * 60_000, () =>
      loadDiscover({ list, window, limit }, discoverDeps()),
    );
    return sendSourced(value, CACHE.discovery, { stale });
  });
}
