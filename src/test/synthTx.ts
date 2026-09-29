import type { RpcParsedTransaction } from '@/lib/analytics/tx-types';

/**
 * Minimal jsonParsed transactions for tests of the on-chain trade feed and
 * its pool corroboration (tests only; never imported by app code).
 */

/** Real on-curve wallets (they can sign). */
export const WALLET_A = 'DHpRzLRuACd8i1BVGZh8rGQWaQsP7b4spBZFWbzW5WSb';
export const WALLET_B = 'DH7hz5x4KpYqwoWtcyK8qm5VSqjvMCrNJoRVdKFDrZSL';
/** A real off-curve vault authority (Raydium AMM v4). */
export const AUTHORITY = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
export const LAMPORTS = 1_000_000_000;

export interface SynthAccount {
  pubkey: string;
  signer?: boolean;
  pre: number;
  post: number;
}

export interface SynthTokenAccount {
  owner: string;
  mint: string;
  decimals: number;
  pre: bigint;
  post: bigint;
}

/** Wallets / pools with lamports first, then token accounts, then read-only keys (e.g. a pool the tx only lists). */
export function synthTx(signature: string, accounts: SynthAccount[], tokens: SynthTokenAccount[], extraKeys: string[] = [], blockTime = 1_790_628_000): RpcParsedTransaction {
  const keys = [
    ...accounts.map((a) => ({ pubkey: a.pubkey, signer: a.signer ?? false, writable: true })),
    ...tokens.map((_, i) => ({ pubkey: `TokenAcct${String(i).padStart(2, '0')}${'1'.repeat(30)}`, signer: false, writable: true })),
    ...extraKeys.map((pubkey) => ({ pubkey, signer: false, writable: false })),
  ];
  const balance = (t: SynthTokenAccount, which: 'pre' | 'post', i: number) => ({
    accountIndex: accounts.length + i,
    mint: t.mint,
    owner: t.owner,
    uiTokenAmount: { amount: String(t[which]), decimals: t.decimals, uiAmount: null },
  });
  return {
    slot: 1,
    blockTime,
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [...accounts.map((a) => a.pre), ...tokens.map(() => 2_039_280), ...extraKeys.map(() => 1)],
      postBalances: [...accounts.map((a) => a.post), ...tokens.map(() => 2_039_280), ...extraKeys.map(() => 1)],
      preTokenBalances: tokens.map((t, i) => balance(t, 'pre', i)),
      postTokenBalances: tokens.map((t, i) => balance(t, 'post', i)),
      logMessages: [],
      innerInstructions: [],
    },
    transaction: { signatures: [signature], message: { accountKeys: keys, instructions: [] } },
  };
}

/**
 * Wallet A pays 1,000 SOL to wallet B for 1M tokens of `mint`; the
 * transaction lists `pool` read-only. No DEX and no pool involved.
 */
export function p2pMentioningPool(signature: string, pool: string, mint: string, blockTime?: number): RpcParsedTransaction {
  return synthTx(
    signature,
    [
      { pubkey: WALLET_A, signer: true, pre: 2_000 * LAMPORTS, post: 1_000 * LAMPORTS - 5_000 },
      { pubkey: WALLET_B, signer: true, pre: LAMPORTS, post: 1_001 * LAMPORTS },
    ],
    [
      { owner: WALLET_A, mint, decimals: 6, pre: 0n, post: 1_000_000_000_000n },
      { owner: WALLET_B, mint, decimals: 6, pre: 1_000_000_000_000n, post: 0n },
    ],
    [pool],
    blockTime,
  );
}
