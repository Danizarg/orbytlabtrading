import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import { SITE } from '@/config/site';
import { bytesToBase58, bytesToBase64 } from '@/lib/wallet/bytes';
import { WalletError } from '@/lib/wallet/errors';
import { confirmSignature, DepositError, executeDeposit, formatLamports, MAINNET_GENESIS_HASH, type DepositRpc, type DepositWallet } from './deposit';

const FROM = 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ';
const TO = SITE.depositAddress;
const BLOCKHASH = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const SIG = bytesToBase58(new Uint8Array(64).fill(7));
const noSleep = async () => {};

interface RpcOpts {
  genesis?: string;
  balance?: number;
  /** getSignatureStatuses answers in order; the last one repeats. */
  statuses?: Array<unknown | Error>;
  blockHeight?: number;
  sendResult?: unknown;
}

function fakeRpc(o: RpcOpts = {}) {
  const statuses = [...(o.statuses ?? [{ err: null, confirmationStatus: 'confirmed' }])];
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const call = vi.fn(async (method: string, params: unknown[]) => {
    calls.push({ method, params });
    switch (method) {
      case 'getGenesisHash':
        return o.genesis ?? MAINNET_GENESIS_HASH;
      case 'getLatestBlockhash':
        return { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 } };
      case 'getSignatureStatuses': {
        const next = statuses.length > 1 ? statuses.shift() : statuses[0];
        if (next instanceof Error) throw next;
        return { context: { slot: 1 }, value: [next ?? null] };
      }
      case 'getBlockHeight':
        return o.blockHeight ?? 10;
      case 'sendTransaction':
        return o.sendResult ?? SIG;
      default:
        throw new Error(`unexpected RPC method ${method}`);
    }
  });
  const getBalance = vi.fn(async () => o.balance ?? 5_000_000_000);
  return { rpc: { call, getBalance } as unknown as DepositRpc, call, getBalance, calls };
}

function fakeWallet(o: { signAndSend?: () => Promise<string | null>; signTransaction?: (tx: Uint8Array) => Promise<Uint8Array> } = {}) {
  const signAndSend = vi.fn<DepositWallet['signAndSend']>(o.signAndSend ?? (async () => SIG));
  const signTransaction = vi.fn<DepositWallet['signTransaction']>(o.signTransaction ?? (async (tx) => tx));
  return { wallet: { signAndSend, signTransaction } satisfies DepositWallet, signAndSend, signTransaction };
}

function decodeMessage(tx: Uint8Array) {
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(tx).messageBytes);
  // kit's decoder also covers v1 messages (no `instructions`); a deposit is always a legacy message.
  if (!('instructions' in message)) throw new Error('expected a legacy or v0 message');
  return message;
}

function lamportsOf(tx: Uint8Array): bigint {
  const message = decodeMessage(tx);
  const d = new Uint8Array(message.instructions[0]!.data!);
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(4, true);
}

describe('formatLamports', () => {
  it('prints exact SOL without float rounding', () => {
    expect(formatLamports(0n)).toBe('0');
    expect(formatLamports(5_000n)).toBe('0.000005');
    expect(formatLamports(4_999_995_000n)).toBe('4.999995');
    expect(formatLamports(5_000_000_000n)).toBe('5');
    expect(formatLamports(1n)).toBe('0.000000001');
    expect(formatLamports(123_456_789_012n)).toBe('123.456789012');
  });
});

describe('executeDeposit', () => {
  it('sends the full balance minus the fee through the wallet and reports success only once confirmed', async () => {
    const { rpc, call } = fakeRpc({ balance: 5_000_000_000, statuses: [null, { err: null, confirmationStatus: 'confirmed' }] });
    const { wallet, signAndSend, signTransaction } = fakeWallet();
    const stages: Array<[string, string | undefined]> = [];

    const result = await executeDeposit({ rpc, from: FROM, to: TO, wallet, sleep: noSleep, onStage: (s, sig) => stages.push([s, sig]) });

    expect(result).toEqual({ signature: SIG, lamports: 4_999_995_000n });
    expect(stages).toEqual([['signing', undefined], ['confirming', SIG]]);
    expect(signAndSend).toHaveBeenCalledTimes(1);
    expect(signTransaction).not.toHaveBeenCalled();
    expect(lamportsOf(signAndSend.mock.calls[0]![0])).toBe(4_999_995_000n);
    const message = decodeMessage(signAndSend.mock.calls[0]![0]);
    expect(message.staticAccounts.slice(0, 2)).toEqual([FROM, TO]);
    expect(message.lifetimeToken).toBe(BLOCKHASH);
    // it polled at least twice: the first status was still unknown
    expect(call.mock.calls.filter(([m]) => m === 'getSignatureStatuses').length).toBeGreaterThanOrEqual(2);
  });

  it('reads the balance fresh at send time and sends a different amount when it changed', async () => {
    const { rpc } = fakeRpc({ balance: 1_234_567_890 });
    const { wallet, signAndSend } = fakeWallet();
    const result = await executeDeposit({ rpc, from: FROM, to: TO, wallet, sleep: noSleep });
    expect(result.lamports).toBe(1_234_562_890n);
    expect(lamportsOf(signAndSend.mock.calls[0]![0])).toBe(1_234_562_890n);
  });

  it('falls back to signTransaction + sendTransaction when the wallet cannot sign and send', async () => {
    const { rpc, calls } = fakeRpc();
    const { wallet, signAndSend, signTransaction } = fakeWallet({ signAndSend: async () => null });
    const result = await executeDeposit({ rpc, from: FROM, to: TO, wallet, sleep: noSleep });

    expect(result.signature).toBe(SIG);
    expect(signAndSend).toHaveBeenCalledTimes(1);
    expect(signTransaction).toHaveBeenCalledTimes(1);
    const send = calls.find((c) => c.method === 'sendTransaction')!;
    expect(send.params[0]).toBe(bytesToBase64(signTransaction.mock.calls[0]![0]));
    expect(send.params[1]).toMatchObject({ encoding: 'base64' });
  });

  it('does not touch the wallet when the RPC is not mainnet', async () => {
    const { rpc } = fakeRpc({ genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' });
    const { wallet, signAndSend } = fakeWallet();
    await expect(executeDeposit({ rpc, from: FROM, to: TO, wallet, sleep: noSleep })).rejects.toThrow(/not connected to Solana mainnet/);
    expect(signAndSend).not.toHaveBeenCalled();
  });

  it('does not touch the wallet when the RPC cannot be reached', async () => {
    const rpc = { call: vi.fn(async () => { throw new Error('boom'); }), getBalance: vi.fn() } as unknown as DepositRpc;
    const { wallet, signAndSend } = fakeWallet();
    await expect(executeDeposit({ rpc, from: FROM, to: TO, wallet, sleep: noSleep })).rejects.toBeInstanceOf(DepositError);
    expect(signAndSend).not.toHaveBeenCalled();
  });

  it.each([0, 4_999, 5_000])('does not prompt the wallet when the balance cannot cover the fee', async (balance) => {
    const { rpc } = fakeRpc({ balance });
    const { wallet, signAndSend, signTransaction } = fakeWallet();
    await expect(executeDeposit({ rpc, from: FROM, to: TO, wallet, sleep: noSleep })).rejects.toThrow(/nothing to deposit/);
    expect(signAndSend).not.toHaveBeenCalled();
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it('passes a declined wallet prompt through untouched and never polls', async () => {
    const { rpc, call } = fakeRpc();
    const { wallet } = fakeWallet({ signAndSend: async () => { throw new WalletError('rejected', 'cancelled'); } });
    await expect(executeDeposit({ rpc, from: FROM, to: TO, wallet, sleep: noSleep })).rejects.toMatchObject({ kind: 'rejected' });
    expect(call.mock.calls.some(([m]) => m === 'getSignatureStatuses')).toBe(false);
  });

  it('rejects a malformed signature from the wallet', async () => {
    const { rpc } = fakeRpc();
    const { wallet } = fakeWallet({ signAndSend: async () => 'not-a-signature' });
    await expect(executeDeposit({ rpc, from: FROM, to: TO, wallet, sleep: noSleep })).rejects.toThrow(/invalid transaction signature/);
  });

  it('surfaces a transaction that failed on-chain, with its signature, and never reports success', async () => {
    const { rpc } = fakeRpc({ statuses: [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }] });
    const { wallet } = fakeWallet();
    const error = await executeDeposit({ rpc, from: FROM, to: TO, wallet, sleep: noSleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DepositError);
    expect((error as DepositError).signature).toBe(SIG);
    expect((error as DepositError).message).toMatch(/failed on-chain/);
  });

  it('reports the signature when the broadcast fallback is refused by the network', async () => {
    const { rpc, call } = fakeRpc();
    call.mockImplementation(async (method: string) => {
      if (method === 'getGenesisHash') return MAINNET_GENESIS_HASH;
      if (method === 'getLatestBlockhash') return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 } };
      throw new Error('Transaction simulation failed: Blockhash not found');
    });
    const { wallet } = fakeWallet({ signAndSend: async () => null });
    await expect(executeDeposit({ rpc, from: FROM, to: TO, wallet, sleep: noSleep })).rejects.toThrow(/Solana rejected the transaction: .*Blockhash not found/);
  });
});

describe('confirmSignature', () => {
  const base = { sleep: noSleep };

  it('accepts confirmed and finalized, but not merely processed', async () => {
    await expect(confirmSignature(fakeRpc({ statuses: [{ err: null, confirmationStatus: 'finalized' }] }).rpc, SIG, base)).resolves.toBeUndefined();
    const processedOnly = fakeRpc({ statuses: [{ err: null, confirmationStatus: 'processed' }] });
    await expect(confirmSignature(processedOnly.rpc, SIG, { ...base, maxPolls: 3 })).rejects.toThrow(/not confirmed yet/);
    expect(processedOnly.call.mock.calls.filter(([m]) => m === 'getSignatureStatuses')).toHaveLength(3);
  });

  it('keeps polling through transient RPC errors', async () => {
    const { rpc } = fakeRpc({ statuses: [new Error('429 rate limited'), new Error('network'), { err: null, confirmationStatus: 'confirmed' }] });
    await expect(confirmSignature(rpc, SIG, base)).resolves.toBeUndefined();
  });

  it('times out with the signature attached and a check-Solscan message (the transaction might still land)', async () => {
    const { rpc } = fakeRpc({ statuses: [null], blockHeight: 10 });
    const error = await confirmSignature(rpc, SIG, { ...base, maxPolls: 4 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DepositError);
    expect((error as DepositError).signature).toBe(SIG);
    expect((error as DepositError).message).toMatch(/Check its status on Solscan/);
  });

  it('never claims a transaction did not happen just because it is unconfirmed (even when block-height RPCs disagree)', async () => {
    // publicnode answers getBlockHeight with the slot, far above every lastValidBlockHeight: it must not matter
    const { rpc, call } = fakeRpc({ statuses: [null, null, { err: null, confirmationStatus: 'confirmed' }], blockHeight: 451_662_089 });
    await expect(confirmSignature(rpc, SIG, { ...base, maxPolls: 10 })).resolves.toBeUndefined();
    expect(call.mock.calls.some(([m]) => m === 'getBlockHeight')).toBe(false);
    const stuck = fakeRpc({ statuses: [null], blockHeight: 451_662_089 });
    const error = await confirmSignature(stuck.rpc, SIG, { ...base, maxPolls: 5 }).catch((e: unknown) => e);
    expect((error as DepositError).message).not.toMatch(/no SOL was moved|expired/i);
  });

  it('stops when aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { rpc } = fakeRpc();
    await expect(confirmSignature(rpc, SIG, { ...base, signal: ctl.signal })).rejects.toBeDefined();
  });
});
