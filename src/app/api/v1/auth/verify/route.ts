import type { NextRequest } from 'next/server';
import {
  authError,
  authSecret,
  createSessionToken,
  crossSiteRejection,
  noStoreJson,
  nonceLedger,
  readJsonBody,
  requestHost,
  setSessionCookie,
  verifySignInProof,
} from '@/lib/wallet/server';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/auth/verify
 * body { address, signedMessage (base64 of the exact signed bytes), signature (base64) }
 * → { address, verified: true, session: boolean, expiresAt? }
 *
 * Verifies a Sign-In With Solana proof (domain, address, chain, nonce,
 * freshness, Ed25519 signature). With AUTH_SECRET set it also issues the
 * HttpOnly `orbyt_session` cookie (7 days). Signatures are never logged.
 */
export async function POST(request: NextRequest) {
  const rejected = crossSiteRejection(request);
  if (rejected) return rejected;
  const body = await readJsonBody(request);
  if (!body) return authError(400, 'bad_request', 'Send { address, signedMessage, signature } as JSON.');

  const secret = authSecret();
  const outcome = await verifySignInProof(
    { address: body.address, signedMessage: body.signedMessage, signature: body.signature },
    { host: requestHost(request), secret, ledger: nonceLedger },
  );
  if (!outcome.ok) return authError(outcome.status, outcome.code, outcome.message);

  if (!secret) return noStoreJson({ address: outcome.address, verified: true, session: false });

  const { token, session } = await createSessionToken(outcome.address, secret);
  const response = noStoreJson({ address: outcome.address, verified: true, session: true, expiresAt: session.expiresAtMs });
  setSessionCookie(response, request, token, session.expiresAtMs);
  return response;
}
