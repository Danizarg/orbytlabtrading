import { generateKeyPair, getAddressFromPublicKey, signBytes } from '@solana/kit';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount, WalletIcon } from '@wallet-standard/base';
import type { StandardEventsChangeProperties } from '@wallet-standard/features';
import { NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as logoutPOST } from '@/app/api/v1/auth/logout/route';
import { GET as nonceGET } from '@/app/api/v1/auth/nonce/route';
import { GET as sessionGET } from '@/app/api/v1/auth/session/route';
import { POST as verifyPOST } from '@/app/api/v1/auth/verify/route';
import { isWalletError } from './errors';
import { __resetWalletRuntimeForTests, useWallet, WALLET_STORAGE_KEY } from './store';

const ICON = 'data:image/svg+xml;base64,PHN2Zy8+' as WalletIcon;
const ORIGIN = 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Browser stand-ins: window.localStorage and fetch wired to the real auth routes
// ---------------------------------------------------------------------------

const storage = new Map<string, string>();
let cookie = '';
const routeCalls: string[] = [];

async function routeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const path = String(input);
  routeCalls.push(`${init.method ?? 'GET'} ${path}`);
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  if (init.method === 'POST') headers.set('origin', ORIGIN);
  const req = new NextRequest(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers, body: init.body as BodyInit | undefined });
  const res =
    path === '/api/v1/auth/nonce'
      ? await nonceGET(req)
      : path === '/api/v1/auth/verify'
        ? await verifyPOST(req)
        : path === '/api/v1/auth/session'
          ? await sessionGET(req)
          : path === '/api/v1/auth/logout'
            ? await logoutPOST(req)
            : new Response('not found', { status: 404 });
  const set = res.headers.get('set-cookie');
  if (set) {
    const [pair] = set.split(';');
    cookie = pair?.endsWith('=') ? '' : (pair ?? '');
  }
  return res;
}

// ---------------------------------------------------------------------------
// Fake Wallet Standard wallets
// ---------------------------------------------------------------------------

interface FakeWallet extends Wallet {
  emit(props: StandardEventsChangeProperties): void;
  connect: ReturnType<typeof vi.fn>;
  signTx: ReturnType<typeof vi.fn>;
  signMsg: ReturnType<typeof vi.fn>;
  setAccounts(accounts: WalletAccount[]): void;
}

function account(address: string): WalletAccount {
  return { address, publicKey: new Uint8Array(32), chains: ['solana:mainnet'], features: ['solana:signMessage', 'solana:signTransaction'] };
}

function fakeWallet(name: string, opts: { accounts?: WalletAccount[]; keys?: CryptoKeyPair; chains?: `${string}:${string}`[]; icon?: string } = {}): FakeWallet {
  let authorised: WalletAccount[] = [];
  const all = opts.accounts ?? [];
  const listeners = new Set<(p: StandardEventsChangeProperties) => void>();
  const connect = vi.fn(async (input?: { silent?: boolean }) => {
    if (input?.silent && !authorised.length) return { accounts: [] };
    authorised = all;
    return { accounts: authorised };
  });
  const signMsg = vi.fn(async ({ message }: { message: Uint8Array }) => {
    if (!opts.keys) throw new Error('no key');
    return [{ signedMessage: message, signature: new Uint8Array(await signBytes(opts.keys.privateKey, message)) }];
  });
  const signTx = vi.fn(async ({ transaction }: { transaction: Uint8Array }) => [{ signedTransaction: new Uint8Array([...transaction, 1]) }]);
  const wallet = {
    version: '1.0.0' as const,
    name,
    icon: (opts.icon ?? ICON) as WalletIcon,
    chains: opts.chains ?? ['solana:mainnet', 'solana:devnet'],
    get accounts() {
      return authorised;
    },
    features: {
      'standard:connect': { version: '1.0.0', connect },
      'standard:disconnect': { version: '1.0.0', disconnect: vi.fn(async () => {}) },
      'standard:events': {
        version: '1.0.0',
        on: (_event: 'change', listener: (p: StandardEventsChangeProperties) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      'solana:signMessage': { version: '1.0.0', signMessage: signMsg },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: signTx },
    },
    emit: (props: StandardEventsChangeProperties) => listeners.forEach((l) => l(props)),
    setAccounts: (accounts: WalletAccount[]) => {
      authorised = accounts;
    },
    connect,
    signTx,
    signMsg,
  };
  return wallet as unknown as FakeWallet;
}

let keys: CryptoKeyPair;
let addressA: string;
let addressB: string;
const unregister: Array<() => void> = [];
let release: (() => void) | null = null;

function register(...wallets: Wallet[]) {
  unregister.push(getWallets().register(...wallets));
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeAll(async () => {
  keys = await generateKeyPair();
  addressA = await getAddressFromPublicKey(keys.publicKey);
  addressB = await getAddressFromPublicKey((await generateKeyPair()).publicKey);
});

beforeEach(() => {
  storage.clear();
  cookie = '';
  routeCalls.length = 0;
  vi.stubEnv('AUTH_SECRET', 'store-test-secret-0123456789abcdef0123');
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
    addEventListener: () => {},
    dispatchEvent: () => true,
  });
  vi.stubGlobal('fetch', vi.fn(routeFetch));
  __resetWalletRuntimeForTests();
});

afterEach(() => {
  release?.();
  release = null;
  while (unregister.length) unregister.pop()!();
  __resetWalletRuntimeForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('wallet discovery', () => {
  it('lists Solana mainnet wallets, Phantom first, then Solflare, Backpack, others', () => {
    register(
      fakeWallet('Zeta Wallet'),
      fakeWallet('Solflare'),
      fakeWallet('MetaMask', { chains: ['eip155:1'] }),
      fakeWallet('Backpack'),
      fakeWallet('Phantom'),
      fakeWallet('Devnet Only', { chains: ['solana:devnet'] }),
      fakeWallet('Remote Icon', { icon: 'https://evil.example/icon.png' }),
    );
    release = useWallet.getState().init();
    const { wallets, ready } = useWallet.getState();
    expect(ready).toBe(true);
    expect(wallets.map((w) => w.name)).toEqual(['Phantom', 'Solflare', 'Backpack', 'Remote Icon', 'Zeta Wallet']);
    expect(wallets[0]).toMatchObject({ icon: ICON, canSignIn: false, canSignMessage: true, canSignTransaction: true });
    expect(wallets.find((w) => w.name === 'Remote Icon')?.icon).toBeUndefined();
  });

  it('picks up wallets that register after init', () => {
    release = useWallet.getState().init();
    expect(useWallet.getState().wallets).toEqual([]);
    register(fakeWallet('Phantom'));
    expect(useWallet.getState().wallets.map((w) => w.name)).toEqual(['Phantom']);
  });
});

describe('connect / events / disconnect', () => {
  it('connects, follows account switches and wallet-side disconnects', async () => {
    const phantom = fakeWallet('Phantom', { accounts: [account(addressA), account(addressB)], keys });
    register(phantom);
    release = useWallet.getState().init();

    await expect(useWallet.getState().connect('Phantom')).resolves.toBe(true);
    expect(phantom.connect).toHaveBeenCalledWith(undefined);
    expect(useWallet.getState()).toMatchObject({ status: 'connected', address: addressA, walletName: 'Phantom', walletIcon: ICON, verified: false });
    expect(storage.get(WALLET_STORAGE_KEY)).toBe(JSON.stringify({ name: 'Phantom' }));

    phantom.emit({ accounts: [account(addressB)] });
    expect(useWallet.getState()).toMatchObject({ status: 'connected', address: addressB });

    phantom.emit({ accounts: [] });
    expect(useWallet.getState()).toMatchObject({ status: 'idle', address: null, notice: 'Wallet disconnected.' });
  });

  it('treats a rejected connect as a quiet notice, not an error', async () => {
    const phantom = fakeWallet('Phantom', { accounts: [account(addressA)] });
    phantom.connect.mockRejectedValueOnce(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
    register(phantom);
    release = useWallet.getState().init();
    await expect(useWallet.getState().connect('Phantom')).resolves.toBe(false);
    expect(useWallet.getState()).toMatchObject({ status: 'idle', error: null, notice: 'Request cancelled in your wallet.' });
    expect(storage.has(WALLET_STORAGE_KEY)).toBe(false);
  });

  it('reports other connect failures as errors', async () => {
    const phantom = fakeWallet('Phantom');
    phantom.connect.mockRejectedValueOnce(new Error('Extension crashed'));
    register(phantom);
    release = useWallet.getState().init();
    await useWallet.getState().connect('Phantom');
    expect(useWallet.getState()).toMatchObject({ status: 'error', error: 'Could not connect to Phantom. (Extension crashed)' });
    useWallet.getState().clearFeedback();
    expect(useWallet.getState()).toMatchObject({ status: 'idle', error: null });
  });

  it('silently reconnects the last wallet on init', async () => {
    const phantom = fakeWallet('Phantom', { accounts: [account(addressA)] });
    phantom.setAccounts([account(addressA)]); // already authorised in the wallet
    storage.set(WALLET_STORAGE_KEY, JSON.stringify({ name: 'Phantom' }));
    register(phantom);
    release = useWallet.getState().init();
    await flush();
    expect(phantom.connect).toHaveBeenCalledWith({ silent: true });
    expect(useWallet.getState()).toMatchObject({ status: 'connected', address: addressA });
  });

  it('forgets the stored wallet when a silent reconnect gets no account', async () => {
    const phantom = fakeWallet('Phantom', { accounts: [account(addressA)] });
    storage.set(WALLET_STORAGE_KEY, JSON.stringify({ name: 'Phantom' }));
    register(phantom);
    release = useWallet.getState().init();
    await flush();
    expect(useWallet.getState()).toMatchObject({ status: 'idle', address: null, notice: null, error: null });
    expect(storage.has(WALLET_STORAGE_KEY)).toBe(false);
  });

  it('does not prompt again when the same wallet is already connected', async () => {
    const phantom = fakeWallet('Phantom', { accounts: [account(addressA)] });
    register(phantom);
    release = useWallet.getState().init();
    await useWallet.getState().connect('Phantom');
    await expect(useWallet.getState().connect('Phantom')).resolves.toBe(true);
    expect(phantom.connect).toHaveBeenCalledTimes(1);
    expect(useWallet.getState()).toMatchObject({ status: 'connected', address: addressA });
  });

  it('switching to another wallet releases the previous one, even when the new connect fails', async () => {
    const phantom = fakeWallet('Phantom', { accounts: [account(addressA)], keys });
    const solflare = fakeWallet('Solflare', { accounts: [account(addressB)] });
    solflare.connect.mockRejectedValueOnce(new Error('Extension crashed'));
    register(phantom, solflare);
    release = useWallet.getState().init();
    await useWallet.getState().connect('Phantom');
    await useWallet.getState().signIn();
    expect(cookie).toMatch(/^orbyt_session=/);

    await expect(useWallet.getState().connect('Solflare')).resolves.toBe(false);
    expect(useWallet.getState()).toMatchObject({ status: 'error', address: null, verified: false });
    // Regression: the store showed "disconnected" while Phantom still signed for it.
    await expect(useWallet.getState().signTransaction(new Uint8Array([9]))).rejects.toMatchObject({ kind: 'not_connected' });
    expect(phantom.signTx).not.toHaveBeenCalled();
    expect((phantom.features['standard:disconnect'] as { disconnect: ReturnType<typeof vi.fn> }).disconnect).toHaveBeenCalledTimes(1);
    // Events from the released wallet no longer move the state.
    phantom.emit({ accounts: [account(addressA)] });
    expect(useWallet.getState().address).toBeNull();

    // Now a successful switch: the Phantom session (address A) ends because B is another address.
    await useWallet.getState().connect('Phantom');
    await useWallet.getState().signIn();
    expect(useWallet.getState()).toMatchObject({ address: addressA, verified: true, session: true });
    await expect(useWallet.getState().connect('Solflare')).resolves.toBe(true);
    await flush();
    expect(useWallet.getState()).toMatchObject({ status: 'connected', walletName: 'Solflare', address: addressB, verified: false, session: false });
    expect(cookie).toBe('');
    await expect(useWallet.getState().signTransaction(new Uint8Array([7]))).resolves.toEqual(new Uint8Array([7, 1]));
    expect(solflare.signTx).toHaveBeenCalledTimes(1);
    expect(phantom.signTx).not.toHaveBeenCalled();
  });

  it('a change event that drops Solana mainnet detaches without re-applying its accounts', async () => {
    const phantom = fakeWallet('Phantom', { accounts: [account(addressA)] });
    register(phantom);
    release = useWallet.getState().init();
    await useWallet.getState().connect('Phantom');
    (phantom as unknown as { chains: string[] }).chains = ['solana:devnet'];
    phantom.emit({ chains: ['solana:devnet'], accounts: [account(addressB)] });
    expect(useWallet.getState()).toMatchObject({ status: 'idle', address: null, wallets: [] });
  });

  it('disconnect clears state, storage and the server session', async () => {
    const phantom = fakeWallet('Phantom', { accounts: [account(addressA)], keys });
    register(phantom);
    release = useWallet.getState().init();
    await useWallet.getState().connect('Phantom');
    await useWallet.getState().signIn();
    expect(cookie).toMatch(/^orbyt_session=/);
    await useWallet.getState().disconnect();
    expect(useWallet.getState()).toMatchObject({ status: 'idle', address: null, verified: false, session: false });
    expect(storage.has(WALLET_STORAGE_KEY)).toBe(false);
    expect(cookie).toBe('');
    expect(routeCalls).toContain('POST /api/v1/auth/logout');
  });
});

describe('sign in', () => {
  it('signs a SIWS message (signMessage fallback) that the real verify route accepts, then restores the session', async () => {
    const phantom = fakeWallet('Phantom', { accounts: [account(addressA)], keys });
    register(phantom);
    release = useWallet.getState().init();
    await useWallet.getState().connect('Phantom');

    await expect(useWallet.getState().signIn()).resolves.toBe(true);
    expect(useWallet.getState()).toMatchObject({ status: 'connected', verified: true, session: true, error: null });
    const signed = new TextDecoder().decode(phantom.signMsg.mock.calls[0]![0].message as Uint8Array);
    expect(signed).toMatch(/^localhost:3000 wants you to sign in with your Solana account:\n/);
    expect(signed).toContain(`\n${addressA}\n`);
    expect(signed).toContain('Chain ID: mainnet');

    // Reload: a fresh runtime restores `verified` from the cookie once the same wallet reconnects.
    release();
    release = null;
    __resetWalletRuntimeForTests();
    phantom.setAccounts([account(addressA)]);
    storage.set(WALLET_STORAGE_KEY, JSON.stringify({ name: 'Phantom' }));
    release = useWallet.getState().init();
    await flush();
    await flush();
    expect(useWallet.getState()).toMatchObject({ status: 'connected', address: addressA, verified: true, session: true });

    // Switching accounts drops the verification.
    phantom.emit({ accounts: [account(addressB)] });
    expect(useWallet.getState()).toMatchObject({ address: addressB, verified: false, session: false });
  });

  /** Independent transcription of @solana/wallet-standard-util createSignInMessageText (what Phantom signs). */
  function referenceSignInText(input: Record<string, unknown>, address: string): string {
    let message = `${String(input.domain)} wants you to sign in with your Solana account:\n${address}`;
    if (input.statement) message += `\n\n${String(input.statement)}`;
    const fields: string[] = [];
    if (input.uri) fields.push(`URI: ${String(input.uri)}`);
    if (input.version) fields.push(`Version: ${String(input.version)}`);
    if (input.chainId) fields.push(`Chain ID: ${String(input.chainId)}`);
    if (input.nonce) fields.push(`Nonce: ${String(input.nonce)}`);
    if (input.issuedAt) fields.push(`Issued At: ${String(input.issuedAt)}`);
    if (input.expirationTime) fields.push(`Expiration Time: ${String(input.expirationTime)}`);
    if (input.notBefore) fields.push(`Not Before: ${String(input.notBefore)}`);
    if (input.requestId) fields.push(`Request ID: ${String(input.requestId)}`);
    if (fields.length) message += `\n\n${fields.join('\n')}`;
    return message;
  }

  function withSignIn(wallet: FakeWallet, signer: { account: () => WalletAccount; keys: CryptoKeyPair }) {
    const signIn = vi.fn(async (input: Record<string, unknown>) => {
      const account = signer.account();
      const signedMessage = new TextEncoder().encode(referenceSignInText(input, account.address));
      return [{ account, signedMessage, signature: new Uint8Array(await signBytes(signer.keys.privateKey, signedMessage)) }];
    });
    (wallet.features as Record<string, unknown>)['solana:signIn'] = { version: '1.0.0', signIn };
    return signIn;
  }

  it('signs in through solana:signIn (the Phantom path) and the real verify route accepts it', async () => {
    const phantom = fakeWallet('Phantom', { accounts: [account(addressA)], keys });
    const signIn = withSignIn(phantom, { account: () => account(addressA), keys });
    register(phantom);
    release = useWallet.getState().init();
    expect(useWallet.getState().wallets[0]).toMatchObject({ name: 'Phantom', canSignIn: true });
    await useWallet.getState().connect('Phantom');

    await expect(useWallet.getState().signIn()).resolves.toBe(true);
    expect(useWallet.getState()).toMatchObject({ status: 'connected', address: addressA, verified: true, session: true, error: null });
    expect(phantom.signMsg).not.toHaveBeenCalled();
    expect(signIn.mock.calls[0]![0]).toMatchObject({ domain: 'localhost:3000', address: addressA, uri: ORIGIN, version: '1', chainId: 'mainnet' });
  });

  it('follows a solana:signIn wallet that signs in with another authorised account', async () => {
    const keysB = await generateKeyPair();
    const addrB = await getAddressFromPublicKey(keysB.publicKey);
    const phantom = fakeWallet('Phantom', { accounts: [account(addressA), account(addrB)], keys });
    withSignIn(phantom, { account: () => account(addrB), keys: keysB });
    register(phantom);
    release = useWallet.getState().init();
    await useWallet.getState().connect('Phantom');
    expect(useWallet.getState().address).toBe(addressA);

    await expect(useWallet.getState().signIn()).resolves.toBe(true);
    expect(useWallet.getState()).toMatchObject({ address: addrB, verified: true });
    // Transactions are now signed by the account that proved ownership.
    await useWallet.getState().signTransaction(new Uint8Array([1]));
    expect(phantom.signTx.mock.calls[0]![0]).toMatchObject({ account: { address: addrB } });
  });

  it('opens only one wallet prompt when sign-in is requested twice at once', async () => {
    const phantom = fakeWallet('Phantom', { accounts: [account(addressA)], keys });
    register(phantom);
    release = useWallet.getState().init();
    await useWallet.getState().connect('Phantom');
    const [first, second] = await Promise.all([useWallet.getState().signIn(), useWallet.getState().signIn()]);
    expect([first, second]).toEqual([true, false]);
    expect(phantom.signMsg).toHaveBeenCalledTimes(1);
    expect(useWallet.getState()).toMatchObject({ status: 'connected', verified: true });
  });

  it('reports a rejected signature quietly and stays connected', async () => {
    const phantom = fakeWallet('Phantom', { accounts: [account(addressA)], keys });
    phantom.signMsg.mockRejectedValueOnce(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
    register(phantom);
    release = useWallet.getState().init();
    await useWallet.getState().connect('Phantom');
    await expect(useWallet.getState().signIn()).resolves.toBe(false);
    expect(useWallet.getState()).toMatchObject({ status: 'connected', verified: false, notice: 'Request cancelled in your wallet.', error: null });
  });

  it('shows the server reason when verification fails', async () => {
    const other = await generateKeyPair();
    const phantom = fakeWallet('Phantom', { accounts: [account(addressA)], keys: other });
    register(phantom);
    release = useWallet.getState().init();
    await useWallet.getState().connect('Phantom');
    await expect(useWallet.getState().signIn()).resolves.toBe(false);
    expect(useWallet.getState()).toMatchObject({ status: 'connected', verified: false, error: 'The signature does not match this wallet.' });
  });
});

describe('signTransaction', () => {
  it('signs on mainnet with the connected account and surfaces rejections as WalletError', async () => {
    const phantom = fakeWallet('Phantom', { accounts: [account(addressA)] });
    register(phantom);
    release = useWallet.getState().init();
    await expect(useWallet.getState().signTransaction(new Uint8Array([9]))).rejects.toMatchObject({ kind: 'not_connected' });
    await useWallet.getState().connect('Phantom');

    await expect(useWallet.getState().signTransaction(new Uint8Array([9]))).resolves.toEqual(new Uint8Array([9, 1]));
    expect(phantom.signTx.mock.calls[0]![0]).toMatchObject({ chain: 'solana:mainnet', account: { address: addressA } });
    expect(useWallet.getState().status).toBe('connected');

    phantom.signTx.mockRejectedValueOnce(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
    const error = await useWallet.getState().signTransaction(new Uint8Array([9])).catch((e: unknown) => e);
    expect(isWalletError(error) && error.kind).toBe('rejected');
    expect(useWallet.getState().status).toBe('connected');
  });
});
