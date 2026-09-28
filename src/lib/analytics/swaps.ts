import type { ActivityLeg, WalletActivity } from '@/lib/core/types';
import type { ProviderId } from '@/lib/core/providers';
import type { RpcParsedTransaction } from './tx-types';

/**
 * Swap / transfer derivation from parsed Solana transactions.
 * CONTRACT STUB — implementation in progress (see analytics swaps task).
 */

export interface BalanceChanges {
  wallet: string;
  /**
   * Net SOL change for the wallet (native lamports + WSOL token accounts),
   * in SOL, EXCLUDING the network fee paid by the wallet and excluding rent
   * deposited into / refunded from token accounts opened or closed in the tx.
   */
  solDelta: number;
  /** Network fee paid by the wallet (0 when another signer paid). */
  feeSol: number;
  /** Non-SOL token changes for the wallet (signed, decimal-adjusted). */
  tokens: Array<ActivityLeg & { decimals: number }>;
}

export interface DerivedTrade {
  signature: string;
  /** ms */
  timestamp: number;
  side: 'buy' | 'sell';
  /** Trader wallet (the owner whose balance of `mint` changed; not necessarily the fee payer). */
  wallet: string;
  tokenAmount: number;
  /** SOL exchanged by the trader (native + WSOL, fee/rent excluded) when the quote is SOL. */
  solAmount?: number;
  /** Quote mint when not SOL (e.g. USDC). */
  quoteMint?: string;
  quoteAmount?: number;
  /** Execution price per token in quote units (quoteAmount / tokenAmount). */
  priceQuote?: number;
  /** Venue label, e.g. 'pump.fun', 'PumpSwap', 'Raydium', 'Jupiter'. */
  program?: string;
}

export function walletBalanceChanges(_tx: RpcParsedTransaction, _wallet: string): BalanceChanges {
  throw new Error('walletBalanceChanges: not implemented yet');
}

/**
 * Classify what a transaction did for `wallet`. Returns null when the wallet's
 * balances did not change (not involved) — failed transactions are returned
 * with success=false and kind 'other'.
 */
export function classifyWalletActivity(
  _tx: RpcParsedTransaction,
  _wallet: string,
  _opts: { source: ProviderId; symbols?: Record<string, string> } = { source: 'solana-rpc' },
): WalletActivity | null {
  throw new Error('classifyWalletActivity: not implemented yet');
}

/** Derive the trade of `mint` in this transaction (null if none / failed tx). */
export function deriveTradeForMint(_tx: RpcParsedTransaction, _mint: string, _opts: { pool?: string } = {}): DerivedTrade | null {
  throw new Error('deriveTradeForMint: not implemented yet');
}

/** Best-effort venue label from program ids invoked in the transaction. */
export function detectProgram(_tx: RpcParsedTransaction): string | undefined {
  throw new Error('detectProgram: not implemented yet');
}
