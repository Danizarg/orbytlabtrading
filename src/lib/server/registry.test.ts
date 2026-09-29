import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonFetcher } from '@/lib/net/types';

const fetchJson = vi.fn();
vi.mock('./http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http')>();
  return { ...actual, fetchJson: (...args: unknown[]) => fetchJson(...args) };
});

const { geckoKeyless, KEYLESS_GECKO_REQUEST, limitedFetcher } = await import('./registry');

const MINT = '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv';

afterEach(() => {
  vi.useRealTimers();
  fetchJson.mockReset();
});

describe('limitedFetcher (keyless server cap)', () => {
  it('fails fast as rate_limited beyond the cap, without calling upstream, and frees slots as the window slides', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const base = vi.fn(async () => 'ok');
    const fetcher = limitedFetcher(2, 10_000, base as unknown as JsonFetcher);
    await fetcher('jupiter', 'https://example.test/a');
    await fetcher('jupiter', 'https://example.test/b');
    await expect(fetcher('jupiter', 'https://example.test/c')).rejects.toMatchObject({ provider: 'jupiter', code: 'rate_limited' });
    expect(base).toHaveBeenCalledTimes(2);
    vi.setSystemTime(1_010_000);
    await expect(fetcher('jupiter', 'https://example.test/d')).resolves.toBe('ok');
    expect(base).toHaveBeenCalledTimes(3);
  });
});

describe('geckoKeyless (server)', () => {
  it('bounds the wait for a budget slot so a route cannot queue past its maxDuration', async () => {
    fetchJson.mockResolvedValue({ data: [] });
    await geckoKeyless().getPools(MINT);
    expect(fetchJson).toHaveBeenCalledOnce();
    const [provider, url, init] = fetchJson.mock.calls[0] as [string, string, { budgetMs?: number; timeoutMs?: number }];
    expect(provider).toBe('geckoterminal');
    expect(url).toContain(`/tokens/${MINT}/pools`);
    expect(init.budgetMs).toBe(KEYLESS_GECKO_REQUEST.budgetMs);
    expect(init.timeoutMs).toBe(KEYLESS_GECKO_REQUEST.timeoutMs);
    // Waiting for a slot plus one attempt stays well inside the 20–30 s route limits.
    expect(KEYLESS_GECKO_REQUEST.budgetMs + KEYLESS_GECKO_REQUEST.timeoutMs).toBeLessThanOrEqual(10_000);
  });
});
