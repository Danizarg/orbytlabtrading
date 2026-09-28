import type { NextRequest } from 'next/server';
import { loadTransaction, transactionCachePolicy } from '@/lib/server/services/activity';
import { activityDeps } from '@/lib/server/services/deps';
import { handle, sendSourced } from '@/lib/server/services/envelope';
import { requireAddress, requireSignature } from '@/lib/server/services/params';

export const maxDuration = 20;

/** GET /api/v1/tx/[signature]?wallet= → WalletActivity | null (confirmed transactions are immutable). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ signature: string }> }) {
  return handle(async () => {
    const signature = requireSignature((await params).signature, 'signature');
    const wallet = requireAddress(request.nextUrl.searchParams.get('wallet'), 'wallet');
    const result = await loadTransaction(signature, wallet, activityDeps());
    return sendSourced(result, transactionCachePolicy(result));
  });
}
