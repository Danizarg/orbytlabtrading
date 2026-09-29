import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChainError } from '@/lib/core/chain';
import type { DiscoverQuery, ProviderId, TokenDiscoveryProvider, TokenRowsProvider } from '@/lib/core/providers';
import { MINTS } from '@/lib/core/solana';
import type { Sourced, TokenRow } from '@/lib/core/types';
import type { JsonFetcher } from '@/lib/net/types';
import { ProviderError } from '@/lib/net/errors';
import type { JupiterUltraInfo } from '@/lib/providers/jupiter';
import {
  activeFilterCount,
  baseListOf,
  buyShare,
  CLEAR_FILTERS,
  compareNullable,
  COOLDOWN_RECHECK_MS,
  createEnrichmentCache,
  createUniverseLoader,
  DEFAULT_FILTERS,
  DEFAULT_LIST,
  DEX_PROMOTED_NOTE,
  describeAttempt,
  dueAt,
  emptyEntries,
  enrichmentTarget,
  enrichRow,
  enrichRows,
  errorLines,
  filterRows,
  flagReasons,
  formatUsdInput,
  GAINERS_NOTE,
  geckoListPath,
  geckoRowsFromList,
  isExcludedMint,
  isFlagged,
  launchpadBadge,
  launchpadVenue,
  loadDexPromoted,
  loadDiscoverList,
  loadTokenRows,
  mergeRows,
  mergeUniverse,
  mintSetKey,
  needsDex,
  needsUltra,
  nextSort,
  orderByMints,
  parseDexFeed,
  parseDiscoverParams,
  parseUsdInput,
  pickNext,
  riskLevel,
  rowToTokenResult,
  serializeDiscoverParams,
  showsGeckoData,
  sortGainers,
  sortRows,
  sortValue,
  stableFetchSet,
  stageOf,
  summarizeUniverse,
  toGainers,
  txCount,
  UNIVERSE_SOURCES,
  universeBackoffMs,
  UNIVERSE_SPACING_MS,
  visibleFailures,
  withoutExcluded,
  type DiscoverFilters,
  type EnrichmentSnapshot,
  type MergeCache,
  type ProviderClock,
  type UniverseEntries,
  type UniverseEntry,
  type UniverseSourceDef,
} from './discover';

// ---------------------------------------------------------------------------
// Test fixtures (synthetic rows; never used outside tests)
// ---------------------------------------------------------------------------

const NOW = 1_790_000_000_000;

type RowInit = {
  mint: string;
  rank?: number;
  token?: Partial<TokenRow['token']>;
  market?: Partial<TokenRow['market']>;
  pool?: TokenRow['pool'];
  risk?: TokenRow['risk'];
};

function row(init: RowInit): TokenRow {
  const out: TokenRow = {
    token: { mint: init.mint, symbol: init.mint.toUpperCase(), ...init.token },
    market: { mint: init.mint, stats: {}, updatedAt: NOW, source: 'jupiter', ...init.market },
  };
  if (init.pool) out.pool = init.pool;
  if (init.risk) out.risk = init.risk;
  if (init.rank !== undefined) out.rank = init.rank;
  return out;
}

function sourced<T>(data: T, source: ProviderId): Sourced<T> {
  return { data, source, fetchedAt: NOW, freshness: 'fast' };
}

function discovery(id: ProviderId, impl: (q: DiscoverQuery) => Promise<Sourced<TokenRow[]>>): TokenDiscoveryProvider & { calls: DiscoverQuery[] } {
  const calls: DiscoverQuery[] = [];
  return {
    id,
    calls,
    discover: (q) => {
      calls.push(q);
      return impl(q);
    },
  };
}

function rowsProvider(id: ProviderId, known: Record<string, TokenRow>, fail?: Error): TokenRowsProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    id,
    calls,
    getRows: async (mints) => {
      calls.push([...mints]);
      if (fail) throw fail;
      return sourced(
        mints.map((m) => known[m]).filter((r): r is TokenRow => !!r),
        id,
      );
    },
  };
}

const mints = (rows: readonly TokenRow[]) => rows.map((r) => r.token.mint);

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

describe('parseUsdInput / formatUsdInput', () => {
  it('parses trader shorthand', () => {
    expect(parseUsdInput('10k')).toBe(10_000);
    expect(parseUsdInput('1.5M')).toBe(1_500_000);
    expect(parseUsdInput(' $50,000 ')).toBe(50_000);
    expect(parseUsdInput('2b')).toBe(2_000_000_000);
    expect(parseUsdInput('.5k')).toBe(500);
    expect(parseUsdInput('10.')).toBe(10);
  });

  it('treats empty, zero, negative and junk as "no bound"', () => {
    for (const v of ['', '0', '-5', 'abc', '1e5', '5kk', undefined, null]) expect(parseUsdInput(v)).toBeUndefined();
  });

  it('round-trips compact values', () => {
    for (const n of [500, 1_500, 1_234, 10_000, 1_050_000, 1_000_500, 2_500_000_000, 12_345.67]) {
      expect(parseUsdInput(formatUsdInput(n))).toBeCloseTo(n, 6);
    }
    expect(formatUsdInput(10_000)).toBe('10k');
    expect(formatUsdInput(1_500_000)).toBe('1.5m');
    expect(formatUsdInput(undefined)).toBe('');
  });
});

describe('parseDiscoverParams / serializeDiscoverParams', () => {
  it('defaults to the full universe ("All") and ignores invalid values', () => {
    expect(DEFAULT_LIST).toBe('all');
    const p = parseDiscoverParams({ list: 'bogus', w: '2h', stage: 'x', age: '9y', liq: 'nope' });
    expect(p).toEqual({ list: 'all', window: '1h', filters: { stage: 'all', hideFlagged: false } });
    expect(serializeDiscoverParams(p)).toBe('');
  });

  it('keeps a named list in the URL (only the default is omitted)', () => {
    expect(serializeDiscoverParams({ list: 'trending', window: '1h', filters: DEFAULT_FILTERS })).toBe('list=trending');
    expect(parseDiscoverParams(new URLSearchParams('list=trending')).list).toBe('trending');
    expect(parseDiscoverParams(new URLSearchParams('list=all')).list).toBe('all');
  });

  it('maps tabs to their upstream list', () => {
    expect(baseListOf('gainers')).toBe('trending');
    expect(baseListOf('all')).toBe('trending');
    expect(baseListOf('organic')).toBe('organic');
  });

  it('round-trips every field', () => {
    const qs = 'list=gainers&w=5m&liq=10k&mc=1.5m&age=24h&stage=bonding&flagged=hide';
    const p = parseDiscoverParams(new URLSearchParams(qs));
    expect(p).toEqual({
      list: 'gainers',
      window: '5m',
      filters: { minLiquidityUsd: 10_000, minMarketCapUsd: 1_500_000, maxAge: '24h', stage: 'bonding', hideFlagged: true },
    });
    expect(serializeDiscoverParams(p)).toBe(qs);
  });

  it('takes the first value of repeated Next searchParams', () => {
    expect(parseDiscoverParams({ list: ['new', 'top'] }).list).toBe('new');
  });

  it('clears every filter when CLEAR_FILTERS is merged over the current ones', () => {
    const p = parseDiscoverParams(new URLSearchParams('list=new&liq=10k&mc=2m&age=1h&stage=amm&flagged=hide'));
    expect(serializeDiscoverParams({ ...p, filters: { ...p.filters, ...CLEAR_FILTERS } })).toBe('list=new');
    expect(activeFilterCount({ ...p.filters, ...CLEAR_FILTERS })).toBe(0);
  });

  it('counts active filters', () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
    expect(activeFilterCount({ minLiquidityUsd: 1, minMarketCapUsd: 1, maxAge: '1h', stage: 'amm', hideFlagged: true })).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe('compareNullable', () => {
  it('keeps unknown values last in both directions', () => {
    const values = [3, undefined, 1, Number.NaN, 2];
    const asc = [...values].sort((a, b) => compareNullable(a, b, 'asc'));
    const desc = [...values].sort((a, b) => compareNullable(a, b, 'desc'));
    expect(asc.slice(0, 3)).toEqual([1, 2, 3]);
    expect(desc.slice(0, 3)).toEqual([3, 2, 1]);
    for (const list of [asc, desc]) expect(list.slice(3).every((v) => v === undefined || Number.isNaN(v))).toBe(true);
  });
});

describe('sortRows / nextSort / sortValue', () => {
  const rows = [
    row({ mint: 'a', rank: 1, market: { liquidityUsd: 100 } }),
    row({ mint: 'b', rank: 2 }),
    row({ mint: 'c', rank: 3, market: { liquidityUsd: 300 } }),
    row({ mint: 'd', rank: 4, market: { liquidityUsd: 100 } }),
  ];

  it('sorts numerically with unknowns last and stable ties', () => {
    expect(mints(sortRows(rows, { key: 'liq', dir: 'desc' }, '1h'))).toEqual(['c', 'a', 'd', 'b']);
    expect(mints(sortRows(rows, { key: 'liq', dir: 'asc' }, '1h'))).toEqual(['a', 'd', 'c', 'b']);
  });

  it('returns a copy in provider order when unsorted', () => {
    const out = sortRows(rows, null, '1h');
    expect(out).not.toBe(rows);
    expect(mints(out)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('cycles default → reversed → off', () => {
    expect(nextSort(null, 'mc')).toEqual({ key: 'mc', dir: 'desc' });
    expect(nextSort({ key: 'mc', dir: 'desc' }, 'mc')).toEqual({ key: 'mc', dir: 'asc' });
    expect(nextSort({ key: 'mc', dir: 'asc' }, 'mc')).toBeNull();
    expect(nextSort({ key: 'mc', dir: 'asc' }, 'rank')).toEqual({ key: 'rank', dir: 'asc' });
    expect(nextSort(null, 'age')).toEqual({ key: 'age', dir: 'asc' });
  });

  it('sorts age ascending as youngest first', () => {
    const aged = [
      row({ mint: 'old', token: { createdAt: NOW - 86_400_000 } }),
      row({ mint: 'unknown' }),
      row({ mint: 'young', token: { createdAt: NOW - 60_000 } }),
    ];
    expect(mints(sortRows(aged, { key: 'age', dir: 'asc' }, '1h'))).toEqual(['young', 'old', 'unknown']);
  });

  it('reads window stats and derived totals', () => {
    const r = row({ mint: 'x', market: { stats: { m5: { buys: 3, sells: 2, priceChangePct: 7 }, h1: { buys: 10 } } } });
    expect(sortValue(r, 'txns', '5m')).toBe(5);
    expect(sortValue(r, 'txns', '1h')).toBeUndefined();
    expect(sortValue(r, 'change', '5m')).toBe(7);
    expect(sortValue(r, 'change', '24h')).toBeUndefined();
  });
});

describe('gainers', () => {
  const trending = [
    row({ mint: 'flat', rank: 1, market: { stats: { h1: { priceChangePct: 0 } } } }),
    row({ mint: 'none', rank: 2 }),
    row({ mint: 'moon', rank: 3, market: { stats: { h1: { priceChangePct: 250 }, m5: { priceChangePct: -4 } } } }),
    row({ mint: 'dump', rank: 4, market: { stats: { h1: { priceChangePct: -30 }, m5: { priceChangePct: 12 } } } }),
  ];

  it('sorts by the selected window, unknown change last, and re-ranks', () => {
    const h1 = sortGainers(trending, '1h');
    expect(mints(h1)).toEqual(['moon', 'flat', 'dump', 'none']);
    expect(h1.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    expect(mints(sortGainers(trending, '5m'))).toEqual(['dump', 'moon', 'flat', 'none']);
  });

  it('labels the result as a sorted sample', () => {
    const result = toGainers({ ...sourced(trending, 'jupiter'), attempts: [{ provider: 'jupiter', ok: true }] }, '1h');
    expect(result.notes).toContain(GAINERS_NOTE);
    expect(trending[0]?.rank).toBe(1); // input untouched
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe('filterRows', () => {
  const f = (over: Partial<DiscoverFilters>): DiscoverFilters => ({ ...DEFAULT_FILTERS, ...over });

  it('excludes rows whose bounded metric is unknown', () => {
    const rows = [
      row({ mint: 'rich', market: { liquidityUsd: 50_000, marketCapUsd: 2_000_000 } }),
      row({ mint: 'poor', market: { liquidityUsd: 900, marketCapUsd: 10_000 } }),
      row({ mint: 'unknown' }),
    ];
    expect(mints(filterRows(rows, f({ minLiquidityUsd: 10_000 }), NOW))).toEqual(['rich']);
    expect(mints(filterRows(rows, f({ minMarketCapUsd: 5_000 }), NOW))).toEqual(['rich', 'poor']);
    expect(mints(filterRows(rows, DEFAULT_FILTERS, NOW))).toEqual(['rich', 'poor', 'unknown']);
  });

  it('applies max age only to rows with a known creation time', () => {
    const rows = [
      row({ mint: 'fresh', token: { createdAt: NOW - 30 * 60_000 } }),
      row({ mint: 'old', token: { createdAt: NOW - 2 * 86_400_000 } }),
      row({ mint: 'undated' }),
    ];
    expect(mints(filterRows(rows, f({ maxAge: '1h' }), NOW))).toEqual(['fresh']);
    expect(mints(filterRows(rows, f({ maxAge: '3d' }), NOW))).toEqual(['fresh', 'old']);
  });

  it('filters by launch stage with pool fallback', () => {
    const rows = [
      row({ mint: 'curve', token: { launchpad: { stage: 'bonding', launchpad: 'pump.fun' } } }),
      row({ mint: 'grad', token: { launchpad: { stage: 'graduated' } } }),
      row({ mint: 'amm', token: { launchpad: { stage: 'amm' } } }),
      row({ mint: 'pooled', pool: { address: 'p', dex: 'raydium', dexLabel: 'Raydium' } }),
      row({ mint: 'bare' }),
    ];
    expect(mints(filterRows(rows, f({ stage: 'bonding' }), NOW))).toEqual(['curve']);
    expect(mints(filterRows(rows, f({ stage: 'graduated' }), NOW))).toEqual(['grad']);
    expect(mints(filterRows(rows, f({ stage: 'amm' }), NOW))).toEqual(['amm', 'pooled']);
    expect(stageOf(rows[4]!)).toBe('unknown');
  });

  it('hides only rows with a raised flag', () => {
    const sus = row({ mint: 'sus' });
    sus.risk = { top10Pct: 10, isSus: true } as TokenRow['risk'];
    const rows = [
      sus,
      row({ mint: 'mintable', risk: { mintAuthorityDisabled: false } }),
      row({ mint: 'freezable', risk: { freezeAuthorityDisabled: false, mintAuthorityDisabled: true } }),
      row({ mint: 'clean', risk: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true } }),
      row({ mint: 'unknown' }),
    ];
    expect(flagReasons(sus)).toEqual(['Flagged suspicious']);
    expect(isFlagged(rows[4]!)).toBe(false);
    expect(mints(filterRows(rows, f({ hideFlagged: true }), NOW))).toEqual(['clean', 'unknown']);
  });
});

// ---------------------------------------------------------------------------
// Enrichment merge
// ---------------------------------------------------------------------------

describe('enrichRow (fillMissing precedence)', () => {
  const ultra = (info: Partial<JupiterUltraInfo> = {}): JupiterUltraInfo => ({ risk: {}, ...info });

  it('fills risk gaps without overwriting primary values', () => {
    const base = row({ mint: 'm', risk: { top10Pct: 22, devHoldingPct: 1 } });
    const out = enrichRow(base, { ultra: ultra({ risk: { top10Pct: 99, snipersPct: 4, insidersPct: 6, bundlersPct: 8, devHoldingPct: 50 } }) });
    expect(out.risk).toEqual({ top10Pct: 22, devHoldingPct: 1, snipersPct: 4, insidersPct: 6, bundlersPct: 8 });
    expect(base.risk).toEqual({ top10Pct: 22, devHoldingPct: 1 });
  });

  it('adds curve progress to bonding tokens only when missing', () => {
    const bonding = row({ mint: 'b', token: { launchpad: { stage: 'bonding', launchpad: 'pump.fun' } } });
    expect(enrichRow(bonding, { ultra: ultra({ progressPct: 42 }) }).token.launchpad).toEqual({
      stage: 'bonding',
      launchpad: 'pump.fun',
      progressPct: 42,
      progressSource: 'jupiter',
    });
    const exact = row({ mint: 'e', token: { launchpad: { stage: 'bonding', progressPct: 10, progressSource: 'solana-rpc' } } });
    expect(enrichRow(exact, { ultra: ultra({ progressPct: 42 }) }).token.launchpad?.progressPct).toBe(10);
    const amm = row({ mint: 'a', token: { launchpad: { stage: 'amm' } } });
    expect(enrichRow(amm, { ultra: ultra({ progressPct: 42 }) }).token.launchpad).toEqual({ stage: 'amm' });
  });

  it('derives the stage from Ultra progress when the base row has none', () => {
    expect(enrichRow(row({ mint: 'x' }), { ultra: ultra({ progressPct: 55 }) }).token.launchpad).toEqual({
      stage: 'bonding',
      progressPct: 55,
      progressSource: 'jupiter',
    });
    expect(enrichRow(row({ mint: 'y' }), { ultra: ultra({ progressPct: 100 }) }).token.launchpad).toEqual({ stage: 'graduated' });
  });

  it('keeps a known launchpad name when Ultra reveals the stage', () => {
    const named = row({ mint: 'n', token: { launchpad: { stage: 'unknown', launchpad: 'pump.fun' } } });
    expect(enrichRow(named, { ultra: ultra({ progressPct: 40 }) }).token.launchpad).toStrictEqual({
      launchpad: 'pump.fun',
      stage: 'bonding',
      progressPct: 40,
      progressSource: 'jupiter',
    });
    expect(enrichRow(named, { ultra: ultra({ progressPct: 100 }) }).token.launchpad).toStrictEqual({ launchpad: 'pump.fun', stage: 'graduated' });
  });

  it('fills pool, logo and socials from DEX Screener without overriding', () => {
    const base = row({ mint: 'm', token: { image: 'https://primary/logo.png', socials: { twitter: 'https://x.com/primary' } } });
    const dexRow = row({
      mint: 'm',
      token: { image: 'https://dex/logo.png', name: 'Dex Name', socials: { twitter: 'https://x.com/dex', website: 'https://dex.site' } },
      pool: { address: 'pool1', dex: 'pumpswap', dexLabel: 'PumpSwap', quoteSymbol: 'SOL' },
    });
    const out = enrichRow(base, { dex: dexRow });
    expect(out.token.image).toBe('https://primary/logo.png');
    expect(out.token.symbol).toBe('M');
    expect(out.token.socials).toEqual({ twitter: 'https://x.com/primary', website: 'https://dex.site' });
    expect(out.pool?.dexLabel).toBe('PumpSwap');
    expect(out.market).toBe(base.market);
  });

  it('keeps an existing pool and ignores a row for another mint', () => {
    const base = row({ mint: 'm', pool: { address: 'gt', dex: 'raydium', dexLabel: 'Raydium' } });
    const other = row({ mint: 'other', pool: { address: 'x', dex: 'orca', dexLabel: 'Orca' }, token: { image: 'https://o/l.png' } });
    expect(enrichRow(base, { dex: other })).toBe(base);
    const same = row({ mint: 'm', pool: { address: 'ds', dex: 'pumpswap', dexLabel: 'PumpSwap' } });
    expect(enrichRow(base, { dex: same }).pool?.address).toBe('gt');
  });

  it('returns the same object when nothing is filled', () => {
    const base = row({ mint: 'm', risk: { snipersPct: 1 } });
    expect(enrichRow(base, undefined)).toBe(base);
    expect(enrichRow(base, { ultra: ultra({ risk: { snipersPct: 50 } }) })).toBe(base);
    const out = enrichRows([base], { byMint: {}, errors: {} });
    expect(out[0]).toBe(base);
  });

  it('decides which rows need which enrichment', () => {
    expect(needsUltra(row({ mint: 'a' }))).toBe(true);
    expect(needsUltra(row({ mint: 'b', risk: { snipersPct: 1, insidersPct: 1, bundlersPct: 1 } }))).toBe(false);
    expect(
      needsUltra(row({ mint: 'c', risk: { snipersPct: 1, insidersPct: 1, bundlersPct: 1 }, token: { launchpad: { stage: 'bonding' } } })),
    ).toBe(true);
    expect(needsDex(row({ mint: 'd' }))).toBe(true);
    expect(needsDex(row({ mint: 'e', pool: { address: 'p', dex: 'orca', dexLabel: 'Orca' } }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Enrichment cache
// ---------------------------------------------------------------------------

describe('createEnrichmentCache', () => {
  function setup(opts: { ultraFail?: boolean } = {}) {
    let t = NOW;
    const ultraCalls: string[][] = [];
    const dexCalls: string[][] = [];
    const cache = createEnrichmentCache(
      {
        ultra: async (list) => {
          ultraCalls.push(list);
          if (opts.ultraFail) throw new ProviderError('jupiter', 'rate_limited', 'jupiter: HTTP 429');
          const out: Record<string, JupiterUltraInfo> = {};
          for (const m of list) if (m !== 'ghost') out[m] = { risk: { snipersPct: 5 } };
          return out;
        },
        dexRows: async (list) => {
          dexCalls.push(list);
          return list.filter((m) => m !== 'ghost').map((m) => row({ mint: m, pool: { address: `${m}-pool`, dex: 'pumpswap', dexLabel: 'PumpSwap' } }));
        },
      },
      { ttlMs: 55_000, ultraMinGapMs: 30_000, dexMinGapMs: 10_000, now: () => t },
    );
    return { cache, ultraCalls, dexCalls, advance: (ms: number) => (t += ms) };
  }

  it('fetches only new or stale mints, within the minimum gaps', async () => {
    const { cache, ultraCalls, dexCalls, advance } = setup();
    const first = await cache.load([row({ mint: 'a' }), row({ mint: 'b' })]);
    expect(ultraCalls).toEqual([['a', 'b']]);
    expect(dexCalls).toEqual([['a', 'b']]);
    expect(first.byMint.a?.ultra?.risk.snipersPct).toBe(5);
    expect(first.byMint.b?.dex?.pool?.address).toBe('b-pool');

    // New mint 15 s later: DEX Screener gap passed, Ultra gap not yet.
    advance(15_000);
    const second = await cache.load([row({ mint: 'a' }), row({ mint: 'b' }), row({ mint: 'c' })]);
    expect(ultraCalls).toHaveLength(1);
    expect(dexCalls).toEqual([['a', 'b'], ['c']]);
    expect(second.byMint.c?.ultra).toBeUndefined();

    // 20 s later the Ultra gap has passed: only the missing mint is requested.
    advance(20_000);
    await cache.load([row({ mint: 'a' }), row({ mint: 'b' }), row({ mint: 'c' })]);
    expect(ultraCalls).toEqual([['a', 'b'], ['c']]);

    // 25 s later a and b are past the TTL but the Ultra gap still holds them back.
    advance(25_000);
    await cache.load([row({ mint: 'a' }), row({ mint: 'b' }), row({ mint: 'c' })]);
    expect(ultraCalls).toHaveLength(2);

    // Once the gap passes, only the stale entries refresh (c is still fresh).
    advance(5_000);
    await cache.load([row({ mint: 'a' }), row({ mint: 'b' }), row({ mint: 'c' })]);
    expect(ultraCalls[2]).toEqual(['a', 'b']);
  });

  it('negative-caches unknown mints and skips rows that do not need enrichment', async () => {
    const { cache, ultraCalls, dexCalls, advance } = setup();
    const complete = row({
      mint: 'full',
      risk: { snipersPct: 1, insidersPct: 1, bundlersPct: 1 },
      pool: { address: 'p', dex: 'raydium', dexLabel: 'Raydium' },
    });
    const snap = await cache.load([row({ mint: 'ghost' }), complete]);
    expect(ultraCalls).toEqual([['ghost']]);
    expect(dexCalls).toEqual([['ghost']]);
    expect(snap.byMint.ghost).toBeUndefined();
    advance(40_000);
    await cache.load([row({ mint: 'ghost' }), complete]);
    expect(ultraCalls).toHaveLength(1);
    expect(dexCalls).toHaveLength(1);
  });

  it('reports failures, throttles retries and still serves the other source', async () => {
    const { cache, ultraCalls, advance } = setup({ ultraFail: true });
    const snap = await cache.load([row({ mint: 'a' })]);
    expect(snap.errors.ultra).toBe('jupiter: rate limited');
    expect(snap.byMint.a?.dex?.pool).toBeDefined();
    advance(5_000);
    await cache.load([row({ mint: 'a' })]);
    expect(ultraCalls).toHaveLength(1);
    advance(30_000);
    await cache.load([row({ mint: 'a' })]);
    expect(ultraCalls).toHaveLength(2);
  });

  it('covers a target longer than one batch over successive calls, new mints first', async () => {
    let t = NOW;
    const ultraCalls: string[][] = [];
    const cache = createEnrichmentCache(
      {
        ultra: async (list) => {
          ultraCalls.push(list);
          return Object.fromEntries(list.map((m) => [m, { risk: { snipersPct: 1 } }]));
        },
        dexRows: async () => [],
      },
      { ttlMs: 55_000, ultraMinGapMs: 30_000, dexMinGapMs: 0, maxMints: 2, now: () => t },
    );
    const rows = ['a', 'b', 'c', 'd', 'e'].map((m) => row({ mint: m }));
    await cache.load(rows);
    t += 30_000;
    await cache.load(rows);
    t += 30_000; // a and b are stale now, but e has never been fetched
    await cache.load(rows);
    t += 30_000;
    await cache.load(rows);
    expect(ultraCalls).toEqual([['a', 'b'], ['c', 'd'], ['e', 'a'], ['b', 'c']]);
  });

  it('serves cached data for every row, not only the fetch cap, until it is too old', async () => {
    let t = NOW;
    const cache = createEnrichmentCache(
      {
        ultra: async (list) => Object.fromEntries(list.map((m) => [m, { risk: { snipersPct: 1 } }])),
        dexRows: async () => [],
      },
      { ttlMs: 55_000, maxServeAgeMs: 120_000, maxMints: 1, now: () => t },
    );
    await cache.load([row({ mint: 'deep' })]);
    // A later view lists the mint far below the fetch cap: its cached data still renders.
    const view = [row({ mint: 'top', risk: { snipersPct: 1, insidersPct: 1, bundlersPct: 1 }, pool: { address: 'p', dex: 'orca', dexLabel: 'Orca' } }), row({ mint: 'deep' })];
    expect(cache.revision().peek(view).byMint.deep?.ultra?.risk.snipersPct).toBe(1);
    t += 120_001;
    expect(cache.revision().peek(view).byMint.deep).toBeUndefined();
  });

  it('serializes overlapping loads so mints are not requested twice', async () => {
    const ultra = vi.fn(async (list: string[]) => Object.fromEntries(list.map((m) => [m, { risk: { snipersPct: 1 } }])));
    const cache = createEnrichmentCache({ ultra, dexRows: async () => [] }, { ultraMinGapMs: 0, dexMinGapMs: 0, now: () => NOW });
    const rows = [row({ mint: 'a' })];
    await Promise.all([cache.load(rows), cache.load(rows)]);
    expect(ultra).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

describe('loadDiscoverList', () => {
  const rowsOf = (...ids: string[]) => ids.map((id, i) => row({ mint: id, rank: i + 1 }));

  it('prefers the server proxy when provided', async () => {
    const server = discovery('orbyt', async () => sourced(rowsOf('s'), 'jupiter'));
    const jupiter = discovery('jupiter', async () => sourced(rowsOf('j'), 'jupiter'));
    const gecko = discovery('geckoterminal', async () => sourced(rowsOf('g'), 'geckoterminal'));
    const result = await loadDiscoverList({ server, jupiter, gecko }, 'trending', '1h');
    expect(mints(result.data)).toEqual(['s']);
    expect(jupiter.calls).toHaveLength(0);
    expect(server.calls[0]).toEqual({ list: 'trending', window: '1h', limit: 100 });
  });

  it('skips an unconfigured server route silently and falls back on empty answers', async () => {
    const server = discovery('orbyt', async () => {
      throw new ProviderError('orbyt', 'not_configured', 'orbyt: not configured', { status: 501 });
    });
    const jupiter = discovery('jupiter', async () => sourced([], 'jupiter'));
    const gecko = discovery('geckoterminal', async () => sourced(rowsOf('g1', 'g2'), 'geckoterminal'));
    const result = await loadDiscoverList({ server, jupiter, gecko }, 'top', '5m');
    expect(result.source).toBe('geckoterminal');
    expect(result.attempts.map((a) => [a.provider, a.ok, a.code])).toEqual([
      ['orbyt', false, 'not_configured'],
      ['jupiter', false, 'empty'],
      ['geckoterminal', true, undefined],
    ]);
    expect(visibleFailures(result.attempts).map((a) => a.provider)).toEqual(['jupiter']);
  });

  it('has no GeckoTerminal fallback for organic', async () => {
    const jupiter = discovery('jupiter', async () => {
      throw new ProviderError('jupiter', 'rate_limited', 'jupiter: HTTP 429');
    });
    const gecko = discovery('geckoterminal', async () => sourced(rowsOf('g'), 'geckoterminal'));
    await expect(loadDiscoverList({ jupiter, gecko }, 'organic', '1h')).rejects.toBeInstanceOf(ChainError);
    expect(gecko.calls).toHaveLength(0);
  });

  it('returns an honest empty list when every provider answers empty', async () => {
    const jupiter = discovery('jupiter', async () => sourced([], 'jupiter'));
    const gecko = discovery('geckoterminal', async () => sourced([], 'geckoterminal'));
    const result = await loadDiscoverList({ server: null, jupiter, gecko }, 'new', '24h');
    expect(result.data).toEqual([]);
    expect(result.source).toBe('jupiter');
  });

  it('collects every failure when all providers fail', async () => {
    const fail = (id: ProviderId) =>
      discovery(id, async () => {
        throw new ProviderError(id, 'rate_limited', `${id}: HTTP 429`);
      });
    const error = await loadDiscoverList({ jupiter: fail('jupiter'), gecko: fail('geckoterminal') }, 'trending', '1h').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).attempts.map((a) => a.provider)).toEqual(['jupiter', 'geckoterminal']);
  });
});

describe('loadTokenRows', () => {
  const known = {
    a: row({ mint: 'a', market: { source: 'jupiter' } }),
    b: row({ mint: 'b', market: { source: 'jupiter' } }),
  };

  it('keeps the requested order and gap-fills from DEX Screener', async () => {
    const jupiter = rowsProvider('jupiter', known);
    const gecko = rowsProvider('geckoterminal', {});
    const dex = rowsProvider('dexscreener', { c: row({ mint: 'c', market: { source: 'dexscreener' } }) });
    const result = await loadTokenRows({ jupiter, gecko, dex }, ['c', 'zz', 'b', 'a']);
    expect(mints(result.data)).toEqual(['c', 'b', 'a']);
    expect(result.missing).toEqual(['zz']);
    expect(result.source).toBe('jupiter');
    expect(result.contributors).toEqual(['dexscreener']);
    expect(dex.calls).toEqual([['c', 'zz']]);
    expect(gecko.calls).toHaveLength(0);
  });

  it('falls through the chain and does not re-query the winning provider', async () => {
    const fail = new ProviderError('jupiter', 'rate_limited', 'jupiter: HTTP 429');
    const jupiter = rowsProvider('jupiter', known, fail);
    const gecko = rowsProvider('geckoterminal', {}, new ProviderError('geckoterminal', 'rate_limited', 'x'));
    const dex = rowsProvider('dexscreener', { a: known.a });
    const result = await loadTokenRows({ server: null, jupiter, gecko, dex }, ['a', 'b']);
    expect(result.source).toBe('dexscreener');
    expect(result.missing).toEqual(['b']);
    expect(dex.calls).toHaveLength(1);
    expect(result.attempts.filter((a) => !a.ok).map((a) => a.provider)).toEqual(['jupiter', 'geckoterminal']);
  });

  it('notes a failed gap fill without failing the result', async () => {
    const jupiter = rowsProvider('jupiter', known);
    const gecko = rowsProvider('geckoterminal', {});
    const dex = rowsProvider('dexscreener', {}, new ProviderError('dexscreener', 'timeout', 'x'));
    const result = await loadTokenRows({ jupiter, gecko, dex }, ['a', 'q']);
    expect(mints(result.data)).toEqual(['a']);
    expect(result.missing).toEqual(['q']);
    expect(result.notes?.[0]).toContain('dexscreener: timed out');
  });
});

describe('orderByMints / stableFetchSet', () => {
  it('orders rows by mint list and drops duplicates', () => {
    const rows = [row({ mint: 'b' }), row({ mint: 'a' }), row({ mint: 'b', rank: 9 })];
    const out = orderByMints(rows, ['a', 'b', 'c']);
    expect(mints(out)).toEqual(['a', 'b']);
    expect(out[1]?.rank).toBeUndefined();
  });

  it('reuses a superset request when tokens are removed', () => {
    const prev = ['a', 'b', 'c'];
    expect(stableFetchSet(prev, ['a', 'b', 'c'])).toBe(prev);
    expect(stableFetchSet(prev, ['a', 'c'])).toBe(prev);
    expect(stableFetchSet(prev, ['a', 'd'])).toEqual(['a', 'd']);
    expect(stableFetchSet(prev, [])).toEqual([]);
    const big = Array.from({ length: 20 }, (_, i) => `m${String(i).padStart(2, '0')}`);
    expect(stableFetchSet(big, big.slice(0, 5))).toEqual(big.slice(0, 5));
  });
});

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

describe('presentation helpers', () => {
  it('applies the brief risk thresholds', () => {
    expect(riskLevel('top10', 30)).toBe('ok');
    expect(riskLevel('top10', 30.1)).toBe('warn');
    expect(riskLevel('top10', 50.1)).toBe('danger');
    expect(riskLevel('dev', 10.5)).toBe('warn');
    expect(riskLevel('snipers', 20)).toBe('ok');
    expect(riskLevel('bundlers', 21)).toBe('warn');
    expect(riskLevel('insiders', undefined)).toBe('unknown');
  });

  it('computes transaction totals and buy share only from known halves', () => {
    expect(txCount({ buys: 3, sells: 1 })).toBe(4);
    expect(txCount({ buys: 3 })).toBeUndefined();
    expect(buyShare({ buys: 3, sells: 1 })).toBe(75);
    expect(buyShare({ buys: 0, sells: 0 })).toBeUndefined();
  });

  it('describes chain attempts with provider labels', () => {
    expect(describeAttempt({ provider: 'jupiter', ok: false, error: 'jupiter: rate limited', code: 'rate_limited' })).toBe('Jupiter: rate limited');
    expect(describeAttempt({ provider: 'geckoterminal', ok: false, error: 'geckoterminal: no usable data', code: 'empty' })).toBe(
      'GeckoTerminal: no data',
    );
    expect(describeAttempt({ provider: 'orbyt', ok: false, error: 'orbyt: HTTP 502', code: 'http' })).toBe('ORBYT API: HTTP 502');
  });

  it('turns load errors into per-provider lines', () => {
    const chain = new ChainError('discover', [
      { provider: 'orbyt', ok: false, error: 'orbyt: not configured', code: 'not_configured' },
      { provider: 'jupiter', ok: false, error: 'jupiter: rate limited', code: 'rate_limited' },
      { provider: 'geckoterminal', ok: false, error: 'geckoterminal: timed out', code: 'timeout' },
    ]);
    expect(errorLines(chain)).toEqual(['Jupiter: rate limited', 'GeckoTerminal: timed out']);
    expect(errorLines(new ChainError('x', [{ provider: 'orbyt', ok: false, code: 'not_configured' }]))).toHaveLength(1);
    expect(errorLines(new ProviderError('jupiter', 'timeout', 'x'))).toEqual(['jupiter: timed out']);
  });

  it('detects GeckoTerminal data for attribution', () => {
    expect(showsGeckoData({ source: 'jupiter' })).toBe(false);
    expect(showsGeckoData({ source: 'geckoterminal' })).toBe(true);
    expect(showsGeckoData({ source: 'orbyt', contributors: ['coingecko'] })).toBe(true);
    expect(showsGeckoData({ source: 'jupiter' }, [row({ mint: 'a', market: { source: 'geckoterminal' } })])).toBe(true);
    expect(showsGeckoData(undefined)).toBe(false);
  });

  it('shortens launchpad names', () => {
    expect(launchpadBadge('pump.fun')).toBe('Pump');
    expect(launchpadBadge('Meteora DBC')).toBe('DBC');
    expect(launchpadBadge('letsbonk')).toBe('Bonk');
    expect(launchpadBadge(undefined)).toBeUndefined();
    expect(launchpadBadge('averyverylongpad')).toBe('Averyvery…');
    expect(launchpadBadge('metadao')).toBe('MetaDAO');
    expect(launchpadBadge('stonkfun')).toBe('StonkFun');
  });

  it('maps launchpad names to venue labels', () => {
    expect(launchpadVenue('pump.fun')).toBe('Pump.fun');
    expect(launchpadVenue('Meteora DBC')).toBe('Meteora DBC');
    expect(launchpadVenue('LaunchLab')).toBe('Raydium LaunchLab');
    expect(launchpadVenue('stonkfun')).toBe('StonkFun');
    expect(launchpadVenue('new-pad')).toBe('New Pad');
    expect(launchpadVenue(' ')).toBeUndefined();
  });
});

describe('enrichRows memo / rowToTokenResult', () => {
  it('returns the same enriched object while its inputs are unchanged', () => {
    const base = row({ mint: 'm' });
    const ultra: JupiterUltraInfo = { risk: { snipersPct: 3 } };
    const snap = (u: JupiterUltraInfo): EnrichmentSnapshot => ({ byMint: { m: { ultra: u } }, errors: {} });
    const first = enrichRows([base], snap(ultra))[0];
    expect(first?.risk?.snipersPct).toBe(3);
    expect(enrichRows([base], snap(ultra))[0]).toBe(first);
    const next = enrichRows([base], snap({ risk: { snipersPct: 4 } }))[0];
    expect(next).not.toBe(first);
    expect(next?.risk?.snipersPct).toBe(4);
  });

  it('turns a row into a token-page result with its real source and age', () => {
    const jup = rowToTokenResult(row({ mint: 'a', market: { updatedAt: NOW - 20_000 } }));
    expect(jup).toMatchObject({ source: 'jupiter', fetchedAt: NOW - 20_000, freshness: 'fast', attempts: [{ provider: 'jupiter', ok: true }] });
    expect(rowToTokenResult(row({ mint: 'b', market: { source: 'geckoterminal' } })).freshness).toBe('indexed');
    expect(rowToTokenResult(row({ mint: 'c', market: { source: 'dexscreener' } })).freshness).toBe('indexed');
  });
});

// ---------------------------------------------------------------------------
// Universe ("All")
// ---------------------------------------------------------------------------

function fixture(rel: string): unknown {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures', rel), 'utf8'));
}

const WSOL = 'So11111111111111111111111111111111111111112';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

function okEntry(rows: TokenRow[], source: ProviderId, extra: Partial<UniverseEntry> = {}): UniverseEntry {
  return { status: 'ok', rows, fetchedAt: NOW, source, window: '1h', failures: 0, ...extra };
}

const J_TREND: UniverseSourceDef = { id: 'jup-trending', provider: 'jupiter', label: 'Jupiter trending', refreshMs: 30_000, windowed: true };
const J_NEW: UniverseSourceDef = { id: 'jup-new', provider: 'jupiter', label: 'Jupiter recent', refreshMs: 30_000, windowed: false };
const G_VOL: UniverseSourceDef = { id: 'gt-vol-1', provider: 'geckoterminal', label: 'GeckoTerminal top volume p1', refreshMs: 60_000, windowed: false };
const D_PROMO: UniverseSourceDef = { id: 'ds-promoted', provider: 'dexscreener', label: 'DEX Screener promoted', refreshMs: 60_000, windowed: false };
const DEFS: UniverseSourceDef[] = [J_TREND, J_NEW, G_VOL, D_PROMO];

describe('mergeRows', () => {
  const pool = { address: 'p1', dex: 'raydium' as const, dexLabel: 'Raydium' };

  it('fills gaps only, whole stats windows at a time, and keeps the lead source', () => {
    const primary = row({ mint: 'm', token: { name: 'Primary' }, market: { priceUsd: 1, stats: { h1: { volumeUsd: 10, buys: 1, sells: 2 } } } });
    const secondary = row({
      mint: 'm',
      token: { name: 'Other', image: 'https://img.example/x.png' },
      market: { source: 'geckoterminal', priceUsd: 2, liquidityUsd: 500, stats: { h1: { volumeUsd: 99, traders: 7 }, h24: { volumeUsd: 1_000 } } },
      pool,
      risk: { top10Pct: 12 },
    });
    const out = mergeRows(primary, secondary);
    expect(out.token.name).toBe('Primary');
    expect(out.token.image).toBe('https://img.example/x.png');
    expect(out.market.priceUsd).toBe(1);
    expect(out.market.liquidityUsd).toBe(500);
    expect(out.market.stats.h1).toEqual({ volumeUsd: 10, buys: 1, sells: 2 });
    expect(out.market.stats.h24).toEqual({ volumeUsd: 1_000 });
    expect(out.market.source).toBe('jupiter');
    expect(out.pool).toEqual(pool);
    expect(out.risk).toEqual({ top10Pct: 12 });
    expect(primary.market.liquidityUsd).toBeUndefined();
  });

  it('returns the primary object when nothing is filled or the mints differ', () => {
    const full = row({ mint: 'm', market: { priceUsd: 1, liquidityUsd: 5 }, pool });
    expect(mergeRows(full, row({ mint: 'm', market: { priceUsd: 9 } }))).toBe(full);
    expect(mergeRows(full, row({ mint: 'x', market: { holders: 10 } }))).toBe(full);
  });
});

describe('mergeUniverse', () => {
  const entries = (): UniverseEntries => ({
    'jup-trending': okEntry([row({ mint: 'a', rank: 1 }), row({ mint: 'b', rank: 2 })], 'jupiter'),
    'gt-vol-1': okEntry(
      [row({ mint: 'c', market: { source: 'geckoterminal', liquidityUsd: 7 } }), row({ mint: 'a', market: { source: 'geckoterminal', liquidityUsd: 5 } })],
      'geckoterminal',
    ),
    'ds-promoted': okEntry([row({ mint: 'd', market: { source: 'dexscreener' } }), row({ mint: 'c', market: { source: 'dexscreener', holders: 40 } })], 'dexscreener'),
  });

  it('unions every source by mint in source order, richest source leading', () => {
    const { rows, contributors } = mergeUniverse(entries(), DEFS);
    expect(mints(rows)).toEqual(['a', 'b', 'c', 'd']);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    expect(rows[0]?.market.source).toBe('jupiter');
    expect(rows[0]?.market.liquidityUsd).toBe(5);
    expect(rows[2]?.market.source).toBe('geckoterminal');
    expect(rows[2]?.market.holders).toBe(40);
    expect(contributors).toEqual(['jupiter', 'geckoterminal', 'dexscreener']);
  });

  it('lets a richer source lead a mint first listed by a weaker one', () => {
    const e: UniverseEntries = {
      'jup-new': okEntry([row({ mint: 'y' }), row({ mint: 'z', market: { priceUsd: 1 } })], 'jupiter'),
      'ds-promoted': okEntry([row({ mint: 'z', market: { source: 'dexscreener', priceUsd: 2, liquidityUsd: 9 } })], 'dexscreener'),
    };
    const promoFirst: UniverseSourceDef[] = [D_PROMO, J_NEW];
    const [z, y] = mergeUniverse(e, promoFirst).rows;
    expect(z?.token.mint).toBe('z');
    expect(z?.market.source).toBe('jupiter');
    expect(z?.market.priceUsd).toBe(1);
    expect(z?.market.liquidityUsd).toBe(9);
    expect(y?.rank).toBe(2);
  });

  it('keeps row identity for mints whose inputs did not change', () => {
    const cache: MergeCache = new Map();
    const e1 = entries();
    const first = mergeUniverse(e1, DEFS, cache).rows;
    const e2: UniverseEntries = { ...e1, 'ds-promoted': okEntry([row({ mint: 'd', market: { source: 'dexscreener', priceUsd: 3 } })], 'dexscreener') };
    const second = mergeUniverse(e2, DEFS, cache).rows;
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[2]); // c lost its DEX Screener input
    expect(second[3]?.market.priceUsd).toBe(3);
    const third = mergeUniverse({ 'jup-trending': e1['jup-trending'] }, DEFS, cache).rows;
    expect(third[1]).toBe(first[1]); // b only ever came from Jupiter
    expect(third[0]).not.toBe(first[0]); // a lost its GeckoTerminal fill
    expect(third[0]?.market.liquidityUsd).toBeUndefined();
    expect([...cache.keys()].sort()).toEqual(['a', 'b']);
  });

  it('ignores idle and empty sources', () => {
    expect(mergeUniverse(emptyEntries(DEFS), DEFS)).toEqual({ rows: [], contributors: [] });
  });

  it('leaves out SOL and stablecoins (base tokens of GeckoTerminal SOL/USDC-style pools)', () => {
    const e: UniverseEntries = {
      'gt-vol-1': okEntry(
        [row({ mint: MINTS.SOL, market: { source: 'geckoterminal' } }), row({ mint: 'meme', market: { source: 'geckoterminal' } }), row({ mint: MINTS.USDC })],
        'geckoterminal',
      ),
    };
    const { rows } = mergeUniverse(e, DEFS);
    expect(mints(rows)).toEqual(['meme']);
    expect(rows[0]?.rank).toBe(1);
  });
});

describe('excluded mints', () => {
  it('drops SOL and stablecoins from a ranked list and renumbers ranks', () => {
    const list = sourced([row({ mint: MINTS.SOL, rank: 1 }), row({ mint: 'a', rank: 2 }), row({ mint: MINTS.USDT, rank: 3 }), row({ mint: 'b', rank: 4 })], 'geckoterminal');
    const out = withoutExcluded(list);
    expect(mints(out.data)).toEqual(['a', 'b']);
    expect(out.data.map((r) => r.rank)).toEqual([1, 2]);
    const clean = sourced([row({ mint: 'a', rank: 1 })], 'jupiter');
    expect(withoutExcluded(clean)).toBe(clean);
    expect(isExcludedMint('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')).toBe(true);
    expect(isExcludedMint('a')).toBe(false);
  });

  it('filters every step of a named list, falling back when only excluded tokens came back', async () => {
    const jupiter = discovery('jupiter', async () => sourced([row({ mint: MINTS.USDC, rank: 1 })], 'jupiter'));
    const gecko = discovery('geckoterminal', async () => sourced([row({ mint: MINTS.SOL, rank: 1 }), row({ mint: 'g', rank: 2 })], 'geckoterminal'));
    const result = await loadDiscoverList({ jupiter, gecko }, 'top', '24h');
    expect(result.source).toBe('geckoterminal');
    expect(mints(result.data)).toEqual(['g']);
    expect(result.data[0]?.rank).toBe(1);
  });
});

describe('dueAt / pickNext', () => {
  const spacing = { jupiter: 3_000, geckoterminal: 10_000, dexscreener: 0 };
  const defs = [J_TREND, J_NEW, G_VOL];
  const clock = (): ProviderClock => ({ lastStartAt: {}, inflight: {} });

  it('computes when a source is due', () => {
    const loaded = okEntry([], 'jupiter');
    expect(dueAt(J_TREND, { status: 'idle', rows: [], failures: 0 }, '1h')).toBe(0);
    expect(dueAt(J_TREND, loaded, '1h')).toBe(NOW + 30_000);
    expect(dueAt(J_TREND, loaded, '5m')).toBe(0); // windowed list, new window
    expect(dueAt(J_NEW, loaded, '5m')).toBe(NOW + 30_000);
    expect(dueAt(J_TREND, { ...loaded, status: 'loading' }, '1h')).toBeUndefined();
    expect(dueAt(J_TREND, { ...loaded, retryAt: NOW + 90_000 }, '1h')).toBe(NOW + 90_000);
  });

  it('runs one call per provider, spaced, never-fetched sources first', () => {
    const c = clock();
    let entries = emptyEntries(defs);
    expect(pickNext(defs, entries, NOW, '1h', c, spacing).task?.id).toBe('jup-trending');
    c.inflight.jupiter = 1;
    c.lastStartAt.jupiter = NOW;
    expect(pickNext(defs, entries, NOW, '1h', c, spacing).task?.id).toBe('gt-vol-1');
    c.inflight.geckoterminal = 1;
    c.lastStartAt.geckoterminal = NOW;
    expect(pickNext(defs, entries, NOW, '1h', c, spacing)).toEqual({});
    c.inflight.jupiter = 0;
    entries = { ...entries, 'jup-trending': okEntry([], 'jupiter') };
    expect(pickNext(defs, entries, NOW + 1_000, '1h', c, spacing)).toEqual({ waitMs: 2_000 });
    expect(pickNext(defs, entries, NOW + 3_000, '1h', c, spacing).task?.id).toBe('jup-new');
  });

  it('prefers a first load over a due refresh', () => {
    const entries: UniverseEntries = { 'jup-trending': okEntry([], 'jupiter', { fetchedAt: NOW - 60_000 }) };
    expect(pickNext(defs, entries, NOW, '1h', clock(), spacing).task?.id).toBe('jup-new');
  });

  it('refreshes the most overdue source first so sources listed last never starve', () => {
    const entries: UniverseEntries = {
      'jup-trending': okEntry([], 'jupiter', { fetchedAt: NOW - 31_000 }), // due 1 s ago
      'jup-new': okEntry([], 'jupiter', { fetchedAt: NOW - 50_000 }), // due 20 s ago
      'gt-vol-1': okEntry([], 'geckoterminal', { fetchedAt: NOW }),
    };
    expect(pickNext(defs, entries, NOW, '1h', clock(), spacing).task?.id).toBe('jup-new');
    // A window change makes windowed lists due immediately, ahead of any refresh.
    expect(pickNext(defs, entries, NOW, '5m', clock(), spacing).task?.id).toBe('jup-trending');
  });

  it('waits out a provider cooldown', () => {
    const entries: UniverseEntries = { 'gt-vol-1': okEntry([], 'geckoterminal') };
    expect(pickNext(defs, entries, NOW, '1h', clock(), spacing, (p) => p === 'jupiter')).toEqual({ waitMs: COOLDOWN_RECHECK_MS });
  });

  it('backs off exponentially up to two minutes', () => {
    expect([1, 2, 3, 4, 10].map(universeBackoffMs)).toEqual([20_000, 40_000, 80_000, 120_000, 120_000]);
  });

  it('declares every default source once, spaced within the keyless budgets', () => {
    const ids = UNIVERSE_SOURCES.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Jupiter ≤ 4 per 10 s per browser (shared with Ultra and the SOL price); GeckoTerminal ≤ 8 per minute,
    // of which the universe uses at most half so the token page opened next still has budget.
    expect(Math.floor(10_000 / UNIVERSE_SPACING_MS.jupiter) + 1).toBeLessThanOrEqual(3);
    expect(Math.floor(60_000 / UNIVERSE_SPACING_MS.geckoterminal) + 1).toBeLessThanOrEqual(5);
    // Steady-state GeckoTerminal demand fits the spacing (calls per minute).
    const geckoDemand = UNIVERSE_SOURCES.filter((d) => d.provider === 'geckoterminal').reduce((n, d) => n + 60_000 / d.refreshMs, 0);
    expect(geckoDemand).toBeLessThanOrEqual(60_000 / UNIVERSE_SPACING_MS.geckoterminal);
  });
});

describe('createUniverseLoader', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type Deferred = { resolve: (v: Sourced<TokenRow[]>) => void; reject: (e: unknown) => void };

  function setup(defs: readonly UniverseSourceDef[]) {
    const pending = new Map<string, Deferred>();
    const calls: { id: string; window: string }[] = [];
    const loader = createUniverseLoader({
      defs,
      window: '1h',
      spacing: { jupiter: 1_000, geckoterminal: 5_000, dexscreener: 0 },
      backoffMs: () => 20_000,
      fetch: (def, window, signal) =>
        new Promise<Sourced<TokenRow[]>>((resolve, reject) => {
          calls.push({ id: def.id, window });
          pending.set(def.id, { resolve, reject });
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    });
    const settle = async (id: string, outcome: TokenRow[] | Error, source: ProviderId = 'jupiter') => {
      const d = pending.get(id);
      if (!d) throw new Error(`no pending call for ${id}`);
      pending.delete(id);
      if (outcome instanceof Error) d.reject(outcome);
      else d.resolve({ data: outcome, source, fetchedAt: Date.now(), freshness: 'fast' });
      await vi.advanceTimersByTimeAsync(0);
    };
    return { loader, calls, settle };
  }

  it('publishes partial results, spaces calls per provider and keeps rows when a refresh fails', async () => {
    const jTop: UniverseSourceDef = { ...J_NEW, id: 'jup-top', label: 'Jupiter top traded' };
    const defs = [J_TREND, jTop, G_VOL];
    const { loader, calls, settle } = setup(defs);
    let emits = 0;
    loader.subscribe(() => emits++);
    loader.start();
    expect(calls.map((c) => c.id)).toEqual(['jup-trending', 'gt-vol-1']);
    expect(loader.getSnapshot()).toMatchObject({ settling: true, running: true, rows: [] });

    await settle('gt-vol-1', [row({ mint: 'c', market: { source: 'geckoterminal' } })], 'geckoterminal');
    expect(mints(loader.getSnapshot().rows)).toEqual(['c']);

    await settle('jup-trending', [row({ mint: 'a' }), row({ mint: 'b' })]);
    expect(mints(loader.getSnapshot().rows)).toEqual(['a', 'b', 'c']);
    expect(calls).toHaveLength(2); // jup-top waits for the Jupiter spacing
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.map((c) => c.id)).toEqual(['jup-trending', 'gt-vol-1', 'jup-top']);

    await settle('jup-top', new ProviderError('jupiter', 'rate_limited', 'jupiter: HTTP 429'));
    let snap = loader.getSnapshot();
    expect(snap.settling).toBe(false);
    expect(snap.entries['jup-top']).toMatchObject({ status: 'error', failures: 1, retryAt: NOW + 1_000 + 20_000 });
    expect(summarizeUniverse(snap, defs).errors).toEqual(['Jupiter top traded: rate limited']);

    // The failed source retries after its backoff.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls.filter((c) => c.id === 'jup-top')).toHaveLength(2);
    await settle('jup-top', [row({ mint: 'e' })]);
    expect(mints(loader.getSnapshot().rows)).toEqual(['a', 'b', 'e', 'c']);

    // jup-trending refreshes 30 s after its answer; that failure keeps its rows on screen.
    await vi.advanceTimersByTimeAsync(8_999);
    expect(calls.filter((c) => c.id === 'jup-trending')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.filter((c) => c.id === 'jup-trending')).toHaveLength(2);
    await settle('jup-trending', new ProviderError('jupiter', 'timeout', 'x'));
    snap = loader.getSnapshot();
    expect(mints(snap.rows)).toEqual(['a', 'b', 'e', 'c']);
    expect(snap.entries['jup-trending']?.status).toBe('error');
    expect(summarizeUniverse(snap, defs).providers.find((p) => p.provider === 'jupiter')?.stale).toBe(1);
    expect(emits).toBeGreaterThan(3);
    loader.stop();
  });

  it('refetches windowed lists on a window change, and pauses without losing rows', async () => {
    const { loader, calls, settle } = setup([J_TREND, G_VOL]);
    loader.start();
    await settle('jup-trending', [row({ mint: 'a' })]);
    await settle('gt-vol-1', [row({ mint: 'g', market: { source: 'geckoterminal' } })], 'geckoterminal');
    await vi.advanceTimersByTimeAsync(1_000);

    loader.setWindow('5m');
    expect(calls.at(-1)).toEqual({ id: 'jup-trending', window: '5m' });
    expect(calls.filter((c) => c.id === 'gt-vol-1')).toHaveLength(1);

    loader.stop();
    await vi.advanceTimersByTimeAsync(0);
    let snap = loader.getSnapshot();
    expect(snap.running).toBe(false);
    expect(snap.entries['jup-trending']?.status).toBe('ok'); // aborted, not failed
    expect(mints(snap.rows)).toEqual(['a', 'g']);

    loader.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.at(-1)).toEqual({ id: 'jup-trending', window: '5m' });
    await settle('jup-trending', [row({ mint: 'a5' })]);
    snap = loader.getSnapshot();
    expect(snap.entries['jup-trending']?.window).toBe('5m');
    expect(mints(snap.rows)).toEqual(['a5', 'g']);
    loader.stop();
  });

  it('retries failing sources immediately on demand', async () => {
    const { loader, calls, settle } = setup([G_VOL]);
    loader.start();
    await settle('gt-vol-1', new ProviderError('geckoterminal', 'rate_limited', 'x'), 'geckoterminal');
    expect(summarizeUniverse(loader.getSnapshot(), [G_VOL]).allFailed).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);
    loader.retry();
    expect(calls).toHaveLength(2);
    loader.stop();
  });

  it('keeps a failing source failing while it retries and when a retry is aborted', async () => {
    const { loader, calls, settle } = setup([G_VOL]);
    loader.start();
    await settle('gt-vol-1', new ProviderError('geckoterminal', 'rate_limited', 'geckoterminal: HTTP 429'), 'geckoterminal');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(2); // retry in flight
    let s = summarizeUniverse(loader.getSnapshot(), [G_VOL]);
    expect(s).toMatchObject({ failing: 1, pending: 0, allFailed: true });
    expect(s.errors).toEqual(['GeckoTerminal top volume p1: rate limited']);

    loader.stop(); // aborts the retry
    await vi.advanceTimersByTimeAsync(0);
    expect(loader.getSnapshot().entries['gt-vol-1']?.status).toBe('error');
    s = summarizeUniverse(loader.getSnapshot(), [G_VOL]);
    expect(s.allFailed).toBe(true);

    loader.start(); // due again (its retry time has passed) once the provider spacing allows
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(3);
    await settle('gt-vol-1', [row({ mint: 'g', market: { source: 'geckoterminal' } })], 'geckoterminal');
    s = summarizeUniverse(loader.getSnapshot(), [G_VOL]);
    expect(s).toMatchObject({ failing: 0, sourcesWithData: 1, allFailed: false, errors: [] });
    loader.stop();
  });
});

describe('summarizeUniverse', () => {
  it('counts ok, stale, pending and failed sources per provider', () => {
    const entries: UniverseEntries = {
      'jup-trending': okEntry([row({ mint: 'a' })], 'jupiter'),
      'jup-new': { ...okEntry([row({ mint: 'b' })], 'jupiter'), status: 'error', error: 'jupiter: rate limited', failures: 1, retryAt: NOW + 20_000 },
      'gt-vol-1': { status: 'error', rows: [], error: 'geckoterminal: timed out', failures: 2, retryAt: NOW + 40_000 },
    };
    const s = summarizeUniverse({ entries, rows: [row({ mint: 'a' }), row({ mint: 'b' })], updatedAt: NOW }, DEFS);
    expect(s).toMatchObject({ loaded: 2, sourcesTotal: 4, sourcesWithData: 2, pending: 1, failing: 2, allFailed: false, updatedAt: NOW });
    expect(s.errors).toEqual(['Jupiter recent: rate limited', 'GeckoTerminal top volume p1: timed out']);
    const byId = Object.fromEntries(s.providers.map((p) => [p.provider, p]));
    expect(byId.jupiter).toMatchObject({ label: 'Jupiter', total: 2, ok: 1, stale: 1, retryAt: NOW + 20_000 });
    expect(byId.geckoterminal).toMatchObject({ failed: 1, error: 'GeckoTerminal top volume p1: timed out' });
    expect(byId.dexscreener).toMatchObject({ pending: 1 });
  });
});

// ---------------------------------------------------------------------------
// Universe sources (real provider responses captured 2026-09-28)
// ---------------------------------------------------------------------------

describe('DEX Screener promoted feeds', () => {
  it('extracts Solana token addresses in feed order without duplicates', () => {
    const payload = [
      { chainId: 'solana', tokenAddress: JUP },
      { chainId: 'ethereum', tokenAddress: '0x0000000000000000000000000000000000000000' },
      { chainId: 'solana', tokenAddress: ` ${WSOL} ` },
      { chainId: 'solana', tokenAddress: JUP },
      { chainId: 'solana', tokenAddress: 'not-an-address' },
      null,
    ];
    expect(parseDexFeed(payload)).toEqual([JUP, WSOL]);
    expect(parseDexFeed({ pairs: [] })).toEqual([]);
    expect(parseDexFeed(fixture('dexscreener/token-boosts-top.solana-filtered.json')).length).toBeGreaterThan(0);
  });

  it('merges the feeds, looks the mints up for real rows and survives a failed feed', async () => {
    const feeds: Record<string, unknown> = {
      '/token-boosts/top/v1': fixture('dexscreener/token-boosts-top.solana-filtered.json'),
      '/token-boosts/latest/v1': fixture('dexscreener/token-boosts-latest.solana-filtered.json'),
    };
    const fetcher = (async (_provider: ProviderId, url: string) => {
      const body = feeds[new URL(url).pathname];
      if (body === undefined) throw new ProviderError('dexscreener', 'timeout', 'dexscreener: timeout');
      return body;
    }) as JsonFetcher;
    const expected = [...new Set([...parseDexFeed(feeds['/token-boosts/top/v1']), ...parseDexFeed(feeds['/token-boosts/latest/v1'])])];
    const known = Object.fromEntries(expected.map((m) => [m, row({ mint: m, market: { source: 'dexscreener' } })]));
    const provider = rowsProvider('dexscreener', known);
    const result = await loadDexPromoted(fetcher, provider, 'https://api.dexscreener.com/');
    expect(provider.calls).toEqual([expected]);
    expect(mints(result.data)).toEqual(expected);
    expect(result.notes?.[0]).toBe(DEX_PROMOTED_NOTE);
    expect(result.notes?.[1]).toContain('1 of 3 DEX Screener feeds failed');
  });

  it('throws when every feed fails', async () => {
    const fetcher = (async () => {
      throw new ProviderError('dexscreener', 'rate_limited', 'x');
    }) as JsonFetcher;
    await expect(loadDexPromoted(fetcher, rowsProvider('dexscreener', {}), 'https://api.dexscreener.com')).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('GeckoTerminal pool pages', () => {
  it('builds the same URL shapes as the adapter', () => {
    expect(geckoListPath('pools', 2, 'h24_tx_count_desc')).toBe('/networks/solana/pools?include=base_token,quote_token,dex&sort=h24_tx_count_desc&page=2');
    expect(geckoListPath('pools', 0)).toBe('/networks/solana/pools?include=base_token,quote_token,dex&sort=h24_volume_usd_desc&page=1');
    expect(geckoListPath('new_pools', 12)).toBe('/networks/solana/new_pools?include=base_token,quote_token,dex&page=10');
  });

  it('turns a pool list into one row per base token', () => {
    for (const file of ['geckoterminal/top_pools_solana_h24_volume.json', 'geckoterminal/new_pools_solana.json']) {
      const rows = geckoRowsFromList(fixture(file), NOW, 'test');
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(mints(rows)).size).toBe(rows.length);
      for (const r of rows) {
        expect(r.market.source).toBe('geckoterminal');
        expect(r.pool?.address).toBeTruthy();
      }
    }
  });

  it('keeps the SOL-based top pool out of the universe (real response)', () => {
    const rows = geckoRowsFromList(fixture('geckoterminal/top_pools_solana_h24_volume.json'), NOW, 'test');
    expect(mints(rows)).toContain(MINTS.SOL);
    const merged = mergeUniverse({ 'gt-vol-1': okEntry(rows, 'geckoterminal') }, [G_VOL]).rows;
    expect(mints(merged)).not.toContain(MINTS.SOL);
    expect(merged).toHaveLength(rows.length - 1);
  });
});

describe('enrichmentTarget / mintSetKey', () => {
  it('enriches what is on screen first, then the top of the full list, capped', () => {
    const all = ['a', 'b', 'c', 'd', 'e'].map((m) => row({ mint: m }));
    expect(mints(enrichmentTarget([all[3]!, all[0]!], all, 4))).toEqual(['d', 'a', 'b', 'c']);
    expect(mints(enrichmentTarget([], all, 2))).toEqual(['a', 'b']);
  });

  it('keys a mint set independent of order and duplicates', () => {
    expect(mintSetKey([row({ mint: 'b' }), row({ mint: 'a' }), row({ mint: 'b' })])).toBe('a,b');
    expect(mintSetKey(undefined)).toBe('');
  });
});
