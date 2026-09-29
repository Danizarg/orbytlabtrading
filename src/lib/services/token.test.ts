import { describe, expect, it } from 'vitest';
import { ChainError } from '@/lib/core/chain';
import { MINTS } from '@/lib/core/solana';
import type { BondingCurveState, Candle, MintInfo, PoolInfo, RiskReport, TokenMeta, TokenRow, Trade } from '@/lib/core/types';
import {
  applyOnchainAuthorities,
  buildQuoteRequest,
  chainWinner,
  chartCurrencyOption,
  curvePriceUsd,
  explorerLinks,
  filterTrades,
  formatSlippage,
  frozenPools,
  geckoQuoteOhlcvPath,
  impliedQuoteUsd,
  intervalOptions,
  isDefinitelyAbsent,
  isIndexedPool,
  isLiveFreshness,
  isSolQuoted,
  jupiterSwapUrl,
  marketCapAtTrade,
  mergeLaunchpad,
  mergeOverview,
  mergeRiskReports,
  otherQuoteMint,
  parseMinUsd,
  parsePoolParam,
  parseSlippagePct,
  pollForWinner,
  poolFromCurve,
  priceImpactTone,
  quoteMatchesRequest,
  quoteRate,
  quoteToGraduation,
  riskTone,
  sanitizeAmountInput,
  selectPrimaryPool,
  solPricedTrades,
  toRawAmount,
  tokenTradeHref,
  tradeTicks,
  usdToSol,
  visibleFailures,
} from './token';

// Synthetic but structurally real inputs (tests only; the app never uses static data).
const MINT = 'FRhB8L7Y9Qq2L9Yyo7YVPLg4h4hkATXgsdRKUj7DjXcd';
const CURVE_POOL = '5Ng2m8xY1TyzbFJbXQnj1WjUn1a6uw7z3b9xP3e5k1Ab';
const AMM_POOL = '7XQkxFo8oW1PW5A8ynhF9dyAkDxiuHg5tSo6jvHHmnRq';
const AMM_POOL_2 = '9ykk4ymm35iQcLvrY2s6YvQ6Xr3o7FdWVmVEZHmfpTn4';
const WALLET = '2xNwwA8DmH5AsLhBjevvkPzTnpvH6Zz4pQ7vCpV1yB1a';

function pool(p: Partial<PoolInfo> & { address: string }): PoolInfo {
  return { dex: 'raydium', dexLabel: 'Raydium', baseMint: MINT, quoteMint: MINTS.SOL, quoteSymbol: 'SOL', source: 'dexscreener', ...p };
}

const curvePool = pool({ address: CURVE_POOL, dex: 'pumpfun', dexLabel: 'Pump.fun', isBondingCurve: true, liquidityUsd: 12_000, priceUsd: 0.00001 });
const ammPool = pool({ address: AMM_POOL, dex: 'pumpswap', dexLabel: 'PumpSwap', liquidityUsd: 80_000, volume24hUsd: 900_000 });
const smallAmm = pool({ address: AMM_POOL_2, dex: 'raydium-cpmm', dexLabel: 'Raydium CPMM', liquidityUsd: 5_000, volume24hUsd: 100 });

function curve(over: Partial<BondingCurveState> = {}): BondingCurveState {
  return {
    mint: MINT,
    curve: CURVE_POOL,
    complete: false,
    progressPct: 0,
    virtualTokenReserves: 1_073_000_000,
    virtualQuoteReserves: 30,
    realTokenReserves: 793_100_000,
    realQuoteReserves: 0,
    quoteMint: MINTS.SOL,
    quoteDecimals: 9,
    priceQuote: 30 / 1_073_000_000,
    fetchedAt: 1_000,
    ...over,
  };
}

describe('selectPrimaryPool', () => {
  it('picks the most liquid AMM pool and orders pools by liquidity', () => {
    const sel = selectPrimaryPool(MINT, [smallAmm, ammPool], { stage: 'amm' });
    expect(sel.primary?.address).toBe(AMM_POOL);
    expect(sel.pools.map((p) => p.address)).toEqual([AMM_POOL, AMM_POOL_2]);
    expect(sel.overridden).toBe(false);
  });

  it('uses the bonding curve while the token is bonding', () => {
    const sel = selectPrimaryPool(MINT, [curvePool], { stage: 'bonding' });
    expect(sel.primary?.address).toBe(CURVE_POOL);
    const onChain = selectPrimaryPool(MINT, [curvePool, ammPool], { curveComplete: false });
    expect(onChain.primary?.address).toBe(CURVE_POOL);
  });

  it('excludes the frozen post-graduation curve pair', () => {
    const sel = selectPrimaryPool(MINT, [curvePool, ammPool], { stage: 'graduated' });
    expect(sel.primary?.address).toBe(AMM_POOL);
    expect(sel.frozen.has(CURVE_POOL)).toBe(true);
    // The decoded curve flag is authoritative even when providers still say 'bonding'.
    const byChain = selectPrimaryPool(MINT, [curvePool, ammPool], { stage: 'bonding', curveComplete: true });
    expect(byChain.primary?.address).toBe(AMM_POOL);
  });

  it('infers a frozen curve from a migration venue and from a price-less DEX Screener curve', () => {
    expect(frozenPools([curvePool, ammPool]).has(CURVE_POOL)).toBe(true);
    const priceless = { ...curvePool, priceUsd: undefined };
    expect(frozenPools([priceless, smallAmm]).has(CURVE_POOL)).toBe(true);
    expect(frozenPools([curvePool]).size).toBe(0);
  });

  it('honours a valid ?pool= override only for a known active pool', () => {
    const sel = selectPrimaryPool(MINT, [ammPool, smallAmm], { override: AMM_POOL_2 });
    expect(sel.primary?.address).toBe(AMM_POOL_2);
    expect(sel.overridden).toBe(true);
    expect(selectPrimaryPool(MINT, [ammPool], { override: 'not-an-address' }).primary?.address).toBe(AMM_POOL);
    expect(selectPrimaryPool(MINT, [curvePool, ammPool], { stage: 'graduated', override: CURVE_POOL }).primary?.address).toBe(AMM_POOL);
  });

  it('prefers pools where the token is the base asset and de-duplicates addresses', () => {
    const quoteSide = pool({ address: AMM_POOL_2, baseMint: MINTS.USDC, quoteMint: MINT, liquidityUsd: 1_000_000 });
    const sel = selectPrimaryPool(MINT, [quoteSide, ammPool, { ...ammPool, source: 'geckoterminal' }]);
    expect(sel.pools).toHaveLength(1);
    expect(sel.primary?.address).toBe(AMM_POOL);
    expect(selectPrimaryPool(MINT, [quoteSide]).primary?.address).toBe(AMM_POOL_2);
  });
});

describe('mergeOverview', () => {
  const row: TokenRow = {
    token: { mint: MINT, symbol: 'ORB', name: 'Orbyt', image: 'https://img/1.png', decimals: 6, socials: { twitter: 'https://x.com/orb' }, launchpad: { stage: 'bonding', launchpad: 'pump.fun', progressPct: 40 } },
    market: { mint: MINT, priceUsd: 0.001, marketCapUsd: 1_000_000, stats: {}, updatedAt: 1, source: 'jupiter' },
  };
  const info: TokenMeta = {
    mint: MINT,
    symbol: 'ORBX',
    name: 'Orbyt (GT)',
    socials: { twitter: 'https://x.com/other', website: 'https://orb.xyz' },
    description: 'desc',
    creator: WALLET,
    tags: ['meme'],
  };
  const mintInfo: MintInfo = { mint: MINT, decimals: 9, supply: 999_000, tokenProgram: 'token-2022', mintAuthority: null, freezeAuthority: WALLET, fetchedAt: 5 };

  it('keeps row identity, fills gaps from GeckoTerminal info and lets the chain win decimals', () => {
    const view = mergeOverview({ mint: MINT, row, info, infoHolders: 321, mintInfo });
    expect(view.meta.symbol).toBe('ORB');
    expect(view.meta.name).toBe('Orbyt');
    expect(view.meta.socials).toEqual({ twitter: 'https://x.com/orb', website: 'https://orb.xyz' });
    expect(view.meta.description).toBe('desc');
    expect(view.meta.creator).toBe(WALLET);
    expect(view.meta.tags).toEqual(['meme']);
    expect(view.meta.decimals).toBe(9);
    expect(view.meta.tokenProgram).toBe('token-2022');
    expect(view.market?.holders).toBe(321);
    expect(view.market?.priceUsd).toBe(0.001);
    expect(view.supply).toBe(999_000);
  });

  it('overrides provider launch state with the decoded curve', () => {
    const bonding = mergeOverview({ mint: MINT, row, curve: curve({ progressPct: 63.2 }) });
    expect(bonding.meta.launchpad).toMatchObject({ stage: 'bonding', launchpad: 'pump.fun', progressPct: 63.2, progressSource: 'solana-rpc' });
    const done = mergeOverview({ mint: MINT, row, curve: curve({ complete: true, progressPct: 100 }) });
    expect(done.meta.launchpad?.stage).toBe('graduated');
    expect(done.meta.launchpad?.progressPct).toBe(100);
  });

  it('falls back to Token-2022 metadata and reports no market without a row', () => {
    const view = mergeOverview({ mint: MINT, mintInfo: { ...mintInfo, metadata: { name: 'Chain Name', symbol: 'CHN' } } });
    expect(view.meta.symbol).toBe('CHN');
    expect(view.meta.name).toBe('Chain Name');
    expect(view.market).toBeUndefined();
  });

  it('merges launchpad reports one-way (graduation wins over stale bonding)', () => {
    expect(mergeLaunchpad({ stage: 'bonding', launchpad: 'pump.fun' }, { stage: 'graduated' })).toMatchObject({ stage: 'graduated', launchpad: 'pump.fun' });
    expect(mergeLaunchpad({ stage: 'amm' }, { stage: 'bonding', launchpad: 'letsbonk' })?.stage).toBe('bonding');
    expect(mergeLaunchpad({ stage: 'graduated' }, { stage: 'bonding' })?.stage).toBe('graduated');
  });
});

describe('marketCapAtTrade', () => {
  const trade: Trade = { signature: 'sig', timestamp: 1_000, side: 'buy', priceUsd: 0.002, source: 'geckoterminal' };
  it('prefers the provider figure, else price × supply, else undefined', () => {
    expect(marketCapAtTrade({ ...trade, marketCapUsd: 42 }, 1_000_000)).toBe(42);
    expect(marketCapAtTrade(trade, 1_000_000_000)).toBeCloseTo(2_000_000);
    expect(marketCapAtTrade(trade, undefined)).toBeUndefined();
    expect(marketCapAtTrade({ ...trade, priceUsd: undefined }, 1_000)).toBeUndefined();
    expect(marketCapAtTrade({ ...trade, marketCapUsd: 0 }, 0)).toBeUndefined();
  });
});

describe('quote requests', () => {
  it('converts decimal amounts to raw base units without float error', () => {
    expect(toRawAmount('0.5', 9)).toBe('500000000');
    expect(toRawAmount('1234.5', 6)).toBe('1234500000');
    expect(toRawAmount('0.1', 9)).toBe('100000000');
    expect(toRawAmount('1,5', 9)).toBe('1500000000');
    expect(toRawAmount('0.1234567891', 9)).toBe('123456789');
    expect(toRawAmount('0', 9)).toBeUndefined();
    expect(toRawAmount('abc', 9)).toBeUndefined();
    expect(toRawAmount('1', -1)).toBeUndefined();
  });

  it('builds SOL→token buys and token→SOL sells', () => {
    const buy = buildQuoteRequest({ side: 'buy', mint: MINT, amount: '0.5', tokenDecimals: 6, slippageBps: 500 });
    expect(buy).toEqual({ inputMint: MINTS.SOL, outputMint: MINT, amountRaw: '500000000', inputDecimals: 9, outputDecimals: 6, slippageBps: 500 });
    const sell = buildQuoteRequest({ side: 'sell', mint: MINT, amount: '2500', tokenDecimals: 6 });
    expect(sell).toEqual({ inputMint: MINT, outputMint: MINTS.SOL, amountRaw: '2500000000', inputDecimals: 6, outputDecimals: 9 });
    expect(buildQuoteRequest({ side: 'buy', mint: MINT, amount: '1', tokenDecimals: undefined })).toBeUndefined();
    expect(buildQuoteRequest({ side: 'buy', mint: MINTS.SOL, amount: '1', tokenDecimals: 9 })).toBeUndefined();
    expect(buildQuoteRequest({ side: 'buy', mint: MINT, amount: '', tokenDecimals: 6 })).toBeUndefined();
  });

  it('derives the implied SOL price per token from a quote', () => {
    expect(quoteRate({ inAmount: 1, outAmount: 2_000 }, 'buy')).toBeCloseTo(0.0005);
    expect(quoteRate({ inAmount: 2_000, outAmount: 1 }, 'sell')).toBeCloseTo(0.0005);
    expect(quoteRate({ inAmount: 0, outAmount: 1 }, 'buy')).toBeUndefined();
  });

  it('parses slippage and amount fields', () => {
    expect(parseSlippagePct('10')).toBe(1_000);
    expect(parseSlippagePct('0.5%')).toBe(50);
    expect(parseSlippagePct('99')).toBe(5_000);
    expect(parseSlippagePct('0')).toBeUndefined();
    expect(parseSlippagePct('x')).toBeUndefined();
    expect(formatSlippage(1_000)).toBe('10%');
    expect(formatSlippage(50)).toBe('0.5%');
    expect(sanitizeAmountInput('1,2.3abc4')).toBe('1.234');
    expect(sanitizeAmountInput('..5')).toBe('.5');
    expect(priceImpactTone(2)).toBe('ok');
    expect(priceImpactTone(7)).toBe('warn');
    expect(priceImpactTone(-20)).toBe('danger');
    expect(priceImpactTone(undefined)).toBe('unknown');
  });

  it('keeps a previous quote on screen only for the same pair direction', () => {
    const buy = buildQuoteRequest({ side: 'buy', mint: MINT, amount: '1', tokenDecimals: 6 });
    const sell = buildQuoteRequest({ side: 'sell', mint: MINT, amount: '1', tokenDecimals: 6 });
    const buyQuote = { inputMint: MINTS.SOL, outputMint: MINT };
    expect(quoteMatchesRequest(buyQuote, buy)).toBe(true);
    expect(quoteMatchesRequest(buyQuote, sell)).toBe(false);
    expect(quoteMatchesRequest(buyQuote, undefined)).toBe(false);
    expect(quoteMatchesRequest(undefined, buy)).toBe(false);
  });

  it('links to Jupiter with the pair preselected', () => {
    expect(jupiterSwapUrl(MINT, 'buy')).toBe(`https://jup.ag/swap?sell=${MINTS.SOL}&buy=${MINT}`);
    expect(jupiterSwapUrl(MINT, 'sell')).toBe(`https://jup.ag/swap?sell=${MINT}&buy=${MINTS.SOL}`);
  });
});

describe('quoteToGraduation', () => {
  it('computes the SOL needed to buy out the remaining real tokens (constant product)', () => {
    // k = 30 × 1,073,000,000; buying all 793.1M real tokens leaves 279.9M virtual → 30 × 1073 / 279.9 − 30 ≈ 85.0 SOL.
    expect(quoteToGraduation(curve())).toBeCloseTo(85.005, 2);
    // Halfway through: 396.55M real tokens left, 676.45M virtual.
    const half = curve({ realTokenReserves: 396_550_000, virtualTokenReserves: 676_450_000, virtualQuoteReserves: 47.6 });
    expect(quoteToGraduation(half)).toBeCloseTo((47.6 * 676_450_000) / 279_900_000 - 47.6, 6);
  });

  it('is undefined for complete or inconsistent curves', () => {
    expect(quoteToGraduation(curve({ complete: true }))).toBeUndefined();
    expect(quoteToGraduation(curve({ realTokenReserves: 2_000_000_000 }))).toBeUndefined();
    expect(quoteToGraduation(curve({ virtualQuoteReserves: 0 }))).toBeUndefined();
  });

  it('prices the curve in USD only with a SOL price', () => {
    expect(curvePriceUsd(curve(), 150)).toBeCloseTo((30 / 1_073_000_000) * 150);
    expect(curvePriceUsd(curve(), undefined)).toBeUndefined();
    expect(curvePriceUsd(curve({ quoteMint: MINTS.USDC }), undefined)).toBeCloseTo(30 / 1_073_000_000);
  });
});

describe('risk merge', () => {
  const server: RiskReport = { mint: MINT, top10Pct: 22, flags: [{ level: 'warn', label: 'Snipers hold 25%', source: 'solanatracker' }], sources: ['solanatracker'], updatedAt: 10 };
  const jup: RiskReport = { mint: MINT, top10Pct: 30, snipersPct: 25, organicScore: 40, flags: [{ level: 'danger', label: 'snipers hold 25%', source: 'jupiter' }], sources: ['jupiter'], updatedAt: 20 };

  it('fills scalars in precedence order and unions flags by label (most severe wins)', () => {
    const merged = mergeRiskReports(MINT, [server, undefined, jup]);
    expect(merged?.top10Pct).toBe(22);
    expect(merged?.snipersPct).toBe(25);
    expect(merged?.sources).toEqual(['solanatracker', 'jupiter']);
    expect(merged?.flags).toHaveLength(1);
    expect(merged?.flags[0]?.level).toBe('danger');
    expect(merged?.updatedAt).toBe(20);
    expect(mergeRiskReports(MINT, [undefined])).toBeUndefined();
  });

  it('takes authorities from the chain', () => {
    const info: MintInfo = { mint: MINT, decimals: 6, supply: 1, tokenProgram: 'spl-token', mintAuthority: null, freezeAuthority: WALLET, fetchedAt: 1 };
    const risk = applyOnchainAuthorities(MINT, undefined, info);
    expect(risk?.mintAuthorityDisabled).toBe(true);
    expect(risk?.freezeAuthorityDisabled).toBe(false);
    expect(risk?.sources).toEqual(['solana-rpc']);
    expect(riskTone('top10', 55)).toBe('danger');
    expect(riskTone('dev', 12)).toBe('warn');
    expect(riskTone('snipers', undefined)).toBe('unknown');
  });
});

describe('trades', () => {
  const trades: Trade[] = [
    { signature: 'a', timestamp: 3_000, side: 'buy', usdValue: 500, priceUsd: 1, source: 'orbyt' },
    { signature: 'b', timestamp: 2_000, side: 'sell', priceUsd: 2, tokenAmount: 10, source: 'orbyt' },
    { signature: 'c', timestamp: 1_000, side: 'buy', source: 'orbyt' },
  ];

  it('filters by side and minimum USD (unpriced trades hidden under a minimum)', () => {
    expect(filterTrades(trades, { side: 'all', minUsd: 0 })).toHaveLength(3);
    expect(filterTrades(trades, { side: 'sell', minUsd: 0 }).map((t) => t.signature)).toEqual(['b']);
    expect(filterTrades(trades, { side: 'all', minUsd: 20 }).map((t) => t.signature)).toEqual(['a', 'b']);
    expect(filterTrades(trades, { side: 'all', minUsd: 100 }).map((t) => t.signature)).toEqual(['a']);
    expect(parseMinUsd('$1,000')).toBe(1_000);
    expect(parseMinUsd('')).toBe(0);
  });

  it('turns realtime trades into chronological live ticks, counting volume only after the snapshot', () => {
    const ticks = tradeTicks(trades, 2, 2_500);
    expect(ticks).toEqual([
      { timeSec: 2, price: 2 },
      { timeSec: 3, price: 1, volumeUsd: 500 },
    ]);
  });
});

describe('chart intervals', () => {
  it('routes each interval to a keyed server source, GeckoTerminal or ORBYT trade aggregation', () => {
    const keyless = intervalOptions({ serverCandles: false, serverSecondIntervals: [], geckoIntervals: ['1m', '5m', '15m', '1h', '4h', '1d'], hasPool: true, hasTradeFeed: true });
    expect(keyless.find((o) => o.interval === '1s')).toMatchObject({ kind: 'trades', available: true });
    expect(keyless.find((o) => o.interval === '1m')).toMatchObject({ kind: 'gecko', available: true });
    const keyed = intervalOptions({ serverCandles: true, serverSecondIntervals: ['1s'], geckoIntervals: [], hasPool: true, hasTradeFeed: false });
    expect(keyed.find((o) => o.interval === '1s')).toMatchObject({ kind: 'server', available: true });
    expect(keyed.find((o) => o.interval === '5s')).toMatchObject({ available: false });
    const noFeed = intervalOptions({ serverCandles: false, serverSecondIntervals: [], geckoIntervals: ['1m'], hasPool: false, hasTradeFeed: false });
    expect(noFeed.find((o) => o.interval === '1m')?.available).toBe(false);
  });
});

describe('SOL-denominated charts', () => {
  const GECKO = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

  it('names the quote asset that needs its own USD price (not SOL, not a stablecoin) and the price its pool implies', () => {
    const GLDX = 'GLDxQuoteAsset11111111111111111111111111111';
    expect(otherQuoteMint({ quoteMint: GLDX })).toBe(GLDX);
    expect(otherQuoteMint({ quoteMint: MINTS.SOL })).toBeUndefined();
    expect(otherQuoteMint({ quoteMint: MINTS.USDC })).toBeUndefined();
    expect(otherQuoteMint({})).toBeUndefined();
    expect(otherQuoteMint(undefined)).toBeUndefined();
    // $0.0000034 per token at 0.0000000085 GLDx per token → GLDx ≈ $400.
    expect(impliedQuoteUsd({ priceUsd: 0.0000034, priceNative: 0.0000000085 })).toBeCloseTo(400, 9);
    expect(impliedQuoteUsd({ priceUsd: 0.0000034 })).toBeUndefined();
    expect(impliedQuoteUsd({ priceUsd: 0, priceNative: 1 })).toBeUndefined();
    expect(impliedQuoteUsd(undefined)).toBeUndefined();
  });

  it('recognises SOL-quoted pools by mint, else by symbol', () => {
    expect(isSolQuoted(ammPool)).toBe(true);
    expect(isSolQuoted({ quoteMint: MINTS.USDC, quoteSymbol: 'SOL' })).toBe(false);
    expect(isSolQuoted({ quoteSymbol: 'WSOL' })).toBe(true);
    expect(isSolQuoted(undefined)).toBe(false);
  });

  it('offers SOL only where real SOL prices exist (quote-token OHLCV or trade legs)', () => {
    expect(chartCurrencyOption({ quoteIsSol: false, kind: 'gecko', interval: '1m', geckoIntervals: GECKO }).available).toBe(false);
    expect(chartCurrencyOption({ quoteIsSol: true, kind: 'gecko', interval: '5m', geckoIntervals: GECKO }).available).toBe(true);
    expect(chartCurrencyOption({ quoteIsSol: true, kind: 'server', interval: '1h', geckoIntervals: GECKO }).available).toBe(true);
    expect(chartCurrencyOption({ quoteIsSol: true, kind: 'server', interval: '1s', geckoIntervals: GECKO }).available).toBe(false);
    expect(chartCurrencyOption({ quoteIsSol: true, kind: 'trades', interval: '5s', geckoIntervals: GECKO }).available).toBe(true);
    expect(chartCurrencyOption({ quoteIsSol: true, kind: undefined, interval: '1m', geckoIntervals: GECKO }).available).toBe(false);
  });

  it('prices trades by their own SOL / token legs with SOL volume, dropping trades without both legs', () => {
    const out = solPricedTrades([
      { signature: 's1', timestamp: 1_000, side: 'buy', solAmount: 2, tokenAmount: 1_000_000, priceUsd: 0.0003, usdValue: 300, marketCapUsd: 300_000, source: 'orbyt' },
      { signature: 's2', timestamp: 2_000, side: 'sell', tokenAmount: 5, priceUsd: 1, source: 'orbyt' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.priceUsd).toBeCloseTo(2e-6, 15);
    expect(out[0]?.usdValue).toBe(2);
    expect(out[0]?.marketCapUsd).toBeUndefined();
  });

  it('builds the GeckoTerminal quote-token OHLCV path and converts live USD ticks with the live SOL price', () => {
    expect(geckoQuoteOhlcvPath({ pool: AMM_POOL, mint: MINT, interval: '4h', limit: 300, before: 1_790_000_000.5 })).toBe(
      `/networks/solana/pools/${AMM_POOL}/ohlcv/hour?aggregate=4&limit=300&currency=token&token=${MINT}&before_timestamp=1790000000`,
    );
    expect(geckoQuoteOhlcvPath({ pool: AMM_POOL, mint: MINT, interval: '1s', limit: 300 })).toBeUndefined();
    expect(geckoQuoteOhlcvPath({ pool: 'nope', mint: MINT, interval: '1m', limit: 300 })).toBeUndefined();
    expect(usdToSol(3.6e-6, 120)).toBeCloseTo(3e-8, 20);
    expect(usdToSol(1, undefined)).toBeUndefined();
  });
});

describe('links and params', () => {
  it('builds token hrefs, explorer links and validates the pool param', () => {
    expect(tokenTradeHref(MINT)).toBe(`/trade/${MINT}`);
    expect(tokenTradeHref(MINT, AMM_POOL)).toBe(`/trade/${MINT}?pool=${AMM_POOL}`);
    expect(tokenTradeHref(MINT, 'junk')).toBe(`/trade/${MINT}`);
    expect(parsePoolParam(AMM_POOL)).toBe(AMM_POOL);
    expect(parsePoolParam(['x'])).toBeUndefined();
    const links = explorerLinks(MINT, { pool: AMM_POOL, launchpad: 'pump.fun' });
    expect(links.map((l) => l.id)).toEqual(['solscan', 'geckoterminal', 'dexscreener', 'jupiter', 'pumpfun']);
    expect(links[1]?.href).toContain(`/pools/${AMM_POOL}`);
    expect(explorerLinks(MINT).map((l) => l.id)).not.toContain('pumpfun');
    expect(visibleFailures([{ provider: 'orbyt', ok: false, code: 'not_configured' }, { provider: 'jupiter', ok: false, error: 'jupiter: rate limited' }])).toHaveLength(1);
  });
});

describe('poll cadence and freshness honesty', () => {
  it('polls fast only when ORBYT or Jupiter answered, by chain winner (not the upstream source)', () => {
    expect(pollForWinner('orbyt', 3_000, 30_000)).toBe(3_000);
    expect(pollForWinner('jupiter', 10_000, 30_000)).toBe(10_000);
    expect(pollForWinner('geckoterminal', 10_000, 30_000)).toBe(30_000);
    expect(pollForWinner('dexscreener', 10_000, 30_000)).toBe(30_000);
    // Nothing lists the token yet: never walk the whole chain every few seconds.
    expect(pollForWinner(undefined, 10_000, 30_000)).toBe(30_000);
    // A server-proxy result names its upstream provider as `source`; the winner is the 'orbyt' step.
    const viaServer = { source: 'helius' as const, attempts: [{ provider: 'orbyt' as const, ok: true }] };
    expect(chainWinner(viaServer)).toBe('orbyt');
    expect(chainWinner({ attempts: [{ provider: 'orbyt', ok: false, code: 'not_configured' }, { provider: 'geckoterminal', ok: true }] })).toBe('geckoterminal');
  });

  it('reserves LIVE for stream / realtime data', () => {
    expect(isLiveFreshness('stream')).toBe(true);
    expect(isLiveFreshness('realtime')).toBe(true);
    expect(isLiveFreshness('fast')).toBe(false);
    expect(isLiveFreshness('indexed')).toBe(false);
    expect(isLiveFreshness(undefined)).toBe(false);
  });

  it('treats only an all-"not found" chain failure as a definitive absence', () => {
    expect(isDefinitelyAbsent(new ChainError('mint-info', [{ provider: 'orbyt', ok: false, code: 'not_found' }, { provider: 'solana-rpc', ok: false, code: 'not_found' }]))).toBe(true);
    expect(isDefinitelyAbsent(new ChainError('mint-info', [{ provider: 'orbyt', ok: false, code: 'not_found' }, { provider: 'solana-rpc', ok: false, code: 'timeout' }]))).toBe(false);
    expect(isDefinitelyAbsent(new ChainError('token', [{ provider: 'jupiter', ok: false, code: 'rate_limited' }]))).toBe(false);
    expect(isDefinitelyAbsent(new Error('network'))).toBe(false);
    expect(isDefinitelyAbsent(null)).toBe(false);
  });

  it('only sends aggregator-indexed pools to GeckoTerminal', () => {
    expect(isIndexedPool(ammPool)).toBe(true);
    const onChainOnly = poolFromCurve(curve(), 150);
    expect(onChainOnly.source).toBe('solana-rpc');
    expect(isIndexedPool(onChainOnly)).toBe(false);
    expect(isIndexedPool(undefined)).toBe(false);
  });
});

describe('candle helpers keep real data only', () => {
  it('ignores ticks older than the last bar', () => {
    const candles: Candle[] = [{ time: 60, open: 1, high: 2, low: 1, close: 1.5 }];
    expect(tradeTicks([{ signature: 'x', timestamp: 30_000, side: 'buy', priceUsd: 5, source: 'orbyt' }], 60, 0)).toEqual([]);
    expect(candles[0]?.close).toBe(1.5);
  });
});
