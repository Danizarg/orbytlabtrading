import type { NextRequest } from 'next/server';
import { SIGN_IN_STATEMENT, SIWS_CHAIN_ID, SIWS_VERSION, type SignInChallenge } from '@/lib/wallet/siws';
import { authSecret, issueNonce, noStoreJson, requestHost, requestOrigin } from '@/lib/wallet/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/auth/nonce → SignInChallenge
 *
 * A fresh Sign-In With Solana challenge for this host. With AUTH_SECRET set
 * the nonce is HMAC-signed and carries its own expiry (stateless); without it
 * the nonce is random and freshness is enforced through Issued At.
 */
export async function GET(request: NextRequest) {
  const issued = await issueNonce({ secret: authSecret() });
  const challenge: SignInChallenge = {
    nonce: issued.nonce,
    issuedAt: new Date(issued.issuedAtMs).toISOString(),
    expiresAt: new Date(issued.expiresAtMs).toISOString(),
    domain: requestHost(request),
    uri: requestOrigin(request),
    statement: SIGN_IN_STATEMENT,
    version: SIWS_VERSION,
    chainId: SIWS_CHAIN_ID,
    signed: issued.signed,
  };
  return noStoreJson(challenge);
}
