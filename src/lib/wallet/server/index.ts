import 'server-only';
import { NonceLedger } from './tokens';

/** Server-side Sign-In With Solana: challenges, proof verification and signed session cookies. */
export {
  authSecret,
  checkNonce,
  createSessionToken,
  issueNonce,
  NonceLedger,
  readSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type IssuedNonce,
  type Session,
} from './tokens';
export { isSmallOrderPublicKey, verifyEd25519, verifySignInProof, type SignInProof, type VerifyContext, type VerifyOutcome } from './verify';
export { authError, clearSessionCookie, crossSiteRejection, noStoreJson, readJsonBody, requestHost, requestOrigin, setSessionCookie } from './http';

/** Per-instance replay guard shared by the verify route. */
export const nonceLedger = new NonceLedger();
