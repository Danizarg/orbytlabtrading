import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiEnvelope, ApiErrorBody } from '@/lib/core/api';
import { ChainError } from '@/lib/core/chain';
import type { Sourced } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import { CACHE } from '@/lib/server/respond';
import { handle, leastFresh, safeErrorText, sendSourced, sourcesOf, STALE_NOTE, withCache } from './envelope';
import { BadRequestError, NotConfiguredError } from './errors';

const RESULT: Sourced<number[]> & { attempts: { provider: 'birdeye' | 'helius'; ok: boolean; error?: string }[] } = {
  data: [1, 2],
  source: 'birdeye',
  contributors: ['coingecko'],
  fetchedAt: 1_000,
  freshness: 'fast',
  notes: ['provider note'],
  attempts: [
    { provider: 'helius', ok: false, error: 'helius: timed out' },
    { provider: 'birdeye', ok: true },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sourcesOf', () => {
  it('lists attempts then enrichment contributors, stamping fetch time on successes', () => {
    expect(sourcesOf(RESULT)).toEqual([
      { provider: 'helius', ok: false, error: 'helius: timed out' },
      { provider: 'birdeye', ok: true, fetchedAt: 1_000 },
      { provider: 'coingecko', ok: true, role: 'enrichment' },
    ]);
  });

  it('marks successful sources stale when serving after a failure', () => {
    const sources = sourcesOf(RESULT, true);
    expect(sources.filter((s) => s.stale).map((s) => s.provider)).toEqual(['birdeye', 'coingecko']);
    expect(sources[0]?.stale).toBeUndefined();
  });

  it('falls back to the result source without attempts', () => {
    expect(sourcesOf({ data: 1, source: 'solana-rpc', fetchedAt: 5, freshness: 'realtime' })).toEqual([
      { provider: 'solana-rpc', ok: true, fetchedAt: 5 },
    ]);
  });
});

describe('safeErrorText', () => {
  it('removes URLs and key=value credentials and bounds the length', () => {
    expect(safeErrorText('GET https://api.example.com/v1?x=1 failed')).toBe('GET [url] failed');
    expect(safeErrorText('rejected: api-key=abc123&x=1')).toBe('rejected: api-key=***&x=1');
    expect(safeErrorText('bad token=zzz')).toBe('bad token=***');
    expect(safeErrorText('birdeye: rate limited')).toBe('birdeye: rate limited');
    expect(safeErrorText('x'.repeat(500))).toHaveLength(160);
  });

  it('is applied to the sources of a successful envelope', async () => {
    const res = sendSourced(
      { ...RESULT, attempts: [{ provider: 'helius', ok: false, error: 'wss://rpc.example/?api-key=K down' }, { provider: 'birdeye', ok: true }] },
      CACHE.trades,
    );
    const body = (await res.json()) as ApiEnvelope<number[]>;
    expect(body.meta.sources[0]?.error).toBe('[url] down');
  });
});

describe('leastFresh', () => {
  it('returns the stalest label', () => {
    expect(leastFresh(['realtime', 'indexed', 'fast'])).toBe('indexed');
    expect(leastFresh(['stream', 'realtime'])).toBe('realtime');
    expect(leastFresh([])).toBeUndefined();
  });
});

describe('sendSourced', () => {
  it('builds the envelope with provenance and the CDN policy', async () => {
    const res = sendSourced(RESULT, CACHE.trades, { notes: ['extra'] });
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=2, stale-while-revalidate=6');
    const body = (await res.json()) as ApiEnvelope<number[]>;
    expect(body.data).toEqual([1, 2]);
    expect(body.meta).toMatchObject({ primary: 'birdeye', freshness: 'fast', stale: false, dataAsOf: 1_000, notes: ['provider note', 'extra'] });
  });

  it('flags stale payloads and caches them only briefly', async () => {
    const res = sendSourced(RESULT, CACHE.holders, { stale: true });
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=2, stale-while-revalidate=4');
    const body = (await res.json()) as ApiEnvelope<number[]>;
    expect(body.meta.stale).toBe(true);
    expect(body.meta.notes).toEqual(['provider note', STALE_NOTE]);
  });
});

describe('withCache', () => {
  it('serves the last good value flagged stale when the loader fails after expiry', async () => {
    const key = `test:${Math.random()}`;
    const first = await withCache(key, 1, 60_000, async () => 'good');
    expect(first).toEqual({ value: 'good', stale: false });
    await new Promise((r) => setTimeout(r, 5));
    const second = await withCache(key, 1, 60_000, async () => {
      throw new ProviderError('birdeye', 'timeout', 'birdeye: timeout');
    });
    expect(second).toEqual({ value: 'good', stale: true });
  });

  it('rethrows when nothing was cached', async () => {
    await expect(
      withCache(`test:${Math.random()}`, 1_000, 1_000, async () => {
        throw new ProviderError('birdeye', 'timeout', 'birdeye: timeout');
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

async function errorOf(res: Response): Promise<ApiErrorBody> {
  return (await res.json()) as ApiErrorBody;
}

describe('handle', () => {
  it('maps bad input to 400 and missing configuration to 501', async () => {
    const bad = await handle(async () => {
      throw new BadRequestError('mint must be a Solana address');
    });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).error).toEqual({ code: 'bad_request', message: 'mint must be a Solana address' });

    const off = await handle(async () => {
      throw new NotConfiguredError('Server candles need a key.');
    });
    expect(off.status).toBe(501);
    expect(off.headers.get('cache-control')).toBe('no-store');
    expect((await errorOf(off)).error.code).toBe('not_configured');
  });

  it('maps chain failures by cause without leaking internals', async () => {
    const limited = await handle(async () => {
      throw new ChainError('trades', [{ provider: 'birdeye', ok: false, error: 'birdeye: rate limited', code: 'rate_limited' }]);
    });
    expect(limited.status).toBe(503);
    const body = await errorOf(limited);
    expect(body.error.code).toBe('rate_limited');
    expect(body.meta.sources).toEqual([{ provider: 'birdeye', ok: false, error: 'birdeye: rate limited' }]);

    const missing = await handle(async () => {
      throw new ChainError('risk', [{ provider: 'birdeye', ok: false, code: 'not_found' }]);
    });
    expect(missing.status).toBe(404);

    const unconfigured = await handle(async () => {
      throw new ProviderError('helius', 'not_configured', 'helius: API key rejected (HTTP 401)');
    });
    expect(unconfigured.status).toBe(501);
  });

  it('strips URLs and credentials from chain attempt errors echoed to clients', async () => {
    const res = await handle(async () => {
      throw new ChainError('holders', [
        { provider: 'helius', ok: false, error: 'fetch failed for https://mainnet.helius-rpc.com/?api-key=SECRET123', code: 'network' },
      ]);
    });
    expect(res.status).toBe(502);
    const text = JSON.stringify(await errorOf(res));
    expect(text).not.toContain('SECRET123');
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('answers 502 for unexpected errors and logs only a short summary', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await handle(async () => {
      throw new TypeError('x is not a function');
    });
    expect(res.status).toBe(502);
    expect((await errorOf(res)).error.message).not.toContain('x is not a function');
    expect(log).toHaveBeenCalledWith('[orbyt api] x is not a function');
  });
});
