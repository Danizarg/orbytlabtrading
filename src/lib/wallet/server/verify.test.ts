import { generateKeyPair, getAddressDecoder, getAddressFromPublicKey, signBytes } from '@solana/kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { bytesToBase64, utf8Bytes } from '../bytes';
import { buildSignInMessage, SIGN_IN_STATEMENT, type SignInMessageFields } from '../siws';
import { issueNonce, NonceLedger } from './tokens';
import { isSmallOrderPublicKey, verifyEd25519, verifySignInProof } from './verify';

const SECRET = 'verify-secret-0123456789abcdef01234567';
const HOST = 'www.orbytai.org';
const NOW = Date.UTC(2026, 8, 29, 10, 0, 0);

let keys: CryptoKeyPair;
let walletAddress: string;
let otherAddress: string;

beforeAll(async () => {
  keys = await generateKeyPair();
  walletAddress = await getAddressFromPublicKey(keys.publicKey);
  otherAddress = await getAddressFromPublicKey((await generateKeyPair()).publicKey);
});

async function fields(patch: Partial<SignInMessageFields> = {}, secret: string | null = SECRET): Promise<SignInMessageFields> {
  const issued = await issueNonce({ secret: secret ?? undefined, now: NOW });
  return {
    domain: HOST,
    address: walletAddress,
    statement: SIGN_IN_STATEMENT,
    uri: `https://${HOST}`,
    version: '1',
    chainId: 'mainnet',
    nonce: issued.nonce,
    issuedAt: new Date(issued.issuedAtMs).toISOString(),
    expirationTime: new Date(issued.expiresAtMs).toISOString(),
    ...patch,
  };
}

async function proof(f: SignInMessageFields, signer: CryptoKeyPair = keys, address = walletAddress) {
  const message = utf8Bytes(buildSignInMessage(f));
  const signature = new Uint8Array(await signBytes(signer.privateKey, message));
  return { address, signedMessage: bytesToBase64(message), signature: bytesToBase64(signature) };
}

const ctx = (patch: Partial<Parameters<typeof verifySignInProof>[1]> = {}) => ({ host: HOST, secret: SECRET, now: NOW + 30_000, ...patch });

describe('verifyEd25519', () => {
  it('verifies a WebCrypto Ed25519 signature against the address', async () => {
    const message = utf8Bytes('hello');
    const sig = new Uint8Array(await signBytes(keys.privateKey, message));
    expect(await verifyEd25519(walletAddress, message, sig)).toBe(true);
    expect(await verifyEd25519(otherAddress, message, sig)).toBe(false);
    expect(await verifyEd25519(walletAddress, utf8Bytes('hellO'), sig)).toBe(false);
    expect(await verifyEd25519(walletAddress, message, sig.slice(0, 63))).toBe(false);
    expect(await verifyEd25519('not-an-address', message, sig)).toBe(false);
  });

  // Small-order points (libsodium blocklist, y little-endian; sign bit ignored).
  const P = 2n ** 255n - 19n;
  const Y8 = 2707385501144840649318225287225658788936804267575313519463743609750303402022n;
  const encodeY = (y: bigint, sign = false) => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = Number((y >> BigInt(8 * i)) & 0xffn);
    if (sign) out[31]! |= 0x80;
    return out;
  };
  const SMALL_ORDER = [0n, 1n, Y8, P - Y8, P - 1n, P, P + 1n];

  it('flags every small-order public key encoding and no real key', async () => {
    for (const y of SMALL_ORDER) {
      expect(isSmallOrderPublicKey(encodeY(y))).toBe(true);
      expect(isSmallOrderPublicKey(encodeY(y, true))).toBe(true);
    }
    const real = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    expect(isSmallOrderPublicKey(real)).toBe(false);
    expect(isSmallOrderPublicKey(encodeY(2n))).toBe(false);
    expect(isSmallOrderPublicKey(new Uint8Array(31))).toBe(true);
  });

  it('rejects forged signatures for small-order addresses (OpenSSL accepts R=identity, S=0 for the identity key)', async () => {
    // Regression: Node's WebCrypto verified an all-zero signature for 4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM on any message.
    const identity = getAddressDecoder().decode(encodeY(1n));
    expect(identity).toBe('4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM');
    const identityR = encodeY(1n);
    for (const y of [0n, 1n, Y8, P - Y8, P - 1n]) {
      const pub = encodeY(y);
      const addr = getAddressDecoder().decode(pub);
      for (let i = 0; i < 32; i++) {
        const message = utf8Bytes(`forged message ${i}`);
        const zeroS = new Uint8Array(64);
        zeroS.set(identityR, 0);
        const selfR = new Uint8Array(64);
        selfR.set(pub, 0);
        expect(await verifyEd25519(addr, message, zeroS)).toBe(false);
        expect(await verifyEd25519(addr, message, selfR)).toBe(false);
      }
    }

    // End to end: a SIWS "proof" for the identity address with the universal forgery.
    const f = await fields({ address: identity });
    const forged = new Uint8Array(64);
    forged.set(identityR, 0);
    const res = await verifySignInProof(
      { address: identity, signedMessage: bytesToBase64(utf8Bytes(buildSignInMessage(f))), signature: bytesToBase64(forged) },
      ctx(),
    );
    expect(res).toMatchObject({ ok: false, status: 401, message: expect.stringMatching(/signature does not match/) });
  });
});

describe('verifySignInProof', () => {
  it('accepts a valid proof and records the nonce against replay', async () => {
    const ledger = new NonceLedger();
    const p = await proof(await fields());
    const ok = await verifySignInProof(p, ctx({ ledger }));
    expect(ok).toMatchObject({ ok: true, address: walletAddress });

    const replay = await verifySignInProof(p, ctx({ ledger }));
    expect(replay).toMatchObject({ ok: false, status: 401, message: expect.stringMatching(/already used/) });
  });

  it('lets only one of two concurrent submissions of the same proof through', async () => {
    const ledger = new NonceLedger();
    const p = await proof(await fields());
    const results = await Promise.all([verifySignInProof(p, ctx({ ledger })), verifySignInProof(p, ctx({ ledger })), verifySignInProof(p, ctx({ ledger }))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && /already used/.test(r.message))).toHaveLength(2);
  });

  it('does not burn the nonce when the signature is invalid', async () => {
    const ledger = new NonceLedger();
    const f = await fields();
    const bad = await verifySignInProof(await proof(f, await generateKeyPair()), ctx({ ledger }));
    expect(bad).toMatchObject({ ok: false, message: expect.stringMatching(/signature does not match/) });
    expect(await verifySignInProof(await proof(f), ctx({ ledger }))).toMatchObject({ ok: true });
  });

  it('accepts solana:mainnet as the chain id and a host match ignoring case', async () => {
    expect(await verifySignInProof(await proof(await fields({ chainId: 'solana:mainnet' })), ctx({ host: 'WWW.orbytai.org' }))).toMatchObject({ ok: true });
  });

  it('rejects a message for another domain, address, chain or version', async () => {
    const cases: Array<[Partial<SignInMessageFields>, RegExp]> = [
      [{ domain: 'evil.example' }, /different site/],
      [{ uri: 'https://evil.example' }, /different site/],
      [{ chainId: 'devnet' }, /mainnet/],
      [{ chainId: undefined }, /mainnet/],
      [{ version: '2' }, /version/],
    ];
    for (const [patch, reason] of cases) {
      const res = await verifySignInProof(await proof(await fields(patch)), ctx());
      expect(res).toMatchObject({ ok: false, status: 401, message: expect.stringMatching(reason) });
    }
    // Message names another wallet than the one submitted.
    const res = await verifySignInProof(await proof(await fields({ address: otherAddress })), ctx());
    expect(res).toMatchObject({ ok: false, message: expect.stringMatching(/different wallet/) });
  });

  it('rejects a bad signature', async () => {
    const other = await generateKeyPair();
    const res = await verifySignInProof(await proof(await fields(), other), ctx());
    expect(res).toMatchObject({ ok: false, status: 401, message: expect.stringMatching(/signature does not match/) });
  });

  it('enforces nonce validity and expiry with a secret', async () => {
    const foreign = await fields({}, 'another-secret-0123456789abcdef0123456');
    expect(await verifySignInProof(await proof(foreign), ctx())).toMatchObject({ ok: false, message: expect.stringMatching(/not issued by ORBYT/) });
    const unsigned = await fields({}, null);
    expect(await verifySignInProof(await proof(unsigned), ctx())).toMatchObject({ ok: false });
    const late = await verifySignInProof(await proof(await fields()), ctx({ now: NOW + 11 * 60_000 }));
    expect(late).toMatchObject({ ok: false, message: expect.stringMatching(/expired/) });
  });

  it('without a secret still requires a fresh Issued At', async () => {
    const f = await fields({}, null);
    expect(await verifySignInProof(await proof(f), ctx({ secret: undefined }))).toMatchObject({ ok: true });
    expect(await verifySignInProof(await proof(f), ctx({ secret: undefined, now: NOW + 11 * 60_000 }))).toMatchObject({ ok: false });
    const future = await fields({ issuedAt: new Date(NOW + 5 * 60_000).toISOString(), expirationTime: undefined }, null);
    expect(await verifySignInProof(await proof(future), ctx({ secret: undefined }))).toMatchObject({ ok: false, message: expect.stringMatching(/future/) });
    const noIssuedAt = await fields({ issuedAt: undefined }, null);
    expect(await verifySignInProof(await proof(noIssuedAt), ctx({ secret: undefined }))).toMatchObject({ ok: false });
  });

  it('validates input encoding', async () => {
    const p = await proof(await fields());
    expect(await verifySignInProof({ ...p, address: 'x' }, ctx())).toMatchObject({ ok: false, status: 400 });
    expect(await verifySignInProof({ ...p, signature: 'AAAA' }, ctx())).toMatchObject({ ok: false, status: 400 });
    expect(await verifySignInProof({ ...p, signedMessage: 'not base64!' }, ctx())).toMatchObject({ ok: false, status: 400 });
    expect(await verifySignInProof({ ...p, signedMessage: bytesToBase64(utf8Bytes('hello')) }, ctx())).toMatchObject({ ok: false, status: 400 });
    expect(await verifySignInProof({ ...p, signedMessage: bytesToBase64(new Uint8Array(4_000)) }, ctx())).toMatchObject({ ok: false, status: 400 });
  });
});
