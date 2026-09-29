import { describe, expect, it } from 'vitest';
import { chainForRpc } from './send-deposit';
import { buildSolTransferTransaction } from './build-transaction';

const FROM = '8dbTV2UQXUbhAjpQ8Hf9mcpuJX7LaBWs3FDAqC2rTfc3';
const TO = 'So11111111111111111111111111111111111111112';
const BLOCKHASH = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';

describe('buildSolTransferTransaction', () => {
  it('lays out one empty signature, a 3-account legacy message and the transfer amount', () => {
    const tx = buildSolTransferTransaction(FROM, TO, 1_234_567n, BLOCKHASH);
    expect(tx[0]).toBe(1);
    expect(tx.slice(1, 65).every((b) => b === 0)).toBe(true);
    expect([...tx.slice(65, 69)]).toEqual([1, 0, 1, 3]);
    // 65 + header 3 + count 1 + 3 keys + blockhash = 65 + 4 + 128; then ix count, program, accounts, len, data
    const ix = 65 + 4 + 128;
    expect([...tx.slice(ix, ix + 6)]).toEqual([1, 2, 2, 0, 1, 12]);
    const view = new DataView(tx.buffer, tx.byteOffset + ix + 6, 12);
    expect(view.getUint32(0, true)).toBe(2);
    expect(view.getBigUint64(4, true)).toBe(1_234_567n);
    expect(tx.length).toBe(ix + 6 + 12);
  });

  it('rejects bad input', () => {
    expect(() => buildSolTransferTransaction('nope', TO, 1n, BLOCKHASH)).toThrow();
    expect(() => buildSolTransferTransaction(FROM, TO, 0n, BLOCKHASH)).toThrow();
  });
});

describe('chainForRpc', () => {
  it('detects the cluster from the RPC url', () => {
    expect(chainForRpc('https://api.devnet.solana.com')).toBe('solana:devnet');
    expect(chainForRpc('https://api.testnet.solana.com')).toBe('solana:testnet');
    expect(chainForRpc('https://solana-rpc.publicnode.com')).toBe('solana:mainnet');
  });
});
