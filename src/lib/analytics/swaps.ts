import { getAddressDecoder, getBase58Encoder, getBase64Encoder, isAddress, isOffCurveAddress } from '@solana/kit';
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
 *
 * Wallet view (walletBalanceChanges / classifyWalletActivity, used by PnL):
 * rent of NON-token accounts (e.g. pump's per-user volume accumulator,
 * ~0.00135 SOL; a new coin's mint and bonding curve on a create + dev buy)
 * stays in the SOL delta both when it is deposited and when a later close
 * refunds it — a close cannot be attributed from balances alone, so excluding
 * only the deposit would bias PnL. Trade view (deriveTradeForMint, the trade
 * feed): rent the trader locked into accounts created in the tx is not trade
 * value and is excluded from the quote (see `createdAccountRent`).
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
  /**
   * SOL exchanged by the trader (native + WSOL) when the quote is SOL. Excludes
   * the network fee, rent of the trader's own token accounts opened/closed in
   * the tx and rent it locked into any other account created in the tx (a new
   * coin's mint / bonding curve / curve vault on a create + dev buy, pump's
   * volume accumulators, someone else's ATA).
   */
  solAmount?: number;
  /** Quote mint when not SOL (e.g. USDC). */
  quoteMint?: string;
  quoteAmount?: number;
  /**
   * Execution price per token in quote units (quote / tokenAmount). When the
   * trader's own quote leg is unknown it falls back to the pump.fun curve
   * price (TradeEvent `sol_amount / token_amount`), then to the pool side.
   */
  priceQuote?: number;
  /**
   * Which balance change produced `solAmount` / `quoteAmount` / `priceQuote`:
   * `trader` — the trader's own leg (includes router/bot fees and tips it paid);
   * `event` — no trader leg was visible, the pump.fun TradeEvent priced it;
   * `pool` — no trader leg was visible (a bot or relayer paid on its behalf, or
   * the paying PDA differs from the token-holding PDA), the quote is what the
   * pool / curve itself moved, i.e. the venue price before third-party fees.
   * Absent when no quote could be attributed.
   */
  quoteSide?: 'trader' | 'event' | 'pool';
  /** Venue label, e.g. 'pump.fun', 'PumpSwap', 'Raydium', 'Jupiter' (an aggregator wins over the AMM it routed through). */
  program?: string;
  /** The AMM / bonding-curve program that executed the swap (never an aggregator), e.g. 'PumpSwap' under 'DFlow'. */
  venue?: string;
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
  /** Post-trade curve reserves (quote lamports / raw tokens). */
  virtualSolReserves?: bigint;
  virtualTokenReserves?: bigint;
  realSolReserves?: bigint;
  realTokenReserves?: bigint;
  /** pump protocol fee and creator fee, in quote lamports (on top of `solAmount` for buys, deducted from it for sells). */
  fee?: bigint;
  creatorFee?: bigint;
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
/** Anchor `emit_cpi!` instruction tag (EVENT_IX_TAG_LE, e445a52e51cb9a1d): the self-CPI carrying an event. */
const EVENT_IX_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d] as const;
/** pump.fun `__event_authority` PDA: the only account of its event self-CPI (it must sign, so only pump can emit). */
const PUMP_EVENT_AUTHORITY = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';

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
  // Digit strings are parsed exactly (JSON numbers above 2^53 are already lossy; nothing to recover there).
  // Anything else (booleans, '1e3', negatives, fractions) is malformed, never coerced.
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? BigInt(value) : undefined;
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
  // String-only keys (non-parsed encodings) carry no signer flags: the first
  // header.numRequiredSignatures static keys sign.
  const header: unknown = (tx.transaction.message as { header?: unknown }).header;
  const requiredSignatures = isRecord(header) ? num(header.numRequiredSignatures) : undefined;
  rawKeys.forEach((k: unknown, i: number) => {
    const pubkey = keyOf(k);
    if (!pubkey) throw malformed(provider, 'account key without pubkey');
    keys.push(pubkey);
    if (isRecord(k) ? k.signer === true : requiredSignatures !== undefined && i < requiredSignatures) signers.add(pubkey);
  });
  const feePayer = keys[0] as string;
  // The fee payer always signs.
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

interface AccountLifecycle {
  /** Who paid for each account created in the tx (system create* or ATA create). */
  funders: Map<string, string>;
  /** Lamports each system create* instruction put into the new account, by account and funder. */
  created: Map<string, { funder: string; lamports: bigint }>;
  /** System transfers, in execution order. */
  transfers: Array<{ source: string; destination: string; lamports: bigint }>;
  /** Where each closed token account's lamports went. */
  closedTo: Map<string, string>;
}

function accountLifecycle(view: TxView): AccountLifecycle {
  const funders = new Map<string, string>();
  const created = new Map<string, { funder: string; lamports: bigint }>();
  const transfers: AccountLifecycle['transfers'] = [];
  const closedTo = new Map<string, string>();
  for (const ix of view.instructions) {
    const p = parsedInfo(ix);
    if (!p) continue;
    const { type, info } = p;
    if (ix.programId === SYSTEM_PROGRAM && (type === 'createAccount' || type === 'createAccountWithSeed')) {
      if (typeof info.newAccount !== 'string' || typeof info.source !== 'string') continue;
      if (!funders.has(info.newAccount)) funders.set(info.newAccount, info.source);
      const lamports = lamportsOf(info.lamports);
      if (lamports !== undefined && !created.has(info.newAccount)) created.set(info.newAccount, { funder: info.source, lamports });
    } else if (ix.programId === SYSTEM_PROGRAM && (type === 'transfer' || type === 'transferWithSeed')) {
      const lamports = lamportsOf(info.lamports);
      if (typeof info.source === 'string' && typeof info.destination === 'string' && lamports !== undefined) {
        transfers.push({ source: info.source, destination: info.destination, lamports });
      }
    } else if (ix.programId === ATA_PROGRAM && (type === 'create' || type === 'createIdempotent')) {
      if (typeof info.account === 'string' && typeof info.source === 'string' && !funders.has(info.account)) funders.set(info.account, info.source);
    } else if (TOKEN_PROGRAMS.has(ix.programId) && type === 'closeAccount') {
      if (typeof info.account === 'string' && typeof info.destination === 'string') closedTo.set(info.account, info.destination);
    }
  }
  return { funders, created, transfers, closedTo };
}

/**
 * Lamports `payer` locked into accounts it created in this tx, other than its
 * own new token accounts (whose rent walletLamports already excludes): a new
 * coin's mint (plus its Token-2022 metadata top-up), bonding curve and curve
 * vault on a create + dev buy, pump's volume accumulators, someone else's ATA.
 * None of it is paid to the venue, so none of it is trade value.
 * - Only what is still in the account at the end counts (temporary accounts
 *   closed in the tx cost nothing), and WSOL held by a new token account is
 *   not rent.
 * - At most the lamports of the create instruction itself, so SOL paid later
 *   into a new account (a bonding curve receiving the dev buy) is never
 *   mistaken for rent — except for a mint account, which holds nothing but
 *   rent: transfers `payer` made into it (the metadata realloc top-up) count.
 */
function createdAccountRent(view: TxView, payer: string, lifecycle = accountLifecycle(view)): bigint {
  let mints: Set<string> | undefined;
  let rent = 0n;
  for (const [account, { funder, lamports }] of lifecycle.created) {
    if (funder !== payer) continue;
    const index = view.keys.indexOf(account);
    if (index < 0 || view.pre[index] !== 0n) continue;
    const before = view.preTokens.get(index);
    const after = view.postTokens.get(index);
    if (!before && after?.owner === payer) continue;
    let held = (view.post[index] as bigint) - (after?.mint === WSOL ? after.raw : 0n);
    if (held <= 0n) continue;
    let paid = lamports;
    mints ??= new Set([...view.preTokens.values(), ...view.postTokens.values()].map((t) => t.mint));
    if (mints.has(account)) {
      for (const t of lifecycle.transfers) if (t.source === payer && t.destination === account) paid += t.lamports;
    }
    if (held > paid) held = paid;
    rent += held;
  }
  return rent;
}

function walletLamports(view: TxView, wallet: string, deltas: OwnerDeltas, lifecycle = accountLifecycle(view)): WalletLamports {
  const index = view.keys.indexOf(wallet);
  const native = index >= 0 ? (view.post[index] as bigint) - (view.pre[index] as bigint) : 0n;
  const fee = view.feePayer === wallet ? view.fee : 0n;
  const wsol = deltas.get(wallet)?.get(WSOL)?.raw ?? 0n;

  let rent = 0n;
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

/**
 * Raw integer → decimal-adjusted number, correctly rounded: the exact decimal
 * string is handed to the JS number parser. (Adding the integer and fraction
 * parts as doubles is off by one ulp for ~1 in 9,000 amounts, e.g. 1,412,654,698
 * lamports → 1.4126546979999999.)
 */
function toUi(raw: bigint, decimals: number): number {
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString();
  let value: number;
  if (decimals === 0) value = Number(digits);
  else {
    const padded = digits.padStart(decimals + 1, '0');
    value = Number(`${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`);
  }
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
 * balance delta (never from instruction names). One trade per transaction:
 * in a bundle (several users trading the mint) it is the largest signer's,
 * still carrying its own TradeEvent leg.
 *
 * Quote: the trader's own leg moving against `mint` — its SOL delta (native +
 * WSOL; network fee, own-ATA rent and rent locked into accounts created in the
 * tx excluded; ≥ 0.000001 SOL) or a token leg (a unique USDC/USDT
 * leg, else a unique leg). When both a SOL and a token leg qualify (e.g. a
 * USDC-quoted buy that also paid a SOL tip) the one the other side of the
 * trade (the pool / curve) moved by a comparable amount wins; if that cannot
 * decide, or the trader also moved other tokens in the same direction as
 * `mint` (two buys in one tx), the quote is ambiguous and left undefined
 * rather than guessed — the trade is still returned.
 *
 * When the trader has no counter-leg at all, the trade is still real if the
 * other side proves it: a SOL-quoted pump.fun TradeEvent (then only
 * `venueSolAmount` / `priceQuote` carry its value), else the pool side (see
 * `poolSideQuote`: the counterpart moved exactly one quote asset the way a
 * trade moves it — a bot or relayer paid for the receiver). Otherwise null —
 * a transfer is not a trade.
 * Timestamp: blockTime, else the TradeEvent timestamp; null without either.
 * The TradeEvent identifies the trader and dates the trade whatever the
 * curve's quote asset; only a SOL-quoted curve's event yields `venueSolAmount`.
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

  const events = decodePumpTradeEvents(tx).filter((e) => e.mint === mint);
  const consistent = consistentTradeEvent(events);
  const fromEvent = consistent ? candidates.find((c) => c.owner === consistent.user && (c.raw > 0n) === consistent.isBuy) : undefined;
  const trader = fromEvent ?? pickTrader(candidates, view.signers);
  if (!trader) return null;
  // Several users traded the mint (a bundle): the chosen trader's own events still describe its curve leg.
  const own = fromEvent ? consistent : consistentTradeEvent(events.filter((e) => e.user === trader.owner));
  const event = own && own.user === trader.owner && own.isBuy === (trader.raw > 0n) ? own : undefined;

  // All events of a tx carry the same on-chain clock.
  const eventSeconds = events.find((e) => e.timestamp !== undefined)?.timestamp;
  const timestamp = blockTimeMs(tx) ?? (eventSeconds !== undefined ? eventSeconds * 1000 : undefined);
  if (timestamp === undefined) return null;

  const side = trader.raw > 0n ? 'buy' : 'sell';
  const tokenAmount = toUi(abs(trader.raw), trader.decimals);
  const trade: DerivedTrade = { signature: view.signature, timestamp, side, wallet: trader.owner, tokenAmount };
  const programs = programLabels(tx);
  const program = programs.aggregator ?? programs.venue;
  if (program) trade.program = program;
  if (programs.venue) trade.venue = programs.venue;
  const venueSol = event?.solAmount !== undefined ? toUi(event.solAmount, LAMPORTS_DECIMALS) : undefined;
  if (venueSol !== undefined) trade.venueSolAmount = venueSol;
  const lifecycle = accountLifecycle(view);

  const applyQuote = (quote: QuoteLeg, side: 'trader' | 'pool') => {
    const amount = toUi(abs(quote.raw), quote.decimals);
    if (quote.mint === WSOL) trade.solAmount = amount;
    else {
      trade.quoteMint = quote.mint;
      trade.quoteAmount = amount;
    }
    trade.priceQuote = amount / tokenAmount;
    trade.quoteSide = side;
    return trade;
  };
  const quote = resolveQuote(view, deltas, trader, mint, lifecycle);
  if (quote === 'ambiguous') return trade;
  if (quote) return applyQuote(quote, 'trader');
  if (venueSol !== undefined && venueSol > 0 && event !== undefined && event.tokenAmount > 0n) {
    // The curve event proves the trade even when the trader's own SOL leg is not visible (e.g. paid by a router).
    // Price = the curve's own SOL / tokens (the trader's net token delta may include unrelated moves).
    trade.priceQuote = venueSol / toUi(event.tokenAmount, trader.decimals);
    trade.quoteSide = 'event';
    return trade;
  }
  const poolSide = poolSideQuote(view, deltas, trader, mint, opts.pool);
  return poolSide ? applyQuote(poolSide, 'pool') : null;
}

/** A quote leg of the trader: `mint` is WSOL for its SOL (native + WSOL) leg. */
interface QuoteLeg {
  mint: string;
  raw: bigint;
  decimals: number;
}

function resolveQuote(
  view: TxView,
  deltas: OwnerDeltas,
  trader: { owner: string } & MintDelta,
  mint: string,
  lifecycle: AccountLifecycle,
): QuoteLeg | 'ambiguous' | undefined {
  const traderUp = trader.raw > 0n;
  const others = tokenLegsOf(deltas, trader.owner).filter((t) => t.mint !== mint);
  const counter = others.filter((t) => (t.raw > 0n) !== traderUp);
  // Trade value: rent the trader locked into accounts created in the tx is added back (not paid to the venue).
  const sol = walletLamports(view, trader.owner, deltas, lifecycle).sol + createdAccountRent(view, trader.owner, lifecycle);
  const solLeg: QuoteLeg | undefined = abs(sol) >= DUST_LAMPORTS && (sol > 0n) !== traderUp ? { mint: WSOL, raw: sol, decimals: LAMPORTS_DECIMALS } : undefined;
  const legs: QuoteLeg[] = solLeg ? [solLeg, ...counter] : counter;
  if (legs.length === 0) return undefined;
  // Another token moved the same way as `mint`: the quote paid / received cannot be attributed to `mint` alone.
  if (others.some((t) => (t.raw > 0n) === traderUp)) return 'ambiguous';
  if (legs.length === 1) return legs[0];

  const matched = legs.filter((leg) => otherSideMoved(view, deltas, trader, mint, leg));
  if (matched.length === 1) return matched[0];
  if (!solLeg) {
    const stables = counter.filter((t) => STABLE_MINTS.has(t.mint));
    if (stables.length === 1) return stables[0];
  }
  return 'ambiguous';
}

/**
 * True when an owner on the other side of the trade (its `mint` delta opposes
 * the trader's: the pool vault owner, the bonding curve) moved `leg`'s asset
 * against the trader's leg by a comparable amount (the trader's leg is at
 * least half of it, which tolerates router/bot fees but rejects a SOL tip or a
 * dust leftover next to the real quote).
 */
function otherSideMoved(view: TxView, deltas: OwnerDeltas, trader: { owner: string; raw: bigint }, mint: string, leg: QuoteLeg): boolean {
  for (const [owner, byMint] of deltas) {
    if (owner === trader.owner) continue;
    const d = byMint.get(mint)?.raw ?? 0n;
    if (d === 0n || (d > 0n) === (trader.raw > 0n)) continue;
    const moved = leg.mint === WSOL ? ownerSol(view, deltas, owner) : (byMint.get(leg.mint)?.raw ?? 0n);
    if (moved !== 0n && (moved > 0n) !== (leg.raw > 0n) && abs(leg.raw) * 2n >= abs(moved)) return true;
  }
  return false;
}

/**
 * Quote read from the other side of the trade when the trader shows no quote
 * leg of its own (a bot or relayer paid for the receiver; a sniper program
 * holds tokens in one PDA and pays from another). The counterpart is `pool`
 * when given and it holds token accounts in the tx (it must have moved `mint`
 * against the trader), else the unique off-curve owner that did — e.g. the
 * vault authority of an AMM whose pool id is not its vault owner (Raydium AMM
 * v4 / CPMM); an on-curve wallet on the other side is a plain
 * transfer, never a pool. It qualifies only when it moved exactly one quote
 * asset — SOL (native + WSOL, above dust) or one other token — the way a pool
 * does (it receives quote on a buy, pays it on a sell) and no other token
 * moved with `mint` on either side (two tokens for one payment cannot be
 * priced). The result is the venue price before third-party fees.
 */
function poolSideQuote(view: TxView, deltas: OwnerDeltas, trader: { owner: string } & MintDelta, mint: string, pool: string | undefined): QuoteLeg | undefined {
  const traderUp = trader.raw > 0n;
  if (tokenLegsOf(deltas, trader.owner).some((t) => t.mint !== mint && (t.raw > 0n) === traderUp)) return undefined;
  const opposing: string[] = [];
  for (const [owner, byMint] of deltas) {
    const d = byMint.get(mint)?.raw ?? 0n;
    if (owner !== trader.owner && d !== 0n && (d > 0n) !== traderUp) opposing.push(owner);
  }
  let other: string | undefined;
  if (pool !== undefined && deltas.has(pool)) other = opposing.find((o) => o === pool);
  else if (opposing.length === 1 && isOffCurve(opposing[0] as string)) other = opposing[0];
  if (other === undefined) return undefined;

  const legs: QuoteLeg[] = [];
  const sol = ownerSol(view, deltas, other);
  if (abs(sol) >= DUST_LAMPORTS && (sol > 0n) === traderUp) legs.push({ mint: WSOL, raw: sol, decimals: LAMPORTS_DECIMALS });
  for (const t of tokenLegsOf(deltas, other)) {
    if (t.mint === mint) continue;
    // Another token left the pool together with `mint` (or entered it with `mint` on a sell).
    if ((t.raw > 0n) !== traderUp) return undefined;
    legs.push(t);
  }
  return legs.length === 1 ? legs[0] : undefined;
}

/** Raw SOL movement of any owner: its own lamports (fee added back when it paid it) + its WSOL token accounts. */
function ownerSol(view: TxView, deltas: OwnerDeltas, owner: string): bigint {
  const index = view.keys.indexOf(owner);
  let native = index >= 0 ? (view.post[index] as bigint) - (view.pre[index] as bigint) : 0n;
  if (index === 0) native += view.fee;
  return native + (deltas.get(owner)?.get(WSOL)?.raw ?? 0n);
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
  /** Summed raw token amount moved against the curve. */
  tokenAmount: bigint;
  /** Summed curve lamports; absent when any event is quoted in another asset (e.g. a PUMP-paired curve). */
  solAmount?: bigint;
  timestamp?: number;
}

/** One trader, one direction — otherwise the event is not used. Summed over the trader's events of the mint. */
function consistentTradeEvent(events: PumpTradeEvent[]): ConsistentEvent | undefined {
  const first = events[0];
  if (!first) return undefined;
  let solAmount: bigint | undefined = 0n;
  let tokenAmount = 0n;
  for (const e of events) {
    if (e.user !== first.user || e.isBuy !== first.isBuy) return undefined;
    tokenAmount += e.tokenAmount;
    const solQuoted = e.quoteMint === undefined || e.quoteMint === SYSTEM_PROGRAM || e.quoteMint === WSOL;
    solAmount = solQuoted && solAmount !== undefined ? solAmount + e.solAmount : undefined;
  }
  const out: ConsistentEvent = { user: first.user, isBuy: first.isBuy, tokenAmount };
  if (solAmount !== undefined) out.solAmount = solAmount;
  if (first.timestamp !== undefined) out.timestamp = first.timestamp;
  return out;
}

/** Aggregator (first one invoked) and AMM / curve venue (first one invoked) of the transaction. */
function programLabels(tx: RpcParsedTransaction): { aggregator?: string; venue?: string } {
  let keys: unknown[] = [];
  if (isRecord(tx) && isRecord(tx.transaction) && isRecord(tx.transaction.message) && Array.isArray(tx.transaction.message.accountKeys)) {
    keys = tx.transaction.message.accountKeys;
  }
  const out: { aggregator?: string; venue?: string } = {};
  for (const ix of orderedInstructions(tx)) {
    let programId: string | undefined = typeof ix.programId === 'string' ? ix.programId : undefined;
    if (!programId) {
      // Non-parsed encodings reference the program by index.
      const index = num((ix as { programIdIndex?: unknown }).programIdIndex);
      programId = index !== undefined ? keyOf(keys[index]) : undefined;
    }
    if (!programId) continue;
    out.aggregator ??= AGGREGATORS.get(programId);
    out.venue ??= VENUES.get(programId);
    if (out.aggregator && out.venue) break;
  }
  return out;
}

/** Best-effort venue label from program ids invoked in the transaction (an aggregator wins over the AMM it routed through). */
export function detectProgram(tx: RpcParsedTransaction): string | undefined {
  const { aggregator, venue } = programLabels(tx);
  return aggregator ?? venue;
}

// ---------------------------------------------------------------------------
// pump.fun TradeEvent decoding
// ---------------------------------------------------------------------------

const INVOKE_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[\d+\]$/;
const EXIT_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed)/;

/**
 * Decode the pump.fun TradeEvents of a successful transaction ([] for a
 * failed one: its events were rolled back).
 *
 * Primary source: pump's `emit_cpi!` self-invocations in innerInstructions
 * (EVENT_IX_TAG ‖ event bytes, signed by pump's event authority). Inner
 * instructions are never truncated, unlike logs. Fallback (older program
 * versions, or a transaction without innerInstructions): `Program data:` logs
 * emitted while pump is the executing program (other programs' look-alike
 * logs are ignored), up to 'Log truncated'.
 * Layout per pump's IDL (verified on live fixtures); trailing fields added
 * over time (quote_mint, quote_amount…) are read only when present.
 */
export function decodePumpTradeEvents(tx: RpcParsedTransaction): PumpTradeEvent[] {
  if (!isRecord(tx) || !isRecord(tx.meta)) return [];
  if (tx.meta.err !== null && tx.meta.err !== undefined) return [];
  const fromCpi = tradeEventsFromSelfCpi(tx.meta.innerInstructions);
  return fromCpi.length > 0 ? fromCpi : tradeEventsFromLogs(tx.meta.logMessages);
}

function tradeEventsFromSelfCpi(groups: unknown): PumpTradeEvent[] {
  if (!Array.isArray(groups)) return [];
  const ordered = groups
    .filter((g): g is { index: unknown; instructions: unknown[] } => isRecord(g) && Array.isArray(g.instructions))
    .map((g) => ({ index: num(g.index) ?? Number.MAX_SAFE_INTEGER, instructions: g.instructions }))
    .sort((a, b) => a.index - b.index);
  const out: PumpTradeEvent[] = [];
  for (const group of ordered) {
    for (const ix of group.instructions) {
      if (!isRecord(ix) || ix.programId !== PROGRAMS.PUMP || typeof ix.data !== 'string') continue;
      if (!Array.isArray(ix.accounts) || ix.accounts.length !== 1 || ix.accounts[0] !== PUMP_EVENT_AUTHORITY) continue;
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(getBase58Encoder().encode(ix.data));
      } catch {
        continue;
      }
      if (bytes.length < EVENT_IX_TAG.length || EVENT_IX_TAG.some((b, i) => bytes[i] !== b)) continue;
      const event = decodeTradeEventBytes(bytes.subarray(EVENT_IX_TAG.length));
      if (event) out.push(event);
    }
  }
  return out;
}

function tradeEventsFromLogs(logs: unknown): PumpTradeEvent[] {
  if (!Array.isArray(logs)) return [];
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
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(getBase64Encoder().encode(line.slice('Program data: '.length).split(' ')[0] ?? ''));
      } catch {
        continue;
      }
      const event = decodeTradeEventBytes(bytes);
      if (event) out.push(event);
    }
  }
  return out;
}

function decodeTradeEventBytes(bytes: Uint8Array): PumpTradeEvent | undefined {
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

  // virtual_sol, virtual_token, real_sol, real_token reserves 4×u64 @97
  if (bytes.length < 129) return event;
  event.virtualSolReserves = data.getBigUint64(97, true);
  event.virtualTokenReserves = data.getBigUint64(105, true);
  event.realSolReserves = data.getBigUint64(113, true);
  event.realTokenReserves = data.getBigUint64(121, true);
  // fee_recipient 32 @129, fee_basis_points u64 @161, fee u64 @169, creator 32 @177, creator_fee_basis_points u64 @209, creator_fee u64 @217
  if (bytes.length < 225) return event;
  event.fee = data.getBigUint64(169, true);
  event.creatorFee = data.getBigUint64(217, true);

  // track_volume 1, total_unclaimed_tokens 8, total_claimed_tokens 8, current_sol_volume 8, last_update_timestamp 8
  let o = 225 + 1 + 32;
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
