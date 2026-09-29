import type { NextRequest } from 'next/server';
import { CACHE } from '@/lib/server/respond';
import { quoteDeps } from '@/lib/server/services/deps';
import { handle, sendSourced } from '@/lib/server/services/envelope';
import { parseAmountRaw, parseDecimals, parseSlippageBps, requireAddress } from '@/lib/server/services/params';
import { loadQuote } from '@/lib/server/services/quote';

export const maxDuration = 15;

/**
 * GET /api/v1/quote?inputMint=&outputMint=&amountRaw=&inputDecimals=&outputDecimals=&slippageBps=
 * → SwapQuote (read-only preview; ORBYT never signs or sends transactions).
 */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const params = request.nextUrl.searchParams;
    const inputMint = requireAddress(params.get('inputMint'), 'inputMint');
    const outputMint = requireAddress(params.get('outputMint'), 'outputMint');
    const amountRaw = parseAmountRaw(params.get('amountRaw'));
    const inputDecimals = parseDecimals(params.get('inputDecimals'), 'inputDecimals');
    const outputDecimals = parseDecimals(params.get('outputDecimals'), 'outputDecimals');
    const slippageBps = parseSlippageBps(params.get('slippageBps'));
    const quote = await loadQuote(
      { inputMint, outputMint, amountRaw, inputDecimals, outputDecimals, ...(slippageBps !== undefined ? { slippageBps } : {}) },
      quoteDeps(),
    );
    return sendSourced(quote, CACHE.live);
  });
}
