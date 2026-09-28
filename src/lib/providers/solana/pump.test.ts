import { describe, expect, it } from 'vitest';
import { address, getAddressEncoder } from '@solana/kit';
import { MINTS, PROGRAMS } from '@/lib/core/solana';
import { ProviderError } from '@/lib/net/errors';
import {
  createPumpCurveProvider,
  curveProgressPct,
  decodeBondingCurve,
  decodeBondingCurveAccount,
  derivePumpCurveAddress,
  PUMP_BONDING_CURVE_DISCRIMINATOR,
  PUMP_TOKEN_MINT,
} from './pump';
import { createRpcClient, type RpcAccountInfo } from './rpc';
import { fakeRpc, loadFixture, type RpcRequest } from './test-helpers';

interface DecodedFixture {
  virtual_token_reserves: string;
  virtual_quote_reserves: string;
  real_token_reserves: string;
  real_quote_reserves: string;
  token_total_supply: string;
  complete: boolean;
  creator: string;
  is_mayhem_mode: boolean;
  is_cashback_coin: boolean;
  quote_mint: string;
  creator_fee_bps: string;
  can_edit_creator_fee: boolean;
  is_holder_reward: boolean;
  _account_data_len: number;
}

interface CurveFixtureEntry {
  mint: string;
  bonding_curve_pda: string;
  account_owner: string;
  decoded: DecodedFixture;
  derived: { price_sol_per_token: number | null; market_cap_sol: number | null; bonding_progress_pct: number };
}

const recorded = loadFixture<{ primary_raw_getAccountInfo_value: RpcAccountInfo; bonding_curves: CurveFixtureEntry[] }>(
  'pump/pump_bonding_curve_decoded_rpc_2026-09-28.json',
);
const migratedRaw = loadFixture<{ result: { value: RpcAccountInfo } }>('pump/rpc-getAccountInfo-pump-bonding-curve.json');
const migratedDecoded = loadFixture<{
  mint: string;
  pda: string;
  virtualTokenReserves: string;
  virtualSolReserves: string;
  realTokenReserves: string;
  realSolReserves: string;
  tokenTotalSupply: string;
  complete: boolean;
  creator: string;
  byteLength: number;
}>('pump/decoded-pump-bonding-curve.json');
const multiParsed = loadFixture<{ response: { result: { value: RpcAccountInfo[] } } }>(
  'solana-rpc/rpc_getMultipleAccounts_jsonParsed_mint_tokenacct_curve.json',
);
const multiBase64 = loadFixture<{ response: { result: { value: RpcAccountInfo[] } } }>(
  'solana-rpc/publicnode_getMultipleAccounts_base64_mint_bondingcurve.json',
);

const entry = (mint: string): CurveFixtureEntry => {
  const found = recorded.bonding_curves.find((c) => c.mint === mint);
  if (!found) throw new Error(`fixture missing ${mint}`);
  return found;
};

const b64 = (account: RpcAccountInfo): string => (Array.isArray(account.data) ? account.data[0] : '');

/** Re-encode recorded decoded values into account bytes (for curves whose raw bytes were not captured). */
function encodeCurve(d: DecodedFixture, length = d._account_data_len): Uint8Array {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  const enc = getAddressEncoder();
  bytes.set(PUMP_BONDING_CURVE_DISCRIMINATOR, 0);
  view.setBigUint64(8, BigInt(d.virtual_token_reserves), true);
  view.setBigUint64(16, BigInt(d.virtual_quote_reserves), true);
  view.setBigUint64(24, BigInt(d.real_token_reserves), true);
  view.setBigUint64(32, BigInt(d.real_quote_reserves), true);
  view.setBigUint64(40, BigInt(d.token_total_supply), true);
  bytes[48] = d.complete ? 1 : 0;
  if (length >= 81) bytes.set(enc.encode(address(d.creator)), 49);
  if (length >= 82) bytes[81] = d.is_mayhem_mode ? 1 : 0;
  if (length >= 83) bytes[82] = d.is_cashback_coin ? 1 : 0;
  if (length >= 115) bytes.set(enc.encode(address(d.quote_mint)), 83);
  if (length >= 123) view.setBigUint64(115, BigInt(d.creator_fee_bps), true);
  if (length >= 124) bytes[123] = d.can_edit_creator_fee ? 1 : 0;
  if (length >= 125) bytes[124] = d.is_holder_reward ? 1 : 0;
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe('derivePumpCurveAddress', () => {
  it('derives the verified PDA for 2qEHj…tpump', async () => {
    expect(await derivePumpCurveAddress('2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump')).toBe('2JUXSuq1A1EdBzZj757cXFYuALPxv6vee4X981ajpzo8');
    expect(migratedDecoded.pda).toBe('2JUXSuq1A1EdBzZj757cXFYuALPxv6vee4X981ajpzo8');
  });

  it('matches every PDA recorded from mainnet', async () => {
    for (const c of recorded.bonding_curves) {
      expect(await derivePumpCurveAddress(c.mint)).toBe(c.bonding_curve_pda);
    }
    expect(await derivePumpCurveAddress('7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump')).toBe('9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A');
  });

  it('rejects invalid mints', async () => {
    await expect(derivePumpCurveAddress('not-a-mint')).rejects.toThrow(TypeError);
  });
});

describe('decodeBondingCurveAccount', () => {
  it('reproduces the recorded decode of a live 151-byte curve', () => {
    const d = entry('dB98iqo6YQ2p1X1KtvmLRDFmtQauEiA2CtxL8cvpump').decoded;
    const raw = decodeBondingCurveAccount(Uint8Array.from(atob(b64(recorded.primary_raw_getAccountInfo_value)), (c) => c.charCodeAt(0)));
    expect(raw.byteLength).toBe(151);
    expect(raw.virtualTokenReserves.toString()).toBe(d.virtual_token_reserves);
    expect(raw.virtualQuoteReserves.toString()).toBe(d.virtual_quote_reserves);
    expect(raw.realTokenReserves.toString()).toBe(d.real_token_reserves);
    expect(raw.realQuoteReserves.toString()).toBe(d.real_quote_reserves);
    expect(raw.tokenTotalSupply.toString()).toBe(d.token_total_supply);
    expect(raw.complete).toBe(d.complete);
    expect(raw.creator).toBe(d.creator);
    expect(raw.isMayhemMode).toBe(d.is_mayhem_mode);
    expect(raw.isCashbackCoin).toBe(d.is_cashback_coin);
    expect(raw.quoteMint).toBe(d.quote_mint);
    expect(raw.creatorFeeBps?.toString()).toBe(d.creator_fee_bps);
    expect(raw.canEditCreatorFee).toBe(d.can_edit_creator_fee);
    expect(raw.isHolderReward).toBe(d.is_holder_reward);
  });

  it('reproduces the recorded decode of the migrated 150-byte curve', () => {
    const bytes = Uint8Array.from(atob(b64(migratedRaw.result.value)), (c) => c.charCodeAt(0));
    const raw = decodeBondingCurveAccount(bytes);
    expect(raw.byteLength).toBe(migratedDecoded.byteLength);
    expect(raw.virtualTokenReserves.toString()).toBe(migratedDecoded.virtualTokenReserves);
    expect(raw.virtualQuoteReserves.toString()).toBe(migratedDecoded.virtualSolReserves);
    expect(raw.realTokenReserves.toString()).toBe(migratedDecoded.realTokenReserves);
    expect(raw.realQuoteReserves.toString()).toBe(migratedDecoded.realSolReserves);
    expect(raw.tokenTotalSupply.toString()).toBe(migratedDecoded.tokenTotalSupply);
    expect(raw.complete).toBe(true);
    expect(raw.creator).toBe(migratedDecoded.creator);
  });

  it('round-trips every recorded curve (SOL, PUMP-quoted, mayhem, completed)', () => {
    for (const c of recorded.bonding_curves) {
      const raw = decodeBondingCurveAccount(encodeCurve(c.decoded));
      expect(raw.virtualQuoteReserves.toString()).toBe(c.decoded.virtual_quote_reserves);
      expect(raw.quoteMint).toBe(c.decoded.quote_mint);
      expect(raw.isMayhemMode).toBe(c.decoded.is_mayhem_mode);
      expect(raw.creatorFeeBps?.toString()).toBe(c.decoded.creator_fee_bps);
      expect(curveProgressPct(raw)).toBeCloseTo(c.derived.bonding_progress_pct, 1);
    }
  });

  it('tolerates older, shorter layouts', () => {
    const d = entry('dB98iqo6YQ2p1X1KtvmLRDFmtQauEiA2CtxL8cvpump').decoded;
    const old81 = decodeBondingCurveAccount(encodeCurve(d, 81));
    expect(old81.creator).toBe(d.creator);
    expect(old81.isMayhemMode).toBeUndefined();
    expect(old81.quoteMint).toBeUndefined();
    const old49 = decodeBondingCurveAccount(encodeCurve(d, 49));
    expect(old49.creator).toBeUndefined();
    expect(old49.virtualTokenReserves.toString()).toBe(d.virtual_token_reserves);
  });

  it('rejects non-curve data as malformed', () => {
    const mintBytes = Uint8Array.from(atob(b64(multiBase64.response.result.value[0] as RpcAccountInfo)), (c) => c.charCodeAt(0));
    expect(() => decodeBondingCurveAccount(mintBytes)).toThrow(ProviderError);
    expect(() => decodeBondingCurveAccount(new Uint8Array(20))).toThrow(/too short/);
    expect(() => decodeBondingCurve('!!not base64!!', 'm', 'c')).toThrow(ProviderError);
  });
});

describe('decodeBondingCurve', () => {
  it('derives price, market cap and progress for a live SOL curve', () => {
    const c = entry('dB98iqo6YQ2p1X1KtvmLRDFmtQauEiA2CtxL8cvpump');
    const state = decodeBondingCurve(b64(recorded.primary_raw_getAccountInfo_value), c.mint, c.bonding_curve_pda, 1_000_000_000, { fetchedAt: 1 });
    expect(state.mint).toBe(c.mint);
    expect(state.curve).toBe(c.bonding_curve_pda);
    expect(state.quoteMint).toBe(MINTS.SOL);
    expect(state.quoteDecimals).toBe(9);
    expect(state.complete).toBe(false);
    expect(state.virtualTokenReserves).toBe(1068488241.635014);
    expect(state.virtualQuoteReserves).toBe(30.126676911);
    expect(state.realQuoteReserves).toBe(0.126676911);
    expect(state.priceQuote).toBeCloseTo(c.derived.price_sol_per_token ?? NaN, 18);
    expect(state.marketCapQuote).toBeCloseTo(c.derived.market_cap_sol ?? NaN, 6);
    expect(state.progressPct).toBeCloseTo(0.5689, 4);
    expect(Math.floor(state.progressPct * 100) / 100).toBe(c.derived.bonding_progress_pct);
    expect(state.isMayhemMode).toBe(false);
    expect(state.creator).toBe(c.decoded.creator);
    expect(state.fetchedAt).toBe(1);
  });

  it('omits market cap without the mint supply', () => {
    const state = decodeBondingCurve(b64(recorded.primary_raw_getAccountInfo_value), 'm', 'c');
    expect(state.priceQuote).toBeGreaterThan(0);
    expect(state.marketCapQuote).toBeUndefined();
  });

  it('reports a migrated curve as 100% with no price and no default creator', () => {
    const state = decodeBondingCurve(b64(migratedRaw.result.value), migratedDecoded.mint, migratedDecoded.pda, 1_000_000_000);
    expect(state.complete).toBe(true);
    expect(state.progressPct).toBe(100);
    expect(state.priceQuote).toBeUndefined();
    expect(state.marketCapQuote).toBeUndefined();
    expect(state.creator).toBeUndefined();
    expect(state.realTokenReserves).toBe(0);
  });

  it('uses the mint supply (2B) for mayhem market cap', () => {
    const c = entry('GJNVxxuSGZ4FQYVBrYYEQe4DFDithm9LopFno2XKpump');
    const state = decodeBondingCurve(encodeCurve(c.decoded), c.mint, c.bonding_curve_pda, 2_000_000_000);
    expect(state.isMayhemMode).toBe(true);
    expect(state.priceQuote).toBeCloseTo(c.derived.price_sol_per_token ?? NaN, 18);
    // Recorded market cap assumed 1B tokens; the mayhem mint really has 2B.
    expect(state.marketCapQuote).toBeCloseTo((c.derived.market_cap_sol ?? NaN) * 2, 6);
    expect(state.progressPct).toBeCloseTo(7.0049, 3);
  });

  it('clamps negative mayhem progress to 0', () => {
    const d = { ...entry('GJNVxxuSGZ4FQYVBrYYEQe4DFDithm9LopFno2XKpump').decoded, real_token_reserves: '802600000000000' };
    expect(decodeBondingCurve(encodeCurve(d), 'm', 'c').progressPct).toBe(0);
  });

  it('prices a PUMP-quoted curve in PUMP units (6 decimals)', () => {
    const c = entry('EVQSX4EQFP8VtS5KDfwkQYJCiVoB3bvJbuooV7Qzpump');
    const state = decodeBondingCurve(encodeCurve(c.decoded), c.mint, c.bonding_curve_pda, 1_000_000_000);
    expect(state.quoteMint).toBe(PUMP_TOKEN_MINT);
    expect(state.quoteDecimals).toBe(6);
    expect(state.virtualQuoteReserves).toBe(841456.831993);
    expect(state.priceQuote).toBeCloseTo(841456.831993 / 1_073_000_000, 12);
    expect(state.progressPct).toBe(0);
  });

  it('requires decimals for an unknown quote mint', () => {
    const d = { ...entry('EVQSX4EQFP8VtS5KDfwkQYJCiVoB3bvJbuooV7Qzpump').decoded, quote_mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' };
    const bytes = encodeCurve(d);
    expect(() => decodeBondingCurve(bytes, 'm', 'c')).toThrow(/unknown decimals/);
    expect(decodeBondingCurve(bytes, 'm', 'c', undefined, { quoteDecimals: 5 }).virtualQuoteReserves).toBe(8414568.31993);
  });
});

describe('createPumpCurveProvider', () => {
  const MINT_7EHSM = '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump';
  const MINT_2QEHJ = '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump';
  const MINT_NO_CURVE = 'dB98iqo6YQ2p1X1KtvmLRDFmtQauEiA2CtxL8cvpump';
  const MINT_WRONG_OWNER = 'GJNVxxuSGZ4FQYVBrYYEQe4DFDithm9LopFno2XKpump';
  const [mintAccount, , curveAccount] = multiParsed.response.result.value;

  const accountsByAddress: Record<string, { base64?: RpcAccountInfo | null; jsonParsed?: RpcAccountInfo | null }> = {
    '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A': { base64: curveAccount },
    [MINT_7EHSM]: { jsonParsed: mintAccount },
    '2JUXSuq1A1EdBzZj757cXFYuALPxv6vee4X981ajpzo8': { base64: migratedRaw.result.value },
    // A Token-2022-owned account at a "curve" address must be ignored.
    DHWsRWXasrurtXbLx7uMWSBrgc85vtcJw9B3CfmnPFxJ: { base64: multiBase64.response.result.value[0] },
  };

  const handler = (request: RpcRequest) => {
    const [addresses, config] = request.params as [string[], { encoding: 'base64' | 'jsonParsed' }];
    return { result: { context: { slot: 1 }, value: addresses.map((a) => accountsByAddress[a]?.[config.encoding] ?? null) } };
  };

  it('returns decoded curves for existing pump-owned PDAs only', async () => {
    const rpc = fakeRpc(handler);
    const provider = createPumpCurveProvider({ rpc: createRpcClient({ url: 'https://rpc.example.org', fetcher: rpc.fetcher }) });
    const before = Date.now();
    const result = await provider.getCurves([MINT_7EHSM, MINT_2QEHJ, MINT_NO_CURVE, MINT_WRONG_OWNER, MINT_7EHSM, 'bogus']);

    expect(provider.id).toBe('solana-rpc');
    expect(result.source).toBe('solana-rpc');
    expect(result.freshness).toBe('realtime');
    expect(result.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(Object.keys(result.data).sort()).toEqual([MINT_2QEHJ, MINT_7EHSM].sort());

    const live = result.data[MINT_7EHSM];
    expect(live?.curve).toBe('9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A');
    expect(live?.progressPct).toBeCloseTo(50.0333, 3);
    expect(live?.realQuoteReserves).toBe(17.605246569);
    expect(live?.marketCapQuote).toBeCloseTo(70.4026, 3);
    expect(live?.priceQuote).toBeCloseTo(7.040259392e-8, 15);

    const migrated = result.data[MINT_2QEHJ];
    expect(migrated?.complete).toBe(true);
    expect(migrated?.progressPct).toBe(100);
    expect(migrated?.marketCapQuote).toBeUndefined();

    const calls = rpc.requestsFor('getMultipleAccounts');
    expect(calls).toHaveLength(2);
    const encodings = calls.map((c) => (c.params[1] as { encoding: string }).encoding).sort();
    expect(encodings).toEqual(['base64', 'jsonParsed']);
    // Deduplicated and validated mints.
    expect((calls[0]?.params[0] as string[]).length).toBe(4);
  });

  it('keeps curves when the mint lookup fails, without market cap', async () => {
    const rpc = fakeRpc((request) => {
      const config = request.params[1] as { encoding: string };
      if (config.encoding === 'jsonParsed') return { error: { code: -32603, message: 'internal' } };
      return handler(request);
    });
    const provider = createPumpCurveProvider({ rpc: createRpcClient({ url: 'https://rpc.example.org', fetcher: rpc.fetcher }) });
    const result = await provider.getCurves([MINT_7EHSM]);
    expect(result.data[MINT_7EHSM]?.priceQuote).toBeGreaterThan(0);
    expect(result.data[MINT_7EHSM]?.marketCapQuote).toBeUndefined();
    expect(result.notes?.length).toBe(1);
  });

  it('fails when the curve accounts cannot be read', async () => {
    const rpc = fakeRpc(() => {
      throw new ProviderError('solana-rpc', 'rate_limited', 'Solana RPC getMultipleAccounts: HTTP 429', { status: 429 });
    });
    const provider = createPumpCurveProvider({ rpc: createRpcClient({ url: 'https://rpc.example.org', fetcher: rpc.fetcher }) });
    await expect(provider.getCurves([MINT_7EHSM])).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('looks up decimals of unknown quote mints once', async () => {
    const quoteMint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const d = { ...entry('EVQSX4EQFP8VtS5KDfwkQYJCiVoB3bvJbuooV7Qzpump').decoded, quote_mint: quoteMint };
    const curve: RpcAccountInfo = { owner: PROGRAMS.PUMP, lamports: 1, executable: false, data: [toBase64(encodeCurve(d)), 'base64'] };
    const quoteMintAccount = structuredClone(mintAccount) as RpcAccountInfo;
    if (!Array.isArray(quoteMintAccount.data)) {
      (quoteMintAccount.data.parsed as { info: { decimals: number } }).info.decimals = 5;
    }
    const table: typeof accountsByAddress = {
      '9fYSQGMDMnG2KDWU2Vk1chHWXEXSSzArqVNEqBDygtCn': { base64: curve },
      [quoteMint]: { jsonParsed: quoteMintAccount },
    };
    const rpc = fakeRpc((request) => {
      const [addresses, config] = request.params as [string[], { encoding: 'base64' | 'jsonParsed' }];
      return { result: { context: { slot: 1 }, value: addresses.map((a) => table[a]?.[config.encoding] ?? null) } };
    });
    const provider = createPumpCurveProvider({ rpc: createRpcClient({ url: 'https://rpc.example.org', fetcher: rpc.fetcher }), provider: 'helius' });
    const result = await provider.getCurves(['EVQSX4EQFP8VtS5KDfwkQYJCiVoB3bvJbuooV7Qzpump']);
    expect(result.source).toBe('helius');
    const state = result.data.EVQSX4EQFP8VtS5KDfwkQYJCiVoB3bvJbuooV7Qzpump;
    expect(state?.quoteMint).toBe(quoteMint);
    expect(state?.quoteDecimals).toBe(5);
    expect(rpc.requestsFor('getMultipleAccounts')).toHaveLength(3);
  });

  it('skips curves whose quote decimals cannot be determined', async () => {
    const d = { ...entry('EVQSX4EQFP8VtS5KDfwkQYJCiVoB3bvJbuooV7Qzpump').decoded, quote_mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' };
    const curve: RpcAccountInfo = { owner: PROGRAMS.PUMP, lamports: 1, executable: false, data: [toBase64(encodeCurve(d)), 'base64'] };
    const rpc = fakeRpc((request) => {
      const [addresses, config] = request.params as [string[], { encoding: string }];
      return { result: { context: { slot: 1 }, value: addresses.map((a) => (config.encoding === 'base64' && a === '9fYSQGMDMnG2KDWU2Vk1chHWXEXSSzArqVNEqBDygtCn' ? curve : null)) } };
    });
    const provider = createPumpCurveProvider({ rpc: createRpcClient({ url: 'https://rpc.example.org', fetcher: rpc.fetcher }) });
    const result = await provider.getCurves(['EVQSX4EQFP8VtS5KDfwkQYJCiVoB3bvJbuooV7Qzpump']);
    expect(result.data).toEqual({});
    expect(result.notes).toContain('Curves with a quote mint of unknown decimals were skipped.');
  });

  it('returns an empty record without calls for no valid mints', async () => {
    const rpc = fakeRpc(handler);
    const provider = createPumpCurveProvider({ rpc: createRpcClient({ url: 'https://rpc.example.org', fetcher: rpc.fetcher }) });
    const result = await provider.getCurves(['nope']);
    expect(result.data).toEqual({});
    expect(rpc.calls).toHaveLength(0);
  });
});
