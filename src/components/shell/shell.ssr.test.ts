import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { UseSearchResult } from '@/data/hooks/useSearch';
import { addressActions, parseSearchQuery, type RankedHit } from '@/data/hooks/useSearch';

/**
 * Server-render smoke tests (node environment, no DOM renderer): the shell
 * and app-level states must render on the server with no data, no sockets
 * and no browser APIs, exactly as Next streams them before hydration.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/discover',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children?: ReactNode; prefetch?: boolean }) =>
    createElement('a', { href, ...rest }, children),
}));

const { AppShell } = await import('./AppShell');
const { SearchResults } = await import('./SearchResults');
const { buildOptions } = await import('./search-options');
const { default: NotFound } = await import('@/app/not-found');
const { default: Loading } = await import('@/app/loading');
const { default: RouteError } = await import('@/app/error');

/** Drop React's text-node separators so assertions read like the rendered text. */
const text = (html: string) => html.replaceAll('<!-- -->', '');

function withQuery(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, node);
}

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';

function searchState(patch: Partial<UseSearchResult>): UseSearchResult {
  return {
    parsed: { kind: 'empty' },
    actions: [],
    accountPending: false,
    hits: [],
    attempts: [],
    isLoading: false,
    isStale: false,
    offline: false,
    error: null,
    resolving: false,
    retry: () => {},
    resolve: async () => ({ actions: [], hits: [] }),
    ...patch,
  };
}

describe('AppShell (server render)', () => {
  const html = text(renderToString(withQuery(createElement(AppShell, null, createElement('p', null, 'page body')))));

  it('renders header, page and status bar', () => {
    expect(html).toContain('page body');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('Search token, mint or wallet');
    expect(html).toContain('aria-label="Main"');
    expect(html).toMatch(/href="\/discover"[^>]*aria-current="page"/);
    expect(html).toContain('Deposit');
  });

  it('shows attribution and the no-custody disclaimer', () => {
    expect(html).toContain('on-chain data powered by GeckoTerminal');
    expect(html).toContain('TradingView Lightweight Charts');
    expect(html).toContain('Market data only · No custody · No trade execution · Not financial advice');
  });

  it('never claims health or prices it has not observed', () => {
    expect(html).toContain('Connection status: Idle');
    expect(html).not.toContain('Operational');
    // No price yet: a loading placeholder, never a number.
    expect(html).toContain('title="Loading SOL price"');
    expect(html).not.toMatch(/\$\d/);
  });
});

describe('SearchResults (server render)', () => {
  const render = (search: UseSearchResult, variant: 'inline' | 'sheet' = 'inline') => {
    const options = buildOptions({ actions: search.actions, hits: search.hits, recent: [] });
    return text(renderToString(
      createElement(SearchResults, {
        variant,
        listboxId: 'lb',
        optionId: (i: number) => `opt-${i}`,
        options,
        active: 0,
        search,
        onHover: () => {},
        onPick: () => {},
        onClearRecent: () => {},
      }),
    ));
  };

  it('renders address shortcuts and token rows as listbox options with honest gaps', () => {
    const parsed = parseSearchQuery(BONK);
    const hit: RankedHit = {
      mint: BONK,
      symbol: 'Bonk',
      name: 'Bonk',
      verified: true,
      marketCapUsd: 1_500_000_000,
      launchpad: { stage: 'graduated', launchpad: 'pump.fun' },
      source: 'jupiter',
      sources: ['jupiter'],
    };
    const html = render(searchState({ parsed, actions: addressActions(parsed), hits: [hit], attempts: [{ provider: 'jupiter', ok: true, hits: 1 }] }));
    expect(html.match(/role="option"/g)).toHaveLength(3);
    expect(html).toContain('id="opt-0"');
    expect(html).toMatch(/id="opt-0"[^>]*aria-selected="true"/);
    expect(html).toContain('Open token');
    expect(html).toContain('Open wallet');
    expect(html).toContain('Verified on Jupiter');
    expect(html).toContain('Migrated · pump.fun');
    expect(html).toContain('$1.5B');
    // Liquidity unknown → em dash, never $0.
    expect(html).toContain('—');
    expect(html).not.toContain('$0');
    expect(html).toContain('via Jupiter');
  });

  it('renders loading, empty, error and short-query states', () => {
    expect(render(searchState({ parsed: parseSearchQuery('bonk'), isLoading: true }))).toContain('aria-hidden="true"');
    expect(render(searchState({ parsed: parseSearchQuery('zzzz') }))).toContain('No tokens match “zzzz”.');
    expect(render(searchState({ parsed: parseSearchQuery('b') }))).toContain('Type at least 2 characters');
    const failed = render(
      searchState({
        parsed: parseSearchQuery('bonk'),
        error: Object.assign(new Error('x'), { name: 'SearchError', attempts: [{ provider: 'jupiter' as const, ok: false, code: 'rate_limited' as const }] }) as UseSearchResult['error'],
      }),
    );
    expect(failed).toContain('Search unavailable · Jupiter rate limited');
    expect(failed).toContain('Retry');
    expect(failed).toContain('aria-live="polite">Search unavailable<');
  });

  it('offers only the wallet route for a classified wallet, without a "no token" notice', () => {
    const parsed = parseSearchQuery(WIF);
    const account = { kind: 'wallet' } as const;
    const html = render(searchState({ parsed, account, actions: addressActions(parsed, account), attempts: [{ provider: 'jupiter', ok: true, hits: 0 }] }));
    expect(html).toContain('aria-label="Wallet"');
    expect(html).toContain('Open wallet');
    expect(html).not.toContain('Open token');
    expect(html).not.toContain('No token found');
    expect(html).toContain('aria-live="polite">Wallet<');
  });

  it('puts the token a pool address trades before the explorer link', () => {
    const parsed = parseSearchQuery(WIF);
    const account = { kind: 'program-account', owner: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' } as const;
    const hit: RankedHit = { mint: BONK, symbol: 'Bonk', source: 'dexscreener', sources: ['dexscreener'] };
    const html = render(searchState({ parsed, account, actions: addressActions(parsed, account), hits: [hit] }));
    const first = html.match(/<a[^>]*id="opt-0"[^>]*>/)?.[0];
    expect(first).toContain(`href="/trade/${BONK}"`);
    expect(html).toContain(`https://solscan.io/account/${WIF}`);
    expect(html).not.toContain(`/trade/${WIF}`);
  });

  it('says when lookups are paused offline instead of reporting no matches', () => {
    const html = render(searchState({ parsed: parseSearchQuery('bonk'), offline: true }));
    expect(html).toContain('Offline · search resumes when the connection returns.');
    expect(html).not.toContain('No tokens match');
  });

  it('labels signature shortcuts as a transaction', () => {
    const sig = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
    const parsed = parseSearchQuery(sig);
    const html = render(searchState({ parsed, actions: addressActions(parsed) }), 'sheet');
    expect(html).toContain('aria-label="Transaction"');
    expect(html).toContain(`https://solscan.io/tx/${sig}`);
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe('ConnectionPanel (server render)', () => {
  it('lists streams, keyless providers and server providers with their states', async () => {
    const { ConnectionPanel } = await import('./StreamStatus');
    const { buildSystemHealth } = await import('./health');
    const { deriveCapabilities } = await import('@/lib/config/capabilities');
    const now = Date.UTC(2026, 8, 29, 12);
    const configured = { helius: true, birdeye: false, solanatracker: false, coingecko: 'demo' as const, jupiter: false, customRpc: false };
    const health = buildSystemHealth({
      now,
      online: true,
      streams: {
        pumpPortal: { badge: 'live', status: 'open', attempt: 0, consumers: 1, lastMessageAt: now - 1_000 },
        solanaWs: { badge: 'idle', status: 'closed', attempt: 0, consumers: 0 },
      },
      browser: [
        { provider: 'jupiter', lastOkAt: now - 3_000 },
        { provider: 'geckoterminal', coolingDownUntil: now + 12_000, lastError: 'geckoterminal: rate limited' },
      ],
      api: { hasData: true, updatedAt: now - 20_000, failed: false },
      report: {
        configured,
        rpc: 'helius',
        capabilities: deriveCapabilities(configured),
        providers: [{ provider: 'helius', okCount: 4, errorCount: 0, lastOkAt: now - 8_000 }],
      },
    });
    const html = text(renderToString(createElement(ConnectionPanel, { health })));
    expect(html).toContain('Degraded');
    expect(html).toContain('Live · 1s ago');
    expect(html).toContain('Cooling down · 12s');
    expect(html).toContain('Helius RPC');
    expect(html).toContain('Not configured');
    expect(html).toContain('Demo · Configured');
    expect(html).toContain('OK · checked 20s ago');
    // Only booleans / plan names ever reach the UI.
    expect(html).not.toMatch(/api[-_]?key=/i);
  });
});

describe('app-level states (server render)', () => {
  it('404 links back into the terminal', () => {
    const html = renderToString(createElement(NotFound));
    expect(html).toContain('404');
    expect(html).toContain('href="/pulse"');
  });

  it('loading is announced and error offers retry without leaking details in production', () => {
    expect(renderToString(createElement(Loading))).toContain('aria-busy="true"');
    const error = Object.assign(new Error('secret upstream detail'), { digest: 'abc123' });
    const env = process.env.NODE_ENV;
    vi.stubEnv('NODE_ENV', 'production');
    const html = renderToString(createElement(RouteError, { error, retry: () => {} }));
    vi.stubEnv('NODE_ENV', env ?? 'test');
    expect(html).toContain('Retry');
    expect(html).toContain('abc123');
    expect(html).not.toContain('secret upstream detail');
  });
});
