import type { NextRequest } from 'next/server';
import { INTERVALS } from '@/lib/core/types';
import { CACHE } from '@/lib/server/respond';
import {
  CANDLES_DEFAULT_LIMIT,
  CANDLES_MAX_LIMIT,
  candlesAreKeylessOnly,
  candlesCachePolicy,
  KEYLESS_CANDLES_TTL,
  loadCandles,
} from '@/lib/server/services/candles';
import { candlesDeps } from '@/lib/server/services/deps';
import { handle, ROUTE_CACHE, sendSourced, withCache } from '@/lib/server/services/envelope';
import { optionalAddress, parseEnum, parseLimit, parseUnixSeconds, requireAddress } from '@/lib/server/services/params';

// Up to two bounded keyless GeckoTerminal calls (pool lookup + OHLCV) after any keyed providers.
export const maxDuration = 30;

/**
 * GET /api/v1/candles?mint=&pool=&interval=&before=&limit= → CandleSeries.
 * Keyed providers first (Birdeye / Solana Tracker / CoinGecko), then keyless
 * GeckoTerminal OHLCV (1m–1d), so the route answers without any key.
 * Keyless answers are CDN-cached 30 s (latest page) / 600 s (pages with `before`).
 */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const params = request.nextUrl.searchParams;
    const mint = requireAddress(params.get('mint'), 'mint');
    const pool = optionalAddress(params.get('pool'), 'pool');
    const interval = parseEnum(params.get('interval'), INTERVALS, 'interval');
    const before = parseUnixSeconds(params.get('before'), 'before');
    const limit = parseLimit(params.get('limit'), { fallback: CANDLES_DEFAULT_LIMIT, max: CANDLES_MAX_LIMIT });
    const historic = before !== undefined;
    const deps = candlesDeps();
    const keylessOnly = candlesAreKeylessOnly(interval, deps);
    const ttlMs = keylessOnly ? (historic ? KEYLESS_CANDLES_TTL.history : KEYLESS_CANDLES_TTL.latest) : historic ? 5 * 60_000 : 10_000;
    const { value, stale } = await withCache(`candles:${mint}:${pool ?? ''}:${interval}:${before ?? ''}:${limit}`, ttlMs, 10 * 60_000, () =>
      loadCandles({ mint, pool, interval, before, limit }, deps),
    );
    const policy = candlesCachePolicy(value.source, historic, { latest: CACHE.candles, history: ROUTE_CACHE.historicCandles });
    return sendSourced(value, policy, { stale });
  });
}
