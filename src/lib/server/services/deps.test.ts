import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverRpcIsPublic, tradesDeps } from './deps';

const KEYS = ['HELIUS_API_KEY', 'BIRDEYE_API_KEY', 'SOLANATRACKER_API_KEY', 'COINGECKO_API_KEY', 'COINGECKO_API_PLAN', 'JUPITER_API_KEY', 'SOLANA_RPC_URL'];
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const key of KEYS) vi.stubEnv(key, values[key] ?? '');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('serverRpcIsPublic', () => {
  it('follows the URL server calls actually use', () => {
    setEnv({});
    expect(serverRpcIsPublic()).toBe(true);
    setEnv({ HELIUS_API_KEY: 'k' });
    expect(serverRpcIsPublic()).toBe(false);
    setEnv({ SOLANA_RPC_URL: 'https://rpc.example.org' });
    expect(serverRpcIsPublic()).toBe(false);
    setEnv({ SOLANA_RPC_URL: 'https://rpc.example.org', HELIUS_API_KEY: 'k' });
    expect(serverRpcIsPublic()).toBe(false);
  });

  it('is public when SOLANA_RPC_URL names the public endpoint even with a Helius key', () => {
    setEnv({ SOLANA_RPC_URL: PUBLIC_RPC, HELIUS_API_KEY: 'k' });
    expect(serverRpcIsPublic()).toBe(true);
    // No RPC-derived trade feed then: the public RPC cannot sustain one.
    expect(tradesDeps().rpcTrades).toBeNull();
  });
});
