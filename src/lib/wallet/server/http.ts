import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from './tokens';

/** Request helpers shared by the /api/v1/auth route handlers. */

const NO_STORE = { 'Cache-Control': 'no-store', Vary: 'Cookie' } as const;
const MAX_BODY_BYTES = 8_192;

/** Host the browser addressed (the Host header; Vercel routes on it, so it cannot be spoofed cross-deployment). */
export function requestHost(request: NextRequest): string {
  return (request.headers.get('host') ?? request.nextUrl.host).trim().toLowerCase();
}

export function requestOrigin(request: NextRequest): string {
  return `${request.nextUrl.protocol}//${requestHost(request)}`;
}

export function noStoreJson(body: unknown, init: { status?: number } = {}): NextResponse {
  return NextResponse.json(body, { status: init.status ?? 200, headers: NO_STORE });
}

export function authError(status: number, code: string, message: string): NextResponse {
  return noStoreJson({ error: { code, message } }, { status });
}

/**
 * State-changing auth requests must come from this site: a JSON body (which a
 * cross-site HTML form cannot send without a CORS preflight) and, when the
 * browser sends one, an Origin whose host matches.
 */
export function crossSiteRejection(request: NextRequest): NextResponse | null {
  const origin = request.headers.get('origin');
  if (origin) {
    let host: string | undefined;
    try {
      host = new URL(origin).host.toLowerCase();
    } catch {
      host = undefined;
    }
    if (host !== requestHost(request)) return authError(403, 'forbidden', 'Cross-site sign-in requests are not allowed.');
  }
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) return authError(415, 'unsupported_media_type', 'Send the request as application/json.');
  return null;
}

/** Parse a small JSON body; null when it is too large or not an object. */
export async function readJsonBody(request: NextRequest): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function secureCookies(request: NextRequest): boolean {
  return process.env.NODE_ENV === 'production' || request.nextUrl.protocol === 'https:';
}

export function setSessionCookie(response: NextResponse, request: NextRequest, token: string, expiresAtMs: number): void {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: secureCookies(request),
    sameSite: 'lax',
    path: '/',
    maxAge: Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000)),
  });
}

export function clearSessionCookie(response: NextResponse, request: NextRequest): void {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    secure: secureCookies(request),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}
