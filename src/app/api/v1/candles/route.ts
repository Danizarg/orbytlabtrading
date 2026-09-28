import type { NextRequest } from 'next/server';
import { INTERVALS } from '@/lib/core/types';
import { CACHE } from '@/lib/server/respond';
import { CANDLES_DEFAULT_LIMIT, CANDLES_MAX_LIMIT, loadCandles } from '@/lib/server/services/candles';
import { candlesDeps } from '@/lib/server/services/deps';
import { handle, ROUTE_CACHE, sendSourced, withCache } from '@/lib/server/services/envelope';
import { optionalAddress, parseEnum, parseLimit, parseUnixSeconds, requireAddress } from '@/lib/server/services/params';

export const maxDuration = 20;

/** GET /api/v1/candles?mint=&pool=&interval=&before=&limit= → CandleSeries from native keyed sources. */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const params = request.nextUrl.searchParams;
    const mint = requireAddress(params.get('mint'), 'mint');
    const pool = optionalAddress(params.get('pool'), 'pool');
    const interval = parseEnum(params.get('interval'), INTERVALS, 'interval');
    const before = parseUnixSeconds(params.get('before'), 'before');
    const limit = parseLimit(params.get('limit'), { fallback: CANDLES_DEFAULT_LIMIT, max: CANDLES_MAX_LIMIT });
    const historic = before !== undefined;
    const { value, stale } = await withCache(
      `candles:${mint}:${pool ?? ''}:${interval}:${before ?? ''}:${limit}`,
      historic ? 5 * 60_000 : 10_000,
      10 * 60_000,
      () => loadCandles({ mint, pool, interval, before, limit }, candlesDeps()),
    );
    return sendSourced(value, historic ? ROUTE_CACHE.historicCandles : CACHE.candles, { stale });
  });
}
