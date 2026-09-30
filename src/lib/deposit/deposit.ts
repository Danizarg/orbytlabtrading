import { LAMPORTS_PER_SOL, isSignature } from '@/lib/core/solana';
import type { RpcClient } from '@/lib/providers/solana/rpc';
import { bytesToBase64 } from '@/lib/wallet/bytes';
import { buildSolTransferTransaction, depositableLamports } from './build-transaction';

/**
 * The deposit flow: check the RPC is mainnet, read the FRESH balance, build a
 * transfer of everything except the network fee, let the wallet sign and send
 * it, then confirm it on-chain. It reports success only for a transaction the
 * cluster has confirmed without error.
 */

/** Genesis hash of Solana mainnet-beta: proves the RPC we talk to is the cluster the wallet signs for. */
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

/** Confirmation polling: ~90 s in total, well past the ~60 s blockhash lifetime. */
export const CONFIRM_POLL_MS = 1_500;
export const CONFIRM_MAX_POLLS = 60;

/** Raised for every deposit failure that has a user-safe message. `signature` is set once the transaction was submitted. */
export class DepositError extends Error {
  readonly signature?: string;
  constructor(message: string, opts: { signature?: string; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'DepositError';
    this.signature = opts.signature;
  }
}

export type DepositRpc = Pick<RpcClient, 'call' | 'getBalance'>;

/** The connected wallet, as far as the deposit needs it. */
export interface DepositWallet {
  /** solana:signAndSendTransaction: the base58 signature, or null when the wallet lacks the feature. */
  signAndSend: (transaction: Uint8Array) => Promise<string | null>;
  /** solana:signTransaction fallback: the signed, serialized transaction. */
  signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>;
}

export type DepositStage = 'signing' | 'confirming';

export interface DepositResult {
  signature: string;
  lamports: bigint;
}

export interface DepositOptions {
  rpc: DepositRpc;
  from: string;
  to: string;
  wallet: DepositWallet;
  /** 'signing' before the wallet prompt; 'confirming' (with the signature) once the transaction was submitted. */
  onStage?: (stage: DepositStage, signature?: string) => void;
  signal?: AbortSignal;
  /** Test seam: pause between confirmation polls. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Exact SOL text for a lamport amount ("4.999995"), no float rounding. */
export function formatLamports(lamports: bigint): string {
  const whole = lamports / BigInt(LAMPORTS_PER_SOL);
  const frac = (lamports % BigInt(LAMPORTS_PER_SOL)).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** The RPC must be mainnet: a leftover devnet URL would hand the wallet a blockhash that can never land. */
export async function assertMainnet(rpc: DepositRpc, signal?: AbortSignal): Promise<void> {
  let genesis: unknown;
  try {
    genesis = await rpc.call<unknown>('getGenesisHash', [], signal);
  } catch (e) {
    throw new DepositError('Could not reach the Solana network. Try again in a moment.', { cause: e });
  }
  if (genesis !== MAINNET_GENESIS_HASH) {
    throw new DepositError('ORBYT is not connected to Solana mainnet, so the deposit was not started.');
  }
}

async function latestBlockhash(rpc: DepositRpc, signal?: AbortSignal): Promise<{ blockhash: string; lastValidBlockHeight: bigint }> {
  let result: unknown;
  try {
    result = await rpc.call<unknown>('getLatestBlockhash', [{ commitment: 'confirmed' }], signal);
  } catch (e) {
    throw new DepositError('Could not read the latest blockhash from Solana. Try again in a moment.', { cause: e });
  }
  const value = isRecord(result) && isRecord(result.value) ? result.value : undefined;
  const blockhash = value?.blockhash;
  const height = value?.lastValidBlockHeight;
  if (typeof blockhash !== 'string' || typeof height !== 'number' || !Number.isFinite(height)) {
    throw new DepositError('Solana returned an unreadable blockhash. Try again in a moment.');
  }
  return { blockhash, lastValidBlockHeight: BigInt(Math.trunc(height)) };
}

/** Fallback for wallets without signAndSendTransaction: broadcast the wallet-signed transaction ourselves. */
async function sendSigned(rpc: DepositRpc, signed: Uint8Array, signal?: AbortSignal): Promise<string> {
  let signature: unknown;
  try {
    signature = await rpc.call<unknown>('sendTransaction', [bytesToBase64(signed), { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }], signal);
  } catch (e) {
    throw new DepositError(`Solana rejected the transaction: ${e instanceof Error ? e.message : 'unknown error'}`, { cause: e });
  }
  if (!isSignature(signature)) throw new DepositError('Solana returned no transaction signature.');
  return signature;
}

/**
 * Wait until `signature` is confirmed (or finalized). Throws DepositError for a
 * transaction that failed on-chain, or that is still unconfirmed after ~90 s.
 *
 * "Not confirmed" is never turned into "did not happen": the transaction may
 * still land, so the timeout message sends the visitor to Solscan. (Blockhash
 * expiry is deliberately NOT inferred from getBlockHeight: the default public
 * browser RPC answers that method with the slot, not the block height, which
 * would wrongly report every transaction as expired.) Transient RPC errors
 * while polling are retried, not fatal.
 */
export async function confirmSignature(
  rpc: DepositRpc,
  signature: string,
  opts: { signal?: AbortSignal; sleep?: DepositOptions['sleep']; maxPolls?: number; pollMs?: number } = {},
): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  const maxPolls = opts.maxPolls ?? CONFIRM_MAX_POLLS;
  const pollMs = opts.pollMs ?? CONFIRM_POLL_MS;

  for (let poll = 0; poll < maxPolls; poll++) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError');
    try {
      const res = await rpc.call<unknown>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }], opts.signal);
      const status = isRecord(res) && Array.isArray(res.value) ? res.value[0] : null;
      if (isRecord(status)) {
        if (status.err !== null && status.err !== undefined) {
          throw new DepositError(`The transaction failed on-chain: ${JSON.stringify(status.err)}`, { signature });
        }
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return;
      }
    } catch (e) {
      if (e instanceof DepositError || opts.signal?.aborted) throw e;
      /* transient RPC error (rate limit, network): keep polling */
    }
    await sleep(pollMs, opts.signal);
  }
  throw new DepositError(
    'The transaction was sent but is not confirmed yet. Check its status on Solscan: if it never appears there, it did not go through and you can try again.',
    { signature },
  );
}

/** Run the whole deposit. Throws WalletError (wallet declined/failed) or DepositError. */
export async function executeDeposit(options: DepositOptions): Promise<DepositResult> {
  const { rpc, from, to, wallet, onStage, signal } = options;

  await assertMainnet(rpc, signal);

  let balance: number;
  try {
    balance = await rpc.getBalance(from, signal);
  } catch (e) {
    throw new DepositError('Could not read your wallet balance. Try again in a moment.', { cause: e });
  }
  const lamports = depositableLamports(BigInt(Math.trunc(balance)));
  if (lamports <= 0n) throw new DepositError('Your balance is too low to cover the network fee, so there is nothing to deposit.');

  const { blockhash, lastValidBlockHeight } = await latestBlockhash(rpc, signal);
  const transaction = buildSolTransferTransaction({ from, to, lamports, blockhash, lastValidBlockHeight });

  onStage?.('signing');
  let signature = await wallet.signAndSend(transaction);
  if (signature === null) {
    const signed = await wallet.signTransaction(transaction);
    signature = await sendSigned(rpc, signed, signal);
  }
  if (!isSignature(signature)) throw new DepositError('The wallet returned an invalid transaction signature.');

  onStage?.('confirming', signature);
  await confirmSignature(rpc, signature, { signal, sleep: options.sleep });
  return { signature, lamports };
}
