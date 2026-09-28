import type { NextRequest } from 'next/server';
import { CACHE } from '@/lib/server/respond';
import { tradesDeps } from '@/lib/server/services/deps';
import { handle, sendSourced, withCache } from '@/lib/server/services/envelope';
import { optionalAddress, parseLimit, requireAddress } from '@/lib/server/services/params';
import { loadTrades, TRADES_DEFAULT_LIMIT, TRADES_MAX_LIMIT } from '@/lib/server/services/trades';

export const maxDuration = 20;

/** GET /api/v1/trades?mint=&pool=&limit= → Trade[] from keyed feeds (newest first). */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const params = request.nextUrl.searchParams;
    const mint = requireAddress(params.get('mint'), 'mint');
    const pool = optionalAddress(params.get('pool'), 'pool');
    const limit = parseLimit(params.get('limit'), { fallback: TRADES_DEFAULT_LIMIT, max: TRADES_MAX_LIMIT });
    const { value, stale } = await withCache(`trades:${mint}:${pool ?? ''}:${limit}`, 2_000, 60_000, () =>
      loadTrades({ mint, pool, limit }, tradesDeps()),
    );
    return sendSourced(value, CACHE.trades, { stale });
  });
}
