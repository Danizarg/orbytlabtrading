import type { NextRequest } from 'next/server';
import { cachedPools } from '@/lib/server/services/deps';
import { handle, sendSourced } from '@/lib/server/services/envelope';
import { requireAddress } from '@/lib/server/services/params';
import { POOLS_CACHE } from '@/lib/server/services/pools';

export const maxDuration = 20;

/**
 * GET /api/v1/pools?mint= → PoolInfo[] (DEX Screener token-pairs + GeckoTerminal
 * token pools, merged by address; keyless). CDN-cached 60 s so one upstream
 * call serves every visitor of a token.
 */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const mint = requireAddress(request.nextUrl.searchParams.get('mint'), 'mint');
    const { value, stale } = await cachedPools(mint);
    return sendSourced(value, POOLS_CACHE, { stale });
  });
}
