import { getAddressEncoder } from '@solana/kit';
import { LAMPORTS_PER_SOL, isSolanaAddress } from '@/lib/core/solana';

/**
 * System Program ID (always 11111111111111111111111111111111 on Solana).
 */
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/**
 * Instruction discriminator for SystemProgram.Transfer (little-endian u32 = 2).
 */
const TRANSFER_INSTRUCTION_TYPE = 2;

/**
 * Build an unsigned SOL transfer transaction ready for wallet signing.
 *
 * This creates a minimal, valid Solana transaction (version 0 / legacy) that:
 * - Transfers SOL from `from` to `to`
 * - Is signed only by `from` (the payer)
 * - Uses a dummy recent blockhash (the wallet may override this)
 *
 * The transaction is returned as bytes, ready for wallet.signTransaction().
 *
 * Safety: This builds ONLY a transfer instruction, no other operations.
 */
export async function buildSolTransferTransaction(
  from: string,
  to: string,
  amountSol: number,
): Promise<Uint8Array> {
  if (!isSolanaAddress(from)) throw new Error(`Invalid sender address: ${from}`);
  if (!isSolanaAddress(to)) throw new Error(`Invalid recipient address: ${to}`);
  if (amountSol <= 0) throw new Error(`Amount must be positive`);

  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
  if (lamports <= 0) throw new Error(`Amount is too small`);

  try {
    const encoder = getAddressEncoder();

    // Encode addresses to get 32-byte keys (convert to mutable arrays)
    const fromKey = new Uint8Array(encoder.encode(from as Parameters<typeof encoder.encode>[0]));
    const toKey = new Uint8Array(encoder.encode(to as Parameters<typeof encoder.encode>[0]));
    const systemProgramKey = new Uint8Array(
      encoder.encode(SYSTEM_PROGRAM as Parameters<typeof encoder.encode>[0]),
    );
    // Use a placeholder recent blockhash (wallet may override)
    const recentBlockhash = new Uint8Array(
      encoder.encode('11111111111111111111111111111111' as Parameters<typeof encoder.encode>[0]),
    );

    // Build the transfer instruction data (u32 discriminator + u64 amount)
    const instructionData = new Uint8Array(4 + 8);
    const view = new DataView(instructionData.buffer);
    view.setUint32(0, TRANSFER_INSTRUCTION_TYPE, true); // little-endian
    view.setBigUint64(4, BigInt(lamports), true); // little-endian

    // Build transaction message format (version 0 / legacy)
    const parts: Uint8Array[] = [];

    // Header
    // - byte 0: number of required signer (1 = from)
    parts.push(new Uint8Array([1]));
    // - byte 1: number of read-only signers (0)
    parts.push(new Uint8Array([0]));
    // - byte 2: number of read-only non-signers (1 = system program)
    parts.push(new Uint8Array([1]));

    // Account list (accounts are ordered: signers first, then read-only)
    // Account 0: from (signer, writable)
    parts.push(fromKey);
    // Account 1: to (non-signer, writable)
    parts.push(toKey);
    // Account 2: system program (non-signer, read-only)
    parts.push(systemProgramKey);

    // Recent blockhash (32 bytes)
    parts.push(recentBlockhash);

    // Instructions
    // - byte: instruction count (1)
    parts.push(new Uint8Array([1]));

    // Instruction 0
    // - program index (2 = system program, the 3rd account)
    parts.push(new Uint8Array([2]));
    // - accounts referenced: 2 accounts (from=0, to=1)
    parts.push(new Uint8Array([2, 0, 1]));
    // - data length (varint: 12 bytes for our instruction)
    parts.push(new Uint8Array([12]));
    // - data
    parts.push(instructionData);

    // Concatenate all parts into the transaction message
    const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
    const messageBytes = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of parts) {
      messageBytes.set(part, offset);
      offset += part.length;
    }

    // Build the transaction wire format: signatures + message
    // For an unsigned transaction, the wallet will add signatures
    // We'll return just the message; the wallet will wrap it with signature placeholders
    return messageBytes;
  } catch (error) {
    throw new Error(
      `Failed to build transfer transaction: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
