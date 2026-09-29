import 'server-only';
import { address as toAddress, getAddressEncoder, getPublicKeyFromAddress, signatureBytes, verifySignature } from '@solana/kit';
import { isSolanaAddress } from '@/lib/core/solana';
import { base64ToBytes, utf8Text } from '../bytes';
import {
  parseIsoTime,
  parseSignInMessage,
  SIGN_IN_CLOCK_SKEW_MS,
  SIGN_IN_MAX_MESSAGE_BYTES,
  SIGN_IN_TTL_MS,
  SIWS_ACCEPTED_CHAIN_IDS,
  SIWS_VERSION,
} from '../siws';
import { checkNonce, type NonceLedger } from './tokens';

/**
 * Server verification of a Sign-In With Solana proof: the message must be a
 * well-formed SIWS message for THIS host, this address, Solana mainnet and a
 * fresh nonce, and the Ed25519 signature must verify against the address's
 * public key (WebCrypto via @solana/kit).
 */

export interface SignInProof {
  address: unknown;
  /** base64 of the exact bytes the wallet signed. */
  signedMessage: unknown;
  /** base64 Ed25519 signature (64 bytes). */
  signature: unknown;
}

export interface VerifyContext {
  /** Host the request was made to (e.g. "www.orbytai.org" or "localhost:3000"). */
  host: string;
  secret?: string;
  now?: number;
  /** Replay guard; a nonce is claimed before the signature check and released only if the signature is invalid. */
  ledger?: NonceLedger;
}

export type VerifyOutcome =
  | { ok: true; address: string; nonce: string }
  | { ok: false; status: 400 | 401; code: string; message: string };

const invalid = (message: string): VerifyOutcome => ({ ok: false, status: 400, code: 'bad_request', message });
const denied = (message: string): VerifyOutcome => ({ ok: false, status: 401, code: 'unauthorized', message });

const P = 2n ** 255n - 19n;
/** y of the order-8 torsion points (libsodium's small-order blocklist). */
const Y_ORDER_8 = 2707385501144840649318225287225658788936804267575313519463743609750303402022n;
/**
 * y coordinates (sign bit ignored) of every small-order Ed25519 point,
 * including the non-canonical encodings p and p + 1.
 */
const SMALL_ORDER_Y: ReadonlySet<bigint> = new Set([0n, 1n, Y_ORDER_8, P - Y_ORDER_8, P - 1n, P, P + 1n]);

/**
 * True when a 32-byte Ed25519 public key encodes a point of small order.
 * OpenSSL (and so Node's WebCrypto) does not reject these keys: for the
 * identity key an all-zero signature verifies for ANY message, so they must
 * be refused before verifying. Nobody holds a private key for them.
 */
export function isSmallOrderPublicKey(publicKey: Uint8Array): boolean {
  if (publicKey.length !== 32) return true;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? (publicKey[i] ?? 0) & 0x7f : (publicKey[i] ?? 0));
  return SMALL_ORDER_Y.has(y);
}

/** Ed25519 check of `message` against the public key encoded by `address`. Never throws. */
export async function verifyEd25519(address: string, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  if (!isSolanaAddress(address) || signature.length !== 64) return false;
  try {
    if (isSmallOrderPublicKey(new Uint8Array(getAddressEncoder().encode(toAddress(address))))) return false;
    const key = await getPublicKeyFromAddress(toAddress(address));
    return await verifySignature(key, signatureBytes(signature), message);
  } catch {
    return false;
  }
}

function sameHost(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export async function verifySignInProof(proof: SignInProof, ctx: VerifyContext): Promise<VerifyOutcome> {
  const now = ctx.now ?? Date.now();
  if (!isSolanaAddress(proof.address)) return invalid('address must be a Solana address.');
  const address = proof.address;

  const signature = base64ToBytes(proof.signature, 64);
  if (!signature || signature.length !== 64) return invalid('signature must be a base64 Ed25519 signature.');
  const bytes = base64ToBytes(proof.signedMessage, SIGN_IN_MAX_MESSAGE_BYTES);
  if (!bytes) return invalid('signedMessage must be base64 and at most 2 KB.');
  const text = utf8Text(bytes);
  const message = text === null ? null : parseSignInMessage(text);
  if (!message) return invalid('signedMessage is not a Sign-In With Solana message.');

  if (!ctx.host || !sameHost(message.domain, ctx.host)) return denied('This sign-in message was created for a different site.');
  if (message.address !== address) return denied('The signed message is for a different wallet address.');
  if (message.version !== SIWS_VERSION) return denied('Unsupported sign-in message version.');
  if (!message.chainId || !SIWS_ACCEPTED_CHAIN_IDS.has(message.chainId)) return denied('Sign-in must be for Solana mainnet.');
  if (message.uri !== undefined) {
    let uriHost: string | undefined;
    try {
      uriHost = new URL(message.uri).host;
    } catch {
      uriHost = undefined;
    }
    if (!uriHost || !sameHost(uriHost, ctx.host)) return denied('This sign-in message was created for a different site.');
  }

  const issuedAt = parseIsoTime(message.issuedAt);
  if (issuedAt === undefined) return denied('The sign-in message has no valid Issued At time.');
  if (issuedAt > now + SIGN_IN_CLOCK_SKEW_MS) return denied('The sign-in message is dated in the future. Check your device clock.');
  if (now - issuedAt > SIGN_IN_TTL_MS) return denied('Sign-in request expired. Please sign in again.');
  if (message.expirationTime !== undefined) {
    const exp = parseIsoTime(message.expirationTime);
    if (exp === undefined || exp <= now) return denied('Sign-in request expired. Please sign in again.');
  }
  if (message.notBefore !== undefined) {
    const nbf = parseIsoTime(message.notBefore);
    if (nbf === undefined || nbf > now + SIGN_IN_CLOCK_SKEW_MS) return denied('The sign-in message is not valid yet.');
  }

  const nonceCheck = await checkNonce(message.nonce, { secret: ctx.secret, now });
  if (!nonceCheck.ok) return denied(nonceCheck.reason);
  const nonce = message.nonce!;
  // Claim the nonce synchronously BEFORE the (async) signature check, so two
  // concurrent submissions of the same proof cannot both pass; release it if
  // the signature turns out to be invalid.
  const ledgerExpiry = Math.min(nonceCheck.expiresAtMs, issuedAt + SIGN_IN_TTL_MS) + SIGN_IN_CLOCK_SKEW_MS;
  if (ctx.ledger && !ctx.ledger.claim(nonce, ledgerExpiry, now)) return denied('This sign-in request was already used. Please sign in again.');

  if (!(await verifyEd25519(address, bytes, signature))) {
    ctx.ledger?.release(nonce);
    return denied('The signature does not match this wallet.');
  }
  return { ok: true, address, nonce };
}
