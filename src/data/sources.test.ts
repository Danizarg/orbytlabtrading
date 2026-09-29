import { describe, expect, it, vi } from 'vitest';
import type { ApiEnvelope } from '@/lib/core/api';
import { ChainError, type ChainStep } from '@/lib/core/chain';
import type { ProviderId } from '@/lib/core/providers';
import type { Sourced } from '@/lib/core/types';
import { ProviderError, type ProviderErrorCode } from '@/lib/net/errors';
import { fromEnvelope, isRetryableAttempt, isServerStale, runWithServerFallback, server } from './sources';

function ok(id: ProviderId, data: number[]): ChainStep<number[]> {
  return { id, run: async (): Promise<Sourced<number[]>> => ({ data, source: id, fetchedAt: 1, freshness: 'indexed' }) };
}

function fail(id: ProviderId, code: ProviderErrorCode): ChainStep<number[]> {
  return {
    id,
    run: async () => {
      throw new ProviderError(id, code, `${id}: ${code}`);
    },
  };
}

function serverStep(data: number[] | Error) {
  const run = vi.fn(async (): Promise<Sourced<number[]>> => {
    if (data instanceof Error) throw data;
    return { data, source: 'dexscreener', fetchedAt: 2, freshness: 'indexed' };
  });
  return { step: { id: 'orbyt' as const, run }, run };
}

const nonEmpty = { accept: (r: Sourced<number[]>) => r.data.length > 0 };

describe('runWithServerFallback', () => {
  it('never calls the server when a direct source answers', async () => {
    const s = serverStep([9]);
    const result = await runWithServerFallback('t', [fail('jupiter', 'rate_limited'), ok('dexscreener', [1])], s.step, nonEmpty);
    expect(result.data).toEqual([1]);
    expect(s.run).not.toHaveBeenCalled();
  });

  it('asks the server after rate-limited browser sources and names it the winner', async () => {
    const s = serverStep([7]);
    const result = await runWithServerFallback('t', [fail('jupiter', 'rate_limited'), fail('geckoterminal', 'network')], s.step, nonEmpty);
    expect(result.data).toEqual([7]);
    expect(result.source).toBe('dexscreener');
    expect(result.attempts.map((a) => [a.provider, a.ok])).toEqual([
      ['jupiter', false],
      ['geckoterminal', false],
      ['orbyt', true],
    ]);
  });

  it('also asks the server when a source failed and the rest answered empty', async () => {
    const s = serverStep([3]);
    const result = await runWithServerFallback('t', [ok('dexscreener', []), fail('geckoterminal', 'rate_limited')], s.step, nonEmpty);
    expect(result.data).toEqual([3]);
    expect(s.run).toHaveBeenCalledOnce();
  });

  it('skips the server when every source answered "no data" (same indexes) and keeps the honest empty answer', async () => {
    const s = serverStep([3]);
    const result = await runWithServerFallback('t', [ok('dexscreener', []), ok('geckoterminal', [])], s.step, nonEmpty);
    expect(result.data).toEqual([]);
    expect(s.run).not.toHaveBeenCalled();
  });

  it('skips the server on a definitive not-found and keeps the ChainError (allNotFound)', async () => {
    const s = serverStep([3]);
    const error = await runWithServerFallback('t', [fail('jupiter', 'not_found'), fail('geckoterminal', 'not_found')], s.step, nonEmpty).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).allNotFound).toBe(true);
    expect(s.run).not.toHaveBeenCalled();
  });

  it('asks the server when no direct source could run', async () => {
    const s = serverStep([5]);
    const result = await runWithServerFallback('t', [false, null], s.step, nonEmpty);
    expect(result.data).toEqual([5]);
  });

  it('reports every attempt when the server fails too', async () => {
    const s = serverStep(new ProviderError('orbyt', 'rate_limited', 'orbyt: 503'));
    const error = await runWithServerFallback('t', [fail('geckoterminal', 'rate_limited')], s.step, nonEmpty).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).attempts.map((a) => [a.provider, a.code])).toEqual([
      ['geckoterminal', 'rate_limited'],
      ['orbyt', 'rate_limited'],
    ]);
  });

  it('returns the empty direct answer (with the server attempt) when the server has nothing usable either', async () => {
    const s = serverStep([]);
    const result = await runWithServerFallback('t', [ok('dexscreener', []), fail('geckoterminal', 'timeout')], s.step, nonEmpty);
    expect(result.data).toEqual([]);
    expect(result.source).toBe('dexscreener');
    expect(result.attempts.at(-1)).toMatchObject({ provider: 'orbyt', ok: false, code: 'empty' });
  });

  it('throws (keeps the last good data) instead of an empty answer when a source failed and the server failed too', async () => {
    const s = serverStep(new ProviderError('orbyt', 'rate_limited', 'orbyt: 503'));
    const error = await runWithServerFallback('t', [ok('dexscreener', []), fail('geckoterminal', 'network')], s.step, nonEmpty).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).allNotFound).toBe(false);
    expect((error as ChainError).attempts.map((a) => [a.provider, a.code])).toEqual([
      ['dexscreener', 'empty'],
      ['geckoterminal', 'network'],
      ['orbyt', 'rate_limited'],
    ]);
  });

  it('propagates aborts without asking the server', async () => {
    const s = serverStep([1]);
    const aborted: ChainStep<number[]> = {
      id: 'jupiter',
      run: async () => {
        throw new ProviderError('jupiter', 'aborted', 'jupiter: aborted');
      },
    };
    await expect(runWithServerFallback('t', [aborted], s.step, nonEmpty)).rejects.toMatchObject({ code: 'aborted' });
    expect(s.run).not.toHaveBeenCalled();
  });

  it('classifies retryable attempts', () => {
    expect(isRetryableAttempt({ provider: 'jupiter', ok: false, code: 'rate_limited' })).toBe(true);
    expect(isRetryableAttempt({ provider: 'jupiter', ok: false, code: 'timeout' })).toBe(true);
    expect(isRetryableAttempt({ provider: 'jupiter', ok: false })).toBe(true);
    for (const code of ['empty', 'not_found', 'not_configured', 'unsupported']) {
      expect(isRetryableAttempt({ provider: 'jupiter', ok: false, code })).toBe(false);
    }
    expect(isRetryableAttempt({ provider: 'jupiter', ok: true })).toBe(false);
  });
});

describe('server proxies', () => {
  const envelope = (stale: boolean): ApiEnvelope<number[]> => ({
    data: [1],
    meta: { generatedAt: 10, dataAsOf: 5, primary: 'geckoterminal', freshness: 'indexed', sources: [{ provider: 'geckoterminal', ok: true, fetchedAt: 5 }], stale },
  });

  it('flags a stale-if-error server answer', () => {
    expect(isServerStale(fromEnvelope(envelope(true)))).toBe(true);
    expect(isServerStale(fromEnvelope(envelope(false)))).toBe(false);
    expect(fromEnvelope(envelope(false))).not.toHaveProperty('stale');
    expect(isServerStale(undefined)).toBe(false);
  });

  it('exposes the keyless candles proxy with the keyless GeckoTerminal intervals only', () => {
    expect(server.candlesKeyless.id).toBe('orbyt');
    expect([...server.candlesKeyless.intervals]).toEqual(['1m', '5m', '15m', '1h', '4h', '1d']);
    expect(server.pools.id).toBe('orbyt');
  });

  it('calls the ORBYT routes with the query (keyless candles and pools)', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(envelope(false)), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await server.candlesKeyless.getCandles({ mint: 'M', pool: 'P', interval: '5m', before: 100, limit: 300 }, undefined);
      await server.pools.getPools('M', undefined);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls).toEqual(['/api/v1/candles?mint=M&pool=P&interval=5m&before=100&limit=300', '/api/v1/pools?mint=M']);
  });
});
