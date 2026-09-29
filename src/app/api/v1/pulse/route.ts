import type { NextRequest } from 'next/server';
import { pulseDeps } from '@/lib/server/services/deps';
import { handle, ROUTE_CACHE, sendSourced, withCache } from '@/lib/server/services/envelope';
import { parseEnum } from '@/lib/server/services/params';
import { loadPulse, PULSE_COLUMNS } from '@/lib/server/services/pulse';

export const maxDuration = 15;

/** GET /api/v1/pulse?column=new|final|migrated → PulseToken[] from keyed launchpad lists. */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const column = parseEnum(request.nextUrl.searchParams.get('column'), PULSE_COLUMNS, 'column');
    const { value, stale } = await withCache(`pulse:${column}`, 5_000, 2 * 60_000, () => loadPulse(column, pulseDeps()));
    return sendSourced(value, ROUTE_CACHE.pulse, { stale });
  });
}
