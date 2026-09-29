import 'server-only';
import { runChain, type ChainResult } from '@/lib/core/chain';
import type { LaunchpadProvider } from '@/lib/core/providers';
import type { PulseColumn, PulseToken } from '@/lib/core/types';
import { NotConfiguredError } from './errors';

/**
 * /api/v1/pulse: keyed launchpad lists (Solana Tracker → Birdeye) that
 * backfill the Pulse columns; the browser's PumpPortal stream adds launches
 * and migrations in real time on top.
 */

export const PULSE_COLUMNS: readonly PulseColumn[] = ['new', 'final', 'migrated'];

export interface PulseDeps {
  solanaTracker: LaunchpadProvider | null;
  birdeye: LaunchpadProvider | null;
}

export async function loadPulse(column: PulseColumn, deps: PulseDeps): Promise<ChainResult<PulseToken[]>> {
  const providers = [deps.solanaTracker, deps.birdeye].filter((p): p is LaunchpadProvider => p !== null);
  if (!providers.length) {
    throw new NotConfiguredError('Server launch lists need SOLANATRACKER_API_KEY or BIRDEYE_API_KEY. Pulse uses the public stream and indexers instead.');
  }
  return runChain(
    `pulse ${column}`,
    providers.map((p) => ({ id: p.id, run: () => p.getPulse(column) })),
    // An empty column from one list provider is worth a second opinion.
    { accept: (r) => r.data.length > 0 },
  );
}
