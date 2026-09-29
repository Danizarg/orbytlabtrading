import { getBase58Decoder, getBase64Decoder, getBase64Encoder } from '@solana/kit';

/**
 * Isomorphic byte helpers (browser + Node/Edge). Wallets hand back raw bytes;
 * the auth routes and Jupiter speak base64.
 */

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function bytesToBase64(bytes: Uint8Array): string {
  return getBase64Decoder().decode(bytes);
}

/** Strict base64 → bytes; null for anything that is not canonical base64 or exceeds `maxBytes`. */
export function base64ToBytes(value: unknown, maxBytes = Number.POSITIVE_INFINITY): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0 || !BASE64_RE.test(value)) return null;
  // Every 4 characters decode to at most 3 bytes: reject oversized input before decoding it.
  if ((value.length / 4) * 3 > maxBytes + 2) return null;
  try {
    const bytes = new Uint8Array(getBase64Encoder().encode(value));
    return bytes.length <= maxBytes ? bytes : null;
  } catch {
    return null;
  }
}

export function bytesToBase58(bytes: Uint8Array): string {
  return getBase58Decoder().decode(bytes);
}

const utf8Encoder = new TextEncoder();

export function utf8Bytes(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

/** Strict UTF-8 decode; null when the bytes are not valid UTF-8. */
export function utf8Text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}
