/**
 * Wallet analytics and tracker composition (isomorphic, pure).
 *
 * Everything here is free of React and I/O so it can be unit tested:
 * honest portfolio pricing, activity page merging, PnL input assembly and the
 * tracker feed reducer. Nothing invents a value: an unpriced holding stays
 * unpriced (counted, excluded from totals), a USD estimate is labelled as
 * "at the current SOL price", and unknown fields stay undefined.
 */

import type { PnlInput } from '@/lib/analytics/pnl';
import { runChain, type ChainResult } from '@/lib/core/chain';
import type { PortfolioProvider } from '@/lib/core/providers';
import { MINTS } from '@/lib/core/solana';
import type {
  ActivityKind,
  PnlReport,
  Portfolio,
  TokenBalance,
  TokenIdentity,
  WalletActivity,
  WalletActivityPage,
} from '@/lib/core/types';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Holdings priced in the browser (3 Jupiter Price V3 calls of 50). */
export const MAX_PRICED_HOLDINGS = 150;
/** Mints looked up for symbol / logo per batch (one Jupiter search call). */
export const MAX_IDENTITY_MINTS = 100;
/** Activity page size requested from the server route. */
export const ACTIVITY_PAGE_SIZE = 15;
/** PnL: pages fetched automatically, added per "Analyze more", and the hard cap. */
export const PNL_AUTO_PAGES = 3;
export const PNL_MORE_PAGES = 3;
export const PNL_MAX_PAGES = 30;
/** Tracker: entries kept in the merged feed, backfill and reconciliation page sizes. */
export const TRACKER_MAX_ENTRIES = 300;
export const TRACKER_BACKFILL_LIMIT = 10;
export const TRACKER_POLL_LIMIT = 5;
export const TRACKER_POLL_MS = 90_000;
export const TRACKER_STAGGER_MS = 300;

const positive = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

/** Server RPC route first (always available), keyless Jupiter holdings as the fallback. */
export function loadPortfolio(
  sources: { server: PortfolioProvider; jupiter: PortfolioProvider },
  address: string,
  signal?: AbortSignal,
): Promise<ChainResult<Portfolio>> {
  return runChain<Portfolio>(
    'portfolio',
    [
      { id: 'orbyt', run: () => sources.server.getPortfolio(address, signal) },
      { id: 'jupiter', run: () => sources.jupiter.getPortfolio(address, signal) },
    ],
    { signal },
  );
}

export interface Holding extends TokenBalance {
  /** Share of the portfolio total (0–100); only for priced holdings when the total is known. */
  sharePct?: number;
}

export interface PricedPortfolio {
  address: string;
  sol: number;
  solPriceUsd?: number;
  /** SOL balance in USD when the SOL price is known. */
  solValueUsd?: number;
  /** Priced holdings by value, then unpriced by balance. */
  tokens: Holding[];
  /** Sum of priced token values (excludes SOL and unpriced tokens). */
  tokenValueUsd: number;
  /** SOL + priced tokens; omitted when SOL cannot be valued or nothing was valued. */
  totalUsd?: number;
  pricedCount: number;
  unpricedCount: number;
  updatedAt: number;
}

function compareHoldings(a: Holding, b: Holding): number {
  const av = a.valueUsd;
  const bv = b.valueUsd;
  if (av !== undefined && bv !== undefined && av !== bv) return bv - av;
  if (av !== undefined && bv === undefined) return -1;
  if (av === undefined && bv !== undefined) return 1;
  if (a.amount !== b.amount) return b.amount - a.amount;
  return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
}

/**
 * Value holdings from real quotes only. Browser prices win over server
 * prices (they are newer); a token without a positive price stays unpriced.
 * Identity (symbol, name, logo) is filled from `identities` without
 * overwriting what the provider already supplied.
 */
export function priceHoldings(
  portfolio: Portfolio,
  prices: Readonly<Record<string, number>>,
  solPriceUsd: number | undefined,
  identities: Readonly<Record<string, TokenIdentity | undefined>> = {},
): PricedPortfolio {
  let pricedCount = 0;
  let tokenValueUsd = 0;
  const tokens: Holding[] = portfolio.tokens.map((token) => {
    const identity = identities[token.mint];
    const { priceUsd: serverPrice, valueUsd: _v, ...rest } = token;
    const holding: Holding = { ...rest };
    if (identity) {
      if (holding.symbol === undefined && identity.symbol) holding.symbol = identity.symbol;
      if (holding.name === undefined && identity.name) holding.name = identity.name;
      if (holding.image === undefined && identity.image) holding.image = identity.image;
    }
    const browserPrice = prices[token.mint];
    const price = positive(browserPrice) ? browserPrice : positive(serverPrice) ? serverPrice : undefined;
    if (price === undefined) return holding;
    holding.priceUsd = price;
    holding.valueUsd = token.amount * price;
    pricedCount++;
    tokenValueUsd += holding.valueUsd;
    return holding;
  });
  tokens.sort(compareHoldings);

  const solPrice = positive(solPriceUsd) ? solPriceUsd : positive(portfolio.solPriceUsd) ? portfolio.solPriceUsd : undefined;
  const out: PricedPortfolio = {
    address: portfolio.address,
    sol: portfolio.sol,
    tokens,
    tokenValueUsd,
    pricedCount,
    unpricedCount: tokens.length - pricedCount,
    updatedAt: portfolio.updatedAt,
  };
  if (solPrice !== undefined) {
    out.solPriceUsd = solPrice;
    out.solValueUsd = portfolio.sol * solPrice;
  }
  // The total needs SOL valued (or absent) and something actually valued; a
  // wallet whose tokens all failed to price gets no total, never a made-up $0.
  const solValued = solPrice !== undefined || portfolio.sol === 0;
  const somethingValued = pricedCount > 0 || (portfolio.sol > 0 && solPrice !== undefined) || tokens.length === 0;
  if (solValued && somethingValued) {
    out.totalUsd = (out.solValueUsd ?? 0) + tokenValueUsd;
    if (out.totalUsd > 0) {
      for (const t of tokens) if (t.valueUsd !== undefined) t.sharePct = (t.valueUsd / out.totalUsd) * 100;
    }
  }
  return out;
}

/** Mints worth an identity lookup: server-priced holdings by value first, then the rest in balance order. */
export function identityMints(tokens: readonly TokenBalance[], max: number = MAX_IDENTITY_MINTS): string[] {
  const priced = tokens.filter((t) => positive(t.valueUsd)).sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  const rest = tokens.filter((t) => !positive(t.valueUsd));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...priced, ...rest]) {
    if (seen.has(t.mint) || t.mint === MINTS.SOL) continue;
    seen.add(t.mint);
    out.push(t.mint);
    if (out.length >= max) break;
  }
  return out;
}

export interface PriceSelection {
  /** Mints to price in the browser (holdings the server left unpriced). */
  mints: string[];
  /** Holdings that will stay unpriced because the budget is exhausted. */
  skipped: number;
  /** More candidates than the budget: wait for metadata so known tokens are preferred. */
  needsMetadata: boolean;
}

/**
 * Which unpriced holdings to price in the browser. Within budget every
 * candidate is priced immediately; beyond it, tokens with known metadata are
 * preferred (`known` undefined = metadata not available yet).
 */
export function selectMintsToPrice(
  tokens: readonly TokenBalance[],
  known: ReadonlySet<string> | undefined,
  max: number = MAX_PRICED_HOLDINGS,
): PriceSelection {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (positive(t.priceUsd) || seen.has(t.mint) || t.mint === MINTS.SOL) continue;
    seen.add(t.mint);
    candidates.push(t.mint);
  }
  if (candidates.length <= max) return { mints: candidates, skipped: 0, needsMetadata: false };
  if (!known) return { mints: candidates.slice(0, max), skipped: candidates.length - max, needsMetadata: true };
  const preferred = candidates.filter((m) => known.has(m));
  const others = candidates.filter((m) => !known.has(m));
  return { mints: [...preferred, ...others].slice(0, max), skipped: candidates.length - max, needsMetadata: false };
}

// ---------------------------------------------------------------------------
// Activity pages
// ---------------------------------------------------------------------------

function compareNewestFirst(a: WalletActivity, b: WalletActivity): number {
  if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
  return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0;
}

/**
 * Flatten activity pages into one newest-first list without duplicates. The
 * first occurrence of a signature wins, so pass the freshest page first.
 */
export function mergeActivityItems(pages: ReadonlyArray<Pick<WalletActivityPage, 'items'>>): WalletActivity[] {
  const seen = new Set<string>();
  const out: WalletActivity[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (seen.has(item.signature)) continue;
      seen.add(item.signature);
      out.push(item);
    }
  }
  return out.sort(compareNewestFirst);
}

export interface ActivityCoverage {
  pages: number;
  /** Signatures the index returned across pages (including failed / unparsed). */
  scanned: number;
  activities: number;
  /** True when the oldest page has no cursor: history exhausted. */
  historyComplete: boolean;
}

export function activityCoverage(pages: readonly WalletActivityPage[], activities: number): ActivityCoverage {
  const last = pages[pages.length - 1];
  return {
    pages: pages.length,
    scanned: pages.reduce((sum, p) => sum + p.scanned, 0),
    activities,
    historyComplete: pages.length > 0 && !last?.nextCursor,
  };
}

// ---------------------------------------------------------------------------
// PnL
// ---------------------------------------------------------------------------

export interface PnlAssembly {
  wallet: string;
  pages: readonly WalletActivityPage[];
  /** Token USD prices by mint (Jupiter Price V3). */
  pricesUsd?: Readonly<Record<string, number>>;
  solPriceUsd?: number;
  symbols?: Readonly<Record<string, string>>;
}

/** Token USD price ÷ SOL USD price → price in SOL; mints without both prices are omitted. */
export function pricesInSol(pricesUsd: Readonly<Record<string, number>> | undefined, solPriceUsd: number | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!pricesUsd || !positive(solPriceUsd)) return out;
  for (const [mint, usd] of Object.entries(pricesUsd)) {
    if (positive(usd)) out[mint] = usd / solPriceUsd;
  }
  return out;
}

/** Build the deterministic PnL input from fetched activity pages and current prices. */
export function assemblePnlInput(input: PnlAssembly): PnlInput {
  const activities = mergeActivityItems(input.pages);
  const coverage = activityCoverage(input.pages, activities.length);
  const out: PnlInput = {
    wallet: input.wallet,
    activities,
    historyComplete: coverage.historyComplete,
    transactionsAnalyzed: coverage.scanned,
  };
  const currentPricesSol = pricesInSol(input.pricesUsd, input.solPriceUsd);
  if (Object.keys(currentPricesSol).length) out.currentPricesSol = currentPricesSol;
  if (positive(input.solPriceUsd)) out.solPriceUsd = input.solPriceUsd;
  const symbols: Record<string, string> = {};
  for (const [mint, symbol] of Object.entries(input.symbols ?? {})) if (symbol) symbols[mint] = symbol;
  if (Object.keys(symbols).length) out.symbols = symbols;
  return out;
}

/** Open positions need a current price for unrealized PnL (closed ones are exact without it). */
export function openPositionMints(report: Pick<PnlReport, 'tokens'>, max: number = MAX_IDENTITY_MINTS): string[] {
  return report.tokens.filter((t) => t.remainingAmount > 0).map((t) => t.mint).slice(0, max);
}

/** Distinct token mints touched by activities (main token and legs), SOL excluded. */
export function activityMints(activities: readonly WalletActivity[], max: number = MAX_IDENTITY_MINTS): string[] {
  const out: string[] = [];
  const seen = new Set<string>([MINTS.SOL]);
  const add = (mint: string | undefined) => {
    if (!mint || seen.has(mint) || out.length >= max) return;
    seen.add(mint);
    out.push(mint);
  };
  for (const a of activities) {
    add(a.tokenMint);
    for (const leg of a.legs) add(leg.mint);
  }
  return out;
}

/** Pages to request after "Analyze more": +3, capped. */
export function nextPnlTarget(current: number): number {
  return Math.min(PNL_MAX_PAGES, current + PNL_MORE_PAGES);
}

/** SOL → USD at the current SOL price ("≈ now"); undefined without a price. */
export function solToUsd(sol: number | undefined, solPriceUsd: number | undefined): number | undefined {
  if (typeof sol !== 'number' || !Number.isFinite(sol) || !positive(solPriceUsd)) return undefined;
  return sol * solPriceUsd;
}

// ---------------------------------------------------------------------------
// Activity presentation
// ---------------------------------------------------------------------------

export type KindTone = 'up' | 'down' | 'neutral' | 'muted';

export interface KindView {
  label: string;
  tone: KindTone;
}

export const KIND_VIEW: Readonly<Record<ActivityKind, KindView>> = {
  buy: { label: 'Buy', tone: 'up' },
  sell: { label: 'Sell', tone: 'down' },
  swap: { label: 'Swap', tone: 'neutral' },
  transfer_in: { label: 'Receive', tone: 'neutral' },
  transfer_out: { label: 'Send', tone: 'neutral' },
  sol_in: { label: 'SOL in', tone: 'neutral' },
  sol_out: { label: 'SOL out', tone: 'neutral' },
  other: { label: 'Other', tone: 'muted' },
};

/** Signed SOL change for the wallet, when the activity has a SOL leg. */
export function signedSol(a: WalletActivity): number | undefined {
  const leg = a.legs.find((l) => l.mint === MINTS.SOL);
  if (leg && Number.isFinite(leg.delta)) return leg.delta;
  if (a.solAmount === undefined) return undefined;
  if (a.kind === 'buy' || a.kind === 'transfer_out' || a.kind === 'sol_out') return -a.solAmount;
  if (a.kind === 'sell' || a.kind === 'transfer_in' || a.kind === 'sol_in') return a.solAmount;
  return undefined;
}

export interface UsdEstimate {
  value: number;
  /** True when the provider reported the USD value (stablecoin leg); false for a SOL × current-price estimate. */
  exact: boolean;
}

/** USD for an activity: the provider's value when known, else SOL × the current SOL price. */
export function usdEstimate(a: WalletActivity, solPriceUsd: number | undefined): UsdEstimate | undefined {
  if (positive(a.usdValue)) return { value: a.usdValue, exact: true };
  const usd = solToUsd(a.solAmount, solPriceUsd);
  return usd === undefined ? undefined : { value: usd, exact: false };
}

// ---------------------------------------------------------------------------
// Tracker feed
// ---------------------------------------------------------------------------

export type TrackerVia = 'backfill' | 'stream' | 'poll';

export interface TrackerEntry {
  /** `${wallet}:${signature}` */
  key: string;
  wallet: string;
  activity: WalletActivity;
  via: TrackerVia;
  /** When this browser learned about the entry (ms). */
  seenAt: number;
}

export function trackerKey(wallet: string, signature: string): string {
  return `${wallet}:${signature}`;
}

export function toTrackerEntries(items: readonly WalletActivity[], wallet: string, via: TrackerVia, seenAt: number): TrackerEntry[] {
  return items.map((activity) => ({ key: trackerKey(wallet, activity.signature), wallet, activity, via, seenAt }));
}

function compareEntries(a: TrackerEntry, b: TrackerEntry): number {
  return compareNewestFirst(a.activity, b.activity);
}

export interface TrackerMerge {
  entries: TrackerEntry[];
  /** Entries that were not in the feed before. */
  added: number;
}

/**
 * Merge incoming entries into the feed: de-duplicated by wallet + signature
 * (existing entries win, so their `seenAt` and `via` are stable), newest
 * first by block time, capped. Returns the same array when nothing changed.
 */
export function mergeTrackerEntries(existing: readonly TrackerEntry[], incoming: readonly TrackerEntry[], max: number = TRACKER_MAX_ENTRIES): TrackerMerge {
  const keys = new Set(existing.map((e) => e.key));
  const fresh: TrackerEntry[] = [];
  for (const entry of incoming) {
    if (keys.has(entry.key)) continue;
    keys.add(entry.key);
    fresh.push(entry);
  }
  if (!fresh.length) return { entries: existing as TrackerEntry[], added: 0 };
  const merged = [...existing, ...fresh].sort(compareEntries).slice(0, max);
  return { entries: merged, added: fresh.length };
}

/** Drop entries of wallets that are no longer tracked (same array when nothing changed). */
export function pruneTrackerEntries(entries: readonly TrackerEntry[], wallets: readonly string[]): TrackerEntry[] {
  const keep = new Set(wallets);
  const next = entries.filter((e) => keep.has(e.wallet));
  return next.length === entries.length ? (entries as TrackerEntry[]) : next;
}

export type TrackerKindFilter = 'all' | 'buy' | 'sell' | 'swap' | 'transfer' | 'other';

export const TRACKER_KIND_FILTERS: readonly { value: TrackerKindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'buy', label: 'Buys' },
  { value: 'sell', label: 'Sells' },
  { value: 'swap', label: 'Swaps' },
  { value: 'transfer', label: 'Transfers' },
  { value: 'other', label: 'Other' },
];

const TRANSFER_KINDS: ReadonlySet<ActivityKind> = new Set(['transfer_in', 'transfer_out', 'sol_in', 'sol_out']);

export function matchesKindFilter(kind: ActivityKind, filter: TrackerKindFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'transfer':
      return TRANSFER_KINDS.has(kind);
    case 'other':
      return kind === 'other';
    default:
      return kind === filter;
  }
}

export function filterTrackerEntries(entries: readonly TrackerEntry[], wallet: string | null, kind: TrackerKindFilter): TrackerEntry[] {
  if (!wallet && kind === 'all') return entries as TrackerEntry[];
  return entries.filter((e) => (!wallet || e.wallet === wallet) && matchesKindFilter(e.activity.kind, kind));
}

/** Distinct token mints in the feed (for symbol / logo lookup). */
export function feedMints(entries: readonly TrackerEntry[], max: number = MAX_IDENTITY_MINTS): string[] {
  return activityMints(
    entries.map((e) => e.activity),
    max,
  );
}

/** Delay before the i-th wallet's request so N wallets do not hit the route at once. */
export function staggerMs(index: number, step: number = TRACKER_STAGGER_MS): number {
  return Math.max(0, Math.floor(index)) * step;
}

export interface TrackerWalletStatus {
  backfilledAt?: number;
  backfillError?: string;
  lastPollAt?: number;
  pollError?: string;
  /** Last log notification handled for this wallet (ms). */
  lastStreamAt?: number;
  streamEvents: number;
}

export type TrackerLive = 'subscribed' | 'polling' | 'error';

/** Per-wallet live state: subscribed (WS open and confirmed), polling only (WS down), or error (backfill/poll failing). */
export function walletLive(status: TrackerWalletStatus | undefined, ws: { open: boolean; confirmed: boolean }): TrackerLive {
  if (status?.backfillError && status.backfilledAt === undefined) return 'error';
  if (status?.pollError && (status.lastPollAt === undefined || status.backfilledAt === undefined)) return 'error';
  return ws.open && ws.confirmed ? 'subscribed' : 'polling';
}

export const LIVE_LABEL: Readonly<Record<TrackerLive, string>> = {
  subscribed: 'Subscribed',
  polling: 'Polling only',
  error: 'Error',
};
