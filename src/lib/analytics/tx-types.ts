/**
 * Shape of `getTransaction` results requested with
 * `{ encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }`.
 * Only the fields ORBYT reads are typed; everything is treated as untrusted.
 */

export interface RpcUiTokenAmount {
  /** Raw integer amount as a string (may exceed 2^53). */
  amount: string;
  decimals: number;
  uiAmount: number | null;
  uiAmountString?: string;
}

export interface RpcTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: RpcUiTokenAmount;
}

export interface RpcParsedAccountKey {
  pubkey: string;
  signer: boolean;
  writable: boolean;
  source?: 'transaction' | 'lookupTable' | string;
}

export interface RpcParsedInstruction {
  programId: string;
  program?: string;
  parsed?: unknown;
  accounts?: string[];
  data?: string;
  stackHeight?: number | null;
}

export interface RpcTransactionMeta {
  err: unknown;
  /** Lamports. */
  fee: number;
  /** Lamports, aligned with message.accountKeys. */
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: RpcTokenBalance[] | null;
  postTokenBalances?: RpcTokenBalance[] | null;
  logMessages?: string[] | null;
  innerInstructions?: Array<{ index: number; instructions: RpcParsedInstruction[] }> | null;
  loadedAddresses?: { writable: string[]; readonly: string[] } | null;
}

export interface RpcParsedTransaction {
  slot: number;
  /** UNIX seconds. */
  blockTime?: number | null;
  version?: 'legacy' | number;
  meta: RpcTransactionMeta | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: RpcParsedAccountKey[];
      instructions: RpcParsedInstruction[];
      recentBlockhash?: string;
    };
  };
}
