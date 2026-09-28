import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MINTS } from '@/lib/core/solana';
import {
  clean,
  dexIdentity,
  httpsUrl,
  launchpadFromDetails,
  parseList,
  parseOhlcv,
  parseSingle,
  parseTokenInfo,
  poolInfoFromResource,
  solanaId,
  telegramUrl,
  tradeFromResource,
  twitterUrl,
  type JsonApiResource,
} from './parse';

function fixture(name: string): Record<string, unknown> {
  const file = path.join(process.cwd(), 'tests/fixtures/geckoterminal', name);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete raw._fixture_meta;
  return raw;
}

const CLONES = '5RJGBaFrTcTrmu5HuukxHxKeqpmRWf346YxQ1kXGetRs';
const CLONES_POOL = 'CnJYShWKkDCHeees6Jgi2nx6rekrsu62VqJkDLxpZeNs';

function tradeResource(overrides: Record<string, unknown> = {}): JsonApiResource {
  const doc = parseList('geckoterminal', fixture('trades_pool.json'), 'test');
  const first = doc.data[0];
  if (!first) throw new Error('fixture has no trades');
  return { ...first, attributes: { ...first.attributes, ...overrides } };
}

describe('JSON:API envelope', () => {
  it('rejects payloads without a data array / object as malformed', () => {
    expect(() => parseList('geckoterminal', { status: { error_code: 429 } }, 'x')).toThrow(
      expect.objectContaining({ name: 'ProviderError', code: 'malformed', provider: 'geckoterminal' }),
    );
    expect(() => parseList('coingecko', null, 'x')).toThrow(expect.objectContaining({ code: 'malformed', provider: 'coingecko' }));
    expect(() => parseSingle('geckoterminal', { data: [] }, 'x')).toThrow(expect.objectContaining({ code: 'malformed' }));
    expect(() => parseSingle('geckoterminal', fixture('ohlcv_invalid_aggregate_error_400.json'), 'x')).toThrow(
      expect.objectContaining({ code: 'malformed' }),
    );
  });

  it('skips list items without id/type and indexes included resources', () => {
    const doc = parseList('geckoterminal', { data: [{ id: 'solana_x' }, null, { id: 'a', type: 'pool' }], included: [{ id: 'pumpswap', type: 'dex', attributes: { name: 'PumpSwap' } }] }, 'x');
    expect(doc.data.map((d) => d.id)).toEqual(['a']);
    expect(doc.included.get('dex:pumpswap')?.attributes.name).toBe('PumpSwap');
  });

  it('strips the solana_ prefix and rejects other networks', () => {
    expect(solanaId(`solana_${CLONES}`)).toBe(CLONES);
    expect(solanaId(CLONES)).toBe(CLONES);
    expect(solanaId('eth_0xdeadbeef')).toBeUndefined();
    expect(solanaId(undefined)).toBeUndefined();
  });
});

describe('sanitizers', () => {
  it('accepts only plain twitter handles', () => {
    expect(twitterUrl('thexmrpad')).toBe('https://x.com/thexmrpad');
    expect(twitterUrl('@some_user')).toBe('https://x.com/some_user');
    expect(twitterUrl('davdevsx/status/2104652942892794024')).toBeUndefined();
    expect(twitterUrl('this_handle_is_too_long')).toBeUndefined();
    expect(twitterUrl(null)).toBeUndefined();
  });

  it('builds t.me links from telegram handles only', () => {
    expect(telegramUrl('orbyt_chat')).toBe('https://t.me/orbyt_chat');
    expect(telegramUrl('https://t.me/evil')).toBeUndefined();
    expect(telegramUrl('')).toBeUndefined();
  });

  it('accepts https URLs only for images', () => {
    expect(httpsUrl('https://assets.geckoterminal.com/abc')).toBe('https://assets.geckoterminal.com/abc');
    expect(httpsUrl('http://insecure.example/img.png')).toBeUndefined();
    expect(httpsUrl('javascript:alert(1)')).toBeUndefined();
    expect(httpsUrl('missing.png')).toBeUndefined();
  });

  it('clean() drops undefined keys only', () => {
    expect(clean({ a: 1, b: undefined, c: 0, d: null })).toEqual({ a: 1, c: 0, d: null });
    expect(Object.keys(clean({ a: undefined }))).toEqual([]);
  });
});

describe('dexIdentity', () => {
  it('normalizes known GeckoTerminal ids', () => {
    expect(dexIdentity('pump-fun')).toMatchObject({ dex: 'pumpfun', label: 'Pump.fun', isBondingCurve: true, launchpad: 'pump.fun' });
    expect(dexIdentity('meteora-dbc')).toMatchObject({ dex: 'meteora-dbc', isBondingCurve: true, launchpad: 'Meteora DBC' });
    expect(dexIdentity('raydium-clmm').label).toBe('Raydium CLMM');
  });

  it('uses the included dex name for ids outside the shared vocabulary', () => {
    const included = new Map<string, JsonApiResource>([
      ['dex:saros-amm', { id: 'saros-amm', type: 'dex', attributes: { name: 'Saros AMM' }, relationships: {} }],
    ]);
    expect(dexIdentity('saros-amm', included)).toMatchObject({ dex: 'saros-amm', label: 'Saros AMM', isBondingCurve: false });
    expect(dexIdentity('saros-amm').label).toBe('Saros Amm');
    expect(dexIdentity(undefined)).toMatchObject({ dex: 'unknown' });
  });
});

describe('launchpadFromDetails', () => {
  it('maps a live curve and a completed one', () => {
    expect(launchpadFromDetails({ graduation_percentage: 1.61, completed: false, completed_at: null, migrated_destination_pool_address: null }, 'pump.fun')).toEqual({
      stage: 'bonding',
      launchpad: 'pump.fun',
      progressPct: 1.61,
      progressSource: 'geckoterminal',
    });
    expect(
      launchpadFromDetails(
        {
          graduation_percentage: 100,
          completed: true,
          completed_at: '2026-09-28T19:58:10.000Z',
          migrated_destination_pool_address: 'GG6MBPb94r8dPfba9Fkrn5tyFPWeVZGd1VyBPxQKFSmg',
        },
        undefined,
      ),
    ).toEqual({
      stage: 'graduated',
      progressPct: 100,
      progressSource: 'geckoterminal',
      graduatedAt: Date.parse('2026-09-28T19:58:10.000Z'),
      migratedPool: 'GG6MBPb94r8dPfba9Fkrn5tyFPWeVZGd1VyBPxQKFSmg',
    });
  });

  it('clamps progress, omits unknown progress and rejects junk pool addresses', () => {
    expect(launchpadFromDetails({ graduation_percentage: 104.2, completed: false }, undefined)?.progressPct).toBe(100);
    expect(launchpadFromDetails({ graduation_percentage: '-3', completed: false }, undefined)?.progressPct).toBe(0);
    const unknown = launchpadFromDetails({ graduation_percentage: null, completed: false }, undefined);
    expect(unknown).toEqual({ stage: 'bonding' });
    expect(launchpadFromDetails({ completed: true, migrated_destination_pool_address: 'not-a-pool' }, undefined)?.migratedPool).toBeUndefined();
    expect(launchpadFromDetails(null, 'pump.fun')).toBeUndefined();
  });
});

describe('parseOhlcv', () => {
  it('reverses newest-first rows into ascending UNIX-second candles', () => {
    const { candles, rows } = parseOhlcv('geckoterminal', fixture('ohlcv_minute_1_limit1000.json'), 'x');
    expect(rows).toBe(3);
    expect(candles.map((c) => c.time)).toEqual([1790628180, 1790628240, 1790628300]);
    expect(candles[0]).toEqual({
      time: 1790628180,
      open: 0.001123915167112856,
      high: 0.0012118118691018872,
      low: 0.0008762917304188277,
      close: 0.0009211624439675153,
      volume: 91674.76880046637,
    });
  });

  it('drops invalid rows, dedupes times (keeping the newest copy) and tolerates ms timestamps', () => {
    const payload = {
      data: {
        attributes: {
          ohlcv_list: [
            [1700000120, 2, 3, 1, 2.5, 10],
            [1700000060, 1.5, 2, 1, 2, 5],
            [1700000060, 9, 9, 9, 9, 9], // older duplicate of the same bucket
            [1700000000, 0, 1, 0, 1, 1], // zero price
            [1699999940, 1, 0.5, 2, 1, 1], // high < low
            [null, 1, 1, 1, 1, 1],
            'junk',
            [1699999880000, '1.1', '1.2', '1.0', '1.15'], // ms + string numbers, no volume
            [1699999820, 1, 1, 1, 1, -4], // negative volume is omitted, candle kept
          ],
        },
      },
    };
    const { candles, rows } = parseOhlcv('geckoterminal', payload, 'x');
    expect(rows).toBe(9);
    expect(candles.map((c) => c.time)).toEqual([1699999820, 1699999880, 1700000060, 1700000120]);
    expect(candles.find((c) => c.time === 1700000060)?.open).toBe(1.5);
    expect(candles.find((c) => c.time === 1699999880)).toEqual({ time: 1699999880, open: 1.1, high: 1.2, low: 1, close: 1.15 });
    expect(candles[0]).not.toHaveProperty('volume');
  });

  it('throws malformed when ohlcv_list is missing', () => {
    expect(() => parseOhlcv('geckoterminal', fixture('ohlcv_limit_over_1000_error_400.json'), 'x')).toThrow(
      expect.objectContaining({ code: 'malformed' }),
    );
  });
});

describe('tradeFromResource', () => {
  it('maps a SOL-quoted buy with decimal-adjusted amounts', () => {
    expect(tradeFromResource(tradeResource(), CLONES, CLONES_POOL, 'geckoterminal')).toEqual({
      signature: 'gqcaBQM3GETHZiNYL8XF3YkHNiiWHV2UB4T4fJig6qUskpV4T58kwFoacfGHNAcz4vSNmDJTHwYFcKMTFi9Z5yZ',
      timestamp: Date.parse('2026-09-28T20:45:04Z'),
      side: 'buy',
      wallet: 'Hfy1ettvX6dv2xEhxtM7RithXYam3QCV6fHWfsLzdKA5',
      tokenAmount: 635981.867943,
      solAmount: 4.911028452,
      quoteSymbol: 'SOL',
      usdValue: Number('583.126885594244985545205636828450543893478443335138222632'),
      priceUsd: Number('0.000916892312481002815581917050585391677766421884911919392848741178'),
      pool: CLONES_POOL,
      source: 'geckoterminal',
    });
  });

  it('uses quoteAmount for non-SOL quotes and derives side when kind is missing', () => {
    const trade = tradeFromResource(
      tradeResource({ from_token_address: MINTS.USDC, from_token_amount: '583.12', kind: undefined }),
      CLONES,
      CLONES_POOL,
      'coingecko',
    );
    expect(trade).toMatchObject({ side: 'buy', quoteAmount: 583.12, quoteSymbol: 'USDC', source: 'coingecko' });
    expect(trade).not.toHaveProperty('solAmount');
  });

  it('drops trades without our mint, a valid signature or a timestamp', () => {
    expect(tradeFromResource(tradeResource(), MINTS.USDT, CLONES_POOL, 'geckoterminal')).toBeUndefined();
    expect(tradeFromResource(tradeResource({ tx_hash: 'abc' }), CLONES, CLONES_POOL, 'geckoterminal')).toBeUndefined();
    expect(tradeFromResource(tradeResource({ block_timestamp: null }), CLONES, CLONES_POOL, 'geckoterminal')).toBeUndefined();
  });
});

describe('poolInfoFromResource', () => {
  it('falls back to the pool name for symbols when included tokens are absent', () => {
    const doc = parseList('geckoterminal', fixture('new_pools_cdn_cache_hit.json'), 'x');
    const first = doc.data[0];
    if (!first) throw new Error('fixture empty');
    const pool = poolInfoFromResource(first, doc.included, 'geckoterminal');
    expect(pool).toMatchObject({
      address: 'Dg6uLudeDCzjWYTATUvFMaGKNrdeCu7nkdv1vGTrs9x9',
      dex: 'pumpfun',
      isBondingCurve: true,
      quoteMint: MINTS.SOL,
      quoteSymbol: 'SOL',
      baseToken: { symbol: 'BetOnBlak' },
      launchpad: { stage: 'bonding', launchpad: 'pump.fun' },
    });
    expect(pool?.baseToken).not.toHaveProperty('image');
  });
});

describe('parseTokenInfo', () => {
  it('omits holder fields that are null for brand-new tokens', () => {
    const doc = parseSingle('geckoterminal', fixture('token_info_bonding_curve.json'), 'x');
    const info = parseTokenInfo(doc.data, 'geckoterminal', 1_000);
    expect(info?.holders).toEqual({ mint: '62zeow8T5HL7nsUCqJPmc9c6vViwnPqhxa5Dd2pgpump', top: [], updatedAt: 1_000 });
    expect(info?.risk.top10Pct).toBeUndefined();
    expect(info?.risk.devHoldingPct).toBe(0);
  });

  it('never raises a honeypot flag and treats unknown authority strings as unknown', () => {
    const doc = parseSingle('geckoterminal', fixture('token_info_graduated.json'), 'x');
    const res: JsonApiResource = {
      ...doc.data,
      attributes: { ...doc.data.attributes, mint_authority: 'unknown', freeze_authority: 'yes', is_honeypot: 'yes' },
    };
    const risk = parseTokenInfo(res, 'geckoterminal', 1)?.risk;
    expect(risk?.mintAuthorityDisabled).toBeUndefined();
    expect(risk?.freezeAuthorityDisabled).toBe(false);
    expect(risk?.flags.map((f) => f.label)).toEqual(['Freeze authority enabled', 'Top 10 holders own 89.1%', 'Developer holds 20.7%']);
    expect(risk?.flags.some((f) => /honeypot/i.test(f.label))).toBe(false);
  });
});
