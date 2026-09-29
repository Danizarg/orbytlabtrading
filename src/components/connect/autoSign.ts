import type { WalletStatus } from '@/lib/wallet/store';

/**
 * Whether the Sign-in step should open the wallet's sign-in prompt by
 * itself: right after a connect made in the dialog, or when the visitor
 * picked "Sign in" from the wallet menu. Only once per dialog, only for a
 * connected, not yet verified wallet that can sign messages; after a
 * rejection the visitor retries with the button (or skips).
 */
export function shouldAutoSignIn(input: {
  autoStart: boolean;
  alreadyRequested: boolean;
  canSign: boolean;
  verified: boolean;
  status: WalletStatus;
}): boolean {
  return input.autoStart && !input.alreadyRequested && input.canSign && !input.verified && input.status === 'connected';
}
