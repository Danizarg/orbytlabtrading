import type { NextRequest } from 'next/server';
import { CACHE } from '@/lib/server/respond';
import { curvesDeps } from '@/lib/server/services/deps';
import { handle, sendSourced, withCache } from '@/lib/server/services/envelope';
import { CURVES_MAX_MINTS, loadCurves } from '@/lib/server/services/onchain';
import { parseAddressList } from '@/lib/server/services/params';

export const maxDuration = 15;

/** GET /api/v1/onchain/curves?mints=a,b (≤100) → Record<mint, BondingCurveState> decoded on-chain. */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const mints = parseAddressList(request.nextUrl.searchParams.get('mints'), 'mints', CURVES_MAX_MINTS);
    const key = `curves:${[...mints].sort().join(',')}`;
    const { value, stale } = await withCache(key, 2_000, 30_000, () => loadCurves(mints, curvesDeps()));
    return sendSourced(value, CACHE.live, { stale });
  });
}
