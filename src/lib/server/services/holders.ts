import 'server-only';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { runChain, type ChainResult } from '@/lib/core/chain';
import type { HolderProvider, ProviderId } from '@/lib/core/providers';
import { isSolanaAddress, MINTS, PROGRAMS } from '@/lib/core/solana';
import type { HolderEntry, HolderSnapshot, Sourced } from '@/lib/core/types';
import { isAbortError } from '@/lib/net/errors';
import { BONDING_CURVE_LABEL, HELIUS_MAX_HOLDERS, PUMPSWAP_POOL_LABEL } from '@/lib/providers/helius';
import { derivePumpCurveAddress } from '@/lib/providers/solana';
import { NotConfiguredError } from './errors';

/**
 * /api/v1/holders: top holder list from the keyed providers (Helius → Birdeye
 * → Solana Tracker; indexers first for lists deeper than Helius can serve),
 * with launchpad accounts labelled from exact PDA derivations, and the
 * CoinGecko holder summary (total holders, distribution) merged in when the
 * list provider lacks it.
 */

export const HOLDERS_DEFAULT_LIMIT = 20;
export const HOLDERS_MAX_LIMIT = 100;

// One label vocabulary with the keyed adapters' own liquidity labelling.
export { BONDING_CURVE_LABEL, PUMPSWAP_POOL_LABEL };

export const HELIUS_DEPTH_NOTE = `The on-chain holder list covers the ${HELIUS_MAX_HOLDERS} largest token accounts.`;

export interface HoldersDeps {
  helius: HolderProvider | null;
  birdeye: HolderProvider | null;
  solanaTracker: HolderProvider | null;
  /** CoinGecko keyed token info: holder count + distribution summary only (no list). */
  coingecko: HolderProvider | null;
  /** Address → label map for a mint (injectable for tests). */
  labels?: (mint: string) => Promise<Record<string, string>>;
}

const addressEncoder = getAddressEncoder();
/** Canonical PumpSwap pools use index 0 (u16 little-endian). */
const CANONICAL_POOL_INDEX = new Uint8Array([0, 0]);

/**
 * Canonical PumpSwap pool of a graduated pump.fun coin:
 * pool_authority = PDA(['pool-authority', mint], pump)
 * pool = PDA(['pool', u16le(0), pool_authority, mint, WSOL], pump AMM)
 * (seeds from the pump IDL `migrate` instruction; verified against live pools).
 */
export async function derivePumpSwapPool(mint: string): Promise<string | undefined> {
  if (!isSolanaAddress(mint)) return undefined;
  try {
    const [poolAuthority] = await getProgramDerivedAddress({
      programAddress: address(PROGRAMS.PUMP),
      seeds: ['pool-authority', addressEncoder.encode(address(mint))],
    });
    const [pool] = await getProgramDerivedAddress({
      programAddress: address(PROGRAMS.PUMP_AMM),
      seeds: [
        'pool',
        CANONICAL_POOL_INDEX,
        addressEncoder.encode(poolAuthority),
        addressEncoder.encode(address(mint)),
        addressEncoder.encode(address(MINTS.SOL)),
      ],
    });
    return pool;
  } catch {
    return undefined;
  }
}

/** Launchpad program accounts that can hold a pump.fun coin's supply, keyed by owner address. */
export async function launchpadHolderLabels(mint: string): Promise<Record<string, string>> {
  const labels: Record<string, string> = {};
  const [curve, pool] = await Promise.all([derivePumpCurveAddress(mint).catch(() => undefined), derivePumpSwapPool(mint)]);
  if (curve) labels[curve] = BONDING_CURVE_LABEL;
  if (pool) labels[pool] = PUMPSWAP_POOL_LABEL;
  return labels;
}

/**
 * Apply known labels to holder entries (owner first, then token account).
 * Provider labels are kept. The label maps hold program-derived owners
 * (curve / pool PDAs), so an owner match also marks the entry as a program
 * account. Returns a new snapshot when anything changed.
 */
export function labelHolders(snapshot: HolderSnapshot, labels: Readonly<Record<string, string>>): HolderSnapshot {
  let changed = false;
  const top = snapshot.top.map((entry): HolderEntry => {
    if (entry.label) return entry;
    const ownerLabel = labels[entry.owner];
    if (ownerLabel) {
      changed = true;
      return { ...entry, label: ownerLabel, isProgramAccount: true };
    }
    const accountLabel = entry.tokenAccount ? labels[entry.tokenAccount] : undefined;
    if (!accountLabel) return entry;
    changed = true;
    return { ...entry, label: accountLabel };
  });
  return changed ? { ...snapshot, top } : snapshot;
}

/**
 * Merge a holder summary (count + distribution) into a snapshot without
 * overwriting it. The distribution is taken whole or not at all, so one
 * object never mixes two providers' methodologies.
 */
export function mergeHolderSummary(
  snapshot: HolderSnapshot,
  summary: HolderSnapshot | undefined,
): { snapshot: HolderSnapshot; used: Array<'totalHolders' | 'distribution'> } {
  if (!summary || summary.mint !== snapshot.mint) return { snapshot, used: [] };
  const patch: Partial<HolderSnapshot> = {};
  const used: Array<'totalHolders' | 'distribution'> = [];
  if (snapshot.totalHolders === undefined && summary.totalHolders !== undefined) {
    patch.totalHolders = summary.totalHolders;
    used.push('totalHolders');
  }
  if (snapshot.distribution === undefined && summary.distribution !== undefined) {
    patch.distribution = summary.distribution;
    used.push('distribution');
  }
  return used.length ? { snapshot: { ...snapshot, ...patch }, used } : { snapshot, used };
}

export function needsHolderSummary(snapshot: HolderSnapshot): boolean {
  return snapshot.totalHolders === undefined || snapshot.distribution === undefined;
}

function summaryNote(used: ReadonlyArray<'totalHolders' | 'distribution'>, provider: ProviderId): string {
  const what = used.length === 2 ? 'Holder count and distribution' : used[0] === 'totalHolders' ? 'Holder count' : 'Holder distribution';
  return `${what} from ${provider === 'coingecko' ? 'CoinGecko' : provider}.`;
}

/**
 * List providers in failover order. Helius (exact, on-chain) leads, but
 * getTokenLargestAccounts never returns more than 20 accounts, so a deeper
 * list is asked from the indexers first and Helius stays the fallback.
 */
export function holderProvidersFor(limit: number, deps: HoldersDeps): HolderProvider[] {
  const indexed = [deps.birdeye, deps.solanaTracker];
  const ordered = limit > HELIUS_MAX_HOLDERS ? [...indexed, deps.helius] : [deps.helius, ...indexed];
  return ordered.filter((p): p is HolderProvider => p !== null);
}

export async function loadHolders(mint: string, limit: number, deps: HoldersDeps): Promise<ChainResult<HolderSnapshot>> {
  const listProviders = holderProvidersFor(limit, deps);
  if (!listProviders.length) {
    throw new NotConfiguredError('Holder lists need HELIUS_API_KEY, BIRDEYE_API_KEY or SOLANATRACKER_API_KEY. The browser shows the public holder summary instead.');
  }
  const labelsFor = deps.labels ?? launchpadHolderLabels;

  // PDA derivations (CPU only) run while the list loads.
  const [chainSettled, labelsSettled] = await Promise.allSettled([
    runChain(
      'holders',
      listProviders.map((p) => ({ id: p.id, run: () => p.getHolders(mint, limit) })),
      { accept: (r) => r.data.top.length > 0 },
    ),
    labelsFor(mint),
  ]);
  if (chainSettled.status === 'rejected') throw chainSettled.reason;
  const result = chainSettled.value;

  let snapshot = result.data;
  if (labelsSettled.status === 'fulfilled') snapshot = labelHolders(snapshot, labelsSettled.value);

  const notes = [...(result.notes ?? [])];
  if (result.source === 'helius' && limit > HELIUS_MAX_HOLDERS) notes.push(HELIUS_DEPTH_NOTE);
  const contributors: ProviderId[] = [...(result.contributors ?? [])];
  // The summary costs an extra (quota-limited) call, so it is requested only when the list lacks it.
  if (deps.coingecko && needsHolderSummary(snapshot)) {
    let summary: Sourced<HolderSnapshot> | undefined;
    try {
      summary = await deps.coingecko.getHolders(mint);
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
    const merged = mergeHolderSummary(snapshot, summary?.data);
    if (summary && merged.used.length) {
      snapshot = merged.snapshot;
      if (summary.source !== result.source && !contributors.includes(summary.source)) contributors.push(summary.source);
      notes.push(summaryNote(merged.used, summary.source));
    }
  }

  return {
    ...result,
    data: snapshot,
    ...(contributors.length ? { contributors } : {}),
    ...(notes.length ? { notes } : {}),
  };
}
