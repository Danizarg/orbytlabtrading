import { generateKeyPair, getAddressFromPublicKey, signBytes } from '@solana/kit';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as logoutPOST } from '@/app/api/v1/auth/logout/route';
import { GET as nonceGET } from '@/app/api/v1/auth/nonce/route';
import { GET as sessionGET } from '@/app/api/v1/auth/session/route';
import { POST as verifyPOST } from '@/app/api/v1/auth/verify/route';
import { bytesToBase64, utf8Bytes } from '../bytes';
import { buildSignInMessage, challengeFields, type SignInChallenge } from '../siws';
import { createSessionToken } from './tokens';

const ORIGIN = 'http://localhost:3000';
const SECRET = 'routes-test-secret-0123456789abcdef012';

afterEach(() => vi.unstubAllEnvs());

function req(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function signedProof() {
  const keys = await generateKeyPair();
  const address = await getAddressFromPublicKey(keys.publicKey);
  const challenge = (await (await nonceGET(req('/api/v1/auth/nonce'))).json()) as SignInChallenge;
  const message = utf8Bytes(buildSignInMessage(challengeFields(challenge, address)));
  const signature = new Uint8Array(await signBytes(keys.privateKey, message));
  return { address, challenge, body: { address, signedMessage: bytesToBase64(message), signature: bytesToBase64(signature) } };
}

const post = (path: string, body: unknown, headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json' }) =>
  req(path, { method: 'POST', body, headers });

describe('GET /api/v1/auth/nonce', () => {
  it('returns a no-store challenge for this host', async () => {
    vi.stubEnv('AUTH_SECRET', SECRET);
    const res = await nonceGET(req('/api/v1/auth/nonce'));
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as SignInChallenge;
    expect(body).toMatchObject({ domain: 'localhost:3000', uri: ORIGIN, version: '1', chainId: 'mainnet', signed: true });
    expect(body.nonce).toMatch(/^[0-9a-f]{80}$/);
    expect(Date.parse(body.expiresAt) - Date.parse(body.issuedAt)).toBe(10 * 60_000);
  });
});

describe('POST /api/v1/auth/verify', () => {
  it('verifies and sets an HttpOnly SameSite=Lax session cookie when AUTH_SECRET is set', async () => {
    vi.stubEnv('AUTH_SECRET', SECRET);
    const { address, body } = await signedProof();
    const res = await verifyPOST(post('/api/v1/auth/verify', body));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ address, verified: true, session: true });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^orbyt_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Max-Age=60479[89]|Max-Age=604800/);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('verifies without a session when AUTH_SECRET is not set', async () => {
    vi.stubEnv('AUTH_SECRET', '');
    const { address, body } = await signedProof();
    const res = await verifyPOST(post('/api/v1/auth/verify', body));
    expect(await res.json()).toEqual({ address, verified: true, session: false });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('refuses cross-site and non-JSON requests', async () => {
    const { body } = await signedProof();
    const crossSite = await verifyPOST(post('/api/v1/auth/verify', body, { origin: 'https://evil.example', 'content-type': 'application/json' }));
    expect(crossSite.status).toBe(403);
    const form = await verifyPOST(post('/api/v1/auth/verify', body, { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }));
    expect(form.status).toBe(415);
    const empty = await verifyPOST(post('/api/v1/auth/verify', 'nope'));
    expect(empty.status).toBe(400);
  });

  it('returns 401 with a reason for an invalid proof', async () => {
    vi.stubEnv('AUTH_SECRET', SECRET);
    const { body } = await signedProof();
    const res = await verifyPOST(post('/api/v1/auth/verify', { ...body, signature: bytesToBase64(new Uint8Array(64)) }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'The signature does not match this wallet.' } });
  });
});

describe('GET /api/v1/auth/session and POST /api/v1/auth/logout', () => {
  it('reads a valid cookie, clears a forged one, and logs out', async () => {
    vi.stubEnv('AUTH_SECRET', SECRET);
    const address = '8dbTV2UQXUbhAjpQ8Hf9mcpuJX7LaBWs3FDAqC2rTfc3';
    const { token, session } = await createSessionToken(address, SECRET);

    const ok = await sessionGET(req('/api/v1/auth/session', { headers: { cookie: `orbyt_session=${token}` } }));
    expect(await ok.json()).toEqual({ address, expiresAt: session.expiresAtMs });

    const forged = await sessionGET(req('/api/v1/auth/session', { headers: { cookie: `orbyt_session=${token.slice(0, -3)}abc` } }));
    expect(await forged.json()).toBeNull();
    expect(forged.headers.get('set-cookie')).toMatch(/orbyt_session=;.*Max-Age=0/i);

    const none = await sessionGET(req('/api/v1/auth/session'));
    expect(await none.json()).toBeNull();

    vi.stubEnv('AUTH_SECRET', '');
    const noSecret = await sessionGET(req('/api/v1/auth/session', { headers: { cookie: `orbyt_session=${token}` } }));
    expect(await noSecret.json()).toBeNull();

    const out = await logoutPOST(post('/api/v1/auth/logout', {}));
    expect(await out.json()).toEqual({ ok: true });
    expect(out.headers.get('set-cookie')).toMatch(/orbyt_session=;.*Max-Age=0/i);
    const crossSite = await logoutPOST(post('/api/v1/auth/logout', {}, { origin: 'https://evil.example', 'content-type': 'application/json' }));
    expect(crossSite.status).toBe(403);
  });
});
