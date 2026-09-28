import { getAddressDecoder, getBase64Encoder, isAddress, isOffCurveAddress } from '@solana/kit';
import type { ActivityKind, ActivityLeg, WalletActivity } from '@/lib/core/types';
import type { ProviderId } from '@/lib/core/providers';
import { num } from '@/lib/core/chain';
import { MINTS, PROGRAMS, STABLE_MINTS } from '@/lib/core/solana';
import { ProviderError } from '@/lib/net/errors';
import type { RpcParsedInstruction, RpcParsedTransaction } from './tx-types';

/**
 * Swap / transfer derivation from parsed Solana transactions
 * (`getTransaction` jsonParsed, maxSupportedTransactionVersion 1).
 *
 * Everything is derived from balance deltas, never from instruction names:
 * PumpSwap `BuyExactQuoteIn` on an inverted pool is really a SELL of the token.
 *
 * SOL accounting for a wallet (all BigInt lamports until the final conversion):
 *   native delta of the wallet account
 * + meta.fee when the wallet is the fee payer (accountKeys[0])
 * + WSOL token delta of token accounts the wallet owns
 * + rent moved into the wallet's own token accounts opened in the tx (when the
 *   wallet funded them) − rent refunded from its accounts closed in the tx
 *   (when the refund went to the wallet). Rent is read from lamport deltas,
 *   never hardcoded (it changed in 2026: 1,488,440 vs the old 2,039,280).
 * WSOL wrap accounts created and closed inside one tx never appear in token
 * balances; their net already sits in the native delta.
 *
 * Third-party router/bot fees and tips paid by the wallet stay in its SOL
 * delta (it really paid them). The pump.fun TradeEvent amount (curve SOL,
 * excluding protocol/creator fees) is exposed separately as `venueSolAmount`.
 */

export interface BalanceChanges {
  wallet: string;
  /**
   * Net SOL change for the wallet (native lamports + WSOL token accounts),
   * in SOL, EXCLUDING the network fee paid by the wallet and excluding rent
   * deposited into / refunded from token accounts opened or closed in the tx.
   */
  solDelta: number;
  /** Network fee paid by the wallet (0 when another signer paid). */
  feeSol: number;
  /** Non-SOL token changes for the wallet (signed, decimal-adjusted). */
  tokens: Array<ActivityLeg & { decimals: number }>;
  /**
   * Rent (SOL) the wallet deposited into (+) or recovered from (−) its own
   * token accounts opened/closed in this tx — already excluded from solDelta.
   * Omitted when zero.
   */
  rentSol?: number;
}

export interface DerivedTrade {
  signature: string;
  /** ms */
  timestamp: number;
  side: 'buy' | 'sell';
  /** Trader wallet (the owner whose balance of `mint` changed; not necessarily the fee payer). */
  wallet: string;
  tokenAmount: number;
  /** SOL exchanged by the trader (native + WSOL, fee/rent excluded) when the quote is SOL. */
  solAmount?: number;
  /** Quote mint when not SOL (e.g. USDC). */
  quoteMint?: string;
  quoteAmount?: number;
  /** Execution price per token in quote units (quoteAmount / tokenAmount). */
  priceQuote?: number;
  /** Venue label, e.g. 'pump.fun', 'PumpSwap', 'Raydium', 'Jupiter'. */
  program?: string;
  /**
   * pump.fun only: SOL moved against the bonding curve per the program's own
   * TradeEvent (`sol_amount`), which excludes pump's protocol/creator fees and
   * any router/bot fees or tips. Omitted when the event is absent (e.g.
   * truncated logs) or the curve is not SOL-quoted.
   */
  venueSolAmount?: number;
}

/** Decoded pump.fun `TradeEvent` (from a `Program data:` log line of the pump program). */
export interface PumpTradeEvent {
  mint: string;
  /** Quote lamports moved against the curve (excludes protocol/creator fees). */
  solAmount: bigint;
  /** Raw token amount (pump tokens use 6 decimals). */
  tokenAmount: bigint;
  isBuy: boolean;
  user: string;
  /** UNIX seconds (omitted when not positive). */
  timestamp?: number;
  /** e.g. 'buy' | 'buy_exact_sol_in' | 'sell' (when present in the layout). */
  ixName?: string;
  /** Curve quote mint; the all-zero default pubkey (1111…1111) means SOL. Absent on older layouts. */
  quoteMint?: string;
  quoteAmount?: bigint;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WSOL = MINTS.SOL;
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN_PROGRAMS: ReadonlySet<string> = new Set([PROGRAMS.TOKEN, PROGRAMS.TOKEN_2022]);
/** SOL moves below 0.000001 SOL never make a transfer look like a trade. */
const DUST_LAMPORTS = 1_000n;
const LAMPORTS_DECIMALS = 9;

/** Aggregators win over the AMM they route through. */
const AGGREGATORS: ReadonlyMap<string, string> = new Map([
  ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'Jupiter'],
  /** DFlow Aggregator v4 (the relayer/USDC fixture routes through it). */
  ['DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH', 'DFlow'],
]);

const VENUES: ReadonlyMap<string, string> = new Map([
  [PROGRAMS.PUMP, 'pump.fun'],
  [PROGRAMS.PUMP_AMM, 'PumpSwap'],
  ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'Raydium'],
  ['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', 'Raydium CPMM'],
  ['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', 'Raydium CLMM'],
  ['LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', 'Raydium LaunchLab'],
  ['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', 'Meteora DLMM'],
  ['cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', 'Meteora DAMM v2'],
  ['dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', 'Meteora DBC'],
  ['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', 'Orca'],
]);

/** Anchor event discriminator of pump.fun `TradeEvent` (bddb7fd34ee661ee). */
const TRADE_EVENT_DISCRIMINATOR = [0xbd, 0xdb, 0x7f, 0xd3, 0x4e, 0xe6, 0x61, 0xee] as const;

// ---------------------------------------------------------------------------
// Transaction view (validated, BigInt)
// ---------------------------------------------------------------------------

interface TokenEntry {
  mint: string;
  owner?: string;
  raw: bigint;
  decimals: number;
}

interface TxView {
  signature: string;
  /** Account keys aligned with pre/postBalances (loaded addresses included). */
  keys: string[];
  signers: ReadonlySet<string>;
  feePayer: string;
  fee: bigint;
  pre: bigint[];
  post: bigint[];
  preTokens: Map<number, TokenEntry>;
  postTokens: Map<number, TokenEntry>;
  failed: boolean;
  /** Outer instructions each followed by their inner instructions (execution order). */
  instructions: RpcParsedInstruction[];
}

interface MintDelta {
  raw: bigint;
  decimals: number;
}

/** owner → mint → net raw delta (insertion order follows account index). */
type OwnerDeltas = Map<string, Map<string, MintDelta>>;

interface WalletLamports {
  native: bigint;
  fee: bigint;
  rent: bigint;
  wsol: bigint;
  /** native + fee + rent + wsol: the SOL delta reported for the wallet. */
  sol: bigint;
}

function malformed(provider: ProviderId, message: string): ProviderError {
  return new ProviderError(provider, 'malformed', `getTransaction: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lamportsOf(value: unknown): bigint | undefined {
  const n = num(value);
  return n !== undefined && Number.isInteger(n) && n >= 0 ? BigInt(n) : undefined;
}

function rawAmountOf(value: unknown): bigint | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return undefined;
}

function keyOf(key: unknown): string | undefined {
  if (typeof key === 'string') return key;
  if (isRecord(key) && typeof key.pubkey === 'string') return key.pubkey;
  return undefined;
}

function readTokenBalances(list: unknown, keyCount: number, provider: ProviderId): Map<number, TokenEntry> {
  const out = new Map<number, TokenEntry>();
  if (list === null || list === undefined) return out;
  if (!Array.isArray(list)) throw malformed(provider, 'token balances are not an array');
  for (const item of list) {
    if (!isRecord(item)) throw malformed(provider, 'token balance entry is not an object');
    const index = num(item.accountIndex);
    if (index === undefined || !Number.isInteger(index) || index < 0 || index >= keyCount) {
      throw malformed(provider, 'token balance accountIndex out of range');
    }
    const ui = isRecord(item.uiTokenAmount) ? item.uiTokenAmount : undefined;
    const raw = rawAmountOf(ui?.amount);
    const decimals = num(ui?.decimals);
    if (typeof item.mint !== 'string' || raw === undefined || decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
      throw malformed(provider, 'token balance entry lacks mint/amount/decimals');
    }
    const entry: TokenEntry = { mint: item.mint, raw, decimals };
    if (typeof item.owner === 'string' && item.owner) entry.owner = item.owner;
    out.set(index, entry);
  }
  return out;
}

function orderedInstructions(tx: RpcParsedTransaction): RpcParsedInstruction[] {
  if (!isRecord(tx)) return [];
  const outer = Array.isArray(tx.transaction?.message?.instructions) ? tx.transaction.message.instructions : [];
  const innerGroups = Array.isArray(tx.meta?.innerInstructions) ? tx.meta.innerInstructions : [];
  const inner = new Map<number, RpcParsedInstruction[]>();
  for (const group of innerGroups) {
    if (!isRecord(group) || !Array.isArray(group.instructions)) continue;
    const index = num(group.index);
    if (index === undefined) continue;
    inner.set(index, [...(inner.get(index) ?? []), ...(group.instructions as RpcParsedInstruction[])]);
  }
  const out: RpcParsedInstruction[] = [];
  outer.forEach((ix, i) => {
    if (isRecord(ix)) out.push(ix);
    for (const child of inner.get(i) ?? []) if (isRecord(child)) out.push(child);
  });
  return out;
}

function readTx(tx: RpcParsedTransaction, provider: ProviderId): TxView {
  if (!isRecord(tx) || !isRecord(tx.transaction) || !isRecord(tx.transaction.message)) {
    throw malformed(provider, 'transaction message missing');
  }
  const meta = tx.meta;
  if (!isRecord(meta)) throw malformed(provider, 'transaction meta missing');
  const signature = Array.isArray(tx.transaction.signatures) ? tx.transaction.signatures[0] : undefined;
  if (typeof signature !== 'string' || !signature) throw malformed(provider, 'signature missing');

  const rawKeys: unknown = tx.transaction.message.accountKeys;
  if (!Array.isArray(rawKeys) || rawKeys.length === 0) throw malformed(provider, 'accountKeys missing');
  const keys: string[] = [];
  const signers = new Set<string>();
  for (const k of rawKeys) {
    const pubkey = keyOf(k);
    if (!pubkey) throw malformed(provider, 'account key without pubkey');
    keys.push(pubkey);
    if (isRecord(k) && k.signer === true) signers.add(pubkey);
  }
  const feePayer = keys[0] as string;
  // String-only keys (non-parsed encodings) carry no signer flags; the fee payer always signs.
  signers.add(feePayer);

  if (!Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)) throw malformed(provider, 'pre/postBalances missing');
  // jsonParsed already lists lookup-table keys; other encodings append them (writable, then readonly).
  const loaded = meta.loadedAddresses;
  if (keys.length < meta.preBalances.length && isRecord(loaded)) {
    for (const k of [...(Array.isArray(loaded.writable) ? loaded.writable : []), ...(Array.isArray(loaded.readonly) ? loaded.readonly : [])]) {
      if (typeof k === 'string') keys.push(k);
    }
  }
  if (meta.preBalances.length !== keys.length || meta.postBalances.length !== keys.length) {
    throw malformed(provider, 'balances are not aligned with account keys');
  }
  const pre: bigint[] = [];
  const post: bigint[] = [];
  for (let i = 0; i < keys.length; i++) {
    const a = lamportsOf(meta.preBalances[i]);
    const b = lamportsOf(meta.postBalances[i]);
    if (a === undefined || b === undefined) throw malformed(provider, 'invalid lamport balance');
    pre.push(a);
    post.push(b);
  }
  const fee = lamportsOf(meta.fee);
  if (fee === undefined) throw malformed(provider, 'fee missing');

  return {
    signature,
    keys,
    signers,
    feePayer,
    fee,
    pre,
    post,
    preTokens: readTokenBalances(meta.preTokenBalances, keys.length, provider),
    postTokens: readTokenBalances(meta.postTokenBalances, keys.length, provider),
    failed: meta.err !== null && meta.err !== undefined,
    instructions: orderedInstructions(tx),
  };
}

function tokenIndices(view: TxView): number[] {
  return [...new Set([...view.preTokens.keys(), ...view.postTokens.keys()])].sort((a, b) => a - b);
}

function ownerDeltas(view: TxView): OwnerDeltas {
  const out: OwnerDeltas = new Map();
  const add = (entry: TokenEntry | undefined, sign: 1n | -1n) => {
    if (!entry?.owner) return;
    let byMint = out.get(entry.owner);
    if (!byMint) {
      byMint = new Map();
      out.set(entry.owner, byMint);
    }
    const current = byMint.get(entry.mint);
    byMint.set(entry.mint, { raw: (current?.raw ?? 0n) + sign * entry.raw, decimals: current?.decimals ?? entry.decimals });
  };
  for (const i of tokenIndices(view)) {
    add(view.preTokens.get(i), -1n);
    add(view.postTokens.get(i), 1n);
  }
  return out;
}

function parsedInfo(ix: RpcParsedInstruction): { type: string; info: Record<string, unknown> } | undefined {
  const parsed = ix.parsed;
  if (!isRecord(parsed) || typeof parsed.type !== 'string' || !isRecord(parsed.info)) return undefined;
  return { type: parsed.type, info: parsed.info };
}

/** Who paid for each account created in the tx, and where each closed token account's lamports went. */
function accountLifecycle(view: TxView): { funders: Map<string, string>; closedTo: Map<string, string> } {
  const funders = new Map<string, string>();
  const closedTo = new Map<string, string>();
  for (const ix of view.instructions) {
    const p = parsedInfo(ix);
    if (!p) continue;
    const { type, info } = p;
    if (ix.programId === SYSTEM_PROGRAM && (type === 'createAccount' || type === 'createAccountWithSeed')) {
      if (typeof info.newAccount === 'string' && typeof info.source === 'string' && !funders.has(info.newAccount)) funders.set(info.newAccount, info.source);
    } else if (ix.programId === ATA_PROGRAM && (type === 'create' || type === 'createIdempotent')) {
      if (typeof info.account === 'string' && typeof info.source === 'string' && !funders.has(info.account)) funders.set(info.account, info.source);
    } else if (TOKEN_PROGRAMS.has(ix.programId) && type === 'closeAccount') {
      if (typeof info.account === 'string' && typeof info.destination === 'string') closedTo.set(info.account, info.destination);
    }
  }
  return { funders, closedTo };
}

function walletLamports(view: TxView, wallet: string, deltas: OwnerDeltas): WalletLamports {
  const index = view.keys.indexOf(wallet);
  const native = index >= 0 ? (view.post[index] as bigint) - (view.pre[index] as bigint) : 0n;
  const fee = view.feePayer === wallet ? view.fee : 0n;
  const wsol = deltas.get(wallet)?.get(WSOL)?.raw ?? 0n;

  let rent = 0n;
  const lifecycle = accountLifecycle(view);
  for (const i of tokenIndices(view)) {
    const before = view.preTokens.get(i);
    const after = view.postTokens.get(i);
    const account = view.keys[i] as string;
    const lamportDelta = (view.post[i] as bigint) - (view.pre[i] as bigint);
    if (!before && after?.owner === wallet) {
      // Opened: everything above the wrapped WSOL amount is rent.
      const deposit = lamportDelta - (after.mint === WSOL ? after.raw : 0n);
      const funder = lifecycle.funders.get(account);
      if (funder !== undefined ? funder === wallet : view.signers.has(wallet)) rent += deposit;
    } else if (before?.owner === wallet && !after) {
      // Closed: the account's lamports (rent + any WSOL) left it; the WSOL part is counted as a token delta.
      const refund = lamportDelta + (before.mint === WSOL ? before.raw : 0n);
      const destination = lifecycle.closedTo.get(account);
      if (destination === undefined || destination === wallet) rent += refund;
    }
  }
  return { native, fee, rent, wsol, sol: native + fee + rent + wsol };
}

function toUi(raw: bigint, decimals: number): number {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const value = Number(abs / base) + Number(abs % base) / Number(base);
  return negative ? -value : value;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function blockTimeMs(tx: RpcParsedTransaction): number | undefined {
  const t = num(tx.blockTime);
  return t !== undefined && t > 0 ? Math.round(t * 1000) : undefined;
}

function isOffCurve(owner: string): boolean {
  try {
    return isAddress(owner) && isOffCurveAddress(owner);
  } catch {
    return false;
  }
}

function tokenLegsOf(deltas: OwnerDeltas, wallet: string): Array<{ mint: string } & MintDelta> {
  const out: Array<{ mint: string } & MintDelta> = [];
  for (const [mint, d] of deltas.get(wallet) ?? []) {
    if (mint !== WSOL && d.raw !== 0n) out.push({ mint, ...d });
  }
  return out;
}

function symbolFor(symbols: Record<string, string> | undefined, mint: string): string | undefined {
  return symbols && Object.hasOwn(symbols, mint) ? symbols[mint] : undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function walletBalanceChanges(tx: RpcParsedTransaction, wallet: string): BalanceChanges {
  const view = readTx(tx, 'solana-rpc');
  const deltas = ownerDeltas(view);
  const lamports = walletLamports(view, wallet, deltas);
  const out: BalanceChanges = {
    wallet,
    solDelta: toUi(lamports.sol, LAMPORTS_DECIMALS),
    feeSol: toUi(lamports.fee, LAMPORTS_DECIMALS),
    tokens: tokenLegsOf(deltas, wallet).map((t) => ({ mint: t.mint, delta: toUi(t.raw, t.decimals), decimals: t.decimals })),
  };
  if (lamports.rent !== 0n) out.rentSol = toUi(lamports.rent, LAMPORTS_DECIMALS);
  return out;
}

/**
 * Classify what a transaction did for `wallet`. Returns null when the wallet's
 * balances did not change (not involved) — failed transactions are returned
 * with success=false and kind 'other'.
 *
 * Also null when the transaction has no blockTime: WalletActivity.timestamp is
 * required and a slot cannot be turned into a time without another lookup.
 * Heuristic limits: a one-token receipt paired with an unrelated SOL payment
 * above dust (e.g. a claim fee) reads as a buy; dust leftovers of intermediate
 * route tokens make a trade read as 'swap'/'other'.
 */
export function classifyWalletActivity(
  tx: RpcParsedTransaction,
  wallet: string,
  opts: { source: ProviderId; symbols?: Record<string, string> } = { source: 'solana-rpc' },
): WalletActivity | null {
  const view = readTx(tx, opts.source);
  const timestamp = blockTimeMs(tx);
  if (timestamp === undefined) return null;
  const isFeePayer = view.feePayer === wallet;
  const feeSol = isFeePayer ? toUi(view.fee, LAMPORTS_DECIMALS) : 0;
  const program = detectProgram(tx);
  const base = { signature: view.signature, timestamp, wallet, source: opts.source };

  if (view.failed) {
    if (!view.signers.has(wallet)) return null;
    const failed: WalletActivity = { ...base, kind: 'other', legs: [], feeSol, success: false };
    if (program) failed.program = program;
    return failed;
  }

  const deltas = ownerDeltas(view);
  const lamports = walletLamports(view, wallet, deltas);
  const tokens = tokenLegsOf(deltas, wallet);
  if (tokens.length === 0 && lamports.sol === 0n && !isFeePayer) return null;

  const legs: ActivityLeg[] = tokens.map((t) => {
    const leg: ActivityLeg = { mint: t.mint, delta: toUi(t.raw, t.decimals) };
    const symbol = symbolFor(opts.symbols, t.mint);
    if (symbol) leg.symbol = symbol;
    return leg;
  });
  if (lamports.sol !== 0n) legs.push({ mint: WSOL, symbol: symbolFor(opts.symbols, WSOL) ?? 'SOL', delta: toUi(lamports.sol, LAMPORTS_DECIMALS) });

  const activity: WalletActivity = { ...base, kind: 'other', legs, feeSol, success: true };
  if (program) activity.program = program;
  const setToken = (t: { mint: string } & MintDelta) => {
    activity.tokenMint = t.mint;
    activity.tokenAmount = toUi(abs(t.raw), t.decimals);
    const symbol = symbolFor(opts.symbols, t.mint);
    if (symbol) activity.tokenSymbol = symbol;
  };
  const solMaterial = abs(lamports.sol) >= DUST_LAMPORTS;

  let kind: ActivityKind = 'other';
  const single = tokens.length === 1 ? tokens[0] : undefined;
  if (single) {
    setToken(single);
    if (solMaterial && (single.raw > 0n) !== (lamports.sol > 0n)) {
      kind = single.raw > 0n ? 'buy' : 'sell';
      activity.solAmount = toUi(abs(lamports.sol), LAMPORTS_DECIMALS);
      if (STABLE_MINTS.has(single.mint)) activity.usdValue = activity.tokenAmount;
    } else {
      kind = single.raw > 0n ? 'transfer_in' : 'transfer_out';
      const counterparty = tokenCounterparty(deltas, wallet, single.mint, single.raw);
      if (counterparty) activity.counterparty = counterparty;
    }
  } else if (tokens.length >= 2) {
    const received = tokens.filter((t) => t.raw > 0n);
    const sent = tokens.filter((t) => t.raw < 0n);
    if (received.length > 0 && sent.length > 0) {
      kind = 'swap';
      const nonStable = tokens.filter((t) => !STABLE_MINTS.has(t.mint));
      const main = nonStable.length === 1 ? nonStable[0] : (nonStable.find((t) => t.raw > 0n) ?? nonStable[0] ?? received[0]);
      if (main) {
        setToken(main);
        const stableCounter = tokens.filter((t) => STABLE_MINTS.has(t.mint) && (t.raw > 0n) !== (main.raw > 0n));
        const stable = stableCounter.length === 1 ? stableCounter[0] : undefined;
        if (STABLE_MINTS.has(main.mint)) activity.usdValue = activity.tokenAmount;
        else if (stable) activity.usdValue = toUi(abs(stable.raw), stable.decimals);
      }
    }
  } else if (lamports.sol !== 0n) {
    kind = lamports.sol > 0n ? 'sol_in' : 'sol_out';
    activity.solAmount = toUi(abs(lamports.sol), LAMPORTS_DECIMALS);
    const counterparty = solCounterparty(view, wallet, lamports.sol);
    if (counterparty) activity.counterparty = counterparty;
  }
  activity.kind = kind;
  return activity;
}

/** The other owner whose balance of `mint` moved by exactly the opposite amount (else the only opposite mover). */
function tokenCounterparty(deltas: OwnerDeltas, wallet: string, mint: string, raw: bigint): string | undefined {
  const exact: string[] = [];
  const opposite: string[] = [];
  for (const [owner, byMint] of deltas) {
    if (owner === wallet) continue;
    const d = byMint.get(mint)?.raw ?? 0n;
    if (d === -raw) exact.push(owner);
    if (d !== 0n && (d > 0n) !== (raw > 0n)) opposite.push(owner);
  }
  if (exact.length === 1) return exact[0];
  // Token-2022 transfer fees make sent ≠ received; a unique opposite mover is still the counterparty.
  return exact.length === 0 && opposite.length === 1 ? opposite[0] : undefined;
}

/** The account whose SOL moved by exactly the opposite amount (token accounts resolve to their owner). */
function solCounterparty(view: TxView, wallet: string, sol: bigint): string | undefined {
  const matches = new Set<string>();
  view.keys.forEach((key, i) => {
    if (key === wallet) return;
    let delta = (view.post[i] as bigint) - (view.pre[i] as bigint);
    if (i === 0) delta += view.fee;
    if (delta !== -sol) return;
    const owner = view.postTokens.get(i)?.owner ?? view.preTokens.get(i)?.owner;
    if (owner !== wallet) matches.add(owner ?? key);
  });
  return matches.size === 1 ? [...matches][0] : undefined;
}

/**
 * Derive the trade of `mint` in this transaction (null if none / failed tx).
 *
 * Trader: the pump.fun TradeEvent `user` when present and consistent with the
 * balances; else the signer whose balance of `mint` changed; else (no signer
 * moved it) the non-PDA owner with the largest |delta|. Owners equal to
 * `opts.pool` are never the trader. Side always comes from the trader's
 * balance delta. Quote: the trader's SOL delta (native + WSOL, fee/rent
 * excluded) when it has the opposite sign, else a USDC/USDT (or unique other)
 * token leg of opposite sign. Null when there is no counter-leg (a transfer is
 * not a trade), unless a SOL-quoted pump.fun TradeEvent proves the trade.
 * Timestamp: blockTime, else the TradeEvent timestamp; null without either.
 */
export function deriveTradeForMint(tx: RpcParsedTransaction, mint: string, opts: { pool?: string } = {}): DerivedTrade | null {
  const view = readTx(tx, 'solana-rpc');
  if (view.failed || mint === WSOL) return null;
  const deltas = ownerDeltas(view);

  const candidates: Array<{ owner: string } & MintDelta> = [];
  for (const [owner, byMint] of deltas) {
    const d = byMint.get(mint);
    if (d && d.raw !== 0n && owner !== opts.pool) candidates.push({ owner, ...d });
  }
  if (candidates.length === 0) return null;

  const event = consistentTradeEvent(decodePumpTradeEvents(tx).filter((e) => e.mint === mint));
  const fromEvent = event ? candidates.find((c) => c.owner === event.user && (c.raw > 0n) === event.isBuy) : undefined;
  const trader = fromEvent ?? pickTrader(candidates, view.signers);
  if (!trader) return null;

  const timestamp = blockTimeMs(tx) ?? (event?.timestamp ? event.timestamp * 1000 : undefined);
  if (timestamp === undefined) return null;

  const side = trader.raw > 0n ? 'buy' : 'sell';
  const tokenAmount = toUi(abs(trader.raw), trader.decimals);
  const trade: DerivedTrade = { signature: view.signature, timestamp, side, wallet: trader.owner, tokenAmount };
  const program = detectProgram(tx);
  if (program) trade.program = program;
  const venueSol = fromEvent && event ? toUi(event.solAmount, LAMPORTS_DECIMALS) : undefined;
  if (venueSol !== undefined) trade.venueSolAmount = venueSol;

  const lamports = walletLamports(view, trader.owner, deltas);
  if (abs(lamports.sol) >= DUST_LAMPORTS && (lamports.sol > 0n) !== (trader.raw > 0n)) {
    trade.solAmount = toUi(abs(lamports.sol), LAMPORTS_DECIMALS);
    trade.priceQuote = trade.solAmount / tokenAmount;
    return trade;
  }

  const counter = tokenLegsOf(deltas, trader.owner).filter((t) => t.mint !== mint && (t.raw > 0n) !== (trader.raw > 0n));
  const stables = counter.filter((t) => STABLE_MINTS.has(t.mint));
  const quote = stables.length === 1 ? stables[0] : stables.length === 0 && counter.length === 1 ? counter[0] : undefined;
  if (quote) {
    trade.quoteMint = quote.mint;
    trade.quoteAmount = toUi(abs(quote.raw), quote.decimals);
    trade.priceQuote = trade.quoteAmount / tokenAmount;
    return trade;
  }

  if (venueSol !== undefined && venueSol > 0) {
    // The curve event proves the trade even though the trader's own SOL leg is not visible (e.g. paid by a router).
    trade.priceQuote = venueSol / tokenAmount;
    return trade;
  }
  return null;
}

function pickTrader<T extends { owner: string; raw: bigint }>(candidates: T[], signers: ReadonlySet<string>): T | undefined {
  const largest = (list: T[]) => list.reduce<T | undefined>((best, c) => (!best || abs(c.raw) > abs(best.raw) ? c : best), undefined);
  const signed = candidates.filter((c) => signers.has(c.owner));
  if (signed.length > 0) return largest(signed);
  // Bonding curves and pool authorities are PDAs (off-curve); prefer a real wallet.
  const wallets = candidates.filter((c) => !isOffCurve(c.owner));
  return largest(wallets.length > 0 ? wallets : candidates);
}

interface ConsistentEvent {
  user: string;
  isBuy: boolean;
  solAmount: bigint;
  timestamp?: number;
}

/** One trader, one direction, SOL-quoted — otherwise the event is not used. */
function consistentTradeEvent(events: PumpTradeEvent[]): ConsistentEvent | undefined {
  const first = events[0];
  if (!first) return undefined;
  let solAmount = 0n;
  for (const e of events) {
    if (e.user !== first.user || e.isBuy !== first.isBuy) return undefined;
    if (e.quoteMint !== undefined && e.quoteMint !== SYSTEM_PROGRAM && e.quoteMint !== WSOL) return undefined;
    solAmount += e.solAmount;
  }
  const out: ConsistentEvent = { user: first.user, isBuy: first.isBuy, solAmount };
  if (first.timestamp !== undefined) out.timestamp = first.timestamp;
  return out;
}

/** Best-effort venue label from program ids invoked in the transaction. */
export function detectProgram(tx: RpcParsedTransaction): string | undefined {
  let keys: unknown[] = [];
  if (isRecord(tx) && isRecord(tx.transaction) && isRecord(tx.transaction.message) && Array.isArray(tx.transaction.message.accountKeys)) {
    keys = tx.transaction.message.accountKeys;
  }
  let venue: string | undefined;
  for (const ix of orderedInstructions(tx)) {
    let programId: string | undefined = typeof ix.programId === 'string' ? ix.programId : undefined;
    if (!programId) {
      // Non-parsed encodings reference the program by index.
      const index = num((ix as { programIdIndex?: unknown }).programIdIndex);
      programId = index !== undefined ? keyOf(keys[index]) : undefined;
    }
    if (!programId) continue;
    const aggregator = AGGREGATORS.get(programId);
    if (aggregator) return aggregator;
    venue ??= VENUES.get(programId);
  }
  return venue;
}

// ---------------------------------------------------------------------------
// pump.fun TradeEvent decoding
// ---------------------------------------------------------------------------

const INVOKE_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[\d+\]$/;
const EXIT_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed)/;

/**
 * Decode pump.fun TradeEvents from `Program data:` logs emitted while the
 * pump program is executing (other programs' identical-looking logs are
 * ignored). Stops at 'Log truncated'. Returns [] when logs are missing.
 * Layout per pump's IDL (verified on live fixtures); trailing fields added
 * over time (quote_mint, quote_amount…) are read only when present.
 */
export function decodePumpTradeEvents(tx: RpcParsedTransaction): PumpTradeEvent[] {
  const logs = isRecord(tx) && isRecord(tx.meta) && Array.isArray(tx.meta.logMessages) ? tx.meta.logMessages : [];
  const stack: string[] = [];
  const out: PumpTradeEvent[] = [];
  for (const line of logs) {
    if (typeof line !== 'string') continue;
    if (line.startsWith('Log truncated')) break;
    const invoke = INVOKE_RE.exec(line);
    if (invoke) {
      stack.push(invoke[1] as string);
      continue;
    }
    if (EXIT_RE.test(line)) {
      stack.pop();
      continue;
    }
    if (line.startsWith('Program data: ') && stack[stack.length - 1] === PROGRAMS.PUMP) {
      const event = decodeTradeEventData(line.slice('Program data: '.length).split(' ')[0] ?? '');
      if (event) out.push(event);
    }
  }
  return out;
}

function decodeTradeEventData(base64: string): PumpTradeEvent | undefined {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(getBase64Encoder().encode(base64));
  } catch {
    return undefined;
  }
  // discriminator 8 + mint 32 + sol_amount 8 + token_amount 8 + is_buy 1 + user 32 + timestamp 8
  if (bytes.length < 97 || TRADE_EVENT_DISCRIMINATOR.some((b, i) => bytes[i] !== b)) return undefined;
  const isBuyByte = bytes[56];
  if (isBuyByte !== 0 && isBuyByte !== 1) return undefined;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const addresses = getAddressDecoder();
  const event: PumpTradeEvent = {
    mint: addresses.decode(bytes.subarray(8, 40)),
    solAmount: data.getBigUint64(40, true),
    tokenAmount: data.getBigUint64(48, true),
    isBuy: isBuyByte === 1,
    user: addresses.decode(bytes.subarray(57, 89)),
  };
  const timestamp = Number(data.getBigInt64(89, true));
  if (timestamp > 0) event.timestamp = timestamp;

  // reserves 4×8, fee_recipient 32, fee_bps 8, fee 8, creator 32, creator_fee_bps 8, creator_fee 8,
  // track_volume 1, total_unclaimed 8, total_claimed 8, current_sol_volume 8, last_update_timestamp 8
  let o = 97 + 32 + 32 + 16 + 32 + 16 + 1 + 32;
  if (bytes.length < o + 4) return event;
  const nameLength = data.getUint32(o, true);
  o += 4;
  if (bytes.length < o + nameLength) return event;
  event.ixName = new TextDecoder().decode(bytes.subarray(o, o + nameLength));
  o += nameLength;
  // mayhem_mode 1, cashback_fee_bps 8, cashback 8, buyback_fee_bps 8, buyback_fee 8, shareholders vec<{pubkey,u16}>
  o += 1 + 32;
  if (bytes.length < o + 4) return event;
  o += 4 + data.getUint32(o, true) * 34;
  if (bytes.length < o + 40) return event;
  event.quoteMint = addresses.decode(bytes.subarray(o, o + 32));
  event.quoteAmount = data.getBigUint64(o + 32, true);
  return event;
}
