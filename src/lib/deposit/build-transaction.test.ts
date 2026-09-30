import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { SITE } from '@/config/site';
import { buildSolTransferTransaction, depositableLamports, TRANSFER_FEE_LAMPORTS } from './build-transaction';

const FROM = 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ';
const TO = SITE.depositAddress;
const SYSTEM = '11111111111111111111111111111111';
const BLOCKHASH = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';

function decode(bytes: Uint8Array) {
  const tx = getTransactionDecoder().decode(bytes);
  const decoded = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  // kit's decoder also covers v1 messages (no `instructions`); a deposit is always a legacy message.
  if (!('instructions' in decoded)) throw new Error('expected a legacy or v0 message');
  return { tx, message: decoded };
}

describe('buildSolTransferTransaction', () => {
  const bytes = buildSolTransferTransaction({ from: FROM, to: TO, lamports: 4_999_995_000n, blockhash: BLOCKHASH, lastValidBlockHeight: 123n });
  const { tx, message } = decode(bytes);

  it('is a complete wire transaction: one empty signature slot for the sender, then the message', () => {
    expect(Object.keys(tx.signatures)).toEqual([FROM]);
    expect((tx.signatures as Record<string, unknown>)[FROM]).toBeNull();
    // 1 (count) + 64 (signature slot) + message
    expect(bytes.length).toBe(1 + 64 + tx.messageBytes.length);
    expect(bytes[0]).toBe(1);
    expect(bytes.slice(1, 65).every((b) => b === 0)).toBe(true);
  });

  it('is a legacy message with the sender as the only signer and fee payer', () => {
    expect(message.version).toBe('legacy');
    expect(message.header).toMatchObject({ numSignerAccounts: 1, numReadonlySignerAccounts: 0, numReadonlyNonSignerAccounts: 1 });
    expect(message.staticAccounts).toEqual([FROM, TO, SYSTEM]);
  });

  it('carries the given blockhash', () => {
    expect(message.lifetimeToken).toBe(BLOCKHASH);
  });

  it('contains exactly one System Program transfer of the exact lamports from sender to recipient', () => {
    expect(message.instructions).toHaveLength(1);
    const [ix] = message.instructions;
    expect(message.staticAccounts[ix!.programAddressIndex]).toBe(SYSTEM);
    expect(ix!.accountIndices).toEqual([0, 1]);
    const data = new Uint8Array(ix!.data!);
    expect(data).toHaveLength(12);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(view.getUint32(0, true)).toBe(2);
    expect(view.getBigUint64(4, true)).toBe(4_999_995_000n);
  });

  it('encodes the largest and smallest amounts exactly (no float rounding)', () => {
    const big = 2n ** 53n + 1n;
    const m = decode(buildSolTransferTransaction({ from: FROM, to: TO, lamports: big, blockhash: BLOCKHASH, lastValidBlockHeight: 1n })).message;
    const d = new Uint8Array(m.instructions[0]!.data!);
    expect(new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(4, true)).toBe(big);
    const one = decode(buildSolTransferTransaction({ from: FROM, to: TO, lamports: 1n, blockhash: BLOCKHASH, lastValidBlockHeight: 1n })).message;
    const d1 = new Uint8Array(one.instructions[0]!.data!);
    expect(new DataView(d1.buffer, d1.byteOffset, d1.byteLength).getBigUint64(4, true)).toBe(1n);
  });

  it('rejects bad input instead of building something a wallet could sign', () => {
    const ok = { from: FROM, to: TO, lamports: 1n, blockhash: BLOCKHASH, lastValidBlockHeight: 1n };
    expect(() => buildSolTransferTransaction({ ...ok, from: 'nope' })).toThrow(/sender/i);
    expect(() => buildSolTransferTransaction({ ...ok, to: 'nope' })).toThrow(/recipient/i);
    expect(() => buildSolTransferTransaction({ ...ok, to: FROM })).toThrow(/same address/i);
    expect(() => buildSolTransferTransaction({ ...ok, lamports: 0n })).toThrow(/positive/i);
    expect(() => buildSolTransferTransaction({ ...ok, lamports: -5n })).toThrow(/positive/i);
    expect(() => buildSolTransferTransaction({ ...ok, lamports: 2n ** 64n })).toThrow(/too large/i);
    expect(() => buildSolTransferTransaction({ ...ok, blockhash: 'not-a-blockhash' })).toThrow();
  });
});

describe('depositableLamports', () => {
  it('sends everything except the 5000-lamport network fee', () => {
    expect(TRANSFER_FEE_LAMPORTS).toBe(5_000n);
    expect(depositableLamports(5_000_000_000n)).toBe(4_999_995_000n);
    expect(depositableLamports(5_001n)).toBe(1n);
  });

  it('is 0 when the balance does not cover the fee', () => {
    expect(depositableLamports(0n)).toBe(0n);
    expect(depositableLamports(4_999n)).toBe(0n);
    expect(depositableLamports(5_000n)).toBe(0n);
  });
});
