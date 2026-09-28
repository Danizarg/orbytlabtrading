import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { QuoteRequest } from '@/lib/core/providers';
import { isProviderError } from '@/lib/net/errors';
import {
  buildRiskReport,
  deriveLaunchpad,
  isDiscoverExcluded,
  mapSearchHit,
  mapTokenMarket,
  mapTokenMeta,
  mapTokenRow,
  mapUltraInfo,
  mapWindowStats,
  parseHoldings,
  parseMetisQuote,
  parseUltraOrder,
  priceOf,
  rawToUi,
} from './normalize';

type Json = Record<string, unknown>;

function load(file: string): unknown {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures', file), 'utf8'));
}

function tokens(file: string): Json[] {
  const data = load(file);
  if (!Array.isArray(data)) throw new Error(`${file} is not an array`);
  return data as Json[];
}

function byId(list: Json[], id: string): Json {
  const found = list.find((t) => t.id === id);
  if (!found) throw new Error(`fixture token ${id} missing`);
  return structuredClone(found);
}

const AI6 = 'DKxXdaMC1so182urvrrnhs6V6fGTrttPS8br6JuEpump';
const FARTCOIN = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const CC = '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const multi = tokens('jupiter/tokens_v2_search_multi_mints_graduated_fartcoin_jup.json');
const bonding = tokens('jupiter/tokens_v2_search_bonding_curve_pumpfun_token.json');
const recent = tokens('jupiter/tokens_v2_recent.trimmed.json');
const organic = tokens('jupiter/tokens_v2_toporganicscore_5m_limit3.json');
const pumpRecent = tokens('pump/jupiter_lite_tokens_v2_recent_launchpad_mix_trimmed_2026-09-28.json');
const pumpSearch = tokens('pump/jupiter_lite_tokens_v2_search_launchpad_fields_2026-09-28.json');
const ultra = tokens('jupiter/ultra_v1_search_mints_bonding_graduated_verified.json');

describe('mapTokenMeta', () => {
  it('maps a graduated pump.fun Token-2022 token', () => {
    const meta = mapTokenMeta(byId(multi, AI6));
    expect(meta).toEqual({
      mint: AI6,
      symbol: 'AI6',
      name: 'AI6 Agent',
      image: 'https://gatewaypinata.online/api/meta/ff84e18ed1723235b40a4ac4.jpg',
      decimals: 6,
      tokenProgram: 'token-2022',
      socials: { website: 'https://ai6agent.bot/', twitter: 'https://x.com/ai6agent' },
      creator: 'FBVsacNxQFhD1m79dJMTsLVqRYcoxFsMpyYcyYTmjrsy',
      createdAt: Date.parse('2026-09-28T20:44:09Z'),
      totalSupply: 997883986.413314,
      circulatingSupply: 997883986.413314,
      tags: ['unknown', 'token-2022'],
      launchpad: {
        stage: 'graduated',
        launchpad: 'pump.fun',
        migratedPool: 'A8mMNioRKoRXcb8nVVRy9KV7ZSPyfTTm13ye4bSgHw7F',
        graduatedAt: Date.parse('2026-09-28T20:45:34Z'),
      },
    });
    // Unverified tokens carry no isVerified and no 'verified' tag: omitted, not false.
    expect(meta).not.toHaveProperty('verified');
    expect(meta?.socials).not.toHaveProperty('telegram');
  });

  it('maps verified SPL tokens and uses firstPool.createdAt, not the index date', () => {
    const fart = mapTokenMeta(byId(multi, FARTCOIN));
    expect(fart?.verified).toBe(true);
    expect(fart?.tokenProgram).toBe('spl-token');
    expect(fart?.launchpad).toEqual({
      stage: 'graduated',
      launchpad: 'pump.fun',
      migratedPool: 'Bzc9NZfMqkXR6fz1DBph7BDf9BroyEf6pnzESP7v5iiw',
      graduatedAt: Date.parse('2024-10-18T06:09:47Z'),
    });

    const jup = mapTokenMeta(byId(multi, JUP));
    expect(jup?.createdAt).toBe(Date.parse('2024-01-29T17:33:29Z'));
    expect(jup?.circulatingSupply).toBe(3319369204.37);
    expect(jup?.totalSupply).toBe(6861486471.808773);
    expect(jup?.launchpad).toEqual({ stage: 'amm' });
  });

  it('treats a launchpad token without graduation fields as bonding (no progress in Tokens V2)', () => {
    const meta = mapTokenMeta(bonding[0]);
    expect(meta?.launchpad).toEqual({ stage: 'bonding', launchpad: 'pump.fun' });
    expect(meta?.launchpad).not.toHaveProperty('progressPct');
  });

  it('normalizes launchpad names, preferring launchpad over metaLaunchpad', () => {
    expect(deriveLaunchpad(byId(recent, '7yZKzy4dsDvWWMdb8p4U8bXwGXWoUGvbGKP727JK3CpM'))).toEqual({ stage: 'bonding', launchpad: 'stonkfun' });
    expect(deriveLaunchpad(byId(recent, 'DdW9EaFzqdaQKVnHy4LsVCdVrmZLYXRfQ4jMYKSKtkv8'))).toEqual({ stage: 'bonding', launchpad: 'Meteora DBC' });
    expect(deriveLaunchpad({ metaLaunchpad: 'raydium-launchlab' })).toEqual({ stage: 'bonding', launchpad: 'LaunchLab' });
    const si = tokens('jupiter/tokens_v2_toptrending_1h.trimmed.json');
    expect(deriveLaunchpad(byId(si, 'DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP'))).toEqual({
      stage: 'graduated',
      launchpad: 'stonkfun',
      migratedPool: 'B4VFURUHHzyt8YzBGBV9jiarBvjh1EbMAbRNBnNqaxUD',
      graduatedAt: Date.parse('2026-09-21T15:45:00Z'),
    });
    const claude = byId(pumpSearch, '4ov9rwwS4iBHeTWGCrVaQYW1HzWK51MSfs8csGAApump');
    expect(deriveLaunchpad(claude)).toMatchObject({ stage: 'graduated', migratedPool: '8HbgiXuiNbHRcxiNG8UBD8GLewoy6QVDnPFPgjFGmszf' });
  });

  it('omits unknown fields instead of inventing them', () => {
    const noIcon = mapTokenMeta(byId(recent, 'T3z2P9PEE4kEtWrow2sk4ATj6ojo48QZoj663NYpump'));
    expect(noIcon).not.toHaveProperty('image');
    expect(noIcon?.socials).toEqual({});

    const unsafe = byId(multi, AI6);
    unsafe.icon = 'http://insecure.example/logo.png';
    unsafe.twitter = 'javascript:alert(1)';
    unsafe.decimals = 'six';
    delete unsafe.firstPool;
    unsafe.tokenProgram = 'SomethingElse1111111111111111111111111111111';
    const meta = mapTokenMeta(unsafe);
    expect(meta).not.toHaveProperty('image');
    expect(meta?.socials).not.toHaveProperty('twitter');
    expect(meta).not.toHaveProperty('decimals');
    expect(meta).not.toHaveProperty('createdAt');
    expect(meta).not.toHaveProperty('tokenProgram');
  });

  it('rejects objects without an id', () => {
    expect(mapTokenMeta({ symbol: 'X' })).toBeUndefined();
    expect(mapTokenMeta(null)).toBeUndefined();
    expect(mapTokenRow('nope', 1)).toBeUndefined();
  });
});

describe('mapWindowStats / mapTokenMarket', () => {
  it('maps stats windows with USD volumes and 0–100 price change', () => {
    const market = mapTokenMarket(byId(multi, AI6), 1_000);
    expect(market?.stats.m5).toEqual({
      buys: 2070,
      sells: 1468,
      traders: 1242,
      volumeUsd: 134065.06112203098 + 110517.32676747689,
      buyVolumeUsd: 134065.06112203098,
      sellVolumeUsd: 110517.32676747689,
      priceChangePct: 3374.495471018415,
    });
    expect(Object.keys(market?.stats ?? {}).sort()).toEqual(['h1', 'h24', 'h6', 'm5']);
    expect(market).toMatchObject({
      mint: AI6,
      priceUsd: 0.00024176986679724297,
      marketCapUsd: 241258.27847424874,
      fdvUsd: 241258.27847424874,
      liquidityUsd: 21959.880244486052,
      holders: 934,
      updatedAt: 1_000,
      source: 'jupiter',
    });
    expect(market).not.toHaveProperty('priceSol');
  });

  it('only sums volume when both halves are present', () => {
    expect(mapWindowStats({ buyVolume: 10, numBuys: 2 })).toEqual({ buyVolumeUsd: 10, buys: 2 });
    expect(mapWindowStats({ buyVolume: '5.5', sellVolume: '0.00000002954' })).toEqual({
      buyVolumeUsd: 5.5,
      sellVolumeUsd: 0.00000002954,
      volumeUsd: 5.5 + 0.00000002954,
    });
    expect(mapWindowStats({})).toBeUndefined();
    expect(mapWindowStats(null)).toBeUndefined();
  });

  it('omits a missing stats window and unpriced market fields', () => {
    const cat = mapTokenMarket(byId(pumpSearch, 'EVQSX4EQFP8VtS5KDfwkQYJCiVoB3bvJbuooV7Qzpump'), 1);
    expect(cat?.stats).not.toHaveProperty('m5');
    expect(cat?.stats.h1).toBeDefined();

    // Brand-new met-dbc token: no priced trade yet, no stats.
    const fresh = mapTokenMarket(byId(recent, 'DdW9EaFzqdaQKVnHy4LsVCdVrmZLYXRfQ4jMYKSKtkv8'), 1);
    expect(fresh).toEqual({ mint: 'DdW9EaFzqdaQKVnHy4LsVCdVrmZLYXRfQ4jMYKSKtkv8', holders: 1, stats: {}, updatedAt: 1, source: 'jupiter' });
  });

  it('keeps pump.fun recent-mix fields intact', () => {
    const flake = mapTokenRow(pumpRecent[0], 5, 1);
    expect(flake?.token).not.toHaveProperty('image');
    expect(flake?.market.stats.m5?.buys).toBeTypeOf('number');
    expect(flake?.risk).toMatchObject({ devHoldingPct: 0.03531347272009999, mintAuthorityDisabled: true, devLaunches: 1 });
    expect(flake?.risk).not.toHaveProperty('top10Pct');
  });
});

describe('mapTokenRow / mapSearchHit', () => {
  it('builds a Discover row with risk summary and rank', () => {
    const row = mapTokenRow(byId(multi, FARTCOIN), 42, 3);
    expect(row?.rank).toBe(3);
    expect(row?.token).toMatchObject({ mint: FARTCOIN, symbol: 'Fartcoin', verified: true, creator: 'HyYNVYmnFmi87NsQqWzLJhUTPBKQUfgfhdbBa554nMFF' });
    expect(row?.token).not.toHaveProperty('socials');
    expect(row?.risk).toEqual({
      top10Pct: 33.69108018071797,
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      devLaunches: 495,
      organicScore: 94.34534087151036,
    });
    expect(row).not.toHaveProperty('pool');
    expect(mapTokenRow(byId(multi, FARTCOIN), 42)).not.toHaveProperty('rank');
  });

  it('builds a search hit with 24h volume', () => {
    const hit = mapSearchHit(byId(multi, JUP));
    expect(hit).toEqual({
      mint: JUP,
      symbol: 'JUP',
      name: 'Jupiter',
      image: 'https://static.jup.ag/jup/icon.png',
      priceUsd: 0.3293841141316194,
      marketCapUsd: 1093347484.8571906,
      liquidityUsd: 5552518.672494831,
      volume24hUsd: 12698051.350847384 + 12824534.807003492,
      verified: true,
      launchpad: { stage: 'amm' },
      source: 'jupiter',
    });
  });
});

describe('isDiscoverExcluded', () => {
  it('filters SOL and stablecoins (mint list and stable tag)', () => {
    expect(isDiscoverExcluded(byId(organic, SOL))).toBe(true);
    expect(isDiscoverExcluded(byId(organic, USDC))).toBe(true);
    expect(isDiscoverExcluded({ id: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' })).toBe(true);
    expect(isDiscoverExcluded({ id: 'SomeNewStable1111111111111111111111111111111', tags: ['stablecoin'] })).toBe(true);
    expect(isDiscoverExcluded(byId(organic, 'CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp'))).toBe(false);
  });
});

describe('risk', () => {
  it('derives authority flags from top-level authorities (USDC keeps mint/freeze authority)', () => {
    const report = buildRiskReport(byId(organic, USDC), 7);
    expect(report).toMatchObject({ mint: USDC, mintAuthorityDisabled: false, freezeAuthorityDisabled: false, sources: ['jupiter'], updatedAt: 7 });
    expect(report.flags.filter((f) => f.level === 'warn').map((f) => f.label)).toEqual(['Mint authority active', 'Freeze authority active']);
  });

  it('adds a danger flag only when audit.isSus is present', () => {
    const clean = buildRiskReport(bonding[0] as Json, 1);
    expect(clean.flags.some((f) => f.level === 'danger')).toBe(false);
    const sus = structuredClone(bonding[0]) as Json & { audit: Json };
    sus.audit.isSus = true;
    const flagged = buildRiskReport(sus, 1);
    expect(flagged.flags[0]).toMatchObject({ level: 'danger', source: 'jupiter' });
  });

  it('merges Ultra extras without overriding Tokens V2 audit values', () => {
    const info = mapUltraInfo(byId(ultra, CC));
    const report = buildRiskReport(bonding[0] as Json, 1, info);
    expect(report).toMatchObject({
      top10Pct: 24.514412749176103, // Tokens V2 value wins
      devHoldingPct: 6.6285714223523,
      botHoldersPct: 34.9474765407767,
      devLaunches: 1264,
      organicScore: 0,
    });
    expect(report).not.toHaveProperty('snipersPct');
  });
});

describe('mapUltraInfo', () => {
  it('reads bonding-curve progress and bundler/bot extras', () => {
    expect(mapUltraInfo(byId(ultra, CC))).toEqual({
      progressPct: 50.033290336154835,
      risk: { botHoldersPct: 34.9474765407767, top10Pct: 33.4077053414488, devHoldingPct: 6.6285714223523 },
    });
    expect(mapUltraInfo(byId(ultra, AI6))).toMatchObject({ progressPct: 100, risk: { bundlersPct: 0.908, botHoldersPct: 71.67110050197368 } });
    const jup = mapUltraInfo(byId(ultra, JUP));
    expect(jup).not.toHaveProperty('progressPct');
    expect(jup?.risk.bundlersPct).toBe(0.035);
  });

  it('maps sniper / insider percentages when present and clamps progress', () => {
    expect(mapUltraInfo({ id: CC, bondingCurve: 100.4, audit: { sniperPct: 12.5, insiderPct: '3.25' } })).toEqual({
      progressPct: 100,
      risk: { snipersPct: 12.5, insidersPct: 3.25 },
    });
  });
});

describe('priceOf', () => {
  it('returns only reliable positive prices', () => {
    const prices = load('jupiter/price_v3_mixed_sol_usdc_graduated_bonding_illiquid.json') as Json;
    expect(priceOf(prices[SOL])).toBe(118.75666994538565);
    expect(priceOf(prices.DpBPbJpQhvEvCKW9tFCAHomg6nwzrrtzoSksrwddxCdo)).toBe(0.0000033367214369439403);
    expect(priceOf(undefined)).toBeUndefined();
    expect(priceOf({ usdPrice: null })).toBeUndefined();
    expect(priceOf({ usdPrice: 0 })).toBeUndefined();
  });
});

describe('rawToUi', () => {
  it('converts raw base units using the digit string', () => {
    expect(rawToUi('40184755771', 6)).toBe(40184.755771);
    expect(rawToUi('100000000', 9)).toBe(0.1);
    expect(rawToUi('5', 9)).toBe(0.000000005);
    expect(rawToUi('0', 6)).toBe(0);
    expect(rawToUi(1500, 3)).toBe(1.5);
    expect(rawToUi('12', 0)).toBe(12);
    expect(rawToUi('1.5', 6)).toBeUndefined();
    expect(rawToUi('-1', 6)).toBeUndefined();
    expect(rawToUi(undefined, 6)).toBeUndefined();
    expect(rawToUi('1', -1)).toBeUndefined();
  });
});

describe('parseHoldings', () => {
  const wallet = 'JUPhop9E8ZfdJ5FNHhxQt4uAih822Vs4QpqsWcewFbq';

  it('reads SOL and sums token accounts per mint', () => {
    const payload = load('jupiter/ultra_v1_holdings.trimmed.json') as Json & { tokens: Record<string, Json[]> };
    const mint = 'FvzLALAbwwETJYd1WKRLjjssANGwsL12RKdz4QpogRrc';
    payload.tokens[mint]?.push({ account: 'x', amount: '1500000', uiAmount: 1.5, decimals: 6, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' });
    payload.tokens.ZeroBalanceMint11111111111111111111111111111 = [{ amount: '0', uiAmount: 0, decimals: 6 }];
    const { portfolio, skipped } = parseHoldings(wallet, payload, 9);
    expect(skipped).toBe(0);
    expect(portfolio.sol).toBe(0.860805774);
    expect(portfolio.tokens).toEqual([
      { mint: 'JxxWsvm9jHt4ah7DT9NuLyVLYZcZLUdPD93PcPQ71Ka', amount: 1, decimals: 9, tokenProgram: 'spl-token' },
      { mint: '2rEvYMLNncmvqUiJqeW59YsHFtUbAMLgJ7dMyjrvseC7', amount: 5000000, decimals: 9, tokenProgram: 'spl-token' },
      { mint, amount: 68206251.5, decimals: 6, tokenProgram: 'spl-token' },
    ]);
    expect(portfolio).toMatchObject({ address: wallet, pricedCount: 0, unpricedCount: 3, updatedAt: 9 });
    expect(portfolio).not.toHaveProperty('totalUsd');
    expect(portfolio).not.toHaveProperty('solPriceUsd');
  });

  it('falls back to lamports and raw amounts, and skips unreadable balances', () => {
    const { portfolio, skipped } = parseHoldings(
      wallet,
      { amount: '2500000000', tokens: { A: [{ amount: '123456', decimals: 3 }], B: [{ uiAmount: 5 }], C: [{ uiAmount: 1, decimals: 0 }, 'junk'] } },
      1,
    );
    expect(portfolio.sol).toBe(2.5);
    expect(portfolio.tokens).toEqual([{ mint: 'A', amount: 123.456, decimals: 3 }]);
    expect(skipped).toBe(2);
  });

  it('throws malformed when the structure is wrong', () => {
    for (const bad of [[], { tokens: {} }, { uiAmount: 1 }, { error: 'nope' }]) {
      let caught: unknown;
      try {
        parseHoldings(wallet, bad, 1);
      } catch (e) {
        caught = e;
      }
      expect(isProviderError(caught) && caught.code === 'malformed').toBe(true);
    }
  });
});

describe('quotes', () => {
  const graduated: QuoteRequest = { inputMint: SOL, outputMint: AI6, amountRaw: '100000000', inputDecimals: 9, outputDecimals: 6 };

  it('parses a Metis /swap/v1/quote (ratio price impact → percent)', () => {
    const quote = parseMetisQuote(load('jupiter/swap_v1_quote_graduated_pumpswap.json'), graduated, 100, 5);
    expect(quote).toEqual({
      inputMint: SOL,
      outputMint: AI6,
      inAmount: 0.1,
      outAmount: 40184.755771,
      inUsd: 11.87016454107116,
      priceImpactPct: 0.6954769353820882,
      route: ['Pump.fun Amm'],
      router: 'Metis',
      slippageBps: 100,
      fetchedAt: 5,
    });
    expect(quote).not.toHaveProperty('feeBps');
  });

  it('parses a bonding-curve Metis quote with its own slippage echo', () => {
    const request: QuoteRequest = { ...graduated, outputMint: CC };
    const quote = parseMetisQuote(load('jupiter/swap_v1_quote_bonding_curve_pumpfun.json'), request, 100, 5);
    expect(quote).toMatchObject({ outAmount: 1634407.023205, route: ['Pump.fun'], slippageBps: 300, router: 'Metis' });
  });

  it('parses a Jupiter Ultra /swap/v2/order quote (percent points, positive = cost)', () => {
    const quote = parseUltraOrder(load('jupiter/swap_v2_order_quote_no_taker.json'), graduated, undefined, 6);
    expect(quote).toEqual({
      inputMint: SOL,
      outputMint: AI6,
      inAmount: 0.1,
      outAmount: 41665.048348,
      inUsd: 11.870625406582567,
      outUsd: 10.63333983640017,
      priceImpactPct: 10.423086634477494,
      route: ['Pump.fun Amm'],
      router: 'Jupiter Ultra',
      feeBps: 10,
      fetchedAt: 6,
    });
    // No taker and no explicit slippage: Jupiter's slippageBps 0 is "undetermined", so it is omitted.
    expect(quote).not.toHaveProperty('slippageBps');
  });

  it('reports explicit slippage on Ultra manual-mode quotes', () => {
    const request: QuoteRequest = { ...graduated, outputMint: CC, amountRaw: '50000000' };
    const quote = parseUltraOrder(load('jupiter/swap_v2_order_quote_bonding_curve_manual_slippage.json'), request, 500, 6);
    expect(quote).toMatchObject({ inAmount: 0.05, outAmount: 493502.569631, slippageBps: 500, priceImpactPct: 3.097828989526357, route: ['Pump.fun'] });
  });

  it('rejects mismatched or amount-less payloads', () => {
    const wrongMint = { ...graduated, outputMint: CC };
    expect(() => parseMetisQuote(load('jupiter/swap_v1_quote_graduated_pumpswap.json'), wrongMint, 100, 1)).toThrow(/unexpected response/);
    expect(() => parseUltraOrder({ inputMint: SOL, errorCode: 1, transaction: '' }, graduated, undefined, 1)).toThrow(/unexpected response/);
    expect(() => parseMetisQuote({ error: 'No routes found', errorCode: 'NO_ROUTES_FOUND' }, graduated, 100, 1)).toThrow(/unexpected response/);
  });
});
