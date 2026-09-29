import { describe, expect, it } from 'vitest';
import type { MintInfo } from '@/lib/core/types';
import { loadMintInfo } from './onchain';

const MINT = '4ov9rwwS4iBHeTWGCrVaQYW1HzWK51MSfs8csGAApump';

const INFO: MintInfo = {
  mint: MINT,
  decimals: 6,
  supply: 1_000_000_000,
  tokenProgram: 'spl-token',
  mintAuthority: null,
  freezeAuthority: null,
  fetchedAt: 1_759_000_000_000,
};

describe('loadMintInfo', () => {
  it('stamps the chain read time and provider', async () => {
    const { result, stale } = await loadMintInfo(MINT, { provider: 'solana-rpc', getMintInfo: async () => ({ value: INFO, stale: false }) });
    expect(result).toEqual({ data: INFO, source: 'solana-rpc', fetchedAt: INFO.fetchedAt, freshness: 'realtime' });
    expect(stale).toBe(false);
  });

  it('passes through that a cached value is being served after an RPC failure', async () => {
    const { result, stale } = await loadMintInfo(MINT, { provider: 'helius', getMintInfo: async () => ({ value: INFO, stale: true }) });
    expect(stale).toBe(true);
    // The age stays visible: fetchedAt is the original read, not now.
    expect(result.fetchedAt).toBe(INFO.fetchedAt);
  });
});
