import {
  SolanaSignIn,
  SolanaSignMessage,
  SolanaSignTransaction,
  type SolanaSignInFeature,
  type SolanaSignInInput,
  type SolanaSignInOutput,
  type SolanaSignMessageFeature,
  type SolanaSignMessageOutput,
  type SolanaSignTransactionFeature,
  type SolanaSignTransactionOutput,
} from '@solana/wallet-standard-features';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsChangeProperties,
  type StandardEventsFeature,
} from '@wallet-standard/features';
import { isSolanaAddress } from '@/lib/core/solana';
import { toWalletError, WalletError } from './errors';

/**
 * Thin, framework-agnostic layer over the Wallet Standard: feature checks,
 * ordering, and each wallet call wrapped so failures become WalletError with
 * user-safe text. No React, no store: see store.ts for state.
 */

export const SOLANA_MAINNET = 'solana:mainnet' as const;

/** Wallets listed first, in this order; any other Solana wallet follows alphabetically. */
const PREFERRED = ['phantom', 'solflare', 'backpack'] as const;

const ICON_RE = /^data:image\/(?:svg\+xml|webp|png|gif);base64,[A-Za-z0-9+/=]+$/;

/** Serializable description of a wallet for the UI. */
export interface WalletOption {
  /** Wallet name, unique among registered wallets in practice; used as the id. */
  name: string;
  /** data: URI supplied by the wallet itself, or undefined when it is not a safe inline image. */
  icon?: string;
  canSignIn: boolean;
  canSignMessage: boolean;
  canSignTransaction: boolean;
}

function feature<T>(wallet: Wallet, name: string): T | undefined {
  return (wallet.features as Record<string, unknown>)[name] as T | undefined;
}

export function hasFeature(wallet: Wallet, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(wallet.features, name);
}

/** A wallet ORBYT can use: Solana mainnet plus standard:connect. */
export function isSolanaWallet(wallet: Wallet): boolean {
  return Array.isArray(wallet.chains) && wallet.chains.includes(SOLANA_MAINNET) && hasFeature(wallet, StandardConnect);
}

function rank(name: string): number {
  const lower = name.toLowerCase();
  const i = PREFERRED.findIndex((p) => lower === p || lower.startsWith(`${p} `));
  return i === -1 ? PREFERRED.length : i;
}

/** Phantom, Solflare, Backpack first; everything else alphabetically. */
export function sortWallets<T extends { name: string }>(wallets: readonly T[]): T[] {
  return [...wallets].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** The wallet's own icon, only when it is an inline data: image (never a remote URL). */
export function safeWalletIcon(icon: unknown): string | undefined {
  return typeof icon === 'string' && icon.length < 200_000 && ICON_RE.test(icon) ? icon : undefined;
}

export function toWalletOption(wallet: Wallet): WalletOption {
  return {
    name: wallet.name,
    icon: safeWalletIcon(wallet.icon),
    canSignIn: hasFeature(wallet, SolanaSignIn),
    canSignMessage: hasFeature(wallet, SolanaSignMessage),
    canSignTransaction: hasFeature(wallet, SolanaSignTransaction),
  };
}

/** Accounts usable on Solana mainnet with a valid address. */
export function usableAccounts(accounts: readonly WalletAccount[] | undefined): WalletAccount[] {
  return (accounts ?? []).filter(
    (a) => isSolanaAddress(a.address) && (!Array.isArray(a.chains) || a.chains.length === 0 || a.chains.includes(SOLANA_MAINNET)),
  );
}

/**
 * standard:connect. `silent` asks for already-authorised accounts without a
 * prompt (auto-reconnect); wallets may ignore it, so it is only used for the
 * last wallet the visitor connected.
 */
export async function connectWallet(wallet: Wallet, silent = false): Promise<WalletAccount[]> {
  const connect = feature<StandardConnectFeature[typeof StandardConnect]>(wallet, StandardConnect);
  if (!connect) throw new WalletError('unsupported', `${wallet.name} cannot connect to web apps.`);
  try {
    const { accounts } = await connect.connect(silent ? { silent: true } : undefined);
    return usableAccounts(accounts?.length ? accounts : wallet.accounts);
  } catch (e) {
    throw toWalletError(e, `Could not connect to ${wallet.name}.`);
  }
}

/** standard:disconnect when supported. Never throws: disconnecting locally must always succeed. */
export async function disconnectWallet(wallet: Wallet): Promise<void> {
  const disconnect = feature<StandardDisconnectFeature[typeof StandardDisconnect]>(wallet, StandardDisconnect);
  try {
    await disconnect?.disconnect();
  } catch {
    /* the wallet keeps its own authorisation; ORBYT forgets the connection regardless */
  }
}

/** standard:events 'change' (account switch, disconnect from inside the wallet). Returns an unsubscribe. */
export function onWalletChange(wallet: Wallet, listener: (properties: StandardEventsChangeProperties) => void): () => void {
  const events = feature<StandardEventsFeature[typeof StandardEvents]>(wallet, StandardEvents);
  if (!events) return () => {};
  try {
    return events.on('change', listener);
  } catch {
    return () => {};
  }
}

export interface SignedBytes {
  /** Exact bytes the wallet signed (wallets may prefix or modify the message). */
  signedMessage: Uint8Array;
  signature: Uint8Array;
}

/** solana:signMessage. */
export async function signMessageWith(wallet: Wallet, account: WalletAccount, message: Uint8Array): Promise<SignedBytes> {
  const f = feature<SolanaSignMessageFeature[typeof SolanaSignMessage]>(wallet, SolanaSignMessage);
  if (!f) throw new WalletError('unsupported', `${wallet.name} cannot sign messages.`);
  let output: SolanaSignMessageOutput | undefined;
  try {
    [output] = await f.signMessage({ account, message });
  } catch (e) {
    throw toWalletError(e, `${wallet.name} did not sign the message.`);
  }
  if (!output || !(output.signature instanceof Uint8Array) || output.signature.length !== 64) {
    throw new WalletError('failed', `${wallet.name} returned no valid signature.`);
  }
  return {
    signedMessage: output.signedMessage instanceof Uint8Array && output.signedMessage.length ? new Uint8Array(output.signedMessage) : message,
    signature: new Uint8Array(output.signature),
  };
}

/** solana:signIn (the wallet builds and shows the SIWS message itself). */
export async function signInWith(wallet: Wallet, input: SolanaSignInInput): Promise<SignedBytes & { account: WalletAccount }> {
  const f = feature<SolanaSignInFeature[typeof SolanaSignIn]>(wallet, SolanaSignIn);
  if (!f) throw new WalletError('unsupported', `${wallet.name} does not support Sign In With Solana.`);
  let output: SolanaSignInOutput | undefined;
  try {
    [output] = await f.signIn(input);
  } catch (e) {
    throw toWalletError(e, `${wallet.name} did not sign in.`);
  }
  if (
    !output ||
    !(output.signature instanceof Uint8Array) ||
    output.signature.length !== 64 ||
    !(output.signedMessage instanceof Uint8Array) ||
    !isSolanaAddress(output.account?.address)
  ) {
    throw new WalletError('failed', `${wallet.name} returned an incomplete sign-in.`);
  }
  if (output.signatureType !== undefined && output.signatureType !== 'ed25519') {
    throw new WalletError('unsupported', `${wallet.name} signed with an unsupported signature type.`);
  }
  if (output.signedMessageFormat !== undefined) {
    throw new WalletError('unsupported', `${wallet.name} signed an off-chain message format ORBYT cannot verify yet.`);
  }
  return { account: output.account, signedMessage: new Uint8Array(output.signedMessage), signature: new Uint8Array(output.signature) };
}

/** solana:signTransaction (mainnet unless `chain` says otherwise). Returns the signed, serialized transaction. */
export async function signTransactionWith(
  wallet: Wallet,
  account: WalletAccount,
  transaction: Uint8Array,
  chain: 'solana:mainnet' | 'solana:devnet' | 'solana:testnet' = SOLANA_MAINNET,
): Promise<Uint8Array> {
  const f = feature<SolanaSignTransactionFeature[typeof SolanaSignTransaction]>(wallet, SolanaSignTransaction);
  if (!f) throw new WalletError('unsupported', `${wallet.name} cannot sign transactions in ORBYT.`);
  let output: SolanaSignTransactionOutput | undefined;
  try {
    [output] = await f.signTransaction({ account, transaction, chain });
  } catch (e) {
    throw toWalletError(e, `${wallet.name} did not sign the transaction.`);
  }
  if (!output || !(output.signedTransaction instanceof Uint8Array) || output.signedTransaction.length === 0) {
    throw new WalletError('failed', `${wallet.name} returned no signed transaction.`);
  }
  return new Uint8Array(output.signedTransaction);
}
