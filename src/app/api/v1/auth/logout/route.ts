import type { NextRequest } from 'next/server';
import { clearSessionCookie, crossSiteRejection, noStoreJson } from '@/lib/wallet/server';

export const dynamic = 'force-dynamic';

/** POST /api/v1/auth/logout → { ok: true } (clears the `orbyt_session` cookie). */
export async function POST(request: NextRequest) {
  const rejected = crossSiteRejection(request);
  if (rejected) return rejected;
  const response = noStoreJson({ ok: true });
  clearSessionCookie(response, request);
  return response;
}
