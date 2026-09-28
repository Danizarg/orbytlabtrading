import 'server-only';
import type { ConfiguredProviders } from '@/lib/config/capabilities';
import { deriveCapabilities } from '@/lib/config/capabilities';

/**
 * Server environment. Secrets are read lazily and never serialised to the
 * client; only `configuredProviders()` (booleans) leaves the server.
 */

const PUBLIC_MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

function read(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export const env = {
  heliusApiKey: () => read('HELIUS_API_KEY'),
  birdeyeApiKey: () => read('BIRDEYE_API_KEY'),
  solanaTrackerApiKey: () => read('SOLANATRACKER_API_KEY'),
  coingeckoApiKey: () => read('COINGECKO_API_KEY'),
  coingeckoPlan: (): 'demo' | 'pro' => (read('COINGECKO_API_PLAN')?.toLowerCase() === 'pro' ? 'pro' : 'demo'),
  jupiterApiKey: () => read('JUPITER_API_KEY'),
  /** Explicit RPC override; takes precedence over the Helius-derived URL. */
  solanaRpcUrl: () => read('SOLANA_RPC_URL'),
};

/** HTTP JSON-RPC endpoint for server-side reads: SOLANA_RPC_URL > Helius > public mainnet. */
export function serverRpcUrl(): string {
  const explicit = env.solanaRpcUrl();
  if (explicit) return explicit;
  const helius = env.heliusApiKey();
  if (helius) return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(helius)}`;
  return PUBLIC_MAINNET_RPC;
}

export function rpcKind(): 'custom' | 'helius' | 'public' {
  if (env.solanaRpcUrl() && env.solanaRpcUrl() !== PUBLIC_MAINNET_RPC) return 'custom';
  if (env.heliusApiKey()) return 'helius';
  return 'public';
}

export function configuredProviders(): ConfiguredProviders {
  const explicitRpc = env.solanaRpcUrl();
  return {
    helius: !!env.heliusApiKey(),
    birdeye: !!env.birdeyeApiKey(),
    solanatracker: !!env.solanaTrackerApiKey(),
    coingecko: env.coingeckoApiKey() ? env.coingeckoPlan() : null,
    jupiter: !!env.jupiterApiKey(),
    customRpc: !!explicitRpc && explicitRpc !== PUBLIC_MAINNET_RPC,
  };
}

export function serverCapabilities() {
  return deriveCapabilities(configuredProviders());
}
