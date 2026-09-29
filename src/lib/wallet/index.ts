/**
 * ORBYT wallet layer (browser): Wallet Standard discovery and connection,
 * Sign-In With Solana, message and transaction signing. Non-custodial: keys
 * never leave the visitor's wallet.
 *
 * Server-side verification lives in `@/lib/wallet/server` (server-only).
 */
export {
  getWalletState,
  useWallet,
  useWalletAddress,
  useWalletConnected,
  WALLET_STORAGE_KEY,
  type WalletState,
  type WalletStatus,
} from './store';
export { isUserRejection, isWalletError, REJECTED_MESSAGE, toWalletError, WalletError, type WalletErrorKind } from './errors';
export { SOLANA_MAINNET, sortWallets, type SignedBytes, type WalletOption } from './standard';
export { AUTH_ROUTES, fetchSession, type SessionInfo, type VerifiedSignIn } from './auth-client';
export { buildSignInMessage, parseSignInMessage, SIGN_IN_STATEMENT, type SignInChallenge, type SignInMessageFields } from './siws';
