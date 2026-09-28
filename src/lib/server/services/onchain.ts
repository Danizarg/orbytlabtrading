import 'server-only';
import type { BondingCurveProvider } from '@/lib/core/providers';
import type { BondingCurveState, MintInfo, Sourced } from '@/lib/core/types';

/**
 * /api/v1/onchain/*: exact reads decoded from chain state through the server
 * RPC (works on the public mainnet RPC: getMultipleAccounts / getAccountInfo).
 */

export const CURVES_MAX_MINTS = 100;

export interface CurvesDeps {
  curves: BondingCurveProvider;
}

export function loadCurves(mints: string[], deps: CurvesDeps): Promise<Sourced<Record<string, BondingCurveState>>> {
  return deps.curves.getCurves(mints);
}

export interface MintDeps {
  /**
   * Mint account reader (memory-cached); rejects with ProviderError
   * 'not_found' for non-mint addresses. `stale` is set when the RPC failed
   * and an older cached value is served instead.
   */
  getMintInfo: (mint: string) => Promise<{ value: MintInfo; stale: boolean }>;
  provider: Sourced<unknown>['source'];
}

export async function loadMintInfo(mint: string, deps: MintDeps): Promise<{ result: Sourced<MintInfo>; stale: boolean }> {
  const { value: info, stale } = await deps.getMintInfo(mint);
  return { result: { data: info, source: deps.provider, fetchedAt: info.fetchedAt, freshness: 'realtime' }, stale };
}
