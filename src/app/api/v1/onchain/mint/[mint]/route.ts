import { mintDeps } from '@/lib/server/services/deps';
import { handle, ROUTE_CACHE, sendSourced } from '@/lib/server/services/envelope';
import { loadMintInfo } from '@/lib/server/services/onchain';
import { requireAddress } from '@/lib/server/services/params';

export const maxDuration = 10;

/** GET /api/v1/onchain/mint/[mint] → MintInfo (supply, decimals, authorities) read on-chain. */
export async function GET(_request: Request, { params }: { params: Promise<{ mint: string }> }) {
  return handle(async () => {
    const mint = requireAddress((await params).mint, 'mint');
    const { result, stale } = await loadMintInfo(mint, mintDeps());
    return sendSourced(result, ROUTE_CACHE.mint, { stale });
  });
}
