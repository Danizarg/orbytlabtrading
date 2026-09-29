import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  marketCapFromPrice,
  priceFromReserves,
  progressFromRealTokens,
  progressFromVirtualTokens,
  PUMP_INITIAL_REAL_TOKEN_RESERVES,
  PUMP_INITIAL_VIRTUAL_TOKEN_RESERVES,
  PUMP_STANDARD_SUPPLY,
  PUMP_TOKEN_DECIMALS,
  PUMP_TOKEN_OFFSET,
} from './bonding';

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/pump', name), 'utf8')) as T;
}

interface DecodedCurveFixture {
  global_account: {
    decoded: { initial_virtual_token_reserves: string; initial_real_token_reserves: string; token_total_supply: string };
  };
  bonding_curves: Array<{
    mint: string;
    decoded: {
      virtual_token_reserves: string;
      virtual_quote_reserves: string;
      real_token_reserves: string;
      complete: boolean;
      is_mayhem_mode: boolean;
      quote_mint: string;
    };
    derived: { price_sol_per_token: number | null; market_cap_sol: number | null; bonding_progress_pct: number };
  }>;
}

interface CreateEventsFixture {
  events: Array<{
    mint: string;
    initialBuy: number;
    vTokensInBondingCurve: number;
    vSolInBondingCurve: number;
    marketCapSol: number;
    pool: string;
    is_mayhem_mode: boolean;
  }>;
}

const curves = fixture<DecodedCurveFixture>('pump_bonding_curve_decoded_rpc_2026-09-28.json');
const creates = fixture<CreateEventsFixture>('pumpportal_ws_subscribeNewToken_pump_create_events.json');

/** Raw u64 string with 6 decimals → UI units. */
const tokensUi = (raw: string) => Number(raw) / 10 ** PUMP_TOKEN_DECIMALS;
/** Raw lamports string → SOL. */
const solUi = (raw: string) => Number(raw) / 1e9;
/** Fixture `bonding_progress_pct` is truncated to 2 decimals. */
const truncate2 = (n: number) => Math.floor(n * 100) / 100;

describe('pump.fun constants', () => {
  it('match the on-chain Global account', () => {
    const g = curves.global_account.decoded;
    expect(tokensUi(g.initial_real_token_reserves)).toBe(PUMP_INITIAL_REAL_TOKEN_RESERVES);
    expect(tokensUi(g.initial_virtual_token_reserves)).toBe(PUMP_INITIAL_VIRTUAL_TOKEN_RESERVES);
    expect(tokensUi(g.token_total_supply)).toBe(PUMP_STANDARD_SUPPLY);
    expect(PUMP_INITIAL_VIRTUAL_TOKEN_RESERVES - PUMP_INITIAL_REAL_TOKEN_RESERVES).toBe(PUMP_TOKEN_OFFSET);
  });

  it('virtual − real token offset holds on every live curve that is still bonding (SOL, PUMP-paired, mayhem)', () => {
    const live = curves.bonding_curves.filter((c) => !c.decoded.complete);
    expect(live.length).toBeGreaterThanOrEqual(4);
    for (const c of live) {
      expect(tokensUi(c.decoded.virtual_token_reserves) - tokensUi(c.decoded.real_token_reserves)).toBeCloseTo(PUMP_TOKEN_OFFSET, 6);
    }
  });
});

describe('progressFromRealTokens', () => {
  it('reproduces the decoded progress of real mainnet curves', () => {
    for (const c of curves.bonding_curves) {
      const pct = progressFromRealTokens(tokensUi(c.decoded.real_token_reserves));
      expect(pct, c.mint).toBeDefined();
      expect(truncate2(pct ?? NaN), c.mint).toBe(c.derived.bonding_progress_pct);
    }
  });

  it('is 0 at launch and 100 when the curve is exhausted', () => {
    expect(progressFromRealTokens(PUMP_INITIAL_REAL_TOKEN_RESERVES)).toBe(0);
    expect(progressFromRealTokens(0)).toBe(100);
    expect(progressFromRealTokens(PUMP_INITIAL_REAL_TOKEN_RESERVES / 2)).toBe(50);
  });

  it('clamps mayhem curves whose real reserves exceed 793.1M to 0', () => {
    expect(progressFromRealTokens(803_000_000)).toBe(0);
  });

  it('returns undefined for invalid input instead of a number', () => {
    expect(progressFromRealTokens(Number.NaN)).toBeUndefined();
    expect(progressFromRealTokens(Infinity)).toBeUndefined();
    expect(progressFromRealTokens(-1)).toBeUndefined();
  });
});

describe('progressFromVirtualTokens', () => {
  it('agrees with the real-reserve formula on live curves', () => {
    for (const c of curves.bonding_curves.filter((x) => !x.decoded.complete)) {
      const fromVirtual = progressFromVirtualTokens(tokensUi(c.decoded.virtual_token_reserves));
      const fromReal = progressFromRealTokens(tokensUi(c.decoded.real_token_reserves));
      expect(fromVirtual).toBeCloseTo(fromReal ?? NaN, 9);
    }
  });

  it('maps PumpPortal create frames to 0–100 (initialBuy + vTokens = 1.073B)', () => {
    const pump = creates.events.filter((e) => e.pool === 'pump');
    expect(pump.length).toBeGreaterThanOrEqual(3);
    for (const e of pump) {
      expect(e.initialBuy + e.vTokensInBondingCurve, e.mint).toBeCloseTo(PUMP_INITIAL_VIRTUAL_TOKEN_RESERVES, 3);
      const pct = progressFromVirtualTokens(e.vTokensInBondingCurve);
      expect(pct, e.mint).toBeGreaterThanOrEqual(0);
      expect(pct, e.mint).toBeLessThanOrEqual(100);
      // Progress equals the share of the sellable supply bought at creation.
      expect(pct, e.mint).toBeCloseTo((e.initialBuy / PUMP_INITIAL_REAL_TOKEN_RESERVES) * 100, 6);
    }
  });

  it('is 0 at launch, 100 at the completion reserve and clamps below it', () => {
    expect(progressFromVirtualTokens(PUMP_INITIAL_VIRTUAL_TOKEN_RESERVES)).toBe(0);
    expect(progressFromVirtualTokens(PUMP_TOKEN_OFFSET)).toBe(100);
    expect(progressFromVirtualTokens(PUMP_TOKEN_OFFSET - 1)).toBe(100);
    expect(progressFromVirtualTokens(1_100_000_000)).toBe(0);
  });

  it('treats 0 / missing reserves (zeroed migrated account) as unknown', () => {
    expect(progressFromVirtualTokens(0)).toBeUndefined();
    expect(progressFromVirtualTokens(-5)).toBeUndefined();
    expect(progressFromVirtualTokens(Number.NaN)).toBeUndefined();
  });
});

describe('priceFromReserves / marketCapFromPrice', () => {
  it('reproduces decoded SOL price and market cap of live SOL-quoted curves', () => {
    const solCurves = curves.bonding_curves.filter((c) => !c.decoded.complete && c.decoded.quote_mint === '11111111111111111111111111111111');
    expect(solCurves.length).toBeGreaterThanOrEqual(3);
    for (const c of solCurves) {
      const price = priceFromReserves(solUi(c.decoded.virtual_quote_reserves), tokensUi(c.decoded.virtual_token_reserves));
      expect(price, c.mint).toBeCloseTo(c.derived.price_sol_per_token ?? NaN, 15);
      const mc = marketCapFromPrice(price ?? NaN, PUMP_STANDARD_SUPPLY);
      expect(mc, c.mint).toBeCloseTo(c.derived.market_cap_sol ?? NaN, 6);
    }
  });

  it("reproduces PumpPortal's marketCapSol (vSol / vTokens × 1B supply)", () => {
    for (const e of creates.events.filter((x) => x.pool === 'pump')) {
      const mc = marketCapFromPrice(priceFromReserves(e.vSolInBondingCurve, e.vTokensInBondingCurve) ?? NaN, PUMP_STANDARD_SUPPLY);
      expect(mc, e.mint).toBeCloseTo(e.marketCapSol, 6);
    }
  });

  it('gives ~410.88 SOL market cap at completion (vSol 115.005, vTokens 279.9M)', () => {
    const price = priceFromReserves(115.005359056806, PUMP_TOKEN_OFFSET);
    expect(marketCapFromPrice(price ?? NaN, PUMP_STANDARD_SUPPLY)).toBeCloseTo(410.8801681200643, 9);
  });

  it('never reports a price or market cap for a migrated (all-zero) curve', () => {
    for (const c of curves.bonding_curves.filter((x) => x.decoded.complete)) {
      expect(priceFromReserves(solUi(c.decoded.virtual_quote_reserves), tokensUi(c.decoded.virtual_token_reserves))).toBeUndefined();
      expect(c.derived.price_sol_per_token).toBeNull();
    }
  });

  it('is NaN-safe and rejects non-positive inputs', () => {
    expect(priceFromReserves(30, 0)).toBeUndefined();
    expect(priceFromReserves(0, 1_073_000_000)).toBeUndefined();
    expect(priceFromReserves(-1, 1_073_000_000)).toBeUndefined();
    expect(priceFromReserves(Number.NaN, 1)).toBeUndefined();
    expect(priceFromReserves(1, Infinity)).toBeUndefined();
    expect(marketCapFromPrice(0, 1e9)).toBeUndefined();
    expect(marketCapFromPrice(1e-8, 0)).toBeUndefined();
    expect(marketCapFromPrice(Number.NaN, 1e9)).toBeUndefined();
    expect(marketCapFromPrice(1e300, 1e300)).toBeUndefined();
  });

  it('scales with the actual supply (mayhem coins mint 2B)', () => {
    expect(marketCapFromPrice(3e-8, 2_000_000_000)).toBeCloseTo(2 * (marketCapFromPrice(3e-8, PUMP_STANDARD_SUPPLY) ?? NaN), 12);
  });
});
