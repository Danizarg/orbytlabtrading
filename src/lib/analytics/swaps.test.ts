import { readFileSync } from 'node:fs';
import path from 'node:path';
import { address, getAddressEncoder, getBase64Decoder, getBase64Encoder } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { MINTS, PROGRAMS } from '@/lib/core/solana';
import { isProviderError } from '@/lib/net/errors';
import {
  classifyWalletActivity,
  decodePumpTradeEvents,
  deriveTradeForMint,
  detectProgram,
  walletBalanceChanges,
  type PumpTradeEvent,
} from './swaps';
import type { RpcParsedAccountKey, RpcParsedInstruction, RpcParsedTransaction, RpcTokenBalance } from './tx-types';

/**
 * Swap / transfer derivation against the six live getTransaction captures in
 * tests/fixtures/solana-rpc (2026-09-28) plus minimal synthetic transactions.
 * Every expected number below is recomputed by hand from the fixture's raw
 * pre/post balances; the arithmetic is written next to each assertion.
 */

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

interface FixtureFile {
  response: { result?: RpcParsedTransaction; error?: { code: number; message: string } };
  _decodedPumpTradeEvents?: Array<Record<string, string | boolean | number>>;
}

function fixtureFile(name: string): FixtureFile {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/solana-rpc', name), 'utf8')) as FixtureFile;
}

function fixture(name: string): RpcParsedTransaction {
  const tx = fixtureFile(name).response.result;
  if (!tx) throw new Error(`${name} has no result`);
  return tx;
}

function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

/** Deep copy with a mutable meta (for derived variants of a real transaction). */
function clone(tx: RpcParsedTransaction): RpcParsedTransaction & { meta: NonNullable<RpcParsedTransaction['meta']> } {
  const copy = structuredClone(tx);
  return { ...copy, meta: must(copy.meta, 'meta') };
}

/** a ≈ b within a relative tolerance (prices are ratios of already-rounded doubles). */
function expectRel(actual: number | undefined, expected: number, tol = 1e-12) {
  expect(actual).toBeDefined();
  expect(Math.abs((actual as number) - expected) / Math.abs(expected)).toBeLessThan(tol);
}

function expectMalformed(fn: () => unknown) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(isProviderError(caught)).toBe(true);
  expect((caught as { code?: string }).code).toBe('malformed');
}

const PUMP_EVENT_AUTHORITY = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';
const SOL_DEFAULT_QUOTE = '11111111111111111111111111111111';

const F = {
  buyExactSolIn: 'rpc_getTransaction_pumpfun_bondingcurve_buyExactSolIn_legacy.json',
  buyV2: 'rpc_getTransaction_pumpfun_bondingcurve_buyV2_v0.json',
  sellV1: 'rpc_getTransaction_pumpfun_bondingcurve_sell_v1.json',
  pumpSwapBuyDust: 'rpc_getTransaction_pumpswap_buy_legacy_dust.json',
  pumpSwapSell2022: 'rpc_getTransaction_pumpswap_sell_token2022_v0.json',
  relayerUsdc: 'rpc_getTransaction_aggregator_usdc_quote_relayer_feepayer_v0.json',
  errorV1: 'rpc_getTransaction_error_v1_not_supported.json',
} as const;

/** The independent decode the research agent stored next to each pump fixture. */
function annotatedEvent(name: string): Record<string, string | boolean | number> {
  return must(fixtureFile(name)._decodedPumpTradeEvents?.[0], 'annotated event');
}

function expectEventMatchesAnnotation(event: PumpTradeEvent | undefined, name: string) {
  const a = annotatedEvent(name);
  expect(event).toBeDefined();
  const e = event as PumpTradeEvent;
  expect(e.mint).toBe(a.mint);
  expect(e.solAmount).toBe(BigInt(a.sol_amount as string));
  expect(e.tokenAmount).toBe(BigInt(a.token_amount as string));
  expect(e.isBuy).toBe(a.is_buy);
  expect(e.user).toBe(a.user);
  expect(e.timestamp).toBe(Number(a.timestamp));
  expect(e.virtualSolReserves).toBe(BigInt(a.virtual_sol_reserves as string));
  expect(e.virtualTokenReserves).toBe(BigInt(a.virtual_token_reserves as string));
  expect(e.realSolReserves).toBe(BigInt(a.real_sol_reserves as string));
  expect(e.realTokenReserves).toBe(BigInt(a.real_token_reserves as string));
  expect(e.fee).toBe(BigInt(a.fee as string));
  expect(e.creatorFee).toBe(BigInt(a.creator_fee as string));
  expect(e.ixName).toBe(a.ix_name);
  // Trailing IDL fields (after ix_name: mayhem_mode, cashback/buyback fees, shareholders vec, then quote_mint/quote_amount):
  // SOL-quoted curves carry the default pubkey and quote_amount == sol_amount.
  expect(e.quoteMint).toBe(SOL_DEFAULT_QUOTE);
  expect(e.quoteAmount).toBe(e.solAmount);
}

// ---------------------------------------------------------------------------
// Real fixtures
// ---------------------------------------------------------------------------

describe('pump.fun bonding curve — BuyExactSolIn, legacy tx with durable nonce', () => {
  const tx = fixture(F.buyExactSolIn);
  const WALLET = 'B8jTLPWYJMAZAW5vvw7c7fftNreGRrVt6MWjv6z8WLrw'; // accountKeys[0], the only signer
  const MINT = '4axcD14CCqvTXiVgi1Wwo6LeXR6fL3WiLVtMY3hTpump';
  const CURVE = '9nc4V9mhrTpeM3mG4BkMNqztaFHrkXLPj3HRDGraTEWg'; // bonding-curve PDA, owner of the curve's token vault

  it('decodes the TradeEvent exactly as the independent annotation', () => {
    const events = decodePumpTradeEvents(tx);
    expect(events).toHaveLength(1);
    expectEventMatchesAnnotation(events[0], F.buyExactSolIn);
    expect(events[0]?.ixName).toBe('buy_exact_sol_in');
  });

  it('computes wallet balance changes: fee added back, 2,039,280 ATA rent excluded', () => {
    // native: 1,230,841,335 − 1,236,891,615 = −6,050,280
    // + fee 6,000 (wallet is the fee payer)                       → −6,044,280
    // + rent: ATA 9oAtRd… opened in the tx (post-only token balance), funded by
    //   the wallet (createAccountWithSeed source = wallet), 0 → 2,039,280
    //   (the old 165-byte amount: rent is read from deltas, never hardcoded) → −4,005,000
    const changes = walletBalanceChanges(tx, WALLET);
    expect(changes.solDelta).toBe(-0.004005);
    expect(changes.feeSol).toBe(0.000006);
    expect(changes.rentSol).toBe(0.00203928);
    // token: +4,833,319,952,665 raw at 6 dp (curve vault 642,621,037,817,880 → 637,787,717,865,215 moved the same amount)
    expect(changes.tokens).toEqual([{ mint: MINT, delta: 4833319.952665, decimals: 6 }]);
  });

  it('accounts for every lamport the wallet spent: curve + pump fees + tip', () => {
    // 4,005,000 = sol_amount 3,950,617 (curve 9nc4V… native +3,950,617)
    //           + protocol fee 37,531 (GesfTA… +37,531) + creator fee 11,852 (7Kx6AV… +11,852)
    //           + 5,000 top-level transfer to 5VY91ws… (tip)
    const event = must(decodePumpTradeEvents(tx)[0]);
    expect(event.solAmount + must(event.fee) + must(event.creatorFee) + 5_000n).toBe(4_005_000n);
    const meta = must(tx.meta);
    const curveIndex = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey === CURVE);
    expect(BigInt(must(meta.postBalances[curveIndex]) - must(meta.preBalances[curveIndex]))).toBe(event.solAmount);
  });

  it('derives the buy (trader = TradeEvent user, SOL quote incl. pump fees and tip)', () => {
    for (const trade of [deriveTradeForMint(tx, MINT), deriveTradeForMint(tx, MINT, { pool: CURVE })]) {
      expect(trade).toMatchObject({
        signature: '3oqdtu8EHg7i6TqinKgmCLdZvt7k4LEMXV3eWQYbuF4caiJMm43c5yh88JWMqrqWSSbwDQa2c2Nkh94WGES55r9K',
        timestamp: 1790628401000, // blockTime 1,790,628,401 s → ms
        side: 'buy',
        wallet: WALLET,
        tokenAmount: 4833319.952665,
        solAmount: 0.004005,
        venueSolAmount: 0.003950617, // TradeEvent sol_amount: curve SOL only, pump fees excluded
        program: 'pump.fun',
        venue: 'pump.fun',
      });
      expect(trade?.quoteMint).toBeUndefined();
      // 0.004005 / 4,833,319.952665 = 8.2862298…e-10 SOL per token (fixture annotation: 8.286229836267552e-10)
      expectRel(trade?.priceQuote, 0.004005 / 4833319.952665);
      expectRel(trade?.priceQuote, 8.286229836267552e-10, 1e-12);
    }
  });

  it('classifies the wallet activity as a buy', () => {
    const activity = classifyWalletActivity(tx, WALLET, { source: 'solana-rpc', symbols: { [MINT]: 'TKN' } });
    expect(activity).toEqual({
      signature: '3oqdtu8EHg7i6TqinKgmCLdZvt7k4LEMXV3eWQYbuF4caiJMm43c5yh88JWMqrqWSSbwDQa2c2Nkh94WGES55r9K',
      timestamp: 1790628401000,
      wallet: WALLET,
      source: 'solana-rpc',
      kind: 'buy',
      tokenMint: MINT,
      tokenSymbol: 'TKN',
      tokenAmount: 4833319.952665,
      solAmount: 0.004005,
      legs: [
        { mint: MINT, symbol: 'TKN', delta: 4833319.952665 },
        { mint: MINTS.SOL, symbol: 'SOL', delta: -0.004005 },
      ],
      feeSol: 0.000006,
      success: true,
      program: 'pump.fun',
    });
  });

  it('labels the program pump.fun (system nonce / compute budget / token programs are not venues)', () => {
    expect(detectProgram(tx)).toBe('pump.fun');
  });
});

describe('pump.fun bonding curve — BuyV2, v0 tx creating a Token-2022 ATA', () => {
  const tx = fixture(F.buyV2);
  const WALLET = 'DHpRzLRuACd8i1BVGZh8rGQWaQsP7b4spBZFWbzW5WSb';
  const MINT = '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump';
  const CURVE = '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A';

  it('decodes the TradeEvent', () => {
    const events = decodePumpTradeEvents(tx);
    expect(events).toHaveLength(1);
    expectEventMatchesAnnotation(events[0], F.buyV2);
  });

  it('excludes the 1,513,840-lamport Token-2022 ATA rent and adds the fee back', () => {
    // native: 9,759,034,646 − 10,762,549,184 = −1,003,514,538
    // + fee 1,005,000                                                     → −1,002,509,538
    // + rent: ATA 5M7h7… (170-byte Token-2022 account, ATA createIdempotent source = wallet) 1,513,840 → −1,000,995,698
    const changes = walletBalanceChanges(tx, WALLET);
    expect(changes.solDelta).toBe(-1.000995698);
    expect(changes.feeSol).toBe(0.001005);
    expect(changes.rentSol).toBe(0.00151384);
    // token: 0 → 20,682,995,874,269 raw (curve vault 758,449,168,000,260 → 737,766,172,125,991)
    expect(changes.tokens).toEqual([{ mint: MINT, delta: 20682995.874269, decimals: 6 }]);
  });

  it('reconciles the SOL spent with the curve, pump fees and the tip', () => {
    // 1,000,995,698 = sol_amount 987,650,071 (curve native +987,650,071)
    //               + protocol fee 9,382,676 (= 4,691,338 to G5UZ… + 4,691,338 to 5eHh…)
    //               + creator fee 2,962,951 (E7dBnD… +2,962,951)
    //               + 1,000,000 top-level transfer to 3AVi9… (tip)
    const event = must(decodePumpTradeEvents(tx)[0]);
    expect(must(event.fee)).toBe(2n * 4_691_338n);
    expect(event.solAmount + must(event.fee) + must(event.creatorFee) + 1_000_000n).toBe(1_000_995_698n);
  });

  it('derives the buy', () => {
    const trade = deriveTradeForMint(tx, MINT, { pool: CURVE });
    expect(trade).toMatchObject({
      signature: '4udm6NA1et1irGeY4UNyd8hHYEdAr1ZZ6B4NkqeVFPwDp97qx87KjL2FYSSKb4YVmM4jAKh5Uv2yi4TUznXztd5C',
      timestamp: 1790628401000,
      side: 'buy',
      wallet: WALLET,
      tokenAmount: 20682995.874269,
      solAmount: 1.000995698,
      venueSolAmount: 0.987650071,
      program: 'pump.fun',
    });
    // 1.000995698 / 20,682,995.874269 = 4.83970361…e-8 (fixture annotation 4.8397036100814786e-8)
    expectRel(trade?.priceQuote, 4.8397036100814786e-8);
  });

  it('classifies the buy for the wallet and ignores outsiders', () => {
    expect(classifyWalletActivity(tx, WALLET)).toMatchObject({
      kind: 'buy',
      tokenMint: MINT,
      tokenAmount: 20682995.874269,
      solAmount: 1.000995698,
      feeSol: 0.001005,
      success: true,
      program: 'pump.fun',
    });
    // Wallet not involved in the transaction at all.
    expect(classifyWalletActivity(tx, '6nWLPrww43HxwYwCGShgSNK126426aFLFknSFZYX9NxL')).toBeNull();
    expect(walletBalanceChanges(tx, '6nWLPrww43HxwYwCGShgSNK126426aFLFknSFZYX9NxL')).toEqual({
      wallet: '6nWLPrww43HxwYwCGShgSNK126426aFLFknSFZYX9NxL',
      solDelta: 0,
      feeSol: 0,
      tokens: [],
    });
  });

  it('sees fee recipients and the curve as counterparties, never as the trader', () => {
    // The protocol-fee recipient G5UZ… received 4,691,338 lamports natively (its WSOL account did not change).
    expect(classifyWalletActivity(tx, 'G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP')).toMatchObject({ kind: 'sol_in', solAmount: 0.004691338, feeSol: 0 });
    // The curve PDA sent the tokens and received 987,650,071 lamports, but the event user / signer is the trader.
    expect(deriveTradeForMint(tx, MINT)?.wallet).toBe(WALLET);
  });
});

describe('pump.fun bonding curve — Sell through a trading bot, transaction v1', () => {
  const tx = fixture(F.sellV1);
  const WALLET = '6nWLPrww43HxwYwCGShgSNK126426aFLFknSFZYX9NxL';
  const MINT = '4Dg2Cf2PzeeUecZG5YqxHW36XVLEZgmDB6ts3PC1rPL9'; // not 'pump'-suffixed
  const CURVE = 'A8YN2TjFECBFKMv5jaQ4SthPJb5KF4XYBhwMYKFT5Jd6';

  it('is a version 1 message whose priority fee is part of meta.fee', () => {
    expect(tx.version).toBe(1);
    const config = (tx.transaction.message as unknown as { transactionConfig?: { priorityFee?: number } }).transactionConfig;
    // meta.fee 105,000 = 5,000 base (1 signature) + transactionConfig.priorityFee 100,000
    expect(config?.priorityFee).toBe(100_000);
    expect(must(tx.meta).fee).toBe(105_000);
  });

  it('decodes the sell TradeEvent emitted at depth 2 under the FLASHX bot program', () => {
    const events = decodePumpTradeEvents(tx);
    expect(events).toHaveLength(1);
    expectEventMatchesAnnotation(events[0], F.sellV1);
    expect(events[0]?.isBuy).toBe(false);
  });

  it('keeps the bot fee and tip inside the SOL proceeds (wallet view) — no rent involved', () => {
    // native: 3,470,793,271 − 1,504,900,101 = +1,965,893,170; + fee 105,000 → +1,965,998,170
    // = curve sol_amount 2,011,096,454 − protocol fee 19,105,417 (9,552,709 + 9,552,708)
    //   − creator fee 6,033,290 − FLASHX fee 19,859,577 (to EqGz…) − 100,000 tip (to ASTM…)
    const event = must(decodePumpTradeEvents(tx)[0]);
    expect(event.solAmount - must(event.fee) - must(event.creatorFee) - 19_859_577n - 100_000n).toBe(1_965_998_170n);
    const changes = walletBalanceChanges(tx, WALLET);
    expect(changes.solDelta).toBe(1.96599817);
    expect(changes.feeSol).toBe(0.000105);
    // The token account 7dP8… stays open at 0: no rent refund.
    expect(changes.rentSol).toBeUndefined();
    // token: 29,767,649,860,730 → 0 (curve vault +29,767,649,860,730)
    expect(changes.tokens).toEqual([{ mint: MINT, delta: -29767649.86073, decimals: 6 }]);
  });

  it('derives the sell', () => {
    const trade = deriveTradeForMint(tx, MINT, { pool: CURVE });
    expect(trade).toMatchObject({
      side: 'sell',
      wallet: WALLET,
      tokenAmount: 29767649.86073,
      solAmount: 1.96599817,
      venueSolAmount: 2.011096454,
      timestamp: 1790628401000,
      program: 'pump.fun', // FLASHX is an unknown bot program; pump runs inside it
      venue: 'pump.fun',
    });
    // 1.96599817 / 29,767,649.86073 = 6.6044789…e-8 (fixture annotation 6.604478953488293e-8)
    expectRel(trade?.priceQuote, 6.604478953488293e-8);
  });

  it('classifies the sell', () => {
    expect(classifyWalletActivity(tx, WALLET)).toMatchObject({
      kind: 'sell',
      tokenMint: MINT,
      tokenAmount: 29767649.86073,
      solAmount: 1.96599817,
      feeSol: 0.000105,
      legs: [
        { mint: MINT, delta: -29767649.86073 },
        { mint: MINTS.SOL, symbol: 'SOL', delta: 1.96599817 },
      ],
    });
  });
});

describe('PumpSwap — tiny Buy, legacy tx with a WSOL wrap account created and closed in the tx', () => {
  const tx = fixture(F.pumpSwapBuyDust);
  const WALLET = '9AhHu1N7vEcw7WW4gRsGoLSd4EYhzTMJvHc2G8Zgzhh7';
  const MINT = '6z92xw4oCWRxo9ynBEfpu5ksxEHVMuYN5VK6Wj7Lpump';
  const POOL = 'AU5yNsssb7ww2XVLLD74fXvHVN6Ho79ZZhjM9H9ZDCDP'; // owns both pool vaults

  it('nets the temporary WSOL account out of the native delta', () => {
    // native: 86,659,264 − 86,674,266 = −15,002; + fee 5,002 → −10,000
    // The WSOL ATA 9zbgmN… was created (1,488,440 rent, the 2026 amount) + 12,000 wrapped,
    // paid 9,878 to the pool quote vault + 46 + 30 + 46 fees, then closed back to the wallet
    // (1,490,440). It never appears in token balances, so no WSOL leg and no rent adjustment.
    const changes = walletBalanceChanges(tx, WALLET);
    expect(changes.solDelta).toBe(-0.00001);
    expect(changes.feeSol).toBe(0.000005002);
    expect(changes.rentSol).toBeUndefined();
    // token: 34,462,473,669 → 34,486,487,278 = +24,013,609 raw (pool vault −24,013,609)
    expect(changes.tokens).toEqual([{ mint: MINT, delta: 24.013609, decimals: 6 }]);
  });

  it('derives a 0.00001 SOL buy (above the 0.000001 SOL dust floor)', () => {
    const trade = deriveTradeForMint(tx, MINT, { pool: POOL });
    expect(trade).toMatchObject({ side: 'buy', wallet: WALLET, tokenAmount: 24.013609, solAmount: 0.00001, program: 'PumpSwap', venue: 'PumpSwap' });
    // PumpSwap has no pump.fun curve event.
    expect(trade?.venueSolAmount).toBeUndefined();
    // 0.00001 / 24.013609 = 4.1643053…e-7 (fixture annotation 4.1643053320306837e-7)
    expectRel(trade?.priceQuote, 4.1643053320306837e-7);
  });

  it('ignores PumpSwap Program data (it is not a pump.fun curve event)', () => {
    expect(decodePumpTradeEvents(tx)).toEqual([]);
  });

  it('classifies the buy', () => {
    expect(classifyWalletActivity(tx, WALLET)).toMatchObject({ kind: 'buy', solAmount: 0.00001, tokenAmount: 24.013609, feeSol: 0.000005002, program: 'PumpSwap' });
  });
});

describe('PumpSwap — "BuyExactQuoteIn" on an inverted pool is a SELL, Token-2022, v0', () => {
  const tx = fixture(F.pumpSwapSell2022);
  const WALLET = 'DH7hz5x4KpYqwoWtcyK8qm5VSqjvMCrNJoRVdKFDrZSL';
  const MINT = '5RJGBaFrTcTrmu5HuukxHxKeqpmRWf346YxQ1kXGetRs';
  const POOL = 'CnJYShWKkDCHeees6Jgi2nx6rekrsu62VqJkDLxpZeNs';

  it('ignores the misleading instruction name', () => {
    expect(must(tx.meta).logMessages).toContain('Program log: Instruction: BuyExactQuoteIn');
    expect(deriveTradeForMint(tx, MINT, { pool: POOL })?.side).toBe('sell');
  });

  it('computes the proceeds from the native delta (WSOL account created and closed in the tx)', () => {
    // native: 10,866,055,662 − 8,281,195,074 = +2,584,860,588; + fee 5,000 → +2,584,865,588
    // = exactly what the pool WSOL vault paid (386,776,546,046 → 384,191,680,458)
    const changes = walletBalanceChanges(tx, WALLET);
    expect(changes.solDelta).toBe(2.584865588);
    expect(changes.feeSol).toBe(0.000005);
    expect(changes.rentSol).toBeUndefined();
    // token: 3,923,685,793,343 → 3,633,438,209,576 = −290,247,583,767
    //      = 290,102,894,044 to the pool + 72,344,862 + 72,344,861 token-side fees
    expect(changes.tokens).toEqual([{ mint: MINT, delta: -290247.583767, decimals: 6 }]);
  });

  it('derives the sell with the gross token amount the trader gave up', () => {
    const trade = deriveTradeForMint(tx, MINT, { pool: POOL });
    expect(trade).toMatchObject({ side: 'sell', wallet: WALLET, tokenAmount: 290247.583767, solAmount: 2.584865588, program: 'PumpSwap' });
    // 2.584865588 / 290,247.583767 = 8.9057264…e-6 (fixture annotation 0.000008905726464462264)
    expectRel(trade?.priceQuote, 0.000008905726464462264);
    // Without the pool hint the fee recipients (non-signers receiving tokens) still never win over the signer.
    expect(deriveTradeForMint(tx, MINT)?.wallet).toBe(WALLET);
  });

  it('classifies the sell', () => {
    expect(classifyWalletActivity(tx, WALLET)).toMatchObject({ kind: 'sell', tokenAmount: 290247.583767, solAmount: 2.584865588 });
  });
});

describe('DFlow → PumpSwap buy paid in USDC, relayer fee payer, v0 with lookup tables', () => {
  const tx = fixture(F.relayerUsdc);
  const RELAYER = 'AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51'; // accountKeys[0], pays the fee
  const TRADER = 'FEeorcPpWA73dwyeKi7LuRnNpt63gYhxnFYCWaun1Gqr'; // second signer
  const MINT = 'BfK1fZuZjcgtxpdKowafwDzFTywdVzyQb5mRYAdHpump';
  const POOL = '8SqkELHc1hFBEnhqepxDDdbTVb3NPjFyZAUxWnNLecz8';

  it('aligns balances with jsonParsed keys that already include the lookup-table addresses', () => {
    const keys = tx.transaction.message.accountKeys;
    expect(keys.filter((k) => k.source === 'lookupTable').length).toBeGreaterThan(0);
    expect(must(tx.meta).preBalances).toHaveLength(keys.length);
  });

  it('attributes nothing to the trader in SOL: relayer paid the fee and funded/refunded the WSOL account', () => {
    // Trader native 0 → 0 (10,000,000 lent by the relayer and returned; the 1,346,200-lamport
    // PumpSwap volume accumulator created and closed in the tx). Fee paid by the relayer.
    // WSOL ATA DaMv6… funded by the relayer, received 81,150,249 from the USDC→SOL leg, paid
    // 80,348,369 + 20,047 + 761,786 + 20,047 = 81,150,249 to PumpSwap, closed to the relayer.
    const changes = walletBalanceChanges(tx, TRADER);
    expect(changes.solDelta).toBe(0);
    expect(changes.feeSol).toBe(0);
    expect(changes.rentSol).toBeUndefined();
    // BfK1: 266,456,536,858 → 385,918,133,901 = +119,461,597,043 (pool vault −119,461,597,043)
    // USDC: 9,827,851 → 0 = 9,631,297 (swap leg) + 117,933 + 78,621 (fee transfers)
    expect(changes.tokens).toEqual([
      { mint: MINT, delta: 119461.597043, decimals: 6 },
      { mint: MINTS.USDC, delta: -9.827851, decimals: 6 },
    ]);
  });

  it('picks the signer whose balances changed as the trader, quoted in USDC', () => {
    for (const trade of [deriveTradeForMint(tx, MINT), deriveTradeForMint(tx, MINT, { pool: POOL })]) {
      expect(trade).toMatchObject({
        signature: '5X8ivv6QwWtKsqw8gtvFVgHe5V3fpE74cLRKvgCDsuittu2KvqtR2AMsQQ34uXq6E7xy6DG5bx79jn6mgxPmLnmB',
        timestamp: 1790628323000,
        side: 'buy',
        wallet: TRADER,
        tokenAmount: 119461.597043,
        quoteMint: MINTS.USDC,
        quoteAmount: 9.827851,
        program: 'DFlow', // the aggregator wins for the label…
        venue: 'PumpSwap', // …while the executing AMM stays available
      });
      expect(trade?.solAmount).toBeUndefined();
      expect(trade?.venueSolAmount).toBeUndefined();
      // 9.827851 / 119,461.597043 = 8.2267868…e-5 USDC per token
      expectRel(trade?.priceQuote, 9.827851 / 119461.597043);
    }
  });

  it('classifies the trader as a token↔token swap valued by its USDC leg', () => {
    expect(classifyWalletActivity(tx, TRADER)).toEqual({
      signature: '5X8ivv6QwWtKsqw8gtvFVgHe5V3fpE74cLRKvgCDsuittu2KvqtR2AMsQQ34uXq6E7xy6DG5bx79jn6mgxPmLnmB',
      timestamp: 1790628323000,
      wallet: TRADER,
      source: 'solana-rpc',
      kind: 'swap',
      tokenMint: MINT,
      tokenAmount: 119461.597043,
      usdValue: 9.827851,
      legs: [
        { mint: MINT, delta: 119461.597043 },
        { mint: MINTS.USDC, delta: -9.827851 },
      ],
      feeSol: 0,
      success: true,
      program: 'DFlow',
    });
  });

  it('shows the relayer only paying the 410,000-lamport fee', () => {
    // Relayer native −410,000 = −fee; everything it lent or funded came back.
    expect(walletBalanceChanges(tx, RELAYER)).toEqual({ wallet: RELAYER, solDelta: 0, feeSol: 0.00041, tokens: [] });
    expect(classifyWalletActivity(tx, RELAYER)).toMatchObject({ kind: 'other', legs: [], feeSol: 0.00041, success: true });
  });

  it('decodes no pump.fun curve event (PumpSwap only)', () => {
    expect(decodePumpTradeEvents(tx)).toEqual([]);
  });
});

describe('getTransaction error body (v1 requested with maxSupportedTransactionVersion 0)', () => {
  const file = fixtureFile(F.errorV1);

  it('is an error envelope, not a transaction', () => {
    expect(file.response.error?.code).toBe(-32015);
    expect(file.response.result).toBeUndefined();
  });

  it('never crashes the parsers: malformed errors or empty results', () => {
    for (const input of [file.response.result, file.response, null]) {
      const tx = input as unknown as RpcParsedTransaction;
      expectMalformed(() => walletBalanceChanges(tx, 'B8jTLPWYJMAZAW5vvw7c7fftNreGRrVt6MWjv6z8WLrw'));
      expectMalformed(() => classifyWalletActivity(tx, 'B8jTLPWYJMAZAW5vvw7c7fftNreGRrVt6MWjv6z8WLrw'));
      expectMalformed(() => deriveTradeForMint(tx, '4axcD14CCqvTXiVgi1Wwo6LeXR6fL3WiLVtMY3hTpump'));
      expect(detectProgram(tx)).toBeUndefined();
      expect(decodePumpTradeEvents(tx)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Variants of real transactions
// ---------------------------------------------------------------------------

describe('pump.fun TradeEvent sources', () => {
  const buyV2 = fixture(F.buyV2);
  const MINT = '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump';
  const WALLET = 'DHpRzLRuACd8i1BVGZh8rGQWaQsP7b4spBZFWbzW5WSb';
  const logs = must(must(buyV2.meta).logMessages);
  const eventLine = must(logs.find((l) => l.startsWith('Program data: vdt/007mYe')));

  it('reads the same event from the emit_cpi inner instruction and from the logs', () => {
    const logsOnly = clone(buyV2);
    logsOnly.meta.innerInstructions = [];
    const cpiOnly = clone(buyV2);
    cpiOnly.meta.logMessages = null;
    const fromLogs = decodePumpTradeEvents(logsOnly);
    const fromCpi = decodePumpTradeEvents(cpiOnly);
    expect(fromLogs).toHaveLength(1);
    expect(fromCpi).toEqual(fromLogs);
  });

  it('survives truncated logs via the self-CPI event data', () => {
    const truncated = clone(buyV2);
    const cut = logs.indexOf(eventLine);
    truncated.meta.logMessages = [...logs.slice(0, cut), 'Log truncated'];
    const events = decodePumpTradeEvents(truncated);
    expect(events).toHaveLength(1);
    expectEventMatchesAnnotation(events[0], F.buyV2);
    expect(deriveTradeForMint(truncated, MINT)?.venueSolAmount).toBe(0.987650071);
  });

  it('falls back to balances when neither source has the event', () => {
    const bare = clone(buyV2);
    bare.meta.logMessages = [...logs.slice(0, logs.indexOf(eventLine)), 'Log truncated'];
    bare.meta.innerInstructions = [];
    expect(decodePumpTradeEvents(bare)).toEqual([]);
    const trade = deriveTradeForMint(bare, MINT);
    expect(trade).toMatchObject({ side: 'buy', wallet: WALLET, solAmount: 1.000995698, tokenAmount: 20682995.874269 });
    expect(trade?.venueSolAmount).toBeUndefined();
  });

  it('ignores look-alike events emitted by another program or a spoofed self-CPI', () => {
    const lookAlike = clone(buyV2);
    lookAlike.meta.innerInstructions = [];
    lookAlike.meta.logMessages = [
      'Program FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9 invoke [1]',
      eventLine,
      'Program FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9 success',
    ];
    expect(decodePumpTradeEvents(lookAlike)).toEqual([]);

    const spoofed = clone(buyV2);
    spoofed.meta.logMessages = null;
    for (const group of spoofed.meta.innerInstructions ?? []) {
      for (const ix of group.instructions) {
        if (ix.programId === PROGRAMS.PUMP && ix.accounts?.[0] === PUMP_EVENT_AUTHORITY) ix.accounts = [WALLET];
      }
    }
    expect(decodePumpTradeEvents(spoofed)).toEqual([]);
  });

  it('returns no events for a failed transaction (they were rolled back)', () => {
    const failed = clone(buyV2);
    failed.meta.err = { InstructionError: [4, { Custom: 6002 }] };
    expect(decodePumpTradeEvents(failed)).toEqual([]);
  });

  it('tracks the executing program through nested invokes, consumed and return lines', () => {
    const nested = clone(buyV2);
    nested.meta.innerInstructions = [];
    nested.meta.logMessages = [
      'Program ComputeBudget111111111111111111111111111111 invoke [1]',
      'Program ComputeBudget111111111111111111111111111111 success',
      `Program ${PROGRAMS.PUMP} invoke [1]`,
      'Program log: Instruction: BuyV2',
      `Program ${PROGRAMS.TOKEN_2022} invoke [2]`,
      'Program log: Instruction: TransferChecked',
      eventLine, // emitted while the token program executes: not pump's
      `Program ${PROGRAMS.TOKEN_2022} consumed 1234 of 5678 compute units`,
      `Program ${PROGRAMS.TOKEN_2022} success`,
      `Program ${PROGRAMS.PUMP} invoke [2]`,
      'Program return: abc',
      `Program ${PROGRAMS.PUMP} consumed 100 of 200 compute units`,
      `Program ${PROGRAMS.PUMP} success`,
      eventLine, // back at depth 1 inside pump: accepted
      `Program ${PROGRAMS.PUMP} consumed 30000 of 40000 compute units`,
      `Program ${PROGRAMS.PUMP} success`,
    ];
    expect(decodePumpTradeEvents(nested)).toHaveLength(1);
  });

  it('decodes the 97-byte legacy layout (no reserves / fee / name fields)', () => {
    const legacy = Uint8Array.from(getBase64Encoder().encode(eventLine.slice('Program data: '.length))).subarray(0, 97);
    const tx = clone(buyV2);
    tx.meta.innerInstructions = [];
    tx.meta.logMessages = [`Program ${PROGRAMS.PUMP} invoke [1]`, `Program data: ${getBase64Decoder().decode(legacy)}`, `Program ${PROGRAMS.PUMP} success`];
    const [event] = decodePumpTradeEvents(tx);
    expect(event).toMatchObject({ mint: MINT, solAmount: 987_650_071n, tokenAmount: 20_682_995_874_269n, isBuy: true, user: WALLET, timestamp: 1_790_628_401 });
    expect(event?.virtualSolReserves).toBeUndefined();
    expect(event?.fee).toBeUndefined();
    expect(event?.ixName).toBeUndefined();
    expect(event?.quoteMint).toBeUndefined();
    // A 96-byte fragment is not an event.
    tx.meta.logMessages = [`Program ${PROGRAMS.PUMP} invoke [1]`, `Program data: ${getBase64Decoder().decode(legacy.subarray(0, 96))}`, `Program ${PROGRAMS.PUMP} success`];
    expect(decodePumpTradeEvents(tx)).toEqual([]);
  });

  it("keeps the trader's own curve leg in a bundle where several users traded the mint", () => {
    // A second TradeEvent with user = 6nWL… (bytes 57..89 patched) next to the real one: the events no longer
    // agree on one user, but the trader (the signer DHpRz…) still has its own event for venueSolAmount.
    const OTHER = '6nWLPrww43HxwYwCGShgSNK126426aFLFknSFZYX9NxL';
    const bytes = Uint8Array.from(getBase64Encoder().encode(eventLine.slice('Program data: '.length)));
    bytes.set(getAddressEncoder().encode(address(OTHER)), 57);
    const otherLine = `Program data: ${getBase64Decoder().decode(bytes)}`;
    const bundle = clone(buyV2);
    bundle.meta.innerInstructions = [];
    bundle.meta.logMessages = [`Program ${PROGRAMS.PUMP} invoke [1]`, eventLine, otherLine, `Program ${PROGRAMS.PUMP} success`];
    expect(decodePumpTradeEvents(bundle).map((e) => e.user)).toEqual([WALLET, OTHER]);
    const trade = deriveTradeForMint(bundle, MINT, { pool: '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A' });
    expect(trade).toMatchObject({ side: 'buy', wallet: WALLET, solAmount: 1.000995698, venueSolAmount: 0.987650071, quoteSide: 'trader' });
    // Every event of the tx carries the same clock: it dates the trade without a blockTime.
    bundle.blockTime = null;
    expect(deriveTradeForMint(bundle, MINT)?.timestamp).toBe(1790628401000);
  });

  it('does not treat a non-SOL-quoted curve event as SOL', () => {
    // Patch the event's quote_mint to USDC. Offsets per the IDL: ix_name length u32 @258,
    // then name, mayhem_mode 1, four u64 fee fields, shareholders vec length u32 (0 here), quote_mint.
    const bytes = Uint8Array.from(getBase64Encoder().encode(eventLine.slice('Program data: '.length)));
    const view = new DataView(bytes.buffer);
    const quoteAt = 258 + 4 + view.getUint32(258, true) + 1 + 32 + 4;
    expect(view.getUint32(quoteAt - 4, true)).toBe(0);
    expect(bytes.subarray(quoteAt, quoteAt + 32).every((b) => b === 0)).toBe(true);
    bytes.set(getAddressEncoder().encode(address(MINTS.USDC)), quoteAt);
    const usdcQuoted = clone(buyV2);
    usdcQuoted.meta.innerInstructions = [];
    usdcQuoted.meta.logMessages = logs.map((l) => (l === eventLine ? `Program data: ${getBase64Decoder().decode(bytes)}` : l));
    expect(decodePumpTradeEvents(usdcQuoted)[0]?.quoteMint).toBe(MINTS.USDC);
    const trade = deriveTradeForMint(usdcQuoted, MINT);
    expect(trade?.venueSolAmount).toBeUndefined();
    // The balance-derived quote is unaffected.
    expect(trade?.solAmount).toBe(1.000995698);
    // The event still dates the trade (and names its trader) whatever the curve's quote asset.
    usdcQuoted.blockTime = null;
    expect(deriveTradeForMint(usdcQuoted, MINT)).toMatchObject({ timestamp: 1790628401000, wallet: WALLET, side: 'buy' });
  });
});

describe('failed and timestamp-less transactions', () => {
  const buyV2 = fixture(F.buyV2);
  const MINT = '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump';
  const WALLET = 'DHpRzLRuACd8i1BVGZh8rGQWaQsP7b4spBZFWbzW5WSb';

  function failedCopy() {
    // A failed tx only charges the fee: balances roll back except the fee payer's fee.
    const failed = clone(buyV2);
    failed.meta.err = { InstructionError: [4, { Custom: 6002 }] };
    failed.meta.postBalances = failed.meta.preBalances.map((b, i) => (i === 0 ? b - failed.meta.fee : b));
    failed.meta.postTokenBalances = structuredClone(failed.meta.preTokenBalances);
    return failed;
  }

  it('reports a failed transaction only to its signers, with the fee it cost', () => {
    const failed = failedCopy();
    expect(classifyWalletActivity(failed, WALLET)).toEqual({
      signature: '4udm6NA1et1irGeY4UNyd8hHYEdAr1ZZ6B4NkqeVFPwDp97qx87KjL2FYSSKb4YVmM4jAKh5Uv2yi4TUznXztd5C',
      timestamp: 1790628401000,
      wallet: WALLET,
      source: 'solana-rpc',
      kind: 'other',
      legs: [],
      feeSol: 0.001005,
      success: false,
      program: 'pump.fun',
    });
    // The curve PDA is not a signer: nothing to report.
    expect(classifyWalletActivity(failed, '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A')).toBeNull();
    expect(deriveTradeForMint(failed, MINT)).toBeNull();
    // Balance view of a failed tx: the fee is excluded, nothing else moved.
    expect(walletBalanceChanges(failed, WALLET)).toEqual({ wallet: WALLET, solDelta: 0, feeSol: 0.001005, tokens: [] });
  });

  it('skips activity without a block time but dates a pump trade from its TradeEvent', () => {
    const untimed = clone(buyV2);
    untimed.blockTime = null;
    expect(classifyWalletActivity(untimed, WALLET)).toBeNull();
    // TradeEvent timestamp 1,790,628,401 s → ms
    expect(deriveTradeForMint(untimed, MINT)?.timestamp).toBe(1790628401000);
  });

  it('returns null for a timestamp-less trade without a TradeEvent', () => {
    const untimed = clone(fixture(F.pumpSwapBuyDust));
    untimed.blockTime = null;
    expect(deriveTradeForMint(untimed, '6z92xw4oCWRxo9ynBEfpu5ksxEHVMuYN5VK6Wj7Lpump')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Synthetic minimal transactions
// ---------------------------------------------------------------------------

const ALICE = 'B8jTLPWYJMAZAW5vvw7c7fftNreGRrVt6MWjv6z8WLrw';
const BOB = 'DHpRzLRuACd8i1BVGZh8rGQWaQsP7b4spBZFWbzW5WSb';
const CAROL = '6nWLPrww43HxwYwCGShgSNK126426aFLFknSFZYX9NxL';
const RELAYER = 'AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51';
const TIP = 'ASTMmPXD9KX8PVyUsDSSGHgJpbWaomqo5QspV7gXrEN';
/** A real bonding-curve PDA (off-curve), standing in for a pool. */
const POOL = '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A';
const X = '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump';
const Y = '4axcD14CCqvTXiVgi1Wwo6LeXR6fL3WiLVtMY3hTpump';
const ALICE_X = '5M7h7tDWJc99L86wRwWLKZzrHUueNDDCMnSSe5cYb6vb';
const ALICE_Y = '9oAtRd28SwhVrpmmMWVXbrM8LBTZwVmkeN9sQRkQsPAp';
const ALICE_USDC = 'D31nFyw9V2B6mwZa189kmGnexKEtHoWEvzn2eBPkxkgs';
const ALICE_WSOL = '9zbgmN2JSoeBZBJCcNu8r5k5UMJacF94LfWppS7GPv13';
const BOB_X = '3JsCd8LjmmyPT1PhfQZnJeZQwxr5FD6YgzZQDM61Btwc';
const POOL_X = '5R4MoQJCn3NDtMCzTNeJi6mFKB5cfTvyehFQcudPhWCU';
const POOL_Y = 'aSDy5waVxqAP6FpLM7Qd4YJBB136kbEm6mAD4JrkEEt';
const POOL_USDC = 'HQrh2TqZrkadKuMKic8s3NzeV22FTZVZPUFP1eJtwDqS';
const POOL_WSOL = 'DaMv6o4G9mEnuLyi1YibThDshbhbT3hbRQc5P9sTodjP';
/** Jupiter-style temporary WSOL account (createAccountWithSeed, closed in the same tx). */
const TEMP_WSOL = '3JsCd8LjmmyPT1PhfQZnJeZQwxr5FD6YgzZQDM61Btwc';
/** More real PDAs (off-curve): a second pool, a program's token vault and its treasury. */
const POOL2 = 'AU5yNsssb7ww2XVLLD74fXvHVN6Ho79ZZhjM9H9ZDCDP';
const VAULT_PDA = 'A8YN2TjFECBFKMv5jaQ4SthPJb5KF4XYBhwMYKFT5Jd6';
const TREASURY_PDA = 'CnJYShWKkDCHeees6Jgi2nx6rekrsu62VqJkDLxpZeNs';
const VAULT_X = 'BmwisdBiJQaMMeHya6c3uR6zvZzz6PLmFhzxovdxz39d';
const ALICE_X_AUX = 'CauEvHvbB4LFDqLtRjp39qtK8sbJFWBR2W2113yAm8M5';
const SYSTEM = '11111111111111111111111111111111';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const RAYDIUM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RENT = 2_039_280; // a 165-byte account funded at the pre-2026 amount
const RENT_2026 = 1_488_440;
const FEE = 5_000;
const T = 1_790_000_000;

interface AccountSpec {
  pubkey: string;
  pre: number;
  post: number;
  signer?: boolean;
}
interface TokenSpec {
  account: number;
  mint: string;
  /** Omitted = the pre-2022 balance shape without an owner field. */
  owner?: string;
  decimals: number;
  /** Raw amount before; omitted = the token account did not exist (opened in the tx). */
  pre?: string;
  /** Raw amount after; omitted = the token account was closed in the tx. */
  post?: string;
}

function balance(t: TokenSpec, amount: string): RpcTokenBalance {
  const entry: RpcTokenBalance = { accountIndex: t.account, mint: t.mint, programId: PROGRAMS.TOKEN, uiTokenAmount: { amount, decimals: t.decimals, uiAmount: null } };
  if (t.owner !== undefined) entry.owner = t.owner;
  return entry;
}

function buildTx(spec: {
  accounts: AccountSpec[];
  tokens?: TokenSpec[];
  instructions?: RpcParsedInstruction[];
  inner?: Array<{ index: number; instructions: RpcParsedInstruction[] }>;
  logs?: string[];
  fee?: number;
  err?: unknown;
  blockTime?: number | null;
  signature?: string;
}): RpcParsedTransaction {
  const tokens = spec.tokens ?? [];
  return {
    slot: 1,
    blockTime: spec.blockTime === undefined ? T : spec.blockTime,
    version: 0,
    meta: {
      err: spec.err ?? null,
      fee: spec.fee ?? FEE,
      preBalances: spec.accounts.map((a) => a.pre),
      postBalances: spec.accounts.map((a) => a.post),
      preTokenBalances: tokens.filter((t) => t.pre !== undefined).map((t) => balance(t, t.pre as string)),
      postTokenBalances: tokens.filter((t) => t.post !== undefined).map((t) => balance(t, t.post as string)),
      logMessages: spec.logs ?? [],
      innerInstructions: spec.inner ?? [],
    },
    transaction: {
      signatures: [spec.signature ?? 'synthetic-signature'],
      message: {
        accountKeys: spec.accounts.map((a, i) => ({ pubkey: a.pubkey, signer: a.signer ?? i === 0, writable: true, source: 'transaction' })),
        instructions: spec.instructions ?? [],
      },
    },
  };
}

const ix = {
  transfer: (source: string, destination: string, lamports: number): RpcParsedInstruction => ({
    programId: SYSTEM,
    program: 'system',
    parsed: { type: 'transfer', info: { source, destination, lamports } },
  }),
  createAta: (source: string, account: string, wallet: string, mint: string): RpcParsedInstruction => ({
    programId: ATA,
    program: 'spl-associated-token-account',
    parsed: { type: 'create', info: { source, account, wallet, mint } },
  }),
  /** System createAccount (what the ATA program and pump invoke under the hood; parsed with the funded lamports). */
  createAccount: (source: string, newAccount: string, lamports: number, owner: string): RpcParsedInstruction => ({
    programId: SYSTEM,
    program: 'system',
    parsed: { type: 'createAccount', info: { source, newAccount, lamports, owner, space: 0 } },
  }),
  /** Jupiter's temporary WSOL account pattern (not an ATA). */
  createWithSeed: (source: string, newAccount: string, lamports: number): RpcParsedInstruction => ({
    programId: SYSTEM,
    program: 'system',
    parsed: { type: 'createAccountWithSeed', info: { source, newAccount, lamports, base: source, seed: 'jup-wsol', owner: PROGRAMS.TOKEN, space: 165 } },
  }),
  closeAccount: (account: string, destination: string, owner: string): RpcParsedInstruction => ({
    programId: PROGRAMS.TOKEN,
    program: 'spl-token',
    parsed: { type: 'closeAccount', info: { account, destination, owner } },
  }),
  call: (programId: string): RpcParsedInstruction => ({ programId, accounts: [], data: '' }),
};

describe('synthetic: plain SOL transfers', () => {
  // ALICE (fee payer) sends 0.5 SOL to BOB: ALICE 2,000,000,000 → 1,499,995,000 (−0.5 SOL − 5,000 fee).
  const tx = buildTx({
    accounts: [
      { pubkey: ALICE, pre: 2_000_000_000, post: 1_499_995_000 },
      { pubkey: BOB, pre: 1_000, post: 500_001_000, signer: false },
      { pubkey: SYSTEM, pre: 1, post: 1, signer: false },
    ],
    instructions: [ix.transfer(ALICE, BOB, 500_000_000)],
  });

  it('sender: sol_out net of the fee, counterparty = receiver', () => {
    expect(classifyWalletActivity(tx, ALICE)).toEqual({
      signature: 'synthetic-signature',
      timestamp: T * 1000,
      wallet: ALICE,
      source: 'solana-rpc',
      kind: 'sol_out',
      solAmount: 0.5,
      counterparty: BOB,
      legs: [{ mint: MINTS.SOL, symbol: 'SOL', delta: -0.5 }],
      feeSol: 0.000005,
      success: true,
    });
    expect(walletBalanceChanges(tx, ALICE)).toEqual({ wallet: ALICE, solDelta: -0.5, feeSol: 0.000005, tokens: [] });
  });

  it('receiver: sol_in, counterparty = sender (fee added back to match)', () => {
    expect(classifyWalletActivity(tx, BOB)).toMatchObject({ kind: 'sol_in', solAmount: 0.5, counterparty: ALICE, feeSol: 0 });
  });

  it('is not a trade and has no venue', () => {
    expect(deriveTradeForMint(tx, X)).toBeNull();
    expect(detectProgram(tx)).toBeUndefined();
  });

  it('ignores wallets not in the transaction', () => {
    expect(classifyWalletActivity(tx, CAROL)).toBeNull();
  });
});

describe('synthetic: SPL token transfers', () => {
  // ALICE sends 1,000 X (6 dp) from her ATA to BOB's existing ATA.
  function transfer(extra: { alicePays?: number } = {}) {
    const pays = extra.alicePays ?? 0;
    return buildTx({
      accounts: [
        { pubkey: ALICE, pre: 1_000_000_000, post: 1_000_000_000 - FEE - pays },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: BOB_X, pre: RENT, post: RENT, signer: false },
        { pubkey: BOB, pre: 10_000, post: 10_000 + pays, signer: false },
      ],
      tokens: [
        { account: 1, mint: X, owner: ALICE, decimals: 6, pre: '5000000000', post: '4000000000' },
        { account: 2, mint: X, owner: BOB, decimals: 6, pre: '0', post: '1000000000' },
      ],
    });
  }

  it('classifies transfer_out / transfer_in with counterparties', () => {
    const tx = transfer();
    expect(classifyWalletActivity(tx, ALICE)).toEqual({
      signature: 'synthetic-signature',
      timestamp: T * 1000,
      wallet: ALICE,
      source: 'solana-rpc',
      kind: 'transfer_out',
      tokenMint: X,
      tokenAmount: 1000,
      counterparty: BOB,
      legs: [{ mint: X, delta: -1000 }],
      feeSol: 0.000005,
      success: true,
    });
    expect(classifyWalletActivity(tx, BOB)).toMatchObject({ kind: 'transfer_in', tokenMint: X, tokenAmount: 1000, counterparty: ALICE, feeSol: 0, legs: [{ mint: X, delta: 1000 }] });
  });

  it('a transfer is not a trade', () => {
    expect(deriveTradeForMint(transfer(), X)).toBeNull();
  });

  it('SOL moving the other way below 0.000001 SOL never turns a transfer into a trade', () => {
    // ALICE also pays BOB 999 lamports: BOB received X and SOL (same direction) → transfer_in;
    // ALICE sent X and 999 lamports (same direction) → transfer_out.
    const dust = transfer({ alicePays: 999 });
    expect(classifyWalletActivity(dust, BOB)?.kind).toBe('transfer_in');
    expect(classifyWalletActivity(dust, ALICE)?.kind).toBe('transfer_out');
    // Reverse direction: BOB pays ALICE 999 lamports for the tokens → still below the dust floor.
    const back = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 1_000_000_000, post: 1_000_000_000 - FEE + 999 },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: BOB_X, pre: RENT, post: RENT, signer: false },
        { pubkey: BOB, pre: 10_000, post: 10_000 - 999, signer: true },
      ],
      tokens: [
        { account: 1, mint: X, owner: ALICE, decimals: 6, pre: '5000000000', post: '4000000000' },
        { account: 2, mint: X, owner: BOB, decimals: 6, pre: '0', post: '1000000000' },
      ],
    });
    expect(classifyWalletActivity(back, BOB)?.kind).toBe('transfer_in');
    expect(deriveTradeForMint(back, X)).toBeNull();
    // At exactly 1,000 lamports the SOL leg is material: an OTC trade.
    const otc = structuredClone(back);
    const meta = must(otc.meta);
    meta.postBalances = [1_000_000_000 - FEE + 1_000, RENT, RENT, 10_000 - 1_000];
    expect(classifyWalletActivity(otc, BOB)).toMatchObject({ kind: 'buy', solAmount: 0.000001 });
    expect(classifyWalletActivity(otc, ALICE)).toMatchObject({ kind: 'sell', solAmount: 0.000001 });
    // Both signers moved the mint by the same amount; the first one in account order is reported.
    expect(deriveTradeForMint(otc, X)).toMatchObject({ side: 'sell', wallet: ALICE, solAmount: 0.000001, tokenAmount: 1000 });
  });

  it("paying rent for the recipient's new ATA is a real cost of the sender, not rent to exclude", () => {
    // ALICE creates BOB's ATA (funds 2,039,280) and sends him 1,000 X.
    const tx = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 1_000_000_000, post: 1_000_000_000 - FEE - RENT },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: BOB_X, pre: 0, post: RENT, signer: false },
        { pubkey: BOB, pre: 10_000, post: 10_000, signer: false },
      ],
      tokens: [
        { account: 1, mint: X, owner: ALICE, decimals: 6, pre: '5000000000', post: '4000000000' },
        { account: 2, mint: X, owner: BOB, decimals: 6, post: '1000000000' },
      ],
      instructions: [ix.createAta(ALICE, BOB_X, BOB, X)],
    });
    const alice = walletBalanceChanges(tx, ALICE);
    expect(alice.solDelta).toBe(-0.00203928);
    expect(alice.rentSol).toBeUndefined();
    expect(classifyWalletActivity(tx, ALICE)).toMatchObject({
      kind: 'transfer_out',
      counterparty: BOB,
      legs: [
        { mint: X, delta: -1000 },
        { mint: MINTS.SOL, symbol: 'SOL', delta: -0.00203928 },
      ],
    });
    // BOB did not fund his ATA: nothing to exclude, nothing moved in SOL.
    expect(walletBalanceChanges(tx, BOB)).toEqual({ wallet: BOB, solDelta: 0, feeSol: 0, tokens: [{ mint: X, delta: 1000, decimals: 6 }] });
    expect(classifyWalletActivity(tx, BOB)).toMatchObject({ kind: 'transfer_in', legs: [{ mint: X, delta: 1000 }] });
  });
});

describe('synthetic: token↔token swaps and quote selection', () => {
  // ALICE pays 10 USDC to the pool for 500 X; optionally she also tips 0.001 SOL.
  function usdcBuy(tipLamports = 0) {
    return buildTx({
      accounts: [
        { pubkey: ALICE, pre: 1_000_000_000, post: 1_000_000_000 - FEE - tipLamports },
        { pubkey: ALICE_USDC, pre: RENT, post: RENT, signer: false },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: POOL_USDC, pre: RENT, post: RENT, signer: false },
        { pubkey: POOL_X, pre: RENT, post: RENT, signer: false },
        { pubkey: TIP, pre: 5_000_000, post: 5_000_000 + tipLamports, signer: false },
      ],
      tokens: [
        { account: 1, mint: MINTS.USDC, owner: ALICE, decimals: 6, pre: '10000000', post: '0' },
        { account: 2, mint: X, owner: ALICE, decimals: 6, pre: '0', post: '500000000' },
        { account: 3, mint: MINTS.USDC, owner: POOL, decimals: 6, pre: '1000000000', post: '1010000000' },
        { account: 4, mint: X, owner: POOL, decimals: 6, pre: '1000000000000', post: '999500000000' },
      ],
      instructions: [ix.transfer(ALICE, TIP, tipLamports), ix.call(RAYDIUM)],
    });
  }

  it('classifies a stablecoin → token swap valued in USD', () => {
    expect(classifyWalletActivity(usdcBuy(), ALICE)).toMatchObject({
      kind: 'swap',
      tokenMint: X,
      tokenAmount: 500,
      usdValue: 10,
      legs: [
        { mint: MINTS.USDC, delta: -10 },
        { mint: X, delta: 500 },
      ],
      program: 'Raydium',
    });
  });

  it('derives the USDC-quoted trade', () => {
    const trade = deriveTradeForMint(usdcBuy(), X, { pool: POOL });
    expect(trade).toMatchObject({ side: 'buy', wallet: ALICE, tokenAmount: 500, quoteMint: MINTS.USDC, quoteAmount: 10, priceQuote: 0.02 });
    expect(trade?.solAmount).toBeUndefined();
  });

  it('a SOL tip next to a USDC quote does not become the price', () => {
    // Trader legs against X: SOL −0.001 (tip) and USDC −10. The pool moved USDC (+10), not SOL,
    // so the USDC leg is the quote.
    const tx = usdcBuy(1_000_000);
    const trade = deriveTradeForMint(tx, X, { pool: POOL });
    expect(trade).toMatchObject({ side: 'buy', quoteMint: MINTS.USDC, quoteAmount: 10, priceQuote: 0.02 });
    expect(trade?.solAmount).toBeUndefined();
    expect(classifyWalletActivity(tx, ALICE)).toMatchObject({
      kind: 'swap',
      usdValue: 10,
      legs: [
        { mint: MINTS.USDC, delta: -10 },
        { mint: X, delta: 500 },
        { mint: MINTS.SOL, symbol: 'SOL', delta: -0.001 },
      ],
    });
  });

  it('a stray token dust leg next to a SOL quote does not become the price', () => {
    // ALICE sells 1,000 X to a SOL pool for 1 SOL (the pool pays natively) and also receives
    // 0.000001 USDC dust. Legs against X: SOL +1 and USDC +0.000001; the pool moved SOL.
    const tx = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 1_000_000_000, post: 2_000_000_000 - FEE },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: ALICE_USDC, pre: RENT, post: RENT, signer: false },
        { pubkey: POOL, pre: 50_000_000_000, post: 49_000_000_000, signer: false },
        { pubkey: POOL_X, pre: RENT, post: RENT, signer: false },
      ],
      tokens: [
        { account: 1, mint: X, owner: ALICE, decimals: 6, pre: '1000000000', post: '0' },
        { account: 2, mint: MINTS.USDC, owner: ALICE, decimals: 6, pre: '0', post: '1' },
        { account: 4, mint: X, owner: POOL, decimals: 6, pre: '5000000000', post: '6000000000' },
      ],
    });
    expect(deriveTradeForMint(tx, X, { pool: POOL })).toMatchObject({ side: 'sell', solAmount: 1, tokenAmount: 1000, priceQuote: 0.001 });
  });

  it('leaves the quote undefined when two tokens were bought with one SOL payment', () => {
    // ALICE spends 1 SOL and receives both 1,000 X and 2,000 Y: the SOL cannot be split per mint.
    const tx = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 3_000_000_000, post: 2_000_000_000 - FEE },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: ALICE_Y, pre: RENT, post: RENT, signer: false },
        { pubkey: POOL, pre: 50_000_000_000, post: 51_000_000_000, signer: false },
        { pubkey: POOL_X, pre: RENT, post: RENT, signer: false },
        { pubkey: POOL_Y, pre: RENT, post: RENT, signer: false },
      ],
      tokens: [
        { account: 1, mint: X, owner: ALICE, decimals: 6, pre: '0', post: '1000000000' },
        { account: 2, mint: Y, owner: ALICE, decimals: 6, pre: '0', post: '2000000000' },
        { account: 4, mint: X, owner: POOL, decimals: 6, pre: '5000000000', post: '4000000000' },
        { account: 5, mint: Y, owner: POOL, decimals: 6, pre: '5000000000', post: '3000000000' },
      ],
    });
    const trade = deriveTradeForMint(tx, X, { pool: POOL });
    expect(trade).toMatchObject({ side: 'buy', wallet: ALICE, tokenAmount: 1000 });
    expect(trade?.solAmount).toBeUndefined();
    expect(trade?.quoteMint).toBeUndefined();
    expect(trade?.priceQuote).toBeUndefined();
    // Wallet view: two tokens in, SOL out → 'other' (not a single-token buy).
    expect(classifyWalletActivity(tx, ALICE)).toMatchObject({ kind: 'other', legs: [{ mint: X, delta: 1000 }, { mint: Y, delta: 2000 }, { mint: MINTS.SOL, symbol: 'SOL', delta: -1 }] });
  });

  it('prefers a non-signer wallet over a PDA when no signer moved the mint', () => {
    // RELAYER signs and pays; ALICE's tokens move under a delegate. POOL is an off-curve PDA.
    const tx = buildTx({
      accounts: [
        { pubkey: RELAYER, pre: 1_000_000_000, post: 1_000_000_000 - FEE },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: ALICE_USDC, pre: RENT, post: RENT, signer: false },
        { pubkey: POOL_X, pre: RENT, post: RENT, signer: false },
        { pubkey: POOL_USDC, pre: RENT, post: RENT, signer: false },
      ],
      tokens: [
        { account: 1, mint: X, owner: ALICE, decimals: 6, pre: '0', post: '500000000' },
        { account: 2, mint: MINTS.USDC, owner: ALICE, decimals: 6, pre: '10000000', post: '0' },
        { account: 3, mint: X, owner: POOL, decimals: 6, pre: '1000000000', post: '500000000' },
        { account: 4, mint: MINTS.USDC, owner: POOL, decimals: 6, pre: '0', post: '10000000' },
      ],
    });
    expect(deriveTradeForMint(tx, X)).toMatchObject({ wallet: ALICE, side: 'buy', quoteMint: MINTS.USDC, quoteAmount: 10 });
    // The relayer only paid the fee.
    expect(classifyWalletActivity(tx, RELAYER)).toMatchObject({ kind: 'other', legs: [], feeSol: 0.000005 });
  });
});

describe('synthetic: WSOL wrap / unwrap', () => {
  it('a WSOL account created and closed within the tx leaves only the fee', () => {
    const tx = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 3_000_000_000, post: 3_000_000_000 - FEE },
        { pubkey: ALICE_WSOL, pre: 0, post: 0, signer: false },
      ],
      instructions: [ix.createAta(ALICE, ALICE_WSOL, ALICE, MINTS.SOL), ix.transfer(ALICE, ALICE_WSOL, 1_000_000_000), ix.closeAccount(ALICE_WSOL, ALICE, ALICE)],
    });
    expect(walletBalanceChanges(tx, ALICE)).toEqual({ wallet: ALICE, solDelta: 0, feeSol: 0.000005, tokens: [] });
    expect(classifyWalletActivity(tx, ALICE)).toMatchObject({ kind: 'other', legs: [], feeSol: 0.000005 });
  });

  it('wrapping into a new persistent WSOL ATA is not a SOL movement (rent excluded)', () => {
    // native −(2,039,280 rent + 1,000,000,000 wrapped + 5,000 fee); WSOL +1,000,000,000;
    // rent = lamport delta 1,002,039,280 − wrapped 1,000,000,000 = 2,039,280 → net 0.
    const tx = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 3_000_000_000, post: 3_000_000_000 - FEE - RENT - 1_000_000_000 },
        { pubkey: ALICE_WSOL, pre: 0, post: RENT + 1_000_000_000, signer: false },
      ],
      tokens: [{ account: 1, mint: MINTS.SOL, owner: ALICE, decimals: 9, post: '1000000000' }],
      instructions: [ix.createAta(ALICE, ALICE_WSOL, ALICE, MINTS.SOL), ix.transfer(ALICE, ALICE_WSOL, 1_000_000_000)],
    });
    expect(walletBalanceChanges(tx, ALICE)).toEqual({ wallet: ALICE, solDelta: 0, feeSol: 0.000005, tokens: [], rentSol: 0.00203928 });
    expect(classifyWalletActivity(tx, ALICE)?.kind).toBe('other');
  });

  it('unwrapping (closing a WSOL ATA holding 1 SOL) is not a SOL movement (refund excluded)', () => {
    const tx = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 1_000_000_000, post: 1_000_000_000 - FEE + RENT + 1_000_000_000 },
        { pubkey: ALICE_WSOL, pre: RENT + 1_000_000_000, post: 0, signer: false },
      ],
      tokens: [{ account: 1, mint: MINTS.SOL, owner: ALICE, decimals: 9, pre: '1000000000' }],
      instructions: [ix.closeAccount(ALICE_WSOL, ALICE, ALICE)],
    });
    expect(walletBalanceChanges(tx, ALICE)).toEqual({ wallet: ALICE, solDelta: 0, feeSol: 0.000005, tokens: [], rentSol: -0.00203928 });
    expect(classifyWalletActivity(tx, ALICE)?.kind).toBe('other');
  });

  it('counts proceeds landing in a persistent WSOL account as SOL', () => {
    // ALICE sells 1,000 X; the pool pays 0.5 WSOL into her existing WSOL ATA (0.2 → 0.7 WSOL).
    const tx = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 1_000_000_000, post: 1_000_000_000 - FEE },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: ALICE_WSOL, pre: RENT + 200_000_000, post: RENT + 700_000_000, signer: false },
      ],
      tokens: [
        { account: 1, mint: X, owner: ALICE, decimals: 6, pre: '1000000000', post: '0' },
        { account: 2, mint: MINTS.SOL, owner: ALICE, decimals: 9, pre: '200000000', post: '700000000' },
      ],
    });
    expect(walletBalanceChanges(tx, ALICE)).toEqual({ wallet: ALICE, solDelta: 0.5, feeSol: 0.000005, tokens: [{ mint: X, delta: -1000, decimals: 6 }] });
    expect(classifyWalletActivity(tx, ALICE)).toMatchObject({ kind: 'sell', solAmount: 0.5, tokenAmount: 1000 });
    expect(deriveTradeForMint(tx, X)).toMatchObject({ side: 'sell', solAmount: 0.5, priceQuote: 0.0005 });
  });

  it('never derives a trade "of" WSOL itself', () => {
    const tx = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 1_000_000_000, post: 1_000_000_000 - FEE },
        { pubkey: ALICE_WSOL, pre: RENT + 200_000_000, post: RENT + 700_000_000, signer: false },
      ],
      tokens: [{ account: 1, mint: MINTS.SOL, owner: ALICE, decimals: 9, pre: '200000000', post: '700000000' }],
    });
    expect(deriveTradeForMint(tx, MINTS.SOL)).toBeNull();
  });
});

describe('synthetic: ATA rent on open and close', () => {
  // ALICE buys 1,000 X for 0.1 SOL from a pool holding SOL natively, opening her X ATA (2026 rent 1,488,440).
  const open = buildTx({
    accounts: [
      { pubkey: ALICE, pre: 1_000_000_000, post: 1_000_000_000 - FEE - RENT_2026 - 100_000_000 },
      { pubkey: ALICE_X, pre: 0, post: RENT_2026, signer: false },
      { pubkey: POOL, pre: 50_000_000_000, post: 50_100_000_000, signer: false },
      { pubkey: POOL_X, pre: RENT, post: RENT, signer: false },
    ],
    tokens: [
      { account: 1, mint: X, owner: ALICE, decimals: 6, post: '1000000000' },
      { account: 3, mint: X, owner: POOL, decimals: 6, pre: '5000000000', post: '4000000000' },
    ],
    instructions: [ix.createAta(ALICE, ALICE_X, ALICE, X), ix.call(PROGRAMS.PUMP_AMM)],
  });

  it('excludes the rent of an ATA the wallet opened and funded', () => {
    // native −(5,000 + 1,488,440 + 100,000,000); + fee; + rent 1,488,440 → −100,000,000
    expect(walletBalanceChanges(open, ALICE)).toEqual({
      wallet: ALICE,
      solDelta: -0.1,
      feeSol: 0.000005,
      tokens: [{ mint: X, delta: 1000, decimals: 6 }],
      rentSol: 0.00148844,
    });
    expect(classifyWalletActivity(open, ALICE)).toMatchObject({ kind: 'buy', solAmount: 0.1, tokenAmount: 1000, program: 'PumpSwap' });
    const trade = deriveTradeForMint(open, X, { pool: POOL });
    expect(trade).toMatchObject({ side: 'buy', solAmount: 0.1 });
    expectRel(trade?.priceQuote, 0.0001);
  });

  it('excludes the rent refunded when the wallet closes its ATA to itself', () => {
    // ALICE sells all 1,000 X for 0.2 SOL and closes the ATA: native +200,000,000 + 1,488,440 − 5,000.
    const close = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 1_000_000_000, post: 1_000_000_000 - FEE + RENT_2026 + 200_000_000 },
        { pubkey: ALICE_X, pre: RENT_2026, post: 0, signer: false },
        { pubkey: POOL, pre: 50_000_000_000, post: 49_800_000_000, signer: false },
        { pubkey: POOL_X, pre: RENT, post: RENT, signer: false },
      ],
      tokens: [
        { account: 1, mint: X, owner: ALICE, decimals: 6, pre: '1000000000' },
        { account: 3, mint: X, owner: POOL, decimals: 6, pre: '4000000000', post: '5000000000' },
      ],
      instructions: [ix.call(PROGRAMS.PUMP_AMM), ix.closeAccount(ALICE_X, ALICE, ALICE)],
    });
    expect(walletBalanceChanges(close, ALICE)).toEqual({
      wallet: ALICE,
      solDelta: 0.2,
      feeSol: 0.000005,
      tokens: [{ mint: X, delta: -1000, decimals: 6 }],
      rentSol: -0.00148844,
    });
    expect(classifyWalletActivity(close, ALICE)).toMatchObject({ kind: 'sell', solAmount: 0.2, tokenAmount: 1000 });
  });

  it('does not subtract a refund that went to someone else', () => {
    // Same sale, but the ATA is closed to BOB: ALICE keeps exactly the 0.2 SOL, BOB gets the rent.
    const close = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 1_000_000_000, post: 1_000_000_000 - FEE + 200_000_000 },
        { pubkey: ALICE_X, pre: RENT_2026, post: 0, signer: false },
        { pubkey: POOL, pre: 50_000_000_000, post: 49_800_000_000, signer: false },
        { pubkey: POOL_X, pre: RENT, post: RENT, signer: false },
        { pubkey: BOB, pre: 10_000, post: 10_000 + RENT_2026, signer: false },
      ],
      tokens: [
        { account: 1, mint: X, owner: ALICE, decimals: 6, pre: '1000000000' },
        { account: 3, mint: X, owner: POOL, decimals: 6, pre: '4000000000', post: '5000000000' },
      ],
      instructions: [ix.call(PROGRAMS.PUMP_AMM), ix.closeAccount(ALICE_X, BOB, ALICE)],
    });
    const alice = walletBalanceChanges(close, ALICE);
    expect(alice.solDelta).toBe(0.2);
    expect(alice.rentSol).toBeUndefined();
    expect(classifyWalletActivity(close, BOB)).toMatchObject({ kind: 'sol_in', solAmount: 0.00148844 });
  });

  it('does not exclude rent another signer paid for the wallet', () => {
    // RELAYER pays the fee and funds ALICE's new ATA; ALICE (co-signer) pays 0.1 SOL for 1,000 X.
    const tx = buildTx({
      accounts: [
        { pubkey: RELAYER, pre: 1_000_000_000, post: 1_000_000_000 - FEE - RENT_2026 },
        { pubkey: ALICE, pre: 1_000_000_000, post: 900_000_000, signer: true },
        { pubkey: ALICE_X, pre: 0, post: RENT_2026, signer: false },
        { pubkey: POOL, pre: 50_000_000_000, post: 50_100_000_000, signer: false },
        { pubkey: POOL_X, pre: RENT, post: RENT, signer: false },
      ],
      tokens: [
        { account: 2, mint: X, owner: ALICE, decimals: 6, post: '1000000000' },
        { account: 4, mint: X, owner: POOL, decimals: 6, pre: '5000000000', post: '4000000000' },
      ],
      instructions: [ix.createAta(RELAYER, ALICE_X, ALICE, X)],
    });
    expect(walletBalanceChanges(tx, ALICE)).toEqual({ wallet: ALICE, solDelta: -0.1, feeSol: 0, tokens: [{ mint: X, delta: 1000, decimals: 6 }] });
    // The relayer's rent went into an account it does not own: a real outflow.
    expect(walletBalanceChanges(tx, RELAYER).solDelta).toBe(-0.00148844);
    expect(deriveTradeForMint(tx, X, { pool: POOL })).toMatchObject({ wallet: ALICE, side: 'buy', solAmount: 0.1 });
  });
});

describe('synthetic: Jupiter-style routes', () => {
  it('SOL → X with a createAccountWithSeed WSOL account, a new X ATA and a platform fee in X', () => {
    // ALICE: native −(5,000 fee + 1,488,440 X-ATA rent + 1,000,000,000 wrapped). The temp WSOL account
    // (rent + 1 SOL) is created and closed inside the tx, so it never shows in token balances; the pool's
    // WSOL vault +1 SOL, ALICE +990 X, BOB (platform fee account) +10 X.
    const tx = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 5_000_000_000, post: 5_000_000_000 - FEE - RENT_2026 - 1_000_000_000 },
        { pubkey: TEMP_WSOL, pre: 0, post: 0, signer: false },
        { pubkey: ALICE_X, pre: 0, post: RENT_2026, signer: false },
        { pubkey: POOL_WSOL, pre: RENT + 10_000_000_000, post: RENT + 11_000_000_000, signer: false },
        { pubkey: POOL_X, pre: RENT, post: RENT, signer: false },
        { pubkey: BOB_X, pre: RENT, post: RENT, signer: false },
      ],
      tokens: [
        { account: 2, mint: X, owner: ALICE, decimals: 6, post: '990000000' },
        { account: 3, mint: MINTS.SOL, owner: POOL, decimals: 9, pre: '10000000000', post: '11000000000' },
        { account: 4, mint: X, owner: POOL, decimals: 6, pre: '5000000000', post: '4000000000' },
        { account: 5, mint: X, owner: BOB, decimals: 6, pre: '0', post: '10000000' },
      ],
      instructions: [ix.createWithSeed(ALICE, TEMP_WSOL, RENT_2026 + 1_000_000_000), ix.createAta(ALICE, ALICE_X, ALICE, X), ix.call(JUPITER), ix.closeAccount(TEMP_WSOL, ALICE, ALICE)],
    });
    expect(walletBalanceChanges(tx, ALICE)).toEqual({ wallet: ALICE, solDelta: -1, feeSol: 0.000005, tokens: [{ mint: X, delta: 990, decimals: 6 }], rentSol: 0.00148844 });
    for (const trade of [deriveTradeForMint(tx, X, { pool: POOL }), deriveTradeForMint(tx, X)]) {
      expect(trade).toMatchObject({ side: 'buy', wallet: ALICE, tokenAmount: 990, solAmount: 1, quoteSide: 'trader', program: 'Jupiter' });
      // 1 / 990 SOL per token
      expectRel(trade?.priceQuote, 1 / 990);
    }
    expect(classifyWalletActivity(tx, ALICE)).toMatchObject({ kind: 'buy', solAmount: 1, tokenAmount: 990, program: 'Jupiter' });
  });

  it('X → SOL paid into a pre-existing WSOL ATA that is then closed to unwrap', () => {
    // ALICE: native +(1,488,440 refund + 500,000,000 unwrapped) − fee; the WSOL ATA held 0 before and is gone after.
    const tx = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 1_000_000_000, post: 1_000_000_000 - FEE + RENT_2026 + 500_000_000 },
        { pubkey: ALICE_WSOL, pre: RENT_2026, post: 0, signer: false },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: POOL_WSOL, pre: RENT + 10_000_000_000, post: RENT + 9_500_000_000, signer: false },
        { pubkey: POOL_X, pre: RENT, post: RENT, signer: false },
      ],
      tokens: [
        { account: 1, mint: MINTS.SOL, owner: ALICE, decimals: 9, pre: '0' },
        { account: 2, mint: X, owner: ALICE, decimals: 6, pre: '1000000000', post: '0' },
        { account: 3, mint: MINTS.SOL, owner: POOL, decimals: 9, pre: '10000000000', post: '9500000000' },
        { account: 4, mint: X, owner: POOL, decimals: 6, pre: '5000000000', post: '6000000000' },
      ],
      instructions: [ix.call(JUPITER), ix.closeAccount(ALICE_WSOL, ALICE, ALICE)],
    });
    expect(walletBalanceChanges(tx, ALICE)).toEqual({ wallet: ALICE, solDelta: 0.5, feeSol: 0.000005, tokens: [{ mint: X, delta: -1000, decimals: 6 }], rentSol: -0.00148844 });
    expect(deriveTradeForMint(tx, X, { pool: POOL })).toMatchObject({ side: 'sell', solAmount: 0.5, tokenAmount: 1000, priceQuote: 0.0005, quoteSide: 'trader' });
    expect(classifyWalletActivity(tx, ALICE)).toMatchObject({ kind: 'sell', solAmount: 0.5 });
  });

  it('sums several token accounts of the same mint owned by the wallet', () => {
    const tx = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 1_000_000_000, post: 900_000_000 - FEE },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: ALICE_X_AUX, pre: RENT, post: RENT, signer: false },
        { pubkey: POOL, pre: 1_000_000_000, post: 1_100_000_000, signer: false },
      ],
      tokens: [
        { account: 1, mint: X, owner: ALICE, decimals: 6, pre: '0', post: '600000' },
        { account: 2, mint: X, owner: ALICE, decimals: 6, pre: '100000', post: '500000' },
      ],
    });
    // 600,000 + 400,000 = 1,000,000 raw = 1 X for 0.1 SOL
    expect(walletBalanceChanges(tx, ALICE).tokens).toEqual([{ mint: X, delta: 1, decimals: 6 }]);
    expect(deriveTradeForMint(tx, X)).toMatchObject({ side: 'buy', tokenAmount: 1, solAmount: 0.1, priceQuote: 0.1 });
  });
});

describe('synthetic: quote from the pool side when the trader shows no quote leg', () => {
  /** BOT (signer) pays `lamports` natively to the pool; ALICE's ATA receives 1,000 X from the pool vault. */
  function botPaidBuy(lamports = 1_000_000_000, extraToken = false) {
    return buildTx({
      accounts: [
        { pubkey: CAROL, pre: 5_000_000_000, post: 5_000_000_000 - FEE - lamports },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: ALICE_Y, pre: RENT, post: RENT, signer: false },
        { pubkey: POOL, pre: 1_000_000_000, post: 1_000_000_000 + lamports, signer: false },
        { pubkey: POOL_X, pre: RENT, post: RENT, signer: false },
        { pubkey: POOL_Y, pre: RENT, post: RENT, signer: false },
      ],
      tokens: [
        { account: 1, mint: X, owner: ALICE, decimals: 6, pre: '0', post: '1000000000' },
        { account: 4, mint: X, owner: POOL, decimals: 6, pre: '5000000000', post: '4000000000' },
        ...(extraToken
          ? [
              { account: 2, mint: Y, owner: ALICE, decimals: 6, pre: '0', post: '2000000000' },
              { account: 5, mint: Y, owner: POOL, decimals: 6, pre: '5000000000', post: '3000000000' },
            ]
          : []),
      ],
      instructions: [ix.call(PROGRAMS.PUMP_AMM)],
    });
  }

  it('prices a bot-paid buy from what the pool received', () => {
    const tx = botPaidBuy();
    for (const trade of [deriveTradeForMint(tx, X, { pool: POOL }), deriveTradeForMint(tx, X)]) {
      // The pool received 1 SOL for 1,000 X: 0.001 SOL per token, attributed to the pool side.
      expect(trade).toMatchObject({ side: 'buy', wallet: ALICE, tokenAmount: 1000, solAmount: 1, priceQuote: 0.001, quoteSide: 'pool', program: 'PumpSwap' });
    }
    // Wallet views stay honest: ALICE paid nothing (a transfer in), the bot sent the SOL.
    expect(classifyWalletActivity(tx, ALICE)).toMatchObject({ kind: 'transfer_in', tokenAmount: 1000, counterparty: POOL, feeSol: 0 });
    expect(classifyWalletActivity(tx, CAROL)).toMatchObject({ kind: 'sol_out', solAmount: 1, counterparty: POOL });
  });

  it('prices a sniper program whose token vault and treasury are different PDAs', () => {
    // BOT signs; TREASURY_PDA pays 0.5 SOL to POOL2; VAULT_PDA's token account receives 500 X.
    const tx = buildTx({
      accounts: [
        { pubkey: CAROL, pre: 1_000_000_000, post: 1_000_000_000 - FEE },
        { pubkey: TREASURY_PDA, pre: 3_000_000_000, post: 2_500_000_000, signer: false },
        { pubkey: VAULT_X, pre: RENT, post: RENT, signer: false },
        { pubkey: POOL2, pre: 1_000_000_000, post: 1_500_000_000, signer: false },
        { pubkey: POOL_X, pre: RENT, post: RENT, signer: false },
      ],
      tokens: [
        { account: 2, mint: X, owner: VAULT_PDA, decimals: 6, pre: '0', post: '500000000' },
        { account: 4, mint: X, owner: POOL2, decimals: 6, pre: '5000000000', post: '4500000000' },
      ],
    });
    expect(deriveTradeForMint(tx, X, { pool: POOL2 })).toMatchObject({ side: 'buy', wallet: VAULT_PDA, tokenAmount: 500, solAmount: 0.5, priceQuote: 0.001, quoteSide: 'pool' });
  });

  it('prices a sell whose proceeds the pool paid to a third party', () => {
    // ALICE's 1,000 X go to the pool; the pool pays 0.5 SOL natively to BOB.
    const tx = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 1_000_000_000, post: 1_000_000_000 - FEE },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: POOL, pre: 5_000_000_000, post: 4_500_000_000, signer: false },
        { pubkey: POOL_X, pre: RENT, post: RENT, signer: false },
        { pubkey: BOB, pre: 10_000, post: 500_010_000, signer: false },
      ],
      tokens: [
        { account: 1, mint: X, owner: ALICE, decimals: 6, pre: '1000000000', post: '0' },
        { account: 3, mint: X, owner: POOL, decimals: 6, pre: '4000000000', post: '5000000000' },
      ],
    });
    expect(deriveTradeForMint(tx, X, { pool: POOL })).toMatchObject({ side: 'sell', wallet: ALICE, tokenAmount: 1000, solAmount: 0.5, priceQuote: 0.0005, quoteSide: 'pool' });
    expect(classifyWalletActivity(tx, ALICE)).toMatchObject({ kind: 'transfer_out', counterparty: POOL });
  });

  it('prices a token-quoted trade the pool received', () => {
    // BOT pays 10 USDC into the pool's USDC vault; ALICE receives 500 X.
    const tx = buildTx({
      accounts: [
        { pubkey: CAROL, pre: 1_000_000_000, post: 1_000_000_000 - FEE },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: ALICE_USDC, pre: RENT, post: RENT, signer: false },
        { pubkey: POOL_X, pre: RENT, post: RENT, signer: false },
        { pubkey: POOL_USDC, pre: RENT, post: RENT, signer: false },
      ],
      tokens: [
        { account: 1, mint: X, owner: ALICE, decimals: 6, pre: '0', post: '500000000' },
        { account: 2, mint: MINTS.USDC, owner: CAROL, decimals: 6, pre: '10000000', post: '0' },
        { account: 3, mint: X, owner: POOL, decimals: 6, pre: '1000000000', post: '500000000' },
        { account: 4, mint: MINTS.USDC, owner: POOL, decimals: 6, pre: '0', post: '10000000' },
      ],
    });
    expect(deriveTradeForMint(tx, X, { pool: POOL })).toMatchObject({ side: 'buy', wallet: ALICE, quoteMint: MINTS.USDC, quoteAmount: 10, priceQuote: 0.02, quoteSide: 'pool' });
  });

  it('never invents a price: two tokens for one payment, a wrong-way pool, dust, or an on-curve counterparty', () => {
    // ALICE received X and Y for the bot's single SOL payment: unattributable.
    expect(deriveTradeForMint(botPaidBuy(1_000_000_000, true), X, { pool: POOL })).toBeNull();
    // The pool paid 999 lamports: below the dust floor.
    expect(deriveTradeForMint(botPaidBuy(999), X, { pool: POOL })).toBeNull();
    // The pool sent X to ALICE and ALSO paid SOL out (a reward / distribution, not a trade).
    const wrongWay = buildTx({
      accounts: [
        { pubkey: CAROL, pre: 1_000_000_000, post: 1_000_000_000 - FEE },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: POOL, pre: 5_000_000_000, post: 4_000_000_000, signer: false },
        { pubkey: POOL_X, pre: RENT, post: RENT, signer: false },
        { pubkey: BOB, pre: 10_000, post: 1_000_010_000, signer: false },
      ],
      tokens: [
        { account: 1, mint: X, owner: ALICE, decimals: 6, pre: '0', post: '1000000000' },
        { account: 3, mint: X, owner: POOL, decimals: 6, pre: '5000000000', post: '4000000000' },
      ],
    });
    expect(deriveTradeForMint(wrongWay, X, { pool: POOL })).toBeNull();
    // BOB (an on-curve wallet) sent X to ALICE while receiving SOL from the bot: without a pool hint that is a transfer.
    const wallets = buildTx({
      accounts: [
        { pubkey: CAROL, pre: 5_000_000_000, post: 4_000_000_000 - FEE },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: BOB_X, pre: RENT, post: RENT, signer: false },
        { pubkey: BOB, pre: 10_000, post: 1_000_010_000, signer: false },
      ],
      tokens: [
        { account: 1, mint: X, owner: ALICE, decimals: 6, pre: '0', post: '1000000000' },
        { account: 2, mint: X, owner: BOB, decimals: 6, pre: '1000000000', post: '0' },
      ],
    });
    expect(deriveTradeForMint(wallets, X)).toBeNull();
    expect(classifyWalletActivity(wallets, ALICE)).toMatchObject({ kind: 'transfer_in', counterparty: BOB });
  });

  it('labels the quote side on the real fixtures and prefers the curve event over the pool side', () => {
    expect(deriveTradeForMint(fixture(F.buyExactSolIn), '4axcD14CCqvTXiVgi1Wwo6LeXR6fL3WiLVtMY3hTpump')?.quoteSide).toBe('trader');
    expect(deriveTradeForMint(fixture(F.relayerUsdc), 'BfK1fZuZjcgtxpdKowafwDzFTywdVzyQb5mRYAdHpump')?.quoteSide).toBe('trader');
    // Hide the trader's SOL leg of the BuyV2 fixture (as if a router had paid): the TradeEvent prices it.
    const routerPaid = clone(fixture(F.buyV2));
    routerPaid.meta.postBalances = routerPaid.meta.preBalances.map((b, i) => (i === 0 ? b - routerPaid.meta.fee : (routerPaid.meta.postBalances[i] as number)));
    const trade = deriveTradeForMint(routerPaid, '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump', { pool: '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A' });
    expect(trade).toMatchObject({ side: 'buy', venueSolAmount: 0.987650071, quoteSide: 'event' });
    expect(trade?.solAmount).toBeUndefined();
    // 0.987650071 / 20,682,995.874269 = 4.7751…e-8 SOL per token (curve price, pump fees excluded)
    expectRel(trade?.priceQuote, 0.987650071 / 20682995.874269);
    // The curve price comes from the event's own token_amount: if the trader's net delta also carries an
    // unrelated move (here 1,000,000 X forwarded away in the same tx), the row shows the net amount but the
    // price stays the curve's (0.987650071 / 20,682,995.874269, not / 19,682,995.874269).
    const forwarded = clone(routerPaid);
    const traderPost = must(forwarded.meta.postTokenBalances?.find((b) => b.owner === 'DHpRzLRuACd8i1BVGZh8rGQWaQsP7b4spBZFWbzW5WSb' && b.mint === '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump'));
    traderPost.uiTokenAmount.amount = String(BigInt(traderPost.uiTokenAmount.amount) - 1_000_000_000_000n);
    const net = deriveTradeForMint(forwarded, '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump', { pool: '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A' });
    expect(net).toMatchObject({ side: 'buy', tokenAmount: 19682995.874269, venueSolAmount: 0.987650071, quoteSide: 'event' });
    expectRel(net?.priceQuote, 0.987650071 / 20682995.874269);
    // Without the event, the curve's own +987,650,071 lamports price it from the pool side.
    const noEvent = clone(routerPaid);
    noEvent.meta.innerInstructions = [];
    noEvent.meta.logMessages = [];
    expect(deriveTradeForMint(noEvent, '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump', { pool: '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A' })).toMatchObject({
      side: 'buy',
      solAmount: 0.987650071,
      quoteSide: 'pool',
    });
  });
});

describe('synthetic: rent locked into accounts created in the tx (pump.fun create + dev buy)', () => {
  // ALICE creates coin X and buys 3,500,000 X from its brand-new curve in one tx. Everything she funds:
  const MINT_RENT = 2_500_000; // mint account (system createAccount, source ALICE)
  const METADATA_TOPUP = 1_200_000; // Token-2022 metadata realloc top-up (system transfer ALICE → mint)
  const CURVE_RENT = 1_600_000; // bonding curve PDA (createAccount), which then receives the buy
  const VAULT_RENT = 1_513_840; // the curve's Token-2022 ATA (owned by the curve)
  const OWN_ATA_RENT = 1_513_840; // ALICE's own ATA (excluded by the token-account rule)
  const CURVE_SOL = 100_000_000; // the buy paid into the curve
  const PUMP_FEE = 1_250_000; // protocol + creator fee
  const BOUGHT = 3_500_000_000_000n; // 3,500,000 X at 6 dp

  /** The curve vault is new too: it was minted the whole supply in this tx, so its net delta is +996,500,000 X. */
  function createAndBuy() {
    const spent = MINT_RENT + METADATA_TOPUP + CURVE_RENT + VAULT_RENT + OWN_ATA_RENT + CURVE_SOL + PUMP_FEE;
    return buildTx({
      accounts: [
        { pubkey: ALICE, pre: 10_000_000_000, post: 10_000_000_000 - FEE - spent },
        { pubkey: X, pre: 0, post: MINT_RENT + METADATA_TOPUP, signer: true }, // the new mint keypair co-signs
        { pubkey: POOL, pre: 0, post: CURVE_RENT + CURVE_SOL, signer: false },
        { pubkey: POOL_X, pre: 0, post: VAULT_RENT, signer: false },
        { pubkey: ALICE_X, pre: 0, post: OWN_ATA_RENT, signer: false },
        { pubkey: CAROL, pre: 1_000_000_000, post: 1_000_000_000 + PUMP_FEE, signer: false },
      ],
      tokens: [
        { account: 3, mint: X, owner: POOL, decimals: 6, post: String(1_000_000_000_000_000n - BOUGHT) },
        { account: 4, mint: X, owner: ALICE, decimals: 6, post: String(BOUGHT) },
      ],
      instructions: [ix.call(PROGRAMS.PUMP)],
      inner: [
        {
          index: 0,
          instructions: [
            ix.createAccount(ALICE, X, MINT_RENT, PROGRAMS.TOKEN_2022),
            ix.transfer(ALICE, X, METADATA_TOPUP),
            ix.createAccount(ALICE, POOL, CURVE_RENT, PROGRAMS.PUMP),
            ix.createAta(ALICE, POOL_X, POOL, X),
            ix.createAccount(ALICE, POOL_X, VAULT_RENT, PROGRAMS.TOKEN_2022),
            ix.createAta(ALICE, ALICE_X, ALICE, X),
            ix.createAccount(ALICE, ALICE_X, OWN_ATA_RENT, PROGRAMS.TOKEN_2022),
            ix.transfer(ALICE, POOL, CURVE_SOL),
            ix.transfer(ALICE, CAROL, PUMP_FEE),
          ],
        },
      ],
    });
  }

  it('prices the dev buy without the rent of the mint, curve and curve vault', () => {
    // Trader SOL leg: native −(5,000 + 2,500,000 + 1,200,000 + 1,600,000 + 1,513,840 + 1,513,840 + 100,000,000 + 1,250,000)
    //   = −109,582,680; + fee 5,000 + own ATA rent 1,513,840                   = −108,063,840 (wallet view)
    //   + created-account rent: mint 2,500,000 + 1,200,000 top-up (a mint holds only rent: creation + the
    //     payer's transfers into it, capped at its 3,700,000 balance), curve min(1,600,000 created,
    //     101,600,000 held) = 1,600,000 (creation lamports only, never the buy), curve vault 1,513,840 = 6,813,840
    //                                                                           = −101,250,000 (trade view)
    //   = curve SOL 100,000,000 + pump fee 1,250,000: what a buyer of an existing coin would also pay.
    const trade = deriveTradeForMint(createAndBuy(), X, { pool: POOL });
    expect(trade).toMatchObject({ side: 'buy', wallet: ALICE, tokenAmount: 3_500_000, solAmount: 0.10125, quoteSide: 'trader', program: 'pump.fun' });
    // 0.10125 / 3,500,000 = 2.8928571…e-8 SOL per token (3.0875…e-8 if the 0.00681384 SOL of rent were counted)
    expectRel(trade?.priceQuote, 0.10125 / 3_500_000);
  });

  it('never takes the freshly minted curve for the trader without a pool hint', () => {
    // Both owners gained X (the curve's vault was minted 1e15 raw and gave 3.5e12 away): the signer is the trader.
    expect(deriveTradeForMint(createAndBuy(), X)).toMatchObject({ side: 'buy', wallet: ALICE, tokenAmount: 3_500_000, solAmount: 0.10125 });
  });

  it('never mistakes the buy paid into the new curve for rent, even when balances carry no owners', () => {
    // Pre-2022 balance shape for the curve vault: the curve is not known as a token owner. Its 100,000,000
    // lamports of buy still count (only its 1,600,000 creation lamports are rent), so the quote is unchanged.
    const tx = createAndBuy();
    const vault = must(must(tx.meta).postTokenBalances?.find((b) => b.accountIndex === 3));
    delete vault.owner;
    expect(deriveTradeForMint(tx, X, { pool: POOL })).toMatchObject({ side: 'buy', wallet: ALICE, solAmount: 0.10125 });
  });

  it('keeps the creation rent in the wallet view (a real, non-refundable cost for PnL)', () => {
    // spent = 2,500,000 + 1,200,000 + 1,600,000 + 1,513,840 + 1,513,840 + 100,000,000 + 1,250,000 = 109,577,680
    // native −(5,000 + 109,577,680) + fee 5,000 + own ATA rent 1,513,840 = −108,063,840
    const tx = createAndBuy();
    expect(walletBalanceChanges(tx, ALICE)).toEqual({
      wallet: ALICE,
      solDelta: -0.10806384,
      feeSol: 0.000005,
      tokens: [{ mint: X, delta: 3_500_000, decimals: 6 }],
      rentSol: 0.00151384,
    });
    expect(classifyWalletActivity(tx, ALICE)).toMatchObject({ kind: 'buy', solAmount: 0.10806384, tokenAmount: 3_500_000 });
  });

  it('only adds back rent the trader itself funded', () => {
    // Same buy, but RELAYER funded the curve vault: ALICE's native delta no longer contains it, so nothing
    // may be added back for it (adding it would under-state her cost). Temporary accounts closed in the tx
    // hold nothing at the end and add nothing (the relayer fixture and the Jupiter route cover that).
    const tx = createAndBuy();
    const inner = must(must(tx.meta).innerInstructions)[0];
    const vaultCreate = must(inner?.instructions.find((i) => (i.parsed as { info?: { newAccount?: string } }).info?.newAccount === POOL_X));
    (vaultCreate.parsed as { info: { source: string } }).info.source = RELAYER;
    // ALICE's native delta no longer includes the vault rent; RELAYER is not in the keys (balances unchanged).
    const meta = must(tx.meta);
    meta.postBalances[0] = (meta.postBalances[0] as number) + VAULT_RENT;
    expect(deriveTradeForMint(tx, X, { pool: POOL })?.solAmount).toBe(0.10125);
  });
});

describe('synthetic: pool hints that are not the vault owner', () => {
  /** CAROL (bot) pays POOL 1 SOL natively; ALICE's ATA receives 1,000 X from POOL's vault; TREASURY_PDA holds an idle USDC account. */
  const tx = buildTx({
    accounts: [
      { pubkey: CAROL, pre: 5_000_000_000, post: 4_000_000_000 - FEE },
      { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
      { pubkey: POOL, pre: 1_000_000_000, post: 2_000_000_000, signer: false },
      { pubkey: POOL_X, pre: RENT, post: RENT, signer: false },
      { pubkey: POOL_USDC, pre: RENT, post: RENT, signer: false },
    ],
    tokens: [
      { account: 1, mint: X, owner: ALICE, decimals: 6, pre: '0', post: '1000000000' },
      { account: 3, mint: X, owner: POOL, decimals: 6, pre: '5000000000', post: '4000000000' },
      { account: 4, mint: MINTS.USDC, owner: TREASURY_PDA, decimals: 6, pre: '7000000', post: '7000000' },
    ],
    instructions: [ix.call(RAYDIUM)],
  });

  it('falls back to the unique off-curve counterpart when the hint owns nothing in the tx (AMM id ≠ vault authority)', () => {
    // A Raydium AMM v4 pool id is not the owner of its vaults (the AMM authority PDA is).
    expect(deriveTradeForMint(tx, X, { pool: VAULT_PDA })).toMatchObject({ side: 'buy', wallet: ALICE, solAmount: 1, priceQuote: 0.001, quoteSide: 'pool', program: 'Raydium' });
    expect(deriveTradeForMint(tx, X, { pool: POOL })).toMatchObject({ solAmount: 1, quoteSide: 'pool' });
  });

  it('still refuses a hint that holds token accounts in the tx but did not trade against the receiver', () => {
    expect(deriveTradeForMint(tx, X, { pool: TREASURY_PDA })).toBeNull();
  });
});

describe('synthetic: encodings, big numbers and program labels', () => {
  it('tolerates the pre-2022 token balance shape without owners', () => {
    const tx = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 1_000_000_000, post: 1_000_000_000 - FEE },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
      ],
      tokens: [{ account: 1, mint: X, decimals: 6, pre: '0', post: '1000000' }],
    });
    expect(walletBalanceChanges(tx, ALICE).tokens).toEqual([]);
    expect(deriveTradeForMint(tx, X)).toBeNull();
    expect(classifyWalletActivity(tx, ALICE)).toMatchObject({ kind: 'other', legs: [] });
  });

  it('reads a wallet that only appears through its token account (not an account key)', () => {
    // BOB pays the fee and sends 1 X to ALICE's ATA; ALICE's own pubkey is not in accountKeys.
    const tx = buildTx({
      accounts: [
        { pubkey: BOB, pre: 1_000_000_000, post: 1_000_000_000 - FEE },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: BOB_X, pre: RENT, post: RENT, signer: false },
      ],
      tokens: [
        { account: 1, mint: X, owner: ALICE, decimals: 6, pre: '0', post: '1000000' },
        { account: 2, mint: X, owner: BOB, decimals: 6, pre: '1000000', post: '0' },
      ],
    });
    expect(walletBalanceChanges(tx, ALICE)).toEqual({ wallet: ALICE, solDelta: 0, feeSol: 0, tokens: [{ mint: X, delta: 1, decimals: 6 }] });
    expect(classifyWalletActivity(tx, ALICE)).toMatchObject({ kind: 'transfer_in', counterparty: BOB, feeSol: 0 });
  });

  it('accepts lamports and fees as digit strings and raw amounts as safe integers', () => {
    const tx = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 1_000_000_000, post: 900_000_000 - FEE },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: POOL, pre: 1, post: 100_000_001, signer: false },
      ],
      tokens: [{ account: 1, mint: X, owner: ALICE, decimals: 6, pre: '0', post: '1000000' }],
    });
    const meta = must(tx.meta) as unknown as { fee: unknown; preBalances: unknown[]; postTokenBalances: Array<{ uiTokenAmount: { amount: unknown } }> };
    meta.fee = '5000';
    meta.preBalances = meta.preBalances.map(String);
    must(meta.postTokenBalances[0]).uiTokenAmount.amount = 1_000_000;
    expect(deriveTradeForMint(tx, X)).toMatchObject({ side: 'buy', solAmount: 0.1, tokenAmount: 1, priceQuote: 0.1 });
  });

  it('turns lamports into SOL exactly for representative amounts', () => {
    // lamports / 1e9 is IEEE-correctly rounded, so it is the reference. The last five used to come out one
    // ulp off when the integer and fraction parts were added as doubles (1,412,654,698 → 1.4126546979999999).
    for (const lamports of [
      1_965_998_170, 2_584_865_588, 10_000, 1_000_995_698, 4_005_000, 123_456_789, 1_488_440,
      1_412_654_698, 6_845_517_863, 17_780_248_534, 22_156_753_814, 56_138_698_969,
    ]) {
      const tx = buildTx({
        accounts: [
          { pubkey: ALICE, pre: 100_000_000_000, post: 100_000_000_000 - FEE - lamports },
          { pubkey: POOL, pre: 1, post: 1 + lamports, signer: false },
        ],
      });
      expect(walletBalanceChanges(tx, ALICE).solDelta).toBe(-lamports / 1e9);
    }
  });

  it('keeps raw token math exact beyond 2^53', () => {
    // 9,007,199,254,740,993 → 9,007,199,254,741,000 is +7; float math would say +8.
    const tx = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 1_000_000_000, post: 1_000_000_000 - FEE },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: ALICE_Y, pre: RENT, post: RENT, signer: false },
      ],
      tokens: [
        { account: 1, mint: X, owner: ALICE, decimals: 0, pre: '9007199254740993', post: '9007199254741000' },
        // u64::MAX raw at 9 decimals: 18,446,744,073.709551615 (delta itself > 2^53)
        { account: 2, mint: Y, owner: ALICE, decimals: 9, pre: '0', post: '18446744073709551615' },
      ],
    });
    const { tokens } = walletBalanceChanges(tx, ALICE);
    expect(tokens[0]).toEqual({ mint: X, delta: 7, decimals: 0 });
    // The nearest double to 18,446,744,073.709551615 (what parsing the exact decimal string gives).
    expect(tokens[1]?.delta).toBe(18446744073.709551615);
  });

  it('converts raw token amounts with correct rounding, both signs', () => {
    // 8,281,592,152,188 raw at 9 dp = 8,281.592152188 exactly (double-sum gave 8281.592152188001);
    // −6,845,517,863 raw at 9 dp = −6.845517863 (double-sum gave −6.8455178629999995).
    const tx = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 1_000_000_000, post: 1_000_000_000 - FEE },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: ALICE_Y, pre: RENT, post: RENT, signer: false },
      ],
      tokens: [
        { account: 1, mint: X, owner: ALICE, decimals: 9, pre: '1', post: '8281592152189' },
        { account: 2, mint: Y, owner: ALICE, decimals: 9, pre: '6845517863', post: '0' },
      ],
    });
    expect(walletBalanceChanges(tx, ALICE).tokens).toEqual([
      { mint: X, delta: 8281.592152188, decimals: 9 },
      { mint: Y, delta: -6.845517863, decimals: 9 },
    ]);
  });

  it('rejects lamport values that are not non-negative integers instead of coercing them', () => {
    const base = () => buildTx({ accounts: [{ pubkey: ALICE, pre: 1_000_000_000, post: 1_000_000_000 - FEE }] });
    const withFee = (fee: unknown) => {
      const tx = base();
      (must(tx.meta) as unknown as { fee: unknown }).fee = fee;
      return tx;
    };
    const withPre = (value: unknown) => {
      const tx = base();
      (must(tx.meta) as unknown as { preBalances: unknown[] }).preBalances = [value];
      return tx;
    };
    for (const tx of [withFee(true), withFee('5e3'), withFee(-5_000), withFee(5_000.5), withPre('1e9'), withPre(null), withPre('-1')]) {
      expectMalformed(() => walletBalanceChanges(tx, ALICE));
    }
    // Exact digit strings and integral numbers are fine.
    expect(walletBalanceChanges(withFee('5000'), ALICE)).toEqual({ wallet: ALICE, solDelta: 0, feeSol: 0.000005, tokens: [] });
  });

  it('rejects balances that are not aligned with the account keys', () => {
    const tx = buildTx({ accounts: [{ pubkey: ALICE, pre: 1, post: 1 }] });
    must(tx.meta).postBalances = [1, 2];
    expectMalformed(() => walletBalanceChanges(tx, ALICE));
  });

  it('handles non-parsed messages: string keys, header signers, loaded addresses, programIdIndex', () => {
    // Static keys [RELAYER, ALICE, RAYDIUM, JUPITER] (2 required signatures) + lookup-table keys
    // [BOB] writable, [TIP] readonly (program ids are always static keys).
    const tx = buildTx({
      accounts: [
        { pubkey: RELAYER, pre: 1_000_000_000, post: 1_000_000_000 - FEE },
        { pubkey: ALICE, pre: 1_000_000_000, post: 750_000_000 },
        { pubkey: RAYDIUM, pre: 1, post: 1 },
        { pubkey: JUPITER, pre: 1, post: 1 },
        { pubkey: BOB, pre: 0, post: 250_000_000 },
        { pubkey: TIP, pre: 1, post: 1 },
      ],
    });
    const message = tx.transaction.message as unknown as Record<string, unknown>;
    message.accountKeys = [RELAYER, ALICE, RAYDIUM, JUPITER] as unknown as RpcParsedAccountKey[];
    message.header = { numRequiredSignatures: 2, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 2 };
    message.instructions = [{ programIdIndex: 2, accounts: [], data: '' }, { programIdIndex: 3, accounts: [], data: '' }];
    must(tx.meta).loadedAddresses = { writable: [BOB], readonly: [TIP] };

    expect(classifyWalletActivity(tx, ALICE)).toMatchObject({ kind: 'sol_out', solAmount: 0.25, counterparty: BOB, feeSol: 0 });
    expect(classifyWalletActivity(tx, BOB)).toMatchObject({ kind: 'sol_in', solAmount: 0.25, counterparty: ALICE });
    // Jupiter (aggregator) wins over the Raydium AMM invoked first.
    expect(detectProgram(tx)).toBe('Jupiter');

    // The second header signer is recognised in a failed transaction.
    const failed = structuredClone(tx);
    const meta = must(failed.meta);
    meta.err = { InstructionError: [0, 'InvalidAccountData'] };
    meta.postBalances = [1_000_000_000 - FEE, 1_000_000_000, 1, 1, 0, 1];
    expect(classifyWalletActivity(failed, ALICE)).toMatchObject({ kind: 'other', success: false, feeSol: 0 });
    expect(classifyWalletActivity(failed, BOB)).toBeNull();
  });

  it('labels venues and prefers aggregators', () => {
    const base = { accounts: [{ pubkey: ALICE, pre: 1, post: 1 }] };
    expect(detectProgram(buildTx({ ...base, instructions: [ix.call(RAYDIUM)] }))).toBe('Raydium');
    expect(detectProgram(buildTx({ ...base, instructions: [ix.call('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc')] }))).toBe('Orca');
    expect(detectProgram(buildTx({ ...base, instructions: [ix.call('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo')] }))).toBe('Meteora DLMM');
    // Aggregator found only in an inner instruction still wins.
    const routed = buildTx({ ...base, instructions: [ix.call(RAYDIUM), ix.call(SYSTEM)], inner: [{ index: 1, instructions: [ix.call(JUPITER)] }] });
    expect(detectProgram(routed)).toBe('Jupiter');
    expect(detectProgram(buildTx({ ...base, instructions: [ix.call(SYSTEM)] }))).toBeUndefined();
  });

  it('carries caller-provided symbols on legs', () => {
    const tx = buildTx({
      accounts: [
        { pubkey: ALICE, pre: 1_000_000_000, post: 900_000_000 - FEE },
        { pubkey: ALICE_X, pre: RENT, post: RENT, signer: false },
        { pubkey: POOL, pre: 1_000_000_000, post: 1_100_000_000, signer: false },
      ],
      tokens: [{ account: 1, mint: X, owner: ALICE, decimals: 6, pre: '0', post: '1000000' }],
    });
    expect(classifyWalletActivity(tx, ALICE, { source: 'helius', symbols: { [X]: 'XX', [MINTS.SOL]: 'wSOL' } })).toMatchObject({
      kind: 'buy',
      source: 'helius',
      tokenSymbol: 'XX',
      legs: [
        { mint: X, symbol: 'XX', delta: 1 },
        { mint: MINTS.SOL, symbol: 'wSOL', delta: -0.1 },
      ],
    });
  });
});
