import { describe, expect, it } from 'vitest';
import { shouldAutoSignIn } from './autoSign';

const base = { autoStart: true, alreadyRequested: false, canSign: true, verified: false, status: 'connected' as const };

describe('shouldAutoSignIn', () => {
  it('requests the sign-in signature right after connecting', () => {
    expect(shouldAutoSignIn(base)).toBe(true);
  });

  it('asks only once, only when connected, unverified and able to sign', () => {
    expect(shouldAutoSignIn({ ...base, autoStart: false })).toBe(false);
    expect(shouldAutoSignIn({ ...base, alreadyRequested: true })).toBe(false);
    expect(shouldAutoSignIn({ ...base, canSign: false })).toBe(false);
    expect(shouldAutoSignIn({ ...base, verified: true })).toBe(false);
    for (const status of ['idle', 'connecting', 'signing', 'error'] as const) {
      expect(shouldAutoSignIn({ ...base, status })).toBe(false);
    }
  });
});
