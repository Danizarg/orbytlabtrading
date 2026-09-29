import { getAddressEncoder, type Address } from '@solana/kit';
import { isSolanaAddress } from '@/lib/core/solana';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TRANSFER_INSTRUCTION = 2;

function base58Bytes(value: string): Uint8Array {
  return new Uint8Array(getAddressEncoder().encode(value as Address));
}

/**
 * Unsigned legacy transaction (wire format) that transfers `lamports` from
 * `from` to `to`: one zeroed signature slot followed by the message, ready for
 * the wallet's signTransaction. It contains a single System Program transfer.
 */
export function buildSolTransferTransaction(from: string, to: string, lamports: bigint, recentBlockhash: string): Uint8Array {
  if (!isSolanaAddress(from)) throw new Error(`Invalid sender address: ${from}`);
  if (!isSolanaAddress(to)) throw new Error(`Invalid recipient address: ${to}`);
  if (lamports <= 0n) throw new Error('Amount must be positive');

  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, TRANSFER_INSTRUCTION, true);
  view.setBigUint64(4, lamports, true);

  const message = [
    Uint8Array.of(1, 0, 1), // 1 signer, 0 read-only signers, 1 read-only unsigned (system program)
    Uint8Array.of(3), // account count
    base58Bytes(from),
    base58Bytes(to),
    base58Bytes(SYSTEM_PROGRAM),
    base58Bytes(recentBlockhash),
    Uint8Array.of(1), // instruction count
    Uint8Array.of(2), // program id index
    Uint8Array.of(2, 0, 1), // account indexes: from, to
    Uint8Array.of(data.length),
    data,
  ];

  const parts = [Uint8Array.of(1), new Uint8Array(64), ...message]; // signature count + empty signature
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
