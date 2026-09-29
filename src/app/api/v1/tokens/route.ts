import type { NextRequest } from 'next/server';
import { CACHE } from '@/lib/server/respond';
import { tokenRowsDeps } from '@/lib/server/services/deps';
import { KEYLESS_TOKENS_CACHE, KEYLESS_TOKENS_TTL_MS, loadTokenRows, TOKENS_MAX_MINTS } from '@/lib/server/services/discover';
import { handle, sendSourced, withCache } from '@/lib/server/services/envelope';
import { parseAddressList } from '@/lib/server/services/params';

export const maxDuration = 20;

/**
 * GET /api/v1/tokens?mints=a,b (≤100) → TokenRow[] in request order (unknown mints absent).
 * Keyed Jupiter / CoinGecko first, then keyless Jupiter and DEX Screener rows,
 * so the route answers without any key (keyless answers CDN-cached 15 s).
 */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const mints = parseAddressList(request.nextUrl.searchParams.get('mints'), 'mints', TOKENS_MAX_MINTS);
    const deps = tokenRowsDeps();
    const keyed = !!(deps.jupiter ?? deps.coingecko);
    // Order matters for the response, so the key keeps the request order.
    const { value, stale } = await withCache(`tokens:${mints.join(',')}`, keyed ? 5_000 : KEYLESS_TOKENS_TTL_MS, 2 * 60_000, () =>
      loadTokenRows(mints, deps),
    );
    return sendSourced(value, value.keyless ? KEYLESS_TOKENS_CACHE : CACHE.market, { stale });
  });
}
