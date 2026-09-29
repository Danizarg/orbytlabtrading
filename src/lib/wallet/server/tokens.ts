import 'server-only';
import { isSolanaAddress } from '@/lib/core/solana';
import { base64ToBytes, bytesEqual, bytesToBase64, bytesToHex, randomHex, utf8Bytes, utf8Text } from '../bytes';
import { NONCE_RE, SIGN_IN_CLOCK_SKEW_MS, SIGN_IN_TTL_MS } from '../siws';

/**
 * Stateless, HMAC-SHA256 signed tokens for Sign-In With Solana (WebCrypto,
 * so it runs on Node and Edge):
 *
 * - Nonce: `rand(32 hex) · iat(8 hex s) · exp(8 hex s) · mac(32 hex)`, all
 *   lowercase hex so it satisfies the SIWS alphanumeric nonce rule. Without a
 *   secret the mac is omitted and the nonce is only a random, dated value.
 * - Session: `base64url(JSON{v,sub,iat,exp}) . base64url(mac)` for the
 *   HttpOnly `orbyt_session` cookie.
 *
 * Each token type uses its own domain-separation prefix, so a nonce can
 * never be replayed as a session or vice versa.
 */

export const SESSION_COOKIE = 'orbyt_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
/** Minimum AUTH_SECRET length (characters). Shorter secrets are ignored. */
export const MIN_SECRET_LENGTH = 32;

const NONCE_PREFIX = 'orbyt:siws-nonce:v1:';
const SESSION_PREFIX = 'orbyt:session:v1:';
const SIGNED_NONCE_RE = /^[0-9a-f]{80}$/;
const MAX_SESSION_TOKEN = 512;

let warnedShortSecret = false;

/** AUTH_SECRET when configured and long enough; otherwise undefined (no sessions). */
export function authSecret(): string | undefined {
  const value = process.env.AUTH_SECRET?.trim();
  if (!value) return undefined;
  if (value.length < MIN_SECRET_LENGTH) {
    if (!warnedShortSecret) {
      warnedShortSecret = true;
      console.warn(`[orbyt auth] AUTH_SECRET is shorter than ${MIN_SECRET_LENGTH} characters and is ignored; sign-in sessions are disabled.`);
    }
    return undefined;
  }
  return value;
}

const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', utf8Bytes(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keys.set(secret, key);
    if (keys.size > 4) keys.delete(keys.keys().next().value as string);
  }
  return key;
}

export async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8Bytes(data) as BufferSource));
}

function hex8(seconds: number): string {
  return Math.max(0, Math.floor(seconds)).toString(16).padStart(8, '0').slice(-8);
}

// ---------------------------------------------------------------------------
// Nonces
// ---------------------------------------------------------------------------

export interface IssuedNonce {
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
  signed: boolean;
}

export async function issueNonce(opts: { secret?: string; now?: number; ttlMs?: number } = {}): Promise<IssuedNonce> {
  const now = opts.now ?? Date.now();
  // Whole seconds so the nonce, the ISO timestamps and the checks agree exactly.
  const iat = Math.floor(now / 1000);
  const exp = iat + Math.floor((opts.ttlMs ?? SIGN_IN_TTL_MS) / 1000);
  const body = `${randomHex(16)}${hex8(iat)}${hex8(exp)}`;
  const nonce = opts.secret ? `${body}${bytesToHex((await hmacSha256(opts.secret, `${NONCE_PREFIX}${body}`)).slice(0, 16))}` : body;
  return { nonce, issuedAtMs: iat * 1000, expiresAtMs: exp * 1000, signed: !!opts.secret };
}

export type NonceCheck = { ok: true; expiresAtMs: number } | { ok: false; reason: string };

/**
 * With a secret: the nonce must carry a valid mac and be unexpired. Without
 * one the server cannot tell its nonces apart, so only the shape is checked
 * (freshness then relies on the message's Issued At).
 */
export async function checkNonce(nonce: unknown, opts: { secret?: string; now?: number } = {}): Promise<NonceCheck> {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return { ok: false, reason: 'Sign-in nonce is malformed.' };
  if (!opts.secret) return { ok: true, expiresAtMs: (opts.now ?? Date.now()) + SIGN_IN_TTL_MS };
  if (!SIGNED_NONCE_RE.test(nonce)) return { ok: false, reason: 'Sign-in nonce was not issued by ORBYT.' };
  const body = nonce.slice(0, 48);
  const mac = nonce.slice(48);
  const expected = bytesToHex((await hmacSha256(opts.secret, `${NONCE_PREFIX}${body}`)).slice(0, 16));
  if (!bytesEqual(utf8Bytes(mac), utf8Bytes(expected))) return { ok: false, reason: 'Sign-in nonce was not issued by ORBYT.' };
  const iatMs = parseInt(body.slice(32, 40), 16) * 1000;
  const expMs = parseInt(body.slice(40, 48), 16) * 1000;
  const now = opts.now ?? Date.now();
  if (iatMs > now + SIGN_IN_CLOCK_SKEW_MS) return { ok: false, reason: 'Sign-in nonce is not valid yet.' };
  if (expMs <= now) return { ok: false, reason: 'Sign-in request expired. Please sign in again.' };
  return { ok: true, expiresAtMs: expMs };
}

/**
 * Best-effort replay guard: nonces already used on this server instance are
 * refused until they expire. (Serverless instances do not share memory; the
 * 10-minute expiry bounds replay across instances.)
 */
export class NonceLedger {
  private readonly used = new Map<string, number>();

  constructor(private readonly max = 10_000) {}

  has(nonce: string, now = Date.now()): boolean {
    const exp = this.used.get(nonce);
    return exp !== undefined && exp > now;
  }

  add(nonce: string, expiresAtMs: number, now = Date.now()): void {
    if (this.used.size >= this.max) {
      for (const [key, exp] of this.used) if (exp <= now) this.used.delete(key);
      while (this.used.size >= this.max) this.used.delete(this.used.keys().next().value as string);
    }
    this.used.set(nonce, expiresAtMs);
  }

  /**
   * Atomic check-and-record (synchronous, so no other request can interleave):
   * true when the nonce was unused and is now claimed, false on reuse.
   */
  claim(nonce: string, expiresAtMs: number, now = Date.now()): boolean {
    if (this.has(nonce, now)) return false;
    this.add(nonce, expiresAtMs, now);
    return true;
  }

  /** Give back a claimed nonce (its proof failed verification). */
  release(nonce: string): void {
    this.used.delete(nonce);
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strict base64url: only the canonical encoding is accepted (no alternative spellings of the same bytes). */
function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = base64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4), MAX_SESSION_TOKEN);
  return bytes && toBase64Url(bytes) === value ? bytes : null;
}

export interface Session {
  address: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export async function createSessionToken(address: string, secret: string, opts: { now?: number; ttlMs?: number } = {}): Promise<{ token: string; session: Session }> {
  if (!isSolanaAddress(address)) throw new Error('Session address must be a Solana address');
  const now = opts.now ?? Date.now();
  const iat = Math.floor(now / 1000);
  const exp = iat + Math.floor((opts.ttlMs ?? SESSION_TTL_MS) / 1000);
  const payload = toBase64Url(utf8Bytes(JSON.stringify({ v: 1, sub: address, iat, exp })));
  const mac = toBase64Url(await hmacSha256(secret, `${SESSION_PREFIX}${payload}`));
  return { token: `${payload}.${mac}`, session: { address, issuedAtMs: iat * 1000, expiresAtMs: exp * 1000 } };
}

/** The session in a cookie value, or null when missing, forged, malformed or expired. */
export async function readSessionToken(token: unknown, secret: string, now = Date.now()): Promise<Session | null> {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_SESSION_TOKEN) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const payload = token.slice(0, dot);
  const mac = fromBase64Url(token.slice(dot + 1));
  if (!mac) return null;
  const expected = await hmacSha256(secret, `${SESSION_PREFIX}${payload}`);
  if (!bytesEqual(mac, expected)) return null;
  const json = fromBase64Url(payload);
  const text = json ? utf8Text(json) : null;
  if (!text) return null;
  let data: { v?: unknown; sub?: unknown; iat?: unknown; exp?: unknown };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    return null;
  }
  if (data.v !== 1 || !isSolanaAddress(data.sub) || typeof data.iat !== 'number' || typeof data.exp !== 'number') return null;
  const expiresAtMs = data.exp * 1000;
  if (expiresAtMs <= now) return null;
  return { address: data.sub, issuedAtMs: data.iat * 1000, expiresAtMs };
}
