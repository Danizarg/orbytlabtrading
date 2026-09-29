import 'server-only';
import type { QuoteRequest, TradingProvider } from '@/lib/core/providers';
import type { Sourced, SwapQuote } from '@/lib/core/types';
import { isAbortError, isProviderError } from '@/lib/net/errors';
import { BadRequestError, NoRouteError, NotConfiguredError } from './errors';

/**
 * /api/v1/quote: read-only Jupiter quote with the deployment's key. ORBYT
 * never builds, signs or sends a transaction; the UI links out to execute.
 */

export interface QuoteDeps {
  jupiter: TradingProvider | null;
}

/**
 * The transport keeps only the status of a rejected quote. Every parameter
 * is validated before the call, so a 4xx rejection means the router cannot
 * quote this pair / amount (no route, not tradable, dust): a final answer,
 * not an outage. Rate limits (429) and server errors stay outages.
 */
export function isNoRouteError(error: unknown): boolean {
  if (!isProviderError(error) || isAbortError(error)) return false;
  if (error.code === 'not_found') return true;
  return error.code === 'http' && (error.status === 400 || error.status === 422);
}

export async function loadQuote(request: QuoteRequest, deps: QuoteDeps): Promise<Sourced<SwapQuote>> {
  // Input problems are 400 whatever the configuration.
  if (request.inputMint === request.outputMint) throw new BadRequestError('inputMint and outputMint must differ');
  if (!deps.jupiter) {
    throw new NotConfiguredError('Server quotes need JUPITER_API_KEY. The browser requests keyless quotes instead.');
  }
  try {
    return await deps.jupiter.getQuote(request);
  } catch (error) {
    if (isNoRouteError(error)) throw new NoRouteError(deps.jupiter.id);
    throw error;
  }
}
