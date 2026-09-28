import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApiEnvelope, ApiErrorBody } from '@/lib/core/api';
import { GET as candles } from '@/app/api/v1/candles/route';
import { GET as discover } from '@/app/api/v1/discover/route';
import { GET as health } from '@/app/api/v1/health/route';
import { GET as holders } from '@/app/api/v1/holders/route';
import { GET as curves } from '@/app/api/v1/onchain/curves/route';
import { GET as mint } from '@/app/api/v1/onchain/mint/[mint]/route';
import { GET as pulse } from '@/app/api/v1/pulse/route';
import { GET as quote } from '@/app/api/v1/quote/route';
import { GET as risk } from '@/app/api/v1/risk/route';
import { GET as tokens } from '@/app/api/v1/tokens/route';
import { GET as trades } from '@/app/api/v1/trades/route';
import { GET as tx } from '@/app/api/v1/tx/[signature]/route';
import { GET as activity } from '@/app/api/v1/wallet/[address]/activity/route';
import { GET as portfolio } from '@/app/api/v1/wallet/[address]/portfolio/route';
import type { HealthReport } from './health';

/**
 * Route wiring with no provider keys configured: every assertion here is
 * answered before any network call (validation → 400, keyed-only routes →
 * 501, health → 200).
 */

const MINT = '4ov9rwwS4iBHeTWGCrVaQYW1HzWK51MSfs8csGAApump';
const SOL = 'So11111111111111111111111111111111111111112';
const SIG = '5vkeqCReatk7bXc41f2WXfJGLacAo8ZkcJNqQfCNr1jQAovwJ6P8cuqg4TW6Hi3My4nszgpcBC4TkdmP8CAsSchk';

const KEYS = ['HELIUS_API_KEY', 'BIRDEYE_API_KEY', 'SOLANATRACKER_API_KEY', 'COINGECKO_API_KEY', 'COINGECKO_API_PLAN', 'JUPITER_API_KEY', 'SOLANA_RPC_URL'];

beforeAll(() => {
  for (const key of KEYS) vi.stubEnv(key, '');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function req(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`);
}

function params<T>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get('cache-control')).toBe('no-store');
  const body = (await res.json()) as ApiErrorBody;
  expect(body.error.code).toBe(code);
  expect(body.error.message).not.toMatch(/https?:\/\//);
  return body;
}

describe('input validation (400)', () => {
  it.each([
    ['trades without mint', () => trades(req('/api/v1/trades'))],
    ['trades with a bad pool', () => trades(req(`/api/v1/trades?mint=${MINT}&pool=xyz`))],
    ['trades with a bad limit', () => trades(req(`/api/v1/trades?mint=${MINT}&limit=ten`))],
    ['candles with an unknown interval', () => candles(req(`/api/v1/candles?mint=${MINT}&interval=2m`))],
    ['candles with a millisecond cursor', () => candles(req(`/api/v1/candles?mint=${MINT}&interval=1m&before=1759000000000`))],
    ['holders with a bad mint', () => holders(req('/api/v1/holders?mint=abc'))],
    ['risk without mint', () => risk(req('/api/v1/risk'))],
    ['pulse without column', () => pulse(req('/api/v1/pulse'))],
    ['pulse with an unknown column', () => pulse(req('/api/v1/pulse?column=old'))],
    ['discover with an unknown list', () => discover(req('/api/v1/discover?list=hot'))],
    ['discover with an unknown window', () => discover(req('/api/v1/discover?window=2h'))],
    ['tokens with an invalid mint', () => tokens(req(`/api/v1/tokens?mints=${MINT},nope`))],
    ['quote with a zero amount', () => quote(req(`/api/v1/quote?inputMint=${SOL}&outputMint=${MINT}&amountRaw=0&inputDecimals=9&outputDecimals=6`))],
    ['quote without decimals', () => quote(req(`/api/v1/quote?inputMint=${SOL}&outputMint=${MINT}&amountRaw=1000`))],
    ['curves without mints', () => curves(req('/api/v1/onchain/curves'))],
    ['mint with a bad address', () => mint(req('/api/v1/onchain/mint/abc'), params({ mint: 'abc' }))],
    ['portfolio with a bad address', () => portfolio(req('/api/v1/wallet/abc/portfolio'), params({ address: 'abc' }))],
    ['activity with a non-signature cursor on the public RPC', () =>
      activity(req(`/api/v1/wallet/${MINT}/activity?before=348572918:15`), params({ address: MINT }))],
    ['activity with a bad limit', () => activity(req(`/api/v1/wallet/${MINT}/activity?limit=-1`), params({ address: MINT }))],
    ['tx with a bad signature', () => tx(req(`/api/v1/tx/${MINT}?wallet=${MINT}`), params({ signature: MINT }))],
    ['tx without wallet', () => tx(req(`/api/v1/tx/${SIG}`), params({ signature: SIG }))],
  ])('%s', async (_name, call) => {
    await expectError(await call(), 400, 'bad_request');
  });
});

describe('keyed-only routes without keys (501, skipped silently by clients)', () => {
  it.each([
    ['trades', () => trades(req(`/api/v1/trades?mint=${MINT}&pool=${SOL}`))],
    ['candles', () => candles(req(`/api/v1/candles?mint=${MINT}&interval=1m`))],
    ['holders', () => holders(req(`/api/v1/holders?mint=${MINT}`))],
    ['risk', () => risk(req(`/api/v1/risk?mint=${MINT}`))],
    ['pulse', () => pulse(req('/api/v1/pulse?column=new'))],
    ['discover', () => discover(req('/api/v1/discover?list=trending&window=1h'))],
    ['tokens', () => tokens(req(`/api/v1/tokens?mints=${MINT}`))],
    ['quote', () => quote(req(`/api/v1/quote?inputMint=${SOL}&outputMint=${MINT}&amountRaw=1000000000&inputDecimals=9&outputDecimals=6`))],
  ])('%s', async (_name, call) => {
    const body = await expectError(await call(), 501, 'not_configured');
    expect(body.error.message).not.toMatch(/api-key=|x-api-key/i);
  });
});

describe('/api/v1/health', () => {
  it('reports configuration booleans, the RPC kind and derived capabilities without caching', async () => {
    const res = await health();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as ApiEnvelope<HealthReport>;
    expect(body.data.configured).toEqual({ helius: false, birdeye: false, solanatracker: false, coingecko: null, jupiter: false, customRpc: false });
    expect(body.data.rpc).toBe('public');
    expect(body.data.capabilities.serverTrades).toBe(false);
    expect(body.data.capabilities.serverQuote).toBe(false);
    expect(Array.isArray(body.data.providers)).toBe(true);
    expect(body.meta.primary).toBe('orbyt');
    expect(JSON.stringify(body)).not.toMatch(/api-key|https?:\/\//i);
  });
});
