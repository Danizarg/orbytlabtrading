import type { NextRequest } from 'next/server';
import { CACHE } from '@/lib/server/respond';
import { riskDeps } from '@/lib/server/services/deps';
import { handle, sendSourced, withCache } from '@/lib/server/services/envelope';
import { requireAddress } from '@/lib/server/services/params';
import { loadRisk } from '@/lib/server/services/risk';

export const maxDuration = 20;

/** GET /api/v1/risk?mint= → RiskReport merged from the keyed risk providers. */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const mint = requireAddress(request.nextUrl.searchParams.get('mint'), 'mint');
    const { value, stale } = await withCache(`risk:${mint}`, 30_000, 10 * 60_000, () => loadRisk(mint, riskDeps()));
    return sendSourced(value, CACHE.holders, { stale });
  });
}
