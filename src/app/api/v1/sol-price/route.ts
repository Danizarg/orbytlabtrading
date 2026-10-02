import { loadSolPrice } from '@/data/hooks/useSolPrice';
import { okSourced, upstreamFailure, CACHE } from '@/lib/server/respond';

/**
 * GET /api/v1/sol-price
 * Returns the current SOL/USD price from Jupiter or GeckoTerminal.
 * Cached by Vercel CDN (s-maxage 5, stale-while-revalidate 20).
 */
export async function GET(request: Request) {
  const signal = request.signal;

  try {
    const price = await loadSolPrice(signal);
    return okSourced(price, CACHE.market, []);
  } catch (error) {
    return upstreamFailure(error, []);
  }
}
