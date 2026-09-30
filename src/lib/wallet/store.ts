import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import type { StandardEventsChangeProperties } from '@wallet-standard/features';
import { create } from 'zustand';
import { endSession, fetchSession, signInWithWallet } from './auth-client';
import { isWalletError, REJECTED_MESSAGE, toWalletError, WalletError } from './errors';
import {
  connectWallet,
  disconnectWallet,
  isSolanaWallet,
  onWalletChange,
  safeWalletIcon,
  signMessageWith,
  signAndSendTransactionWith,
  signTransactionWith,
  sortWallets,
  toWalletOption,
  usableAccounts,
  type SignedBytes,
  type WalletOption,
} from './standard';

/**
 * Wallet connection state (zustand). Holds only serializable data; the
 * Wallet Standard objects live in module scope. The store never holds keys
 * or funds: every signature happens inside the visitor's wallet.
 *
 * Lifecycle: `init()` (called by the header's ConnectWalletButton) discovers
 * wallets, silently reconnects the last-used one and restores a verified
 * server session when its cookie matches the connected address.
 */

export type WalletStatus = 'idle' | 'connecting' | 'connected' | 'signing' | 'error';

export const WALLET_STORAGE_KEY = 'orbyt-wallet-v1';

export interface WalletState {
  /** Discovery has started (client only; false during SSR and hydration). */
  ready: boolean;
  /** Detected Solana wallets, Phantom first. */
  wallets: WalletOption[];
  status: WalletStatus;
  /** Wallet in use (or being connected). */
  walletName: string | null;
  walletIcon: string | null;
  /** Connected account address. */
  address: string | null;
  /** The ORBYT server verified a Sign-In With Solana signature for `address`. */
  verified: boolean;
  /** The verification is backed by an HttpOnly session cookie (survives reloads). */
  session: boolean;
  /** A real failure worth showing (connection, verification). */
  error: string | null;
  /** Quiet feedback, e.g. the user cancelled in their wallet. */
  notice: string | null;

  /** Start discovery. Idempotent and ref-counted; returns a release function. */
  init: () => () => void;
  /** Connect a detected wallet by name (prompts the wallet). */
  connect: (walletName: string) => Promise<boolean>;
  /** Forget the connection (and end the server session). */
  disconnect: () => Promise<void>;
  /** Sign-In With Solana, verified by the ORBYT server. */
  signIn: () => Promise<boolean>;
  /** solana:signMessage with the connected account. Throws WalletError. */
  signMessage: (message: Uint8Array) => Promise<SignedBytes>;
  /** solana:signTransaction on mainnet with the connected account. Throws WalletError. */
  signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>;
  /**
   * solana:signAndSendTransaction on mainnet: the wallet signs and broadcasts.
   * Resolves the base58 signature, or null when the wallet lacks the feature
   * (fall back to signTransaction). Throws WalletError.
   */
  signAndSendTransaction: (transaction: Uint8Array) => Promise<string | null>;
  clearFeedback: () => void;
}

// ---------------------------------------------------------------------------
// Module-scope runtime (non-serializable)
// ---------------------------------------------------------------------------

interface Active {
  wallet: Wallet;
  account: WalletAccount;
  off: () => void;
}

const registry = new Map<string, Wallet>();
let active: Active | null = null;
let refs = 0;
let teardown: (() => void) | null = null;
let autoConnectTried = false;
/** Address of the verified server session (from the cookie), if any. */
let sessionAddress: string | null = null;
/** Bumped whenever this page signs in or ends the session, so a late initial session read cannot overwrite it. */
let sessionEpoch = 0;
/** Bumped by every connect/disconnect so late results of superseded calls are ignored. */
let generation = 0;

function readStoredWallet(): string | null {
  try {
    const raw = window.localStorage.getItem(WALLET_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === 'string' && parsed.name.length <= 64 ? parsed.name : null;
  } catch {
    return null;
  }
}

function storeWallet(name: string | null) {
  try {
    if (name) window.localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify({ name }));
    else window.localStorage.removeItem(WALLET_STORAGE_KEY);
  } catch {
    /* storage blocked: no auto-reconnect */
  }
}

const DISCONNECTED = {
  status: 'idle',
  walletName: null,
  walletIcon: null,
  address: null,
  verified: false,
  session: false,
} as const satisfies Partial<WalletState>;

export const useWallet = create<WalletState>()((set, get) => {
  function refreshWallets() {
    registry.clear();
    for (const wallet of getWallets().get()) {
      if (isSolanaWallet(wallet) && !registry.has(wallet.name)) registry.set(wallet.name, wallet);
    }
    set({ wallets: sortWallets([...registry.values()].map(toWalletOption)) });
    // The active wallet was unregistered (extension disabled/removed).
    if (active && registry.get(active.wallet.name) !== active.wallet) detach();
  }

  function detach(notice: string | null = null) {
    generation++;
    active?.off();
    active = null;
    set({ ...DISCONNECTED, notice, error: null });
  }

  function verifiedFor(address: string) {
    return sessionAddress === address ? { verified: true, session: true } : { verified: false, session: false };
  }

  function attach(wallet: Wallet, account: WalletAccount) {
    active?.off();
    const entry: Active = { wallet, account, off: () => {} };
    entry.off = onWalletChange(wallet, (props) => handleChange(entry, props));
    active = entry;
    set({
      status: 'connected',
      walletName: wallet.name,
      walletIcon: safeWalletIcon(wallet.icon) ?? null,
      address: account.address,
      ...verifiedFor(account.address),
      error: null,
    });
  }

  function handleChange(entry: Active, props: StandardEventsChangeProperties) {
    if (active !== entry) return;
    if (props.features || props.chains) refreshWallets();
    // refreshWallets may have detached this wallet (it dropped Solana mainnet or connect).
    if (active !== entry || !props.accounts) return;
    const accounts = usableAccounts(props.accounts);
    if (!accounts.length) {
      // Disconnected (or locked) from inside the wallet.
      void clearSessionIfAny();
      detach('Wallet disconnected.');
      return;
    }
    const same = accounts.find((a) => a.address === entry.account.address);
    const next = same ?? accounts[0]!;
    entry.account = next;
    if (!same) {
      // Account switched in the wallet: a session for the previous address no longer applies.
      if (sessionAddress && sessionAddress !== next.address) void clearSessionIfAny();
      set({ address: next.address, ...verifiedFor(next.address), notice: null, error: null });
    }
  }

  async function clearSessionIfAny() {
    sessionEpoch++;
    if (!sessionAddress) return;
    sessionAddress = null;
    await endSession();
  }

  async function connectInternal(name: string, silent: boolean): Promise<boolean> {
    const wallet = registry.get(name);
    if (!wallet) {
      if (!silent) set({ status: 'error', error: `${name} is not available in this browser.`, notice: null });
      return false;
    }
    // Already connected to this wallet: nothing to do (and no second prompt).
    if (active?.wallet === wallet && get().status !== 'error') return true;
    // Switching wallets: let go of the previous one first, so the state and
    // the wallet that signs can never disagree (even if this connect fails).
    const previous = active;
    if (previous) {
      detach();
      void disconnectWallet(previous.wallet);
    }
    const gen = ++generation;
    set({ status: 'connecting', walletName: wallet.name, walletIcon: safeWalletIcon(wallet.icon) ?? null, error: null, notice: null });
    try {
      const accounts = await connectWallet(wallet, silent);
      if (gen !== generation) return false;
      const account = accounts[0];
      if (!account) {
        if (silent) {
          storeWallet(null);
          set({ ...DISCONNECTED });
          return false;
        }
        throw new WalletError('failed', `${wallet.name} did not share a Solana account.`);
      }
      // A session for the previous wallet's address no longer applies.
      if (previous && sessionAddress && sessionAddress !== account.address) void clearSessionIfAny();
      attach(wallet, account);
      storeWallet(wallet.name);
      return true;
    } catch (e) {
      if (gen !== generation) return false;
      const err = toWalletError(e, `Could not connect to ${wallet.name}.`);
      if (silent || err.kind === 'rejected') {
        set({ ...DISCONNECTED, notice: silent ? null : REJECTED_MESSAGE, error: null });
      } else {
        set({ ...DISCONNECTED, status: 'error', walletName: wallet.name, error: err.message, notice: null });
      }
      return false;
    }
  }

  function tryAutoConnect() {
    if (autoConnectTried || active || get().status === 'connecting') return;
    const name = readStoredWallet();
    if (!name) {
      autoConnectTried = true;
      return;
    }
    if (!registry.has(name)) return; // the extension may register a little later
    autoConnectTried = true;
    void connectInternal(name, true);
  }

  function requireActive(feature: string): Active {
    if (!active) throw new WalletError('not_connected', `Connect a wallet to ${feature}.`);
    return active;
  }

  return {
    ready: false,
    wallets: [],
    ...DISCONNECTED,
    error: null,
    notice: null,

    init: () => {
      if (typeof window === 'undefined') return () => {};
      refs++;
      if (refs === 1) {
        const api = getWallets();
        const offRegister = api.on('register', () => {
          refreshWallets();
          tryAutoConnect();
        });
        const offUnregister = api.on('unregister', refreshWallets);
        teardown = () => {
          offRegister();
          offUnregister();
        };
        set({ ready: true });
        refreshWallets();
        const epoch = sessionEpoch;
        void fetchSession().then((session) => {
          if (epoch !== sessionEpoch) return; // signed in or out meanwhile
          sessionAddress = session?.address ?? null;
          const { address, verified } = get();
          if (address && !verified) set(verifiedFor(address));
        });
        tryAutoConnect();
      }
      return () => {
        refs = Math.max(0, refs - 1);
        if (refs === 0) {
          teardown?.();
          teardown = null;
        }
      };
    },

    connect: (walletName) => connectInternal(walletName, false),

    disconnect: async () => {
      const current = active;
      detach();
      storeWallet(null);
      await Promise.all([current ? disconnectWallet(current.wallet) : Promise.resolve(), clearSessionIfAny()]);
    },

    signIn: async () => {
      const entry = active;
      if (!entry) {
        set({ error: 'Connect a wallet before signing in.', notice: null });
        return false;
      }
      // One wallet prompt at a time (e.g. an automatic request plus a click).
      if (get().status === 'signing') return false;
      set({ status: 'signing', error: null, notice: null });
      try {
        const result = await signInWithWallet(entry.wallet, entry.account);
        if (active !== entry) return false;
        if (result.address !== entry.account.address) {
          // The wallet signed in with another of its accounts: switch to it when it is authorised.
          const other = usableAccounts(entry.wallet.accounts).find((a) => a.address === result.address);
          if (!other) throw new WalletError('verification', 'Your wallet signed in with a different account. Switch accounts and try again.');
          entry.account = other;
        }
        sessionEpoch++;
        sessionAddress = result.session ? result.address : null;
        set({ status: 'connected', address: result.address, verified: true, session: result.session });
        return true;
      } catch (e) {
        if (active !== entry) return false;
        const err = toWalletError(e, 'Sign-in failed.');
        set(err.kind === 'rejected' ? { status: 'connected', notice: REJECTED_MESSAGE } : { status: 'connected', error: err.message });
        return false;
      }
    },

    signMessage: async (message) => {
      const entry = requireActive('sign a message');
      set({ status: 'signing' });
      try {
        return await signMessageWith(entry.wallet, entry.account, message);
      } catch (e) {
        throw isWalletError(e) ? e : toWalletError(e, 'Signing failed.');
      } finally {
        if (active === entry) set({ status: 'connected' });
      }
    },

    signTransaction: async (transaction) => {
      const entry = requireActive('sign a transaction');
      set({ status: 'signing' });
      try {
        return await signTransactionWith(entry.wallet, entry.account, transaction);
      } catch (e) {
        throw isWalletError(e) ? e : toWalletError(e, 'Signing failed.');
      } finally {
        if (active === entry) set({ status: 'connected' });
      }
    },

    signAndSendTransaction: async (transaction) => {
      const entry = requireActive('send a transaction');
      set({ status: 'signing' });
      try {
        return await signAndSendTransactionWith(entry.wallet, entry.account, transaction);
      } catch (e) {
        throw isWalletError(e) ? e : toWalletError(e, 'Sending failed.');
      } finally {
        if (active === entry) set({ status: 'connected' });
      }
    },

    clearFeedback: () => set({ error: null, notice: null, ...(get().status === 'error' ? { status: 'idle' as const, walletName: null, walletIcon: null } : {}) }),
  };
});

/** Connected address, or null. */
export const useWalletAddress = () => useWallet((s) => s.address);

/** True when a wallet is connected (including while it is signing). */
export const useWalletConnected = () => useWallet((s) => s.address !== null && (s.status === 'connected' || s.status === 'signing'));

/** Imperative access for non-React code (e.g. the swap flow). */
export function getWalletState(): WalletState {
  return useWallet.getState();
}

/** Test helper: forget module-scope state between tests. */
export function __resetWalletRuntimeForTests() {
  active?.off();
  active = null;
  registry.clear();
  refs = 0;
  teardown?.();
  teardown = null;
  autoConnectTried = false;
  sessionAddress = null;
  sessionEpoch++;
  generation++;
  useWallet.setState({ ready: false, wallets: [], ...DISCONNECTED, error: null, notice: null });
}
