import 'server-only';
import type { QuoteRequest, TradingProvider } from '@/lib/core/providers';
import type { Sourced, SwapQuote } from '@/lib/core/types';
import { BadRequestError, NotConfiguredError } from './errors';

/**
 * /api/v1/quote: read-only Jupiter quote with the deployment's key. ORBYT
 * never builds, signs or sends a transaction; the UI links out to execute.
 */

export interface QuoteDeps {
  jupiter: TradingProvider | null;
}

export async function loadQuote(request: QuoteRequest, deps: QuoteDeps): Promise<Sourced<SwapQuote>> {
  if (!deps.jupiter) {
    throw new NotConfiguredError('Server quotes need JUPITER_API_KEY. The browser requests keyless quotes instead.');
  }
  if (request.inputMint === request.outputMint) throw new BadRequestError('inputMint and outputMint must differ');
  return deps.jupiter.getQuote(request);
}
