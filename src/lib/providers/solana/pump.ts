import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import type { BondingCurveState, MintInfo, Sourced } from '@/lib/core/types';
import type { BondingCurveProvider, ProviderId } from '@/lib/core/providers';
import { chunk } from '@/lib/core/chain';
import { isSolanaAddress, MINTS, PROGRAMS } from '@/lib/core/solana';
import { isAbortError, ProviderError } from '@/lib/net/errors';
import { LruCache } from './lru';
import { parseMintAccount } from './mint';
import { accountBytes, MAX_MULTIPLE_ACCOUNTS, type RpcClient } from './rpc';
import { formatUnits } from './units';

/**
 * pump.fun bonding curves, decoded from chain (program 6EF8rr…F6P).
 *
 * BondingCurve layout (pump-public-docs idl/pump.json, checked 2026-09-28),
 * little-endian, Anchor discriminator first:
 *   [0]   discriminator 17b7f83760d8ac60
 *   [8]   virtual_token_reserves u64 (raw, 6 decimals)
 *   [16]  virtual_quote_reserves u64 (lamports for SOL curves; quote base units otherwise)
 *   [24]  real_token_reserves u64
 *   [32]  real_quote_reserves u64
 *   [40]  token_total_supply u64 (1e15 even for mayhem coins whose MINT supply is 2e15)
 *   [48]  complete bool
 *   [49]  creator pubkey
 *   [81]  is_mayhem_mode bool
 *   [82]  is_cashback_coin bool
 *   [83]  quote_mint pubkey (default 111…111 = SOL)
 *   [115] creator_fee_bps u64
 *   [123] can_edit_creator_fee bool
 *   [124] is_holder_reward bool
 * Fields were appended over time; accounts are 49–81 bytes (old), 125, 150
 * or 151 bytes (padding), so trailing fields are read only when present.
 */

export const PUMP_BONDING_CURVE_DISCRIMINATOR: readonly number[] = [23, 183, 248, 55, 96, 216, 172, 96];
/** Real token reserves of a fresh standard curve: 793.1M tokens (raw, 6 decimals). */
export const PUMP_INITIAL_REAL_TOKEN_RESERVES_RAW = 793_100_000_000_000n;
/** pump.fun mints always use 6 decimals. */
export const PUMP_TOKEN_DECIMALS = 6;
export const SOL_DECIMALS = 9;
/** All-zero pubkey: `quote_mint` default meaning SOL; also an unset creator. */
export const DEFAULT_PUBKEY = '11111111111111111111111111111111';
/** pump.fun's PUMP token, seen live as a curve quote mint (6 decimals). */
export const PUMP_TOKEN_MINT = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn';

/** Decimals of non-SOL quote mints observed on pump.fun curves (mint decimals are immutable). */
export const KNOWN_QUOTE_DECIMALS: Readonly<Record<string, number>> = {
  [MINTS.USDC]: 6,
  [MINTS.USDT]: 6,
  [PUMP_TOKEN_MINT]: 6,
};

/** Raw decoded BondingCurve account. Optional fields are absent on older, shorter accounts. */
export interface RawBondingCurve {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  /** Decoded as stored (may be the default pubkey). */
  creator?: string;
  isMayhemMode?: boolean;
  isCashbackCoin?: boolean;
  /** Decoded as stored; the default pubkey means SOL. */
  quoteMint?: string;
  creatorFeeBps?: bigint;
  canEditCreatorFee?: boolean;
  isHolderReward?: boolean;
  byteLength: number;
}

const addressDecoder = getAddressDecoder();
const addressEncoder = getAddressEncoder();

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode BondingCurve account bytes. Throws ProviderError('malformed') for non-curve data. */
export function decodeBondingCurveAccount(bytes: Uint8Array): RawBondingCurve {
  if (bytes.length < 49) throw new ProviderError('solana-rpc', 'malformed', `pump bonding curve: account too short (${bytes.length} bytes)`);
  for (let i = 0; i < PUMP_BONDING_CURVE_DISCRIMINATOR.length; i++) {
    if (bytes[i] !== PUMP_BONDING_CURVE_DISCRIMINATOR[i]) throw new ProviderError('solana-rpc', 'malformed', 'pump bonding curve: discriminator mismatch');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = (offset: number) => view.getBigUint64(offset, true);
  const pubkey = (offset: number) => addressDecoder.decode(bytes.subarray(offset, offset + 32));
  const has = (offset: number, size: number) => bytes.length >= offset + size;

  const raw: RawBondingCurve = {
    virtualTokenReserves: u64(8),
    virtualQuoteReserves: u64(16),
    realTokenReserves: u64(24),
    realQuoteReserves: u64(32),
    tokenTotalSupply: u64(40),
    complete: bytes[48] === 1,
    byteLength: bytes.length,
  };
  if (has(49, 32)) raw.creator = pubkey(49);
  if (has(81, 1)) raw.isMayhemMode = bytes[81] === 1;
  if (has(82, 1)) raw.isCashbackCoin = bytes[82] === 1;
  if (has(83, 32)) raw.quoteMint = pubkey(83);
  if (has(115, 8)) raw.creatorFeeBps = u64(115);
  if (has(123, 1)) raw.canEditCreatorFee = bytes[123] === 1;
  if (has(124, 1)) raw.isHolderReward = bytes[124] === 1;
  return raw;
}

/** Quote mint of a decoded curve; SOL curves (absent or default quote_mint) report WSOL. */
export function curveQuoteMint(raw: RawBondingCurve): string {
  return !raw.quoteMint || raw.quoteMint === DEFAULT_PUBKEY ? MINTS.SOL : raw.quoteMint;
}

/**
 * Bonding progress 0–100 from the token side: share of the initial 793.1M
 * real tokens already sold. Complete curves are 100. Mayhem coins can hold
 * more than 793.1M real tokens (agent-adjusted), which clamps to 0.
 */
export function curveProgressPct(raw: RawBondingCurve): number {
  if (raw.complete) return 100;
  const sold = PUMP_INITIAL_REAL_TOKEN_RESERVES_RAW - raw.realTokenReserves;
  // Exact bigint difference; both operands are far below 2^53, so the ratio is float-exact enough.
  const pct = (Number(sold) / Number(PUMP_INITIAL_REAL_TOKEN_RESERVES_RAW)) * 100;
  return Math.min(100, Math.max(0, pct));
}

const toUi = (value: bigint, decimals: number) => Number(formatUnits(value, decimals));

export interface DecodeCurveOptions {
  /** Decimals of a non-SOL quote mint (defaults to KNOWN_QUOTE_DECIMALS). */
  quoteDecimals?: number;
  /** Token decimals (pump.fun mints: 6). */
  tokenDecimals?: number;
  fetchedAt?: number;
}

/**
 * Normalized state from a decoded curve.
 *
 * - priceQuote = (vQuote / 10^quoteDecimals) / (vToken / 10^6); omitted once
 *   the curve is complete or reserves read 0 (the token trades on its AMM).
 * - marketCapQuote = priceQuote × mint supply. Needs the MINT supply
 *   (`mintSupplyTokens`, UI units) because mayhem mints have 2B tokens while
 *   token_total_supply still says 1B; omitted when not provided.
 * Throws ProviderError('unsupported') when a non-SOL quote mint's decimals are unknown.
 */
export function curveStateFromRaw(
  raw: RawBondingCurve,
  mint: string,
  curveAddress: string,
  mintSupplyTokens?: number,
  opts: DecodeCurveOptions = {},
): BondingCurveState {
  const quoteMint = curveQuoteMint(raw);
  const quoteDecimals = quoteMint === MINTS.SOL ? SOL_DECIMALS : (opts.quoteDecimals ?? KNOWN_QUOTE_DECIMALS[quoteMint]);
  if (quoteDecimals === undefined) {
    throw new ProviderError('solana-rpc', 'unsupported', `pump bonding curve: unknown decimals for quote mint ${quoteMint}`);
  }
  const tokenDecimals = opts.tokenDecimals ?? PUMP_TOKEN_DECIMALS;

  const state: BondingCurveState = {
    mint,
    curve: curveAddress,
    complete: raw.complete,
    progressPct: curveProgressPct(raw),
    virtualTokenReserves: toUi(raw.virtualTokenReserves, tokenDecimals),
    virtualQuoteReserves: toUi(raw.virtualQuoteReserves, quoteDecimals),
    realTokenReserves: toUi(raw.realTokenReserves, tokenDecimals),
    realQuoteReserves: toUi(raw.realQuoteReserves, quoteDecimals),
    quoteMint,
    quoteDecimals,
    fetchedAt: opts.fetchedAt ?? Date.now(),
  };

  if (!raw.complete && raw.virtualTokenReserves > 0n && raw.virtualQuoteReserves > 0n) {
    const price = state.virtualQuoteReserves / state.virtualTokenReserves;
    if (Number.isFinite(price) && price > 0) {
      state.priceQuote = price;
      if (typeof mintSupplyTokens === 'number' && Number.isFinite(mintSupplyTokens) && mintSupplyTokens > 0) {
        state.marketCapQuote = price * mintSupplyTokens;
      }
    }
  }
  if (raw.isMayhemMode !== undefined) state.isMayhemMode = raw.isMayhemMode;
  if (raw.creator && raw.creator !== DEFAULT_PUBKEY) state.creator = raw.creator;
  return state;
}

/**
 * Decode BondingCurve account data (base64 string or bytes) into the
 * normalized state; see `curveStateFromRaw` for price / market-cap rules.
 * Throws ProviderError('malformed') for non-curve data.
 */
export function decodeBondingCurve(
  data: string | Uint8Array,
  mint: string,
  curveAddress: string,
  mintSupplyTokens?: number,
  opts: DecodeCurveOptions = {},
): BondingCurveState {
  let bytes: Uint8Array;
  try {
    bytes = typeof data === 'string' ? base64ToBytes(data) : data;
  } catch (cause) {
    throw new ProviderError('solana-rpc', 'malformed', 'pump bonding curve: invalid base64', { cause });
  }
  return curveStateFromRaw(decodeBondingCurveAccount(bytes), mint, curveAddress, mintSupplyTokens, opts);
}

const pdaCache = new LruCache<string, string>(5_000);

/** Bonding-curve PDA: seeds ['bonding-curve', mint] under the pump program (async, uses crypto.subtle). */
export async function derivePumpCurveAddress(mint: string): Promise<string> {
  const cached = pdaCache.get(mint);
  if (cached) return cached;
  if (!isSolanaAddress(mint)) throw new TypeError('derivePumpCurveAddress: invalid mint address');
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(PROGRAMS.PUMP),
    seeds: ['bonding-curve', addressEncoder.encode(address(mint))],
  });
  pdaCache.set(mint, pda);
  return pda;
}

/**
 * BondingCurveProvider over any RPC client: one getMultipleAccounts(base64)
 * for the curve PDAs and one getMultipleAccounts(jsonParsed) for the mints
 * (supply for market cap), plus one more for unknown non-SOL quote mints.
 * Only accounts that exist and are owned by the pump program are returned.
 */
export function createPumpCurveProvider(opts: { rpc: RpcClient; provider?: ProviderId }): BondingCurveProvider {
  const { rpc } = opts;
  const id: ProviderId = opts.provider ?? rpc.provider;

  async function getCurves(mints: string[], signal?: AbortSignal): Promise<Sourced<Record<string, BondingCurveState>>> {
    const unique = [...new Set(mints)].filter(isSolanaAddress);
    const data: Record<string, BondingCurveState> = {};
    const notes = new Set<string>();
    let fetchedAt = Date.now();

    for (const group of chunk(unique, MAX_MULTIPLE_ACCOUNTS)) {
      const pdas = await Promise.all(group.map((mint) => derivePumpCurveAddress(mint)));
      const [curvesRes, mintsRes] = await Promise.allSettled([
        rpc.getMultipleAccounts(pdas, { encoding: 'base64' }, signal),
        rpc.getMultipleAccounts(group, { encoding: 'jsonParsed' }, signal),
      ]);
      if (curvesRes.status === 'rejected') throw curvesRes.reason;
      fetchedAt = Date.now();

      let mintInfos: Array<MintInfo | null> | undefined;
      if (mintsRes.status === 'fulfilled') {
        mintInfos = group.map((mint, i) => parseMintAccount(mint, mintsRes.value[i], fetchedAt));
      } else {
        if (isAbortError(mintsRes.reason)) throw mintsRes.reason;
        notes.add('Mint accounts unavailable: market cap omitted.');
      }

      const decoded: Array<{ index: number; mint: string; curve: string; raw: RawBondingCurve }> = [];
      group.forEach((mint, index) => {
        const account = curvesRes.value[index];
        const curve = pdas[index];
        if (!account || account.owner !== PROGRAMS.PUMP || !curve) return;
        const bytes = accountBytes(account);
        if (!bytes) return;
        try {
          decoded.push({ index, mint, curve, raw: decodeBondingCurveAccount(bytes) });
        } catch {
          notes.add('Some pump program accounts could not be decoded as bonding curves.');
        }
      });

      const quoteDecimals = new Map<string, number>();
      const unknownQuotes = [
        ...new Set(decoded.map((d) => curveQuoteMint(d.raw)).filter((q) => q !== MINTS.SOL && KNOWN_QUOTE_DECIMALS[q] === undefined)),
      ];
      if (unknownQuotes.length > 0) {
        try {
          const accounts = await rpc.getMultipleAccounts(unknownQuotes, { encoding: 'jsonParsed' }, signal);
          unknownQuotes.forEach((quote, i) => {
            const info = parseMintAccount(quote, accounts[i], fetchedAt);
            if (info) quoteDecimals.set(quote, info.decimals);
          });
        } catch (error) {
          if (isAbortError(error)) throw error;
        }
      }

      for (const d of decoded) {
        const quote = curveQuoteMint(d.raw);
        const qd = quote === MINTS.SOL ? SOL_DECIMALS : (KNOWN_QUOTE_DECIMALS[quote] ?? quoteDecimals.get(quote));
        if (qd === undefined) {
          notes.add('Curves with a quote mint of unknown decimals were skipped.');
          continue;
        }
        const mintInfo = mintInfos?.[d.index] ?? undefined;
        data[d.mint] = curveStateFromRaw(d.raw, d.mint, d.curve, mintInfo?.supply, {
          quoteDecimals: qd,
          tokenDecimals: mintInfo?.decimals ?? PUMP_TOKEN_DECIMALS,
          fetchedAt,
        });
      }
    }

    const result: Sourced<Record<string, BondingCurveState>> = { data, source: id, fetchedAt, freshness: 'realtime' };
    if (notes.size > 0) result.notes = [...notes];
    return result;
  }

  return { id, getCurves };
}
