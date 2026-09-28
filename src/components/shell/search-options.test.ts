import { describe, expect, it } from 'vitest';
import { addressActions, parseSearchQuery, type RankedHit, type SearchAttempt } from '@/data/hooks/useSearch';
import { pushRecent, sanitizeRecent, type RecentToken } from './recent';
import { addressGroupTitle, answeringProviders, buildOptions, describeFailures, groupOptions, stageBadge } from './search-options';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

const ranked = (mint: string, extra: Partial<RankedHit> = {}): RankedHit => ({ mint, source: 'jupiter', sources: ['jupiter'], ...extra });
const recent = (mint: string, openedAt = 1): RecentToken => ({ mint, openedAt });

describe('buildOptions', () => {
  it('orders address shortcuts before token hits and links tokens to /trade', () => {
    const options = buildOptions({
      actions: addressActions(parseSearchQuery(BONK)),
      hits: [ranked(BONK, { symbol: 'Bonk', marketCapUsd: 1e9, verified: true })],
      recent: [recent(WIF)],
    });
    expect(options.map((o) => [o.group, o.href])).toEqual([
      ['address', `/trade/${BONK}`],
      ['address', `/wallet/${BONK}`],
      ['tokens', `/trade/${BONK}`],
    ]);
    expect(new Set(options.map((o) => o.key)).size).toBe(3);
    const token = options[2];
    expect(token?.kind === 'token' && token.token).toEqual({ mint: BONK, symbol: 'Bonk', marketCapUsd: 1e9, verified: true });
  });

  it('shows recent tokens (identity only) when there are no hits', () => {
    const options = buildOptions({ actions: [], hits: [], recent: [{ mint: WIF, symbol: 'WIF', openedAt: 5 }, recent(WIF), recent(JUP)] });
    expect(options.map((o) => [o.group, o.kind === 'token' ? o.token : null])).toEqual([
      ['recent', { mint: WIF, symbol: 'WIF' }],
      ['recent', { mint: JUP }],
    ]);
  });

  it('puts explorer links after token hits so a pool address opens its token first', () => {
    const parsed = parseSearchQuery(JUP);
    const options = buildOptions({ actions: addressActions(parsed, { kind: 'program-account', owner: WIF }), hits: [ranked(BONK)], recent: [] });
    expect(options.map((o) => [o.group, o.href])).toEqual([
      ['tokens', `/trade/${BONK}`],
      ['explorer', `https://solscan.io/account/${JUP}`],
    ]);
    expect(groupOptions(options).map((g) => g.group)).toEqual(['tokens', 'explorer']);
  });

  it('names the address group after its on-chain type', () => {
    expect(addressGroupTitle(undefined)).toBe('Address');
    expect(addressGroupTitle({ kind: 'unknown' })).toBe('Address');
    expect(addressGroupTitle({ kind: 'mint' })).toBe('Token mint');
    expect(addressGroupTitle({ kind: 'wallet' })).toBe('Wallet');
    expect(addressGroupTitle({ kind: 'empty' })).toBe('Unused address');
    expect(addressGroupTitle({ kind: 'token-account', mint: BONK, owner: WIF })).toBe('Token account');
  });

  it('groups contiguous options and keeps global indices', () => {
    const options = buildOptions({ actions: addressActions(parseSearchQuery(BONK)), hits: [ranked(BONK), ranked(WIF)], recent: [] });
    expect(groupOptions(options).map((g) => [g.group, g.items.map((i) => i.index)])).toEqual([
      ['address', [0, 1]],
      ['tokens', [2, 3]],
    ]);
    expect(groupOptions([])).toEqual([]);
  });
});

describe('stageBadge', () => {
  it('labels bonding progress and migrations, nothing for plain AMM tokens', () => {
    expect(stageBadge({ stage: 'bonding', launchpad: 'pump.fun', progressPct: 64.9 })).toEqual({ text: 'pump.fun 64%', tone: 'bonding' });
    expect(stageBadge({ stage: 'bonding', progressPct: 140 })).toEqual({ text: 'Bonding 100%', tone: 'bonding' });
    expect(stageBadge({ stage: 'bonding' })).toEqual({ text: 'Bonding', tone: 'bonding' });
    expect(stageBadge({ stage: 'graduated', launchpad: 'letsbonk' })).toEqual({ text: 'Migrated · letsbonk', tone: 'migrated' });
    expect(stageBadge({ stage: 'graduated' })).toEqual({ text: 'Migrated', tone: 'migrated' });
    expect(stageBadge({ stage: 'amm' })).toBeNull();
    expect(stageBadge(undefined)).toBeNull();
  });
});

describe('provenance lines', () => {
  const attempts: SearchAttempt[] = [
    { provider: 'jupiter', ok: false, code: 'rate_limited' },
    { provider: 'dexscreener', ok: true, hits: 2 },
    { provider: 'geckoterminal', ok: true, hits: 0 },
  ];

  it('describes failures tersely', () => {
    expect(describeFailures(attempts)).toBe('Jupiter rate limited');
    expect(describeFailures([{ provider: 'dexscreener', ok: false }])).toBe('DEX Screener unavailable');
    expect(describeFailures([])).toBe('');
  });

  it('credits only providers whose hits are on screen', () => {
    expect(answeringProviders(attempts, [ranked(BONK, { source: 'dexscreener', sources: ['dexscreener'] })])).toEqual(['dexscreener']);
    expect(answeringProviders(attempts, [])).toEqual([]);
  });
});

describe('recent searches', () => {
  it('keeps the newest entry first, one per mint, capped', () => {
    let list: RecentToken[] = [];
    for (const [i, mint] of [BONK, WIF, JUP, BONK].entries()) list = pushRecent(list, recent(mint, i), 3);
    expect(list.map((r) => [r.mint, r.openedAt])).toEqual([
      [BONK, 3],
      [JUP, 2],
      [WIF, 1],
    ]);
    expect(pushRecent(list, recent('nope'))).toEqual(list);
  });

  it('sanitizes persisted data', () => {
    expect(sanitizeRecent(null)).toEqual([]);
    expect(sanitizeRecent({ items: [] })).toEqual([]);
    expect(
      sanitizeRecent([
        { mint: BONK, symbol: ' BONK ', name: 42, openedAt: 'x', image: 'https://x.test/a.png' },
        { mint: BONK, symbol: 'dupe' },
        { mint: 'bad' },
        'junk',
        null,
        { mint: WIF, symbol: 'W'.repeat(100), openedAt: 7 },
      ]),
    ).toEqual([
      { mint: BONK, symbol: 'BONK', image: 'https://x.test/a.png', openedAt: 0 },
      { mint: WIF, symbol: 'W'.repeat(32), openedAt: 7 },
    ]);
  });
});
