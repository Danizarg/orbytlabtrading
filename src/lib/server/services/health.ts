import 'server-only';
import type { Capabilities, ConfiguredProviders } from '@/lib/config/capabilities';
import { deriveCapabilities } from '@/lib/config/capabilities';
import type { ProviderHealth } from '@/lib/server/http';

/**
 * /api/v1/health: which keyed providers are configured (booleans / plan
 * names only, never secrets), the RPC kind, derived capabilities and this
 * worker's provider health bookkeeping.
 */

export interface HealthReport {
  configured: ConfiguredProviders;
  rpc: 'custom' | 'helius' | 'public';
  capabilities: Capabilities;
  providers: ProviderHealth[];
}

export function buildHealthReport(input: {
  configured: ConfiguredProviders;
  rpc: HealthReport['rpc'];
  providers: ProviderHealth[];
}): HealthReport {
  return {
    configured: input.configured,
    rpc: input.rpc,
    capabilities: deriveCapabilities(input.configured),
    // Stable order for the status popover; health text is already key-free (describeError).
    providers: [...input.providers].sort((a, b) => a.provider.localeCompare(b.provider)),
  };
}
