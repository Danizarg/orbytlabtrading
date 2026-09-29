import { CACHE } from '@/lib/server/respond';
import { portfolioDeps } from '@/lib/server/services/deps';
import { handle, sendSourced, withCache } from '@/lib/server/services/envelope';
import { requireAddress } from '@/lib/server/services/params';
import { loadPortfolio } from '@/lib/server/services/portfolio';

export const maxDuration = 30;

/** GET /api/v1/wallet/[address]/portfolio → Portfolio (on-chain balances; priced when a keyed price source exists). */
export async function GET(_request: Request, { params }: { params: Promise<{ address: string }> }) {
  return handle(async () => {
    const address = requireAddress((await params).address, 'address');
    const { value, stale } = await withCache(`portfolio:${address}`, 5_000, 2 * 60_000, () => loadPortfolio(address, portfolioDeps()));
    return sendSourced(value, CACHE.market, { stale });
  });
}
