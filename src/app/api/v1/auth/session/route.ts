import type { NextRequest } from 'next/server';
import { authSecret, clearSessionCookie, noStoreJson, readSessionToken, SESSION_COOKIE } from '@/lib/wallet/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/auth/session → { address, expiresAt } | null
 *
 * The wallet verified by the HttpOnly session cookie. Always null when
 * AUTH_SECRET is not configured (no sessions are issued then). An invalid or
 * expired cookie is cleared.
 */
export async function GET(request: NextRequest) {
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  const secret = authSecret();
  if (!cookie) return noStoreJson(null);
  const session = secret ? await readSessionToken(cookie, secret) : null;
  if (!session) {
    const response = noStoreJson(null);
    clearSessionCookie(response, request);
    return response;
  }
  return noStoreJson({ address: session.address, expiresAt: session.expiresAtMs });
}
