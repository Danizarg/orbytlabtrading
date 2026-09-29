import { afterEach, describe, expect, it, vi } from 'vitest';
import { authSecret, checkNonce, createSessionToken, issueNonce, NonceLedger, readSessionToken } from './tokens';

const SECRET = 'test-secret-0123456789abcdef0123456789';
const OTHER = 'other-secret-0123456789abcdef012345678';
const ADDRESS = '8dbTV2UQXUbhAjpQ8Hf9mcpuJX7LaBWs3FDAqC2rTfc3';
const NOW = Date.UTC(2026, 8, 29, 10, 0, 0);

afterEach(() => vi.unstubAllEnvs());

describe('nonces', () => {
  it('issues alphanumeric, HMAC-signed nonces that verify until they expire', async () => {
    const issued = await issueNonce({ secret: SECRET, now: NOW });
    expect(issued.nonce).toMatch(/^[0-9a-f]{80}$/);
    expect(issued.signed).toBe(true);
    expect(issued.issuedAtMs).toBe(NOW);
    expect(issued.expiresAtMs).toBe(NOW + 10 * 60_000);

    await expect(checkNonce(issued.nonce, { secret: SECRET, now: NOW + 60_000 })).resolves.toEqual({ ok: true, expiresAtMs: issued.expiresAtMs });
    await expect(checkNonce(issued.nonce, { secret: SECRET, now: issued.expiresAtMs })).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
  });

  it('rejects tampered, foreign or unsigned nonces when a secret is set', async () => {
    const { nonce } = await issueNonce({ secret: SECRET, now: NOW });
    // Extending the expiry invalidates the mac.
    const tampered = `${nonce.slice(0, 40)}ffffffff${nonce.slice(48)}`;
    await expect(checkNonce(tampered, { secret: SECRET, now: NOW })).resolves.toMatchObject({ ok: false });
    await expect(checkNonce(nonce, { secret: OTHER, now: NOW })).resolves.toMatchObject({ ok: false });
    const unsigned = await issueNonce({ now: NOW });
    expect(unsigned.nonce).toMatch(/^[0-9a-f]{48}$/);
    await expect(checkNonce(unsigned.nonce, { secret: SECRET, now: NOW })).resolves.toMatchObject({ ok: false });
    await expect(checkNonce('bad nonce!', { secret: SECRET, now: NOW })).resolves.toMatchObject({ ok: false });
  });

  it('rejects nonces issued in the future beyond clock skew', async () => {
    const { nonce } = await issueNonce({ secret: SECRET, now: NOW + 5 * 60_000 });
    await expect(checkNonce(nonce, { secret: SECRET, now: NOW })).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/not valid yet/) });
  });

  it('only checks the shape without a secret', async () => {
    const { nonce, signed } = await issueNonce({ now: NOW });
    expect(signed).toBe(false);
    await expect(checkNonce(nonce, { now: NOW })).resolves.toMatchObject({ ok: true });
    await expect(checkNonce('short', { now: NOW })).resolves.toMatchObject({ ok: false });
  });

  it('ledger refuses reuse until expiry and stays bounded', () => {
    const ledger = new NonceLedger(3);
    ledger.add('a', NOW + 1_000, NOW);
    expect(ledger.has('a', NOW)).toBe(true);
    expect(ledger.has('a', NOW + 1_000)).toBe(false);
    ledger.add('b', NOW + 5_000, NOW);
    ledger.add('c', NOW + 5_000, NOW);
    ledger.add('d', NOW + 5_000, NOW + 2_000);
    expect(ledger.has('d', NOW + 2_000)).toBe(true);
    expect(['a', 'b', 'c', 'd'].filter((n) => ledger.has(n, NOW + 2_000)).length).toBeLessThanOrEqual(3);
  });

  it('ledger claim is check-and-record in one step, and release gives the nonce back', () => {
    const ledger = new NonceLedger();
    expect(ledger.claim('n', NOW + 1_000, NOW)).toBe(true);
    expect(ledger.claim('n', NOW + 1_000, NOW)).toBe(false);
    ledger.release('n');
    expect(ledger.claim('n', NOW + 1_000, NOW)).toBe(true);
    expect(ledger.claim('n', NOW + 2_000, NOW + 1_000)).toBe(true); // expired entries can be claimed again
  });
});

describe('session tokens', () => {
  it('signs and verifies a 7-day session', async () => {
    const { token, session } = await createSessionToken(ADDRESS, SECRET, { now: NOW });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(session).toEqual({ address: ADDRESS, issuedAtMs: NOW, expiresAtMs: NOW + 7 * 24 * 3_600_000 });
    await expect(readSessionToken(token, SECRET, NOW + 1_000)).resolves.toEqual(session);
    await expect(readSessionToken(token, SECRET, session.expiresAtMs)).resolves.toBeNull();
  });

  it('rejects forged, tampered or foreign tokens', async () => {
    const { token } = await createSessionToken(ADDRESS, SECRET, { now: NOW });
    const [payload, mac] = token.split('.') as [string, string];
    await expect(readSessionToken(token, OTHER, NOW)).resolves.toBeNull();
    const forgedPayload = Buffer.from(JSON.stringify({ v: 1, sub: '11111111111111111111111111111111', iat: NOW / 1000, exp: NOW / 1000 + 999_999 })).toString('base64url');
    await expect(readSessionToken(`${forgedPayload}.${mac}`, SECRET, NOW)).resolves.toBeNull();
    await expect(readSessionToken(`${payload}.${mac.slice(0, -2)}AA`, SECRET, NOW)).resolves.toBeNull();
    await expect(readSessionToken(`${payload}.${mac}.x`, SECRET, NOW)).resolves.toBeNull();
    // Same mac bytes, non-canonical spelling (the last char's unused low bit flipped).
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alt = alphabet[alphabet.indexOf(mac.slice(-1)) ^ 1]!;
    expect(Buffer.from(`${mac.slice(0, -1)}${alt}`, 'base64url')).toEqual(Buffer.from(mac, 'base64url'));
    await expect(readSessionToken(`${payload}.${mac.slice(0, -1)}${alt}`, SECRET, NOW)).resolves.toBeNull();
    await expect(readSessionToken('', SECRET, NOW)).resolves.toBeNull();
    await expect(readSessionToken(undefined, SECRET, NOW)).resolves.toBeNull();
  });

  it('requires a valid address', async () => {
    await expect(createSessionToken('nope', SECRET)).rejects.toThrow();
  });
});

describe('authSecret', () => {
  it('reads AUTH_SECRET and ignores short values', () => {
    vi.stubEnv('AUTH_SECRET', '');
    expect(authSecret()).toBeUndefined();
    vi.stubEnv('AUTH_SECRET', 'too-short');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(authSecret()).toBeUndefined();
    warn.mockRestore();
    vi.stubEnv('AUTH_SECRET', ` ${SECRET} `);
    expect(authSecret()).toBe(SECRET);
  });
});
