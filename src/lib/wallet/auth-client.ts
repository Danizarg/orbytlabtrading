import { SolanaSignIn, SolanaSignMessage } from '@solana/wallet-standard-features';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { isSolanaAddress } from '@/lib/core/solana';
import { bytesToBase64, utf8Bytes } from './bytes';
import { WalletError } from './errors';
import { buildSignInMessage, challengeFields, NONCE_RE, type SignInChallenge } from './siws';
import { hasFeature, signInWith, signMessageWith, type SignedBytes } from './standard';

/**
 * Browser side of Sign-In With Solana: fetch a challenge from ORBYT, have the
 * wallet sign it (solana:signIn, or the same message through
 * solana:signMessage), and let the server verify the Ed25519 signature.
 * Nothing here is trusted by the server; it re-checks everything.
 */

export const AUTH_ROUTES = {
  /** GET → SignInChallenge */
  nonce: '/api/v1/auth/nonce',
  /** POST { address, signedMessage, signature } (base64) → VerifiedSignIn */
  verify: '/api/v1/auth/verify',
  /** GET → SessionInfo | null */
  session: '/api/v1/auth/session',
  /** POST → { ok: true } (clears the session cookie) */
  logout: '/api/v1/auth/logout',
} as const;

export interface VerifiedSignIn {
  address: string;
  verified: true;
  /** True when the server issued the HttpOnly session cookie (AUTH_SECRET configured). */
  session: boolean;
  /** Session expiry (ms epoch) when `session` is true. */
  expiresAt?: number;
}

export interface SessionInfo {
  address: string;
  expiresAt: number;
}

async function authRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
    });
  } catch (cause) {
    throw new WalletError('network', 'ORBYT could not be reached. Check your connection and try again.', { cause });
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    const text = typeof message === 'string' && message.length < 200 ? message : `Sign-in service error (${res.status}).`;
    throw new WalletError(res.status >= 500 || res.status === 429 ? 'network' : 'verification', text);
  }
  return body;
}

function isChallenge(value: unknown): value is SignInChallenge {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.nonce === 'string' &&
    NONCE_RE.test(c.nonce) &&
    ['issuedAt', 'expiresAt', 'domain', 'uri', 'statement', 'version', 'chainId'].every((k) => typeof c[k] === 'string' && c[k] !== '')
  );
}

export async function fetchChallenge(): Promise<SignInChallenge> {
  const body = await authRequest(AUTH_ROUTES.nonce);
  if (!isChallenge(body)) throw new WalletError('verification', 'ORBYT returned an invalid sign-in challenge.');
  return body;
}

export async function submitSignIn(proof: { address: string; signedMessage: Uint8Array; signature: Uint8Array }): Promise<VerifiedSignIn> {
  const body = (await authRequest(AUTH_ROUTES.verify, {
    method: 'POST',
    body: JSON.stringify({
      address: proof.address,
      signedMessage: bytesToBase64(proof.signedMessage),
      signature: bytesToBase64(proof.signature),
    }),
  })) as Partial<VerifiedSignIn> | null;
  if (!body || body.verified !== true || body.address !== proof.address) {
    throw new WalletError('verification', 'ORBYT could not verify the signature.');
  }
  return {
    address: body.address,
    verified: true,
    session: body.session === true,
    ...(typeof body.expiresAt === 'number' ? { expiresAt: body.expiresAt } : {}),
  };
}

/** Current server session (HttpOnly cookie), or null. Never throws. */
export async function fetchSession(): Promise<SessionInfo | null> {
  try {
    const body = (await authRequest(AUTH_ROUTES.session)) as Partial<SessionInfo> | null;
    if (!body || !isSolanaAddress(body.address) || typeof body.expiresAt !== 'number') return null;
    return { address: body.address, expiresAt: body.expiresAt };
  } catch {
    return null;
  }
}

/** Clear the server session cookie. Never throws. */
export async function endSession(): Promise<void> {
  try {
    await authRequest(AUTH_ROUTES.logout, { method: 'POST', body: '{}' });
  } catch {
    /* the cookie expires on its own */
  }
}

/**
 * Full sign-in: challenge → wallet signature → server verification. The
 * returned address is the account the wallet actually signed with (a
 * solana:signIn wallet may pick a different account than requested).
 */
export async function signInWithWallet(wallet: Wallet, account: WalletAccount): Promise<VerifiedSignIn> {
  const challenge = await fetchChallenge();
  let address = account.address;
  let signed: SignedBytes;
  if (hasFeature(wallet, SolanaSignIn)) {
    const fields = challengeFields(challenge, account.address);
    const out = await signInWith(wallet, {
      domain: fields.domain,
      address: fields.address,
      statement: fields.statement,
      uri: fields.uri,
      version: fields.version,
      chainId: fields.chainId,
      nonce: fields.nonce,
      issuedAt: fields.issuedAt,
      expirationTime: fields.expirationTime,
    });
    address = out.account.address;
    signed = out;
  } else if (hasFeature(wallet, SolanaSignMessage)) {
    const message = utf8Bytes(buildSignInMessage(challengeFields(challenge, account.address)));
    signed = await signMessageWith(wallet, account, message);
  } else {
    throw new WalletError('unsupported', `${wallet.name} cannot sign messages, so it cannot sign in. You can still use it connected.`);
  }
  return submitSignIn({ address, ...signed });
}
