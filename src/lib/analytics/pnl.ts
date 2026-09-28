import type { PnlLot, PnlReport, PnlTokenResult, WalletActivity } from '@/lib/core/types';
import { MINTS } from '@/lib/core/solana';

/**
 * Deterministic wallet PnL: FIFO lots per mint, denominated in SOL.
 *
 * Inputs are classified wallet activities (see analytics/swaps). Only
 * successful activities are used:
 * - `buy`  (token in, SOL out): adds a lot whose cost is the SOL spent.
 * - `sell` (token out, SOL in): consumes lots FIFO; proceeds are the SOL received.
 * - `transfer_in`: adds a lot with UNKNOWN cost (no SOL leg).
 * - `transfer_out`: consumes lots FIFO with no proceeds — not a sale.
 * - `swap` (token↔token, no SOL leg): excluded from PnL; its non-SOL legs move
 *   inventory like transfers (in = unknown-cost lot, out = FIFO removal) so
 *   later sells are matched honestly.
 * - `sol_in` / `sol_out` / `other`: ignored.
 *
 * Realized PnL is computed only for sold units matched to lots with a known
 * SOL cost (proceeds pro-rated by amount). Units matched to unknown-cost lots,
 * or sold beyond the known inventory (acquired before the analysed window), are
 * excluded and flag the token `costBasisComplete: false`.
 *
 * Pure: no clock, no I/O; the same input always yields the same report.
 */

export interface PnlInput {
  wallet: string;
  activities: readonly WalletActivity[];
  /** Current price per token in SOL, by mint (omit mints without a reliable price). */
  currentPricesSol?: Record<string, number>;
  solPriceUsd?: number;
  /** True when `activities` cover the wallet's entire history. */
  historyComplete: boolean;
  /** Transactions scanned to produce `activities` (including failed / unparsed ones). */
  transactionsAnalyzed: number;
  /** Symbols by mint; preferred over symbols carried by activities. */
  symbols?: Record<string, string>;
}

/** Relative tolerance for float dust when matching amounts (1e-9 of the quantity involved). */
const REL_EPS = 1e-9;

const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

interface MintState {
  mint: string;
  symbol?: string;
  lots: PnlLot[];
  buys: number;
  sells: number;
  boughtAmount: number;
  soldAmount: number;
  costSol: number;
  proceedsSol: number;
  realizedSol: number;
  /** A sold unit had unknown cost, exceeded known inventory, or a trade lacked its SOL amount. */
  realizedIncomplete: boolean;
  holdSecondsWeighted: number;
  holdUnits: number;
  firstTradeAt?: number;
  lastTradeAt?: number;
  /** Contributing signatures in processing (chronological) order. */
  signatures: string[];
  seen: Set<string>;
}

function newState(mint: string): MintState {
  return {
    mint,
    lots: [],
    buys: 0,
    sells: 0,
    boughtAmount: 0,
    soldAmount: 0,
    costSol: 0,
    proceedsSol: 0,
    realizedSol: 0,
    realizedIncomplete: false,
    holdSecondsWeighted: 0,
    holdUnits: 0,
    signatures: [],
    seen: new Set(),
  };
}

function touch(state: MintState, a: WalletActivity, symbol: string | undefined): void {
  if (!state.seen.has(a.signature)) {
    state.seen.add(a.signature);
    state.signatures.push(a.signature);
  }
  if (!state.symbol && symbol) state.symbol = symbol;
}

function markTrade(state: MintState, timestamp: number): void {
  state.firstTradeAt = state.firstTradeAt === undefined ? timestamp : Math.min(state.firstTradeAt, timestamp);
  state.lastTradeAt = state.lastTradeAt === undefined ? timestamp : Math.max(state.lastTradeAt, timestamp);
}

/** Absolute token amount of the activity's main token (field, else its balance leg). */
function tokenAmountOf(a: WalletActivity): number | undefined {
  if (isFiniteNumber(a.tokenAmount) && a.tokenAmount !== 0) return Math.abs(a.tokenAmount);
  const leg = a.legs?.find((l) => l.mint === a.tokenMint);
  if (leg && isFiniteNumber(leg.delta) && leg.delta !== 0) return Math.abs(leg.delta);
  return undefined;
}

function solAmountOf(a: WalletActivity): number | undefined {
  return isFiniteNumber(a.solAmount) ? Math.abs(a.solAmount) : undefined;
}

interface Consumed {
  /** Units matched to lots with a known cost. */
  knownUnits: number;
  /** Cost of those units (SOL). */
  knownCost: number;
  /** Units matched to lots with unknown cost. */
  unknownUnits: number;
  /** Units beyond the tracked inventory. */
  unmatched: number;
  /** Σ units × seconds held (all matched units). */
  holdSecondsWeighted: number;
  matchedUnits: number;
}

/** Remove `amount` units FIFO from `lots` (mutates). */
function consumeFifo(lots: PnlLot[], amount: number, timestamp: number): Consumed {
  const out: Consumed = { knownUnits: 0, knownCost: 0, unknownUnits: 0, unmatched: 0, holdSecondsWeighted: 0, matchedUnits: 0 };
  let remaining = amount;
  const dust = amount * REL_EPS;
  while (remaining > dust) {
    const lot = lots[0];
    if (!lot) break;
    const before = lot.amount;
    const take = Math.min(before, remaining);
    out.matchedUnits += take;
    out.holdSecondsWeighted += take * Math.max(0, (timestamp - lot.timestamp) / 1000);
    if (lot.costSol !== undefined) {
      const portion = lot.costSol * (take / before);
      out.knownUnits += take;
      out.knownCost += portion;
      lot.costSol = Math.max(0, lot.costSol - portion);
    } else {
      out.unknownUnits += take;
    }
    lot.amount = before - take;
    remaining -= take;
    if (lot.amount <= before * REL_EPS) lots.shift();
  }
  out.unmatched = remaining > dust ? remaining : 0;
  return out;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const roundSol = (n: number): number => Number(n.toFixed(6));

export function computePnl(input: PnlInput): PnlReport {
  const { wallet } = input;

  // 1. Scope to this wallet, drop duplicates, order deterministically.
  let foreign = 0;
  let malformed = 0;
  const bySignature = new Map<string, WalletActivity>();
  for (const a of input.activities) {
    if (a.wallet && a.wallet !== wallet) {
      foreign++;
      continue;
    }
    if (!a.signature || !isFiniteNumber(a.timestamp)) {
      malformed++;
      continue;
    }
    if (!bySignature.has(a.signature)) bySignature.set(a.signature, a);
  }
  const ordered = [...bySignature.values()].sort((x, y) =>
    x.timestamp !== y.timestamp ? x.timestamp - y.timestamp : x.signature < y.signature ? -1 : x.signature > y.signature ? 1 : 0,
  );

  // 2. Replay successful activities through FIFO lots.
  const states = new Map<string, MintState>();
  const stateFor = (mint: string): MintState => {
    let s = states.get(mint);
    if (!s) {
      s = newState(mint);
      states.set(mint, s);
    }
    return s;
  };
  const symbolFor = (mint: string, fallback?: string): string | undefined => input.symbols?.[mint] ?? fallback;

  let failed = 0;
  let swapsExcluded = 0;
  let transfers = 0;
  let missingSol = 0;
  let trades = 0;
  let volumeSol = 0;
  let feesSol = 0;
  let feesKnown = false;

  for (const a of ordered) {
    if (!a.success) {
      failed++;
      continue;
    }

    if (a.kind === 'swap') {
      swapsExcluded++;
      for (const leg of a.legs ?? []) {
        if (!leg.mint || leg.mint === MINTS.SOL || !isFiniteNumber(leg.delta) || leg.delta === 0) continue;
        const s = stateFor(leg.mint);
        touch(s, a, symbolFor(leg.mint, leg.symbol));
        if (leg.delta > 0) s.lots.push({ signature: a.signature, timestamp: a.timestamp, amount: leg.delta });
        else consumeFifo(s.lots, -leg.delta, a.timestamp);
      }
      continue;
    }

    if (a.kind !== 'buy' && a.kind !== 'sell' && a.kind !== 'transfer_in' && a.kind !== 'transfer_out') continue;

    const mint = a.tokenMint;
    const amount = tokenAmountOf(a);
    if (!mint || mint === MINTS.SOL || amount === undefined) {
      malformed++;
      continue;
    }
    const s = stateFor(mint);
    const legSymbol = a.legs?.find((l) => l.mint === mint)?.symbol;
    touch(s, a, symbolFor(mint, a.tokenSymbol ?? legSymbol));

    if (a.kind === 'transfer_in') {
      transfers++;
      s.lots.push({ signature: a.signature, timestamp: a.timestamp, amount });
      continue;
    }
    if (a.kind === 'transfer_out') {
      transfers++;
      consumeFifo(s.lots, amount, a.timestamp);
      continue;
    }

    // buy / sell
    trades++;
    markTrade(s, a.timestamp);
    if (isFiniteNumber(a.feeSol)) {
      feesSol += Math.abs(a.feeSol);
      feesKnown = true;
    }
    const sol = solAmountOf(a);
    if (sol === undefined) {
      missingSol++;
      s.realizedIncomplete = true;
    } else {
      volumeSol += sol;
    }

    if (a.kind === 'buy') {
      s.buys++;
      s.boughtAmount += amount;
      if (sol !== undefined) s.costSol += sol;
      const lot: PnlLot = { signature: a.signature, timestamp: a.timestamp, amount };
      if (sol !== undefined) lot.costSol = sol;
      s.lots.push(lot);
      continue;
    }

    s.sells++;
    s.soldAmount += amount;
    if (sol !== undefined) s.proceedsSol += sol;
    const used = consumeFifo(s.lots, amount, a.timestamp);
    s.holdSecondsWeighted += used.holdSecondsWeighted;
    s.holdUnits += used.matchedUnits;
    if (used.unknownUnits > 0 || used.unmatched > 0) s.realizedIncomplete = true;
    if (sol !== undefined && used.knownUnits > 0) {
      s.realizedSol += sol * (used.knownUnits / amount) - used.knownCost;
    }
  }

  // 3. Per-token results (mints with at least one SOL-leg buy or sell).
  const tokens: PnlTokenResult[] = [];
  let incompleteTokens = 0;
  let openWithoutUnrealized = 0;
  for (const s of states.values()) {
    if (s.buys + s.sells === 0 || s.firstTradeAt === undefined || s.lastTradeAt === undefined) continue;
    const remainingAmount = s.lots.reduce((sum, lot) => sum + lot.amount, 0);
    const heldUnknown = s.lots.some((lot) => lot.costSol === undefined);
    const remainingCostSol = heldUnknown ? undefined : s.lots.reduce((sum, lot) => sum + (lot.costSol ?? 0), 0);
    const costBasisComplete = !s.realizedIncomplete && !heldUnknown;
    if (!costBasisComplete) incompleteTokens++;

    const price = input.currentPricesSol?.[s.mint];
    const currentPriceSol = isFiniteNumber(price) && price > 0 ? price : undefined;

    const result: PnlTokenResult = {
      mint: s.mint,
      buys: s.buys,
      sells: s.sells,
      boughtAmount: s.boughtAmount,
      soldAmount: s.soldAmount,
      costSol: s.costSol,
      proceedsSol: s.proceedsSol,
      realizedSol: s.realizedSol,
      remainingAmount,
      firstTradeAt: s.firstTradeAt,
      lastTradeAt: s.lastTradeAt,
      costBasisComplete,
      signatures: s.signatures,
    };
    if (s.symbol) result.symbol = s.symbol;
    if (remainingCostSol !== undefined) result.remainingCostSol = remainingCostSol;
    if (currentPriceSol !== undefined) result.currentPriceSol = currentPriceSol;
    if (s.lots.length === 0) {
      // Closed position: nothing held, so nothing unrealized (exact, not a placeholder).
      result.unrealizedSol = 0;
    } else if (currentPriceSol !== undefined && remainingCostSol !== undefined) {
      result.unrealizedSol = remainingAmount * currentPriceSol - remainingCostSol;
    } else {
      openWithoutUnrealized++;
    }
    if (s.holdUnits > 0) result.avgHoldSeconds = s.holdSecondsWeighted / s.holdUnits;
    tokens.push(result);
  }
  tokens.sort((x, y) => (x.lastTradeAt !== y.lastTradeAt ? y.lastTradeAt - x.lastTradeAt : x.mint < y.mint ? -1 : x.mint > y.mint ? 1 : 0));

  // 4. Totals.
  let realizedSol = 0;
  let unrealizedSol: number | undefined;
  let winners = 0;
  let losers = 0;
  let holdSum = 0;
  let holdCount = 0;
  for (const t of tokens) {
    realizedSol += t.realizedSol;
    if (t.unrealizedSol !== undefined) unrealizedSol = (unrealizedSol ?? 0) + t.unrealizedSol;
    if (t.costBasisComplete && t.sells > 0) {
      if (t.realizedSol > 0) winners++;
      else if (t.realizedSol < 0) losers++;
    }
    if (t.avgHoldSeconds !== undefined) {
      holdSum += t.avgHoldSeconds;
      holdCount++;
    }
  }

  const totals: PnlReport['totals'] = { realizedSol, volumeSol, trades, winners, losers };
  if (unrealizedSol !== undefined) totals.unrealizedSol = unrealizedSol;
  if (winners + losers > 0) totals.winRatePct = (winners / (winners + losers)) * 100;
  if (holdCount > 0) totals.avgHoldSeconds = holdSum / holdCount;

  // 5. Window and caveats.
  const window: PnlReport['window'] = {
    transactionsAnalyzed: input.transactionsAnalyzed,
    swapsCounted: trades,
    historyComplete: input.historyComplete,
  };
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first && last) {
    window.from = first.timestamp;
    window.to = last.timestamp;
  }

  const caveats: string[] = [
    'PnL is FIFO per token and denominated in SOL: a buy costs the SOL it spent, a sell returns the SOL it received. USD prices are not used.',
    `SOL legs are the wallet's net SOL change excluding the network fee, so router/bot fees and tips paid inside a transaction are included in cost and proceeds; network fees${
      feesKnown ? ` (${roundSol(feesSol)} SOL on counted trades)` : ''
    } are not.`,
  ];
  if (!input.historyComplete) {
    const n = input.transactionsAnalyzed;
    caveats.push(
      `History is incomplete: only the most recent ${n === 1 ? 'transaction was' : `${n} transactions were`} analysed, so positions opened earlier have unknown cost basis.`,
    );
  }
  if (incompleteTokens > 0) {
    caveats.push(
      `${plural(incompleteTokens, 'token has', 'tokens have')} incomplete cost basis (sold more than was bought in the analysed window, or tokens received without a SOL cost); realized PnL is computed only for units with a known cost, and these tokens are excluded from the win rate.`,
    );
  }
  if (swapsExcluded > 0) {
    caveats.push(
      `${plural(swapsExcluded, 'token↔token swap', 'token↔token swaps')} without a SOL leg ${swapsExcluded === 1 ? 'was' : 'were'} excluded from PnL; the tokens moved are tracked as transfers with unknown SOL cost.`,
    );
  }
  if (transfers > 0) {
    caveats.push(
      `${plural(transfers, 'token transfer')} affected inventory: transfers in add tokens with unknown cost, transfers out remove tokens FIFO and are not counted as sales.`,
    );
  }
  if (missingSol > 0) {
    caveats.push(`${plural(missingSol, 'buy/sell has', 'buys/sells have')} no SOL amount, so the cost or proceeds of those trades is unknown.`);
  }
  if (openWithoutUnrealized > 0) {
    caveats.push(
      `Unrealized PnL excludes ${plural(openWithoutUnrealized, 'open position')} without a current SOL price or with unknown cost basis.`,
    );
  }
  if (failed > 0) caveats.push(`${plural(failed, 'failed transaction')} ignored.`);
  if (malformed > 0) caveats.push(`${plural(malformed, 'activity', 'activities')} without a usable token, amount or timestamp skipped.`);
  if (foreign > 0) caveats.push(`${plural(foreign, 'activity', 'activities')} belonging to other wallets ignored.`);

  const report: PnlReport = {
    wallet,
    method: 'FIFO',
    quote: 'SOL',
    window,
    tokens,
    totals,
    caveats,
  };
  if (isFiniteNumber(input.solPriceUsd) && input.solPriceUsd > 0) report.solPriceUsd = input.solPriceUsd;
  return report;
}
