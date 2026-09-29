import { describe, expect, it } from 'vitest';
import { buildSignInMessage, challengeFields, parseIsoTime, parseSignInMessage, type SignInChallenge, type SignInMessageFields } from './siws';

const ADDRESS = '8dbTV2UQXUbhAjpQ8Hf9mcpuJX7LaBWs3FDAqC2rTfc3';

const full: SignInMessageFields = {
  domain: 'www.orbytai.org',
  address: ADDRESS,
  statement: 'Sign in to ORBYT.',
  uri: 'https://www.orbytai.org',
  version: '1',
  chainId: 'mainnet',
  nonce: 'a1b2c3d4e5f6',
  issuedAt: '2026-09-29T10:00:00.000Z',
  expirationTime: '2026-09-29T10:10:00.000Z',
  notBefore: '2026-09-29T09:59:00.000Z',
  requestId: 'req-1',
  resources: ['https://www.orbytai.org/terms', 'ipfs://bafy'],
};

describe('buildSignInMessage', () => {
  it('matches the Wallet Standard solana:signIn text layout exactly', () => {
    expect(buildSignInMessage(full)).toBe(
      [
        'www.orbytai.org wants you to sign in with your Solana account:',
        ADDRESS,
        '',
        'Sign in to ORBYT.',
        '',
        'URI: https://www.orbytai.org',
        'Version: 1',
        'Chain ID: mainnet',
        'Nonce: a1b2c3d4e5f6',
        'Issued At: 2026-09-29T10:00:00.000Z',
        'Expiration Time: 2026-09-29T10:10:00.000Z',
        'Not Before: 2026-09-29T09:59:00.000Z',
        'Request ID: req-1',
        'Resources:',
        '- https://www.orbytai.org/terms',
        '- ipfs://bafy',
      ].join('\n'),
    );
  });

  it('omits absent sections', () => {
    expect(buildSignInMessage({ domain: 'localhost:3000', address: ADDRESS })).toBe(`localhost:3000 wants you to sign in with your Solana account:\n${ADDRESS}`);
    expect(buildSignInMessage({ domain: 'localhost:3000', address: ADDRESS, nonce: 'abcdefgh' })).toBe(
      `localhost:3000 wants you to sign in with your Solana account:\n${ADDRESS}\n\nNonce: abcdefgh`,
    );
  });

  it('refuses multi-line values (they would forge fields)', () => {
    expect(() => buildSignInMessage({ ...full, statement: 'hi\nNonce: evil' })).toThrow();
    expect(() => buildSignInMessage({ ...full, domain: '' })).toThrow();
  });
});

describe('parseSignInMessage', () => {
  it('round-trips every field combination', () => {
    const variants: SignInMessageFields[] = [
      full,
      { domain: 'a.b', address: ADDRESS },
      { domain: 'a.b', address: ADDRESS, statement: 'Only a statement' },
      { domain: 'a.b', address: ADDRESS, nonce: 'abcdefgh', chainId: 'solana:mainnet' },
      { domain: 'a.b', address: ADDRESS, statement: 'URI: looks like a field', uri: 'https://a.b' },
      { domain: 'a.b', address: ADDRESS, resources: ['x'] },
    ];
    for (const v of variants) expect(parseSignInMessage(buildSignInMessage(v))).toEqual(v);
  });

  it('tolerates trailing newlines but nothing else', () => {
    expect(parseSignInMessage(`${buildSignInMessage(full)}\n`)).toEqual(full);
    expect(parseSignInMessage(buildSignInMessage(full).replace('\n', '\r\n'))).toBeNull();
  });

  it('rejects out-of-order, duplicate, unknown or empty fields', () => {
    const base = `a.b wants you to sign in with your Solana account:\n${ADDRESS}\n\n`;
    expect(parseSignInMessage(`${base}Version: 1\nURI: https://a.b`)).toBeNull();
    expect(parseSignInMessage(`${base}Nonce: abcdefgh\nNonce: ijklmnop`)).toBeNull();
    expect(parseSignInMessage(`${base}Nonce: abcdefgh\nFoo: bar`)).toBeNull();
    expect(parseSignInMessage(`${base}Nonce: `)).toBeNull();
    expect(parseSignInMessage(`${base}Resources:\n- a\nNonce: x`)).toBeNull();
  });

  it('rejects wrong headers and oversized input', () => {
    expect(parseSignInMessage(`a.b wants you to sign in with your Ethereum account:\n${ADDRESS}`)).toBeNull();
    expect(parseSignInMessage(`evil site wants you to sign in with your Solana account:\n${ADDRESS}`)).toBeNull();
    expect(parseSignInMessage(`a.b wants you to sign in with your Solana account:`)).toBeNull();
    expect(parseSignInMessage(`a.b wants you to sign in with your Solana account:\n${ADDRESS}\n\nx`.padEnd(3_000, 'x'))).toBeNull();
    expect(parseSignInMessage('')).toBeNull();
  });
});

describe('challengeFields', () => {
  it('binds a server challenge to one address', () => {
    const challenge: SignInChallenge = {
      nonce: 'abcdef012345',
      issuedAt: '2026-09-29T10:00:00.000Z',
      expiresAt: '2026-09-29T10:10:00.000Z',
      domain: 'localhost:3000',
      uri: 'http://localhost:3000',
      statement: 'Sign in.',
      version: '1',
      chainId: 'mainnet',
      signed: true,
    };
    const text = buildSignInMessage(challengeFields(challenge, ADDRESS));
    expect(parseSignInMessage(text)).toMatchObject({ domain: 'localhost:3000', address: ADDRESS, nonce: 'abcdef012345', expirationTime: challenge.expiresAt });
  });

  it('parses ISO timestamps only', () => {
    expect(parseIsoTime('2026-09-29T10:00:00.000Z')).toBe(Date.UTC(2026, 8, 29, 10));
    expect(parseIsoTime('1790000000')).toBeUndefined();
    expect(parseIsoTime(undefined)).toBeUndefined();
  });
});
