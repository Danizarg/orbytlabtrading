import { isAddress, isOffCurveAddress } from '@solana/kit';
import type { DerivedTrade } from '@/lib/analytics/swaps';
import type { RpcParsedTransaction } from '@/lib/analytics/tx-types';
import { MINTS } from '@/lib/core/solana';

/**
 * Pool corroboration for balance-derived trades of the on-chain feed.
 *
 * `logsSubscribe(mentions: pool)` and `getSignaturesForAddress(pool)` return
 * every transaction that merely LISTS the pool account, and anyone can list
 * any account (read-only) in a transaction. Balance derivation alone would
 * then turn a peer-to-peer transfer "mentioning" the pool (wallet A sends SOL,
 * wallet B sends tokens back) into a trade on this pool at a price of the
 * sender's choosing: a fake print on the chart of a fresh token.
 *
 * A trade counts only when the pool itself took the other side:
 * - Pool side: the pool account when it owns token accounts in the transaction
 *   (pump.fun curves, PumpSwap, Orca, Meteora DLMM hold their vaults
 *   themselves); otherwise the off-curve owner (a program-derived vault
 *   authority, e.g. Raydium AMM v4 / CPMM) that moved the most of the mint
 *   against the trader. On-curve wallets never count: a wallet is not a pool.
 *   (Residual: a purpose-built program's PDA can still pose as a vault
 *   authority for pools that do not own their vaults; the amount checks below
 *   then still tie the printed price to what that PDA really moved.)
 * - The pool side moved the mint against the trader by a comparable amount
 *   (×½…2 tolerates transfer fees and router hops; a small real swap padded
 *   with a large side transfer is rejected).
 * - Quote: when the pool side moved the trade's quote asset, it moved it the
 *   other way by a comparable amount (×½…2: LP / protocol / router fees). When
 *   the trader's quote leg is another asset (a routed trade), the venue price
 *   comes from the pool side instead (`poolPrice`). A pool side that gave
 *   tokens for nothing (or took them and paid nothing) is not a swap.
 */

export type PoolCorroboration =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** Venue price (pool quote per token, UI units) when the trader's own quote leg is not the pool's quote asset. */
      poolPrice?: { quoteMint: string; price: number };
    };

type TradeLike = Pick<DerivedTrade, 'side' | 'tokenAmount' | 'wallet' | 'solAmount' | 'quoteMint' | 'quoteAmount'>;

interface Delta {
  raw: bigint;
  decimals: number;
}

const WSOL = MINTS.SOL;
/** Pool-side SOL moves below 0.000001 SOL are not a quote leg. */
const DUST_LAMPORTS = 1_000n;
const MIN_RATIO = 0.5;
const MAX_RATIO = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rawOf(value: unknown): bigint | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return undefined;
}

function keyOf(key: unknown): string | undefined {
  if (typeof key === 'string') return key;
  if (isRecord(key) && typeof key.pubkey === 'string') return key.pubkey;
  return undefined;
}

function isOffCurve(owner: string): boolean {
  try {
    return isAddress(owner) && isOffCurveAddress(owner);
  } catch {
    return false;
  }
}

function toUi(raw: bigint, decimals: number): number {
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0');
  const value = decimals === 0 ? Number(digits) : Number(`${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`);
  return negative ? -value : value;
}

const within = (ratio: number) => Number.isFinite(ratio) && ratio >= MIN_RATIO && ratio <= MAX_RATIO;

/** owner → mint → net raw delta over the transaction's token balances. */
function ownerTokenDeltas(meta: Record<string, unknown>): { deltas: Map<string, Map<string, Delta>>; owners: Set<string> } {
  const deltas = new Map<string, Map<string, Delta>>();
  const owners = new Set<string>();
  const add = (list: unknown, sign: 1n | -1n) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!isRecord(item) || typeof item.owner !== 'string' || typeof item.mint !== 'string') continue;
      const ui = isRecord(item.uiTokenAmount) ? item.uiTokenAmount : undefined;
      const raw = rawOf(ui?.amount);
      const decimals = typeof ui?.decimals === 'number' && Number.isInteger(ui.decimals) && ui.decimals >= 0 && ui.decimals <= 255 ? ui.decimals : undefined;
      if (raw === undefined || decimals === undefined) continue;
      owners.add(item.owner);
      let byMint = deltas.get(item.owner);
      if (!byMint) deltas.set(item.owner, (byMint = new Map()));
      const current = byMint.get(item.mint);
      byMint.set(item.mint, { raw: (current?.raw ?? 0n) + sign * raw, decimals: current?.decimals ?? decimals });
    }
  };
  add(meta.preTokenBalances, -1n);
  add(meta.postTokenBalances, 1n);
  return { deltas, owners };
}

/** Net SOL of `owner`: its own lamports (fee added back when it paid it) + its WSOL token accounts. */
function ownerSol(tx: RpcParsedTransaction, meta: Record<string, unknown>, deltas: Map<string, Map<string, Delta>>, owner: string): bigint {
  const keys: unknown[] = Array.isArray(tx.transaction?.message?.accountKeys) ? tx.transaction.message.accountKeys : [];
  const index = keys.findIndex((k) => keyOf(k) === owner);
  let native = 0n;
  if (index >= 0 && Array.isArray(meta.preBalances) && Array.isArray(meta.postBalances)) {
    const pre = rawOf(meta.preBalances[index]);
    const post = rawOf(meta.postBalances[index]);
    if (pre !== undefined && post !== undefined) native = post - pre;
    if (index === 0) native += rawOf(meta.fee) ?? 0n;
  }
  return native + (deltas.get(owner)?.get(WSOL)?.raw ?? 0n);
}

export function corroborateWithPool(tx: RpcParsedTransaction, trade: TradeLike, mint: string, pool: string): PoolCorroboration {
  const meta = isRecord(tx) && isRecord(tx.meta) ? tx.meta : undefined;
  if (!meta) return { ok: false, reason: 'no transaction meta' };
  if (!(trade.tokenAmount > 0)) return { ok: false, reason: 'no token amount' };
  const buy = trade.side === 'buy';
  const { deltas, owners } = ownerTokenDeltas(meta as unknown as Record<string, unknown>);
  const record = meta as unknown as Record<string, unknown>;

  // The pool takes the opposite side: on a buy its mint balance falls and its quote balance rises.
  const opposes = (raw: bigint) => raw !== 0n && (raw < 0n) === buy;
  let side: string | undefined;
  if (owners.has(pool)) side = pool;
  else {
    // The vault authority moved the bulk of the mint; a router's fee PDA next to it moves a sliver.
    let best: bigint | undefined;
    for (const [owner, byMint] of deltas) {
      const raw = byMint.get(mint)?.raw ?? 0n;
      if (owner === trade.wallet || !opposes(raw) || !isOffCurve(owner)) continue;
      const size = raw < 0n ? -raw : raw;
      if (best === undefined || size > best) {
        best = size;
        side = owner;
      }
    }
  }
  if (side === undefined) return { ok: false, reason: 'the pool did not take the other side' };
  const sideDeltas = deltas.get(side);
  const mintDelta = sideDeltas?.get(mint);
  if (!mintDelta || !opposes(mintDelta.raw)) return { ok: false, reason: 'the pool did not move the token against the trader' };
  const poolTokens = Math.abs(toUi(mintDelta.raw, mintDelta.decimals));
  if (!within(poolTokens / trade.tokenAmount)) return { ok: false, reason: 'the pool moved a different token amount' };

  // Quote legs of the pool side that move the way a pool's quote moves (in on a buy, out on a sell).
  const quoteIn = (raw: bigint) => raw !== 0n && (raw > 0n) === buy;
  const legs: Array<{ mint: string; amount: number }> = [];
  const sol = ownerSol(tx, record, deltas, side);
  if ((sol < 0n ? -sol : sol) >= DUST_LAMPORTS) {
    if (!quoteIn(sol)) return { ok: false, reason: 'the pool moved SOL the wrong way' };
    legs.push({ mint: WSOL, amount: Math.abs(toUi(sol, 9)) });
  }
  for (const [legMint, delta] of sideDeltas ?? []) {
    if (legMint === mint || legMint === WSOL || delta.raw === 0n) continue;
    // Another token left the pool with the mint (or entered it with the mint on a sell): not a swap of this mint.
    if (!quoteIn(delta.raw)) return { ok: false, reason: 'the pool moved another token with the mint' };
    legs.push({ mint: legMint, amount: Math.abs(toUi(delta.raw, delta.decimals)) });
  }
  if (legs.length !== 1) return { ok: false, reason: legs.length ? 'the pool moved several quote assets' : 'the pool took no quote asset' };
  const leg = legs[0] as { mint: string; amount: number };

  const traderQuote =
    trade.solAmount !== undefined && trade.solAmount > 0
      ? { mint: WSOL, amount: trade.solAmount }
      : trade.quoteMint !== undefined && trade.quoteAmount !== undefined && trade.quoteAmount > 0
        ? { mint: trade.quoteMint, amount: trade.quoteAmount }
        : undefined;
  if (traderQuote && traderQuote.mint === leg.mint) {
    return within(traderQuote.amount / leg.amount) ? { ok: true } : { ok: false, reason: 'the trader paid a different amount than the pool took' };
  }
  // A routed trade (the trader paid another asset) or no attributable trader leg: the venue price is the pool's.
  const price = leg.amount / poolTokens;
  return Number.isFinite(price) && price > 0 ? { ok: true, poolPrice: { quoteMint: leg.mint, price } } : { ok: true };
}
