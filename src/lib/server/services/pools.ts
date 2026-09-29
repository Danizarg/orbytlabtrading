import 'server-only';
import { ChainError, type ChainAttempt, type ChainResult } from '@/lib/core/chain';
import type { LiquidityProvider, ProviderId } from '@/lib/core/providers';
import type { PoolInfo, Sourced } from '@/lib/core/types';
import { describeError, isAbortError, isProviderError } from '@/lib/net/errors';
import { comparePools } from '@/lib/providers/dexscreener/parse';
import type { CachePolicy } from '@/lib/server/respond';
import { leastFresh } from './envelope';

/**
 * /api/v1/pools?mint=: every pool of a token from DEX Screener token-pairs
 * and GeckoTerminal token pools (keyed CoinGecko when configured), merged by
 * address. Both run in parallel; one failing source never blanks the list.
 * DEX Screener pools keep their own values (including an omitted price for a
 * graduated curve: its price is frozen at migration and is never refilled);
 * GeckoTerminal fills fields DEX Screener lacks and adds pools it does not
 * list. Base-side fields (price, quote, buy/sell counts) are only filled when
 * both sources orient the pool the same way (same base mint): GeckoTerminal
 * sometimes reports the other token as the base, and its base price would be
 * another token's price. Normalized PoolInfo only: no upstream payload (such
 * as GeckoTerminal's embedded token identities) is re-exposed.
 *
 * An empty list is only an answer when every source answered: "no pools"
 * from one source while the other failed is unknown, so it throws and the
 * route serves its last good list (flagged stale) instead of blanking it.
 */

export const POOLS_CACHE: CachePolicy = { sMaxAge: 60, swr: 120 };
/** Per-worker memory TTL (ms), matching the CDN policy. */
export const POOLS_TTL_MS = 60_000;

export interface PoolsDeps {
  dex: LiquidityProvider | null;
  /** Keyed CoinGecko on-chain when configured, else keyless GeckoTerminal. */
  gecko: LiquidityProvider | null;
}

/** Price fields a frozen (graduated) curve must not get back from another source. */
const PRICE_FIELDS: ReadonlySet<string> = new Set(['priceUsd', 'priceNative', 'marketCapUsd', 'fdvUsd']);

/** Fields describing the pool's base side: only comparable between sources that agree on the base token. */
const ORIENTED_FIELDS: ReadonlySet<string> = new Set([...PRICE_FIELDS, 'quoteMint', 'quoteSymbol', 'txns24h']);

/** The PoolInfo fields (adapters may attach extras, e.g. GeckoTerminal's baseToken / quoteToken / launchpad). */
const POOL_FIELDS = [
  'address',
  'dex',
  'dexLabel',
  'baseMint',
  'quoteMint',
  'quoteSymbol',
  'priceUsd',
  'priceNative',
  'liquidityUsd',
  'volume24hUsd',
  'marketCapUsd',
  'fdvUsd',
  'createdAt',
  'txns24h',
  'isBondingCurve',
  'url',
  'source',
] as const satisfies ReadonlyArray<keyof PoolInfo>;
const POOL_FIELD_SET: ReadonlySet<string> = new Set(POOL_FIELDS);

/** Only the PoolInfo fields of a pool (adapter extras are dropped). */
export function pickPoolInfo(pool: PoolInfo): PoolInfo {
  const out: Record<string, unknown> = {};
  for (const key of POOL_FIELDS) if (pool[key] !== undefined) out[key] = pool[key];
  return out as unknown as PoolInfo;
}

/** DEX Screener omits the price of a curve pair it has seen migrate. */
function isFrozenDexCurve(pool: PoolInfo): boolean {
  return pool.source === 'dexscreener' && pool.isBondingCurve === true && pool.priceUsd === undefined;
}

/**
 * Fill undefined PoolInfo fields of `primary` from `extra`: never overwriting,
 * never un-freezing a curve, and never taking base-side fields from a source
 * that orients the pool the other way round.
 */
export function fillPool(primary: PoolInfo, extra: PoolInfo): { pool: PoolInfo; changed: boolean } {
  const frozen = isFrozenDexCurve(primary);
  const sameOrientation = extra.baseMint === primary.baseMint;
  const out: Record<string, unknown> = { ...pickPoolInfo(primary) };
  let changed = false;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || out[key] !== undefined) continue;
    if (key === 'source' || !POOL_FIELD_SET.has(key)) continue;
    if (frozen && PRICE_FIELDS.has(key)) continue;
    if (!sameOrientation && ORIENTED_FIELDS.has(key)) continue;
    out[key] = value;
    changed = true;
  }
  return { pool: out as unknown as PoolInfo, changed };
}

/** Merge pool lists by address: `primary` wins, `secondary` fills gaps and adds missing pools. */
export function mergePools(primary: readonly PoolInfo[], secondary: readonly PoolInfo[]): { pools: PoolInfo[]; secondaryUsed: boolean } {
  const byAddress = new Map<string, PoolInfo>();
  for (const pool of primary) if (!byAddress.has(pool.address)) byAddress.set(pool.address, pickPoolInfo(pool));
  let secondaryUsed = false;
  for (const pool of secondary) {
    const existing = byAddress.get(pool.address);
    if (!existing) {
      byAddress.set(pool.address, pickPoolInfo(pool));
      secondaryUsed = true;
      continue;
    }
    const filled = fillPool(existing, pool);
    if (filled.changed) {
      byAddress.set(pool.address, filled.pool);
      secondaryUsed = true;
    }
  }
  // Most liquid first, bonding curves last (the client re-ranks for its primary pool).
  return { pools: [...byAddress.values()].sort(comparePools), secondaryUsed };
}

function failedAttempt(provider: ProviderId, error: unknown): ChainAttempt {
  return { provider, ok: false, error: describeError(error), code: isProviderError(error) ? error.code : undefined };
}

export async function loadPools(mint: string, deps: PoolsDeps): Promise<ChainResult<PoolInfo[]>> {
  const providers = [deps.dex, deps.gecko].filter((p): p is LiquidityProvider => p !== null);
  const settled = await Promise.allSettled(providers.map((p) => p.getPools(mint)));
  const attempts: ChainAttempt[] = [];
  const answers: Array<{ provider: LiquidityProvider; result: Sourced<PoolInfo[]> }> = [];
  settled.forEach((outcome, i) => {
    const provider = providers[i];
    if (!provider) return;
    if (outcome.status === 'fulfilled') {
      attempts.push({ provider: provider.id, ok: true });
      answers.push({ provider, result: outcome.value });
    } else {
      if (isAbortError(outcome.reason)) throw outcome.reason;
      attempts.push(failedAttempt(provider.id, outcome.reason));
    }
  });
  const [first, second] = answers;
  if (!first) throw new ChainError('pools', attempts);

  // The first source that lists any pool leads; an empty answer never hides the other source's pools.
  const lead = !first.result.data.length && second?.result.data.length ? second : first;
  const other = lead === first ? second : first;
  const merged = other ? mergePools(lead.result.data, other.result.data) : { pools: lead.result.data.map(pickPoolInfo), secondaryUsed: false };
  // "No pools" is only an answer when no source failed (a 404 is an answer); otherwise it is unknown.
  if (!merged.pools.length && attempts.some((a) => !a.ok && a.code !== 'not_found')) throw new ChainError('pools', attempts);
  const parts = merged.secondaryUsed && other ? [lead.result, other.result] : [lead.result];
  const notes = [...new Set(parts.flatMap((r) => r.notes ?? []))];
  const contributors = merged.secondaryUsed && other && other.result.source !== lead.result.source ? [other.result.source] : [];
  return {
    data: merged.pools,
    source: lead.result.source,
    ...(contributors.length ? { contributors } : {}),
    fetchedAt: Math.min(...parts.map((r) => r.fetchedAt)),
    freshness: leastFresh(parts.map((r) => r.freshness)) ?? lead.result.freshness,
    ...(notes.length ? { notes } : {}),
    attempts,
  };
}
