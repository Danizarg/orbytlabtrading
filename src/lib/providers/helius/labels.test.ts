import { address, getProgramDerivedAddress } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { PROGRAMS } from '@/lib/core/solana';
import type { HolderEntry } from '@/lib/core/types';
import {
  AMM_AUTHORITY_LABELS,
  AMM_PROGRAM_LABELS,
  BONDING_CURVE_LABEL,
  holderDistribution,
  PUMPSWAP_POOL_LABEL,
  staticLiquidityLabel,
} from './labels';

const OWNER = 'DHpRzLRuACd8i1BVGZh8rGQWaQsP7b4spBZFWbzW5WSb';

async function pda(program: string, seed: string): Promise<string> {
  const [derived] = await getProgramDerivedAddress({ programAddress: address(program), seeds: [seed] });
  return derived;
}

function entry(owner: string, pctOfSupply?: number): HolderEntry {
  return pctOfSupply === undefined ? { owner, amount: 1 } : { owner, amount: 1, pctOfSupply };
}

describe('liquidity labels', () => {
  it('every static vault authority is the documented PDA of a known AMM program', async () => {
    const derived = {
      [await pda('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'amm authority')]: 'Raydium pool',
      [await pda('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', 'vault_and_lp_mint_auth_seed')]: 'Raydium CPMM pool',
      [await pda('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', 'vault_auth_seed')]: BONDING_CURVE_LABEL,
      [await pda('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', 'pool_authority')]: 'Meteora DAMM v2 pool',
      [await pda('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', 'pool_authority')]: BONDING_CURVE_LABEL,
    };
    expect(AMM_AUTHORITY_LABELS).toEqual(derived);
  });

  it('maps pump.fun and PumpSwap program owners to the labels the holders route uses', () => {
    expect(AMM_PROGRAM_LABELS[PROGRAMS.PUMP]).toBe('Bonding curve');
    expect(AMM_PROGRAM_LABELS[PROGRAMS.PUMP_AMM]).toBe('PumpSwap pool');
    expect(PUMPSWAP_POOL_LABEL).toBe('PumpSwap pool');
  });

  it('labels the curve PDA and known authorities, nothing else', () => {
    expect(staticLiquidityLabel(OWNER, OWNER)).toBe(BONDING_CURVE_LABEL);
    expect(staticLiquidityLabel('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', undefined)).toBe('Raydium pool');
    expect(staticLiquidityLabel(OWNER, undefined)).toBeUndefined();
  });
});

describe('holderDistribution', () => {
  const isPool = (e: HolderEntry) => e.label !== undefined;

  it('excludes liquidity accounts and sums the next ten holders', () => {
    const list: HolderEntry[] = [{ ...entry('curve', 60), label: BONDING_CURVE_LABEL }];
    for (let i = 0; i < 20; i++) list.push(entry(`w${i}`, 1));
    expect(holderDistribution(list, isPool, false)).toEqual({ top10Pct: 10, top11to20Pct: 10 });
  });

  it('omits buckets that an incomplete list cannot fill exactly', () => {
    const list: HolderEntry[] = [{ ...entry('curve', 60), label: BONDING_CURVE_LABEL }];
    for (let i = 0; i < 15; i++) list.push(entry(`w${i}`, 2));
    // 15 holders out of a truncated list: 11–20 would be missing its tail.
    expect(holderDistribution(list, isPool, false)).toEqual({ top10Pct: 20 });
    // The same list is exact when it covers every funded account.
    expect(holderDistribution(list, isPool, true)).toEqual({ top10Pct: 20, top11to20Pct: 10 });
    expect(holderDistribution(list.slice(0, 5), isPool, false)).toBeUndefined();
    expect(holderDistribution(list.slice(0, 5), isPool, true)).toEqual({ top10Pct: 8 });
  });

  it('never sums unknown percentages', () => {
    expect(holderDistribution([entry('a', 5), entry('b')], isPool, true)).toBeUndefined();
    expect(holderDistribution([], isPool, true)).toBeUndefined();
  });
});
