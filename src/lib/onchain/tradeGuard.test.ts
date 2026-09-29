import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isOffCurveAddress } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { deriveTradeForMint } from '@/lib/analytics/swaps';
import type { RpcParsedTransaction } from '@/lib/analytics/tx-types';
import { MINTS } from '@/lib/core/solana';
import { AUTHORITY, LAMPORTS, p2pMentioningPool, synthTx, WALLET_A, WALLET_B } from '@/test/synthTx';
import { corroborateWithPool } from './tradeGuard';

/**
 * Pool corroboration: a transaction that merely LISTS the pool must never
 * become a trade on it. Real captures must pass; peer-to-peer transfers,
 * padded swaps and inflated quote legs must not.
 */

function fixtureTx(name: string): RpcParsedTransaction {
  const file = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/solana-rpc', name), 'utf8')) as { response: { result: RpcParsedTransaction } };
  return file.response.result;
}

const AMM_TX = fixtureTx('rpc_getTransaction_pumpswap_sell_token2022_v0.json');
const AMM_MINT = '5RJGBaFrTcTrmu5HuukxHxKeqpmRWf346YxQ1kXGetRs';
const AMM_POOL = 'CnJYShWKkDCHeees6Jgi2nx6rekrsu62VqJkDLxpZeNs';
const PUMP_TX = fixtureTx('rpc_getTransaction_pumpfun_bondingcurve_buyV2_v0.json');
const PUMP_MINT = '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump';
const PUMP_CURVE = '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A';

const OTHER_POOL = '3JsCd8LjmmyPT1PhfQZnJeZQwxr5FD6YgzZQDM61Btwc';
const MINT = AMM_MINT;

function check(tx: RpcParsedTransaction, mint: string, pool: string) {
  const derived = deriveTradeForMint(tx, mint, { pool });
  if (!derived) throw new Error('expected a derived trade');
  return corroborateWithPool(tx, derived, mint, pool);
}

describe('corroborateWithPool', () => {
  it('uses on-curve wallets and an off-curve authority in these cases', () => {
    expect(isOffCurveAddress(WALLET_A as never)).toBe(false);
    expect(isOffCurveAddress(WALLET_B as never)).toBe(false);
    expect(isOffCurveAddress(AUTHORITY as never)).toBe(true);
  });

  it('accepts real captures: a PumpSwap sell (Token-2022 transfer fee) and a pump.fun curve buy', () => {
    expect(check(AMM_TX, AMM_MINT, AMM_POOL)).toEqual({ ok: true });
    expect(check(PUMP_TX, PUMP_MINT, PUMP_CURVE)).toEqual({ ok: true });
  });

  it('rejects a peer-to-peer transfer that only lists the pool (a fake print at a price of the sender’s choosing)', () => {
    const tx = p2pMentioningPool('P2P'.padEnd(88, 'x'), AMM_POOL, MINT);
    // Balance derivation alone calls this a 1,000 SOL buy of 1M tokens…
    expect(deriveTradeForMint(tx, MINT, { pool: AMM_POOL })).toMatchObject({ side: 'buy', solAmount: 1_000, tokenAmount: 1_000_000 });
    // …but the pool took no side of it.
    expect(corroborateWithPool(tx, deriveTradeForMint(tx, MINT, { pool: AMM_POOL })!, MINT, AMM_POOL)).toMatchObject({ ok: false });
  });

  it('rejects a real swap padded with a large side transfer of the token (the pool moved far fewer tokens)', () => {
    const tx = structuredClone(AMM_TX);
    const meta = tx.meta!;
    const trader = meta.preTokenBalances!.find((b) => b.owner === 'DH7hz5x4KpYqwoWtcyK8qm5VSqjvMCrNJoRVdKFDrZSL')!;
    const traderPost = meta.postTokenBalances!.find((b) => b.accountIndex === trader.accountIndex)!;
    // The trader also sends 10× the swapped amount to wallet A in the same transaction.
    const swapped = BigInt(trader.uiTokenAmount.amount) - BigInt(traderPost.uiTokenAmount.amount);
    const pre = BigInt(trader.uiTokenAmount.amount) + swapped * 10n;
    trader.uiTokenAmount.amount = pre.toString();
    const index = tx.transaction.message.accountKeys.length;
    tx.transaction.message.accountKeys.push({ pubkey: 'SideTransferAta1111111111111111111111111111', signer: false, writable: true });
    meta.preBalances.push(2_039_280);
    meta.postBalances.push(2_039_280);
    meta.preTokenBalances!.push({ accountIndex: index, mint: AMM_MINT, owner: WALLET_A, uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0 } });
    meta.postTokenBalances!.push({ accountIndex: index, mint: AMM_MINT, owner: WALLET_A, uiTokenAmount: { amount: (swapped * 10n).toString(), decimals: 6, uiAmount: null } });
    expect(check(tx, AMM_MINT, AMM_POOL)).toEqual({ ok: false, reason: 'the pool moved a different token amount' });
  });

  it('rejects an inflated quote leg (the trader received far more SOL than the pool paid)', () => {
    const tx = structuredClone(AMM_TX);
    const meta = tx.meta!;
    // Wallet A pays the seller an extra 100 SOL inside the same transaction.
    meta.postBalances[0] = (meta.postBalances[0] as number) + 100 * LAMPORTS;
    tx.transaction.message.accountKeys.push({ pubkey: WALLET_A, signer: true, writable: true });
    meta.preBalances.push(200 * LAMPORTS);
    meta.postBalances.push(100 * LAMPORTS);
    expect(check(tx, AMM_MINT, AMM_POOL)).toEqual({ ok: false, reason: 'the trader paid a different amount than the pool took' });
  });

  it('accepts a pool whose vaults belong to an off-curve authority (Raydium AMM v4 shape)', () => {
    const tx = synthTx(
      'Raydium'.padEnd(88, 'x'),
      [
        { pubkey: WALLET_A, signer: true, pre: 10 * LAMPORTS, post: 9 * LAMPORTS - 5_000 },
        { pubkey: AUTHORITY, pre: LAMPORTS, post: LAMPORTS },
      ],
      [
        { owner: WALLET_A, mint: MINT, decimals: 6, pre: 0n, post: 1_000_000_000n },
        { owner: AUTHORITY, mint: MINT, decimals: 6, pre: 5_000_000_000n, post: 4_000_000_000n },
        { owner: AUTHORITY, mint: MINTS.SOL, decimals: 9, pre: 50n * BigInt(LAMPORTS), post: 51n * BigInt(LAMPORTS) },
      ],
      [OTHER_POOL],
    );
    expect(check(tx, MINT, OTHER_POOL)).toEqual({ ok: true });
  });

  it('prices a routed trade from the pool side (the trader paid USDC, the pool took SOL)', () => {
    const tx = synthTx(
      'Routed'.padEnd(88, 'x'),
      [
        { pubkey: WALLET_A, signer: true, pre: 10 * LAMPORTS, post: 10 * LAMPORTS - 5_000 },
        { pubkey: AMM_POOL, pre: LAMPORTS, post: LAMPORTS },
        { pubkey: OTHER_POOL, pre: LAMPORTS, post: LAMPORTS },
      ],
      [
        { owner: WALLET_A, mint: MINT, decimals: 6, pre: 0n, post: 1_000_000_000n },
        { owner: WALLET_A, mint: MINTS.USDC, decimals: 6, pre: 500_000_000n, post: 350_000_000n },
        { owner: AMM_POOL, mint: MINT, decimals: 6, pre: 5_000_000_000n, post: 4_000_000_000n },
        { owner: AMM_POOL, mint: MINTS.SOL, decimals: 9, pre: 50n * BigInt(LAMPORTS), post: 51n * BigInt(LAMPORTS) },
        { owner: OTHER_POOL, mint: MINTS.USDC, decimals: 6, pre: 0n, post: 150_000_000n },
        { owner: OTHER_POOL, mint: MINTS.SOL, decimals: 9, pre: 5n * BigInt(LAMPORTS), post: 4n * BigInt(LAMPORTS) },
      ],
    );
    const result = check(tx, MINT, AMM_POOL);
    expect(result.ok).toBe(true);
    // 1 SOL for 1,000 tokens at the venue.
    expect(result.ok && result.poolPrice?.quoteMint).toBe(MINTS.SOL);
    expect(result.ok && result.poolPrice?.price).toBeCloseTo(0.001, 12);
  });

  it('rejects a pool side that gave tokens for nothing', () => {
    const tx = synthTx(
      'Nothing'.padEnd(88, 'x'),
      [
        { pubkey: WALLET_A, signer: true, pre: 10 * LAMPORTS, post: 9 * LAMPORTS - 5_000 },
        { pubkey: WALLET_B, pre: LAMPORTS, post: 2 * LAMPORTS },
      ],
      [
        { owner: WALLET_A, mint: MINT, decimals: 6, pre: 0n, post: 1_000_000_000n },
        { owner: AMM_POOL, mint: MINT, decimals: 6, pre: 5_000_000_000n, post: 4_000_000_000n },
      ],
    );
    expect(check(tx, MINT, AMM_POOL)).toEqual({ ok: false, reason: 'the pool took no quote asset' });
  });
});
