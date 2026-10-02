import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash as toBlockhash,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
} from '@solana/kit';
import { isSolanaAddress } from '@/lib/core/solana';

/** System Program (native SOL transfers). */
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

/** SystemInstruction::Transfer is variant 2 (little-endian u32), followed by the u64 lamports. */
const TRANSFER_DISCRIMINATOR = 2;

const U64_MAX = 2n ** 64n - 1n;

/**
 * Network fee of a one-signature transaction without a priority fee: 5000
 * lamports.
 */
export const TRANSFER_FEE_LAMPORTS = 5_000n;

/** Minimum amount to keep on the wallet in USD. */
export const MINIMUM_KEEP_USD = 3;

/** What can be deposited from a balance: everything except the minimum to keep. */
export function depositableLamports(balanceLamports: bigint, minimumKeepLamports: bigint = 0n): bigint {
  return balanceLamports > minimumKeepLamports ? balanceLamports - minimumKeepLamports : 0n;
}

export interface SolTransferParams {
  /** Sender and fee payer (the connected wallet). */
  from: string;
  /** Recipient. */
  to: string;
  lamports: bigint;
  /** Recent blockhash from the same cluster the transaction will be sent to. */
  blockhash: string;
  lastValidBlockHeight: bigint;
}

/**
 * Build the unsigned, wallet-ready wire transaction for a native SOL transfer:
 * `[compact-u16 signature count][64-byte empty signature slot][legacy message]`,
 * exactly what Wallet Standard's solana:signTransaction / signAndSendTransaction
 * expect. It contains ONE instruction (System Program transfer) and nothing else.
 */
export function buildSolTransferTransaction(params: SolTransferParams): Uint8Array {
  const { from, to, lamports, blockhash, lastValidBlockHeight } = params;
  if (!isSolanaAddress(from)) throw new Error('Invalid sender address.');
  if (!isSolanaAddress(to)) throw new Error('Invalid recipient address.');
  if (from === to) throw new Error('Sender and recipient are the same address.');
  if (lamports <= 0n) throw new Error('Amount must be positive.');
  if (lamports > U64_MAX) throw new Error('Amount is too large.');

  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, TRANSFER_DISCRIMINATOR, true);
  view.setBigUint64(4, lamports, true);

  const transfer: Instruction = {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: address(from), role: AccountRole.WRITABLE_SIGNER },
      { address: address(to), role: AccountRole.WRITABLE },
    ],
    data,
  };

  const message = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayer(address(from), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: toBlockhash(blockhash), lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstruction(transfer, m),
  );

  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
}
