import { configuredProviders, rpcKind } from '@/lib/server/env';
import { providerHealth } from '@/lib/server/http';
import { buildMeta, CACHE, ok } from '@/lib/server/respond';
import { handle } from '@/lib/server/services/envelope';
import { buildHealthReport } from '@/lib/server/services/health';

export const dynamic = 'force-dynamic';
export const maxDuration = 5;

/** GET /api/v1/health → HealthReport (configuration booleans + provider health; never secrets). */
export async function GET() {
  return handle(async () => {
    const report = buildHealthReport({ configured: configuredProviders(), rpc: rpcKind(), providers: providerHealth() });
    const now = Date.now();
    return ok(report, buildMeta([{ provider: 'orbyt', ok: true, fetchedAt: now }], { primary: 'orbyt', freshness: 'realtime' }), CACHE.none);
  });
}
