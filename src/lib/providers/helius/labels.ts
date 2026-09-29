import 'server-only';

/**
 * Liquidity-account labels for holder lists (shared by the keyed adapters).
 *
 * A token account owned by a launchpad curve or an AMM pool holds supply on
 * behalf of traders; it is labelled in the holder table and left out of
 * top-holder concentration, the way Solana Tracker's own `top10` treats it.
 *
 * Every address below is a program id already used elsewhere in ORBYT, or a
 * PDA derived from one with its documented single seed (re-derived in
 * labels.test.ts, so a typo cannot slip in). Nothing is guessed: an owner that
 * matches none of these stays unlabelled.
 */

import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { isSolanaAddress, MINTS, PROGRAMS } from '@/lib/core/solana';
import type { HolderEntry, HolderSnapshot } from '@/lib/core/types';
import { derivePumpCurveAddress } from '@/lib/providers/solana/pump';

export const BONDING_CURVE_LABEL = 'Bonding curve';
export const PUMPSWAP_POOL_LABEL = 'PumpSwap pool';

/**
 * Program ids whose pool / curve ACCOUNTS own the vault token accounts
 * directly, so the owner's own program identifies the venue.
 */
export const AMM_PROGRAM_LABELS: Readonly<Record<string, string>> = {
  [PROGRAMS.PUMP]: BONDING_CURVE_LABEL,
  [PROGRAMS.PUMP_AMM]: PUMPSWAP_POOL_LABEL,
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM pool',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM pool',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca pool',
};

/**
 * Programs whose vaults are owned by ONE program-wide authority PDA (an
 * address without account data), keyed by that authority.
 */
export const AMM_AUTHORITY_LABELS: Readonly<Record<string, string>> = {
  /** PDA(['amm authority'], Raydium AMM v4 675kPX…Mp8). */
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1': 'Raydium pool',
  /** PDA(['vault_and_lp_mint_auth_seed'], Raydium CPMM CPMMoo…KP1C). */
  GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL: 'Raydium CPMM pool',
  /** PDA(['vault_auth_seed'], Raydium LaunchLab LanMV9…J3uj). */
  WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh: BONDING_CURVE_LABEL,
  /** PDA(['pool_authority'], Meteora DAMM v2 cpamdp…1sGG). */
  HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC: 'Meteora DAMM v2 pool',
  /** PDA(['pool_authority'], Meteora DBC dbcij3…MaqN). */
  FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM: BONDING_CURVE_LABEL,
};

/** The mint's pump.fun bonding-curve PDA (seeds ['bonding-curve', mint]); undefined for an invalid mint. */
export async function bondingCurvePdaOf(mint: string): Promise<string | undefined> {
  try {
    return await derivePumpCurveAddress(mint);
  } catch {
    return undefined;
  }
}

const addressEncoder = getAddressEncoder();
/** Canonical PumpSwap pools use index 0 (u16 little-endian). */
const CANONICAL_POOL_INDEX = new Uint8Array([0, 0]);

/**
 * The mint's canonical PumpSwap pool, where pump.fun migrates a completed
 * curve (seeds from the pump IDL `migrate` instruction, the same derivation
 * the holders route verified against live pools):
 * pool_authority = PDA(['pool-authority', mint], pump);
 * pool = PDA(['pool', u16le(0), pool_authority, mint, WSOL], pump AMM).
 * The pool account owns its vaults, so it is the owner a holder list shows.
 */
export async function pumpSwapPoolPdaOf(mint: string): Promise<string | undefined> {
  if (!isSolanaAddress(mint)) return undefined;
  try {
    const [poolAuthority] = await getProgramDerivedAddress({
      programAddress: address(PROGRAMS.PUMP),
      seeds: ['pool-authority', addressEncoder.encode(address(mint))],
    });
    const [pool] = await getProgramDerivedAddress({
      programAddress: address(PROGRAMS.PUMP_AMM),
      seeds: ['pool', CANONICAL_POOL_INDEX, addressEncoder.encode(poolAuthority), addressEncoder.encode(address(mint)), addressEncoder.encode(address(MINTS.SOL))],
    });
    return pool;
  } catch {
    return undefined;
  }
}

/** Launchpad accounts that can hold a pump.fun coin's supply (both undefined for an invalid mint). */
export interface LaunchpadPdas {
  curve?: string;
  pumpSwapPool?: string;
}

export async function launchpadPdasOf(mint: string): Promise<LaunchpadPdas> {
  const [curve, pumpSwapPool] = await Promise.all([bondingCurvePdaOf(mint), pumpSwapPoolPdaOf(mint)]);
  const pdas: LaunchpadPdas = {};
  if (curve) pdas.curve = curve;
  if (pumpSwapPool) pdas.pumpSwapPool = pumpSwapPool;
  return pdas;
}

/**
 * Label for an owner known without any network call: the mint's pump.fun
 * bonding-curve PDA, its canonical PumpSwap pool, or a program-wide vault
 * authority.
 */
export function staticLiquidityLabel(owner: string, curvePda: string | undefined, pumpSwapPool?: string): string | undefined {
  if (curvePda && owner === curvePda) return BONDING_CURVE_LABEL;
  if (pumpSwapPool && owner === pumpSwapPool) return PUMPSWAP_POOL_LABEL;
  return AMM_AUTHORITY_LABELS[owner];
}

type Distribution = NonNullable<HolderSnapshot['distribution']>;

function pctSum(entries: readonly HolderEntry[]): number {
  return entries.reduce((sum, e) => sum + (e.pctOfSupply ?? 0), 0);
}

/**
 * Top-holder concentration from a largest-first list, excluding liquidity
 * accounts. A bucket is reported only when it is exact: every entry in it has
 * a percentage and, unless the list covers every funded account (`complete`),
 * the list holds enough non-liquidity entries to fill it.
 */
export function holderDistribution(
  entries: readonly HolderEntry[],
  isLiquidity: (entry: HolderEntry) => boolean,
  complete: boolean,
): Distribution | undefined {
  const holders = entries.filter((e) => !isLiquidity(e));
  const top10 = holders.slice(0, 10);
  if (!top10.length || top10.some((e) => e.pctOfSupply === undefined)) return undefined;
  if (top10.length < 10 && !complete) return undefined;
  const distribution: Distribution = { top10Pct: pctSum(top10) };
  const next = holders.slice(10, 20);
  if (next.length && next.every((e) => e.pctOfSupply !== undefined) && (next.length === 10 || complete)) {
    distribution.top11to20Pct = pctSum(next);
  }
  return distribution;
}

export const DISTRIBUTION_NOTE = 'Top-holder shares exclude bonding-curve and pool accounts.';
