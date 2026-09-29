import { getTransactionDecoder } from '@solana/kit';
import { bytesToBase58 } from '@/lib/wallet/bytes';

/**
 * Minimal read-only inspection of a serialized Solana transaction (legacy,
 * v0 or v1 wire format) so ORBYT can check an order before the wallet sees
 * it: which accounts must sign, and which signatures are present.
 */

export interface InspectedTransaction {
  /** Required signers in order; the first is the fee payer. */
  signers: string[];
  /** base58 signature per signer, or null while unsigned. */
  signatures: Record<string, string | null>;
  messageBytes: Uint8Array;
}

/** Decode a wire transaction; null when the bytes are not a transaction kit can read. */
export function inspectTransaction(bytes: Uint8Array): InspectedTransaction | null {
  try {
    const tx = getTransactionDecoder().decode(bytes);
    const signers = Object.keys(tx.signatures);
    if (!signers.length) return null;
    const signatures: Record<string, string | null> = {};
    for (const signer of signers) {
      const sig = tx.signatures[signer as keyof typeof tx.signatures];
      signatures[signer] = sig && sig.some((b) => b !== 0) ? bytesToBase58(new Uint8Array(sig)) : null;
    }
    return { signers, signatures, messageBytes: new Uint8Array(tx.messageBytes) };
  } catch {
    return null;
  }
}

/** The transaction id once the fee payer has signed (the first signature), else undefined. */
export function transactionId(tx: InspectedTransaction): string | undefined {
  const feePayer = tx.signers[0];
  return feePayer ? (tx.signatures[feePayer] ?? undefined) : undefined;
}
