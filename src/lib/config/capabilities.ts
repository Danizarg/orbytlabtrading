import type { Interval } from '@/lib/core/types';

/**
 * Which server-side (keyed) providers are configured. Only booleans / plan
 * names — never secrets — so this is safe to send to the browser.
 */
export interface ConfiguredProviders {
  helius: boolean;
  birdeye: boolean;
  solanatracker: boolean;
  coingecko: 'demo' | 'pro' | null;
  jupiter: boolean;
  /** SOLANA_RPC_URL points at a private endpoint (not the public mainnet RPC). */
  customRpc: boolean;
}

/**
 * Server capabilities the browser can rely on. When a capability is false the
 * client composes the data from keyless public APIs directly instead.
 */
export interface Capabilities {
  configured: ConfiguredProviders;
  /** Near-real-time trade feed from a keyed RPC/indexer (server route /api/v1/trades). */
  serverTrades: boolean;
  /** Keyed candle source (server route /api/v1/candles). */
  serverCandles: boolean;
  /** Sub-minute intervals available from a keyed candle source. */
  serverSecondIntervals: Interval[];
  /** Holder list (server route /api/v1/holders). */
  serverHolders: boolean;
  /** Keyed risk metrics: snipers/insiders/bundlers (server route /api/v1/risk). */
  serverRisk: boolean;
  /** Keyed launchpad lists (server route /api/v1/pulse). */
  serverPulse: boolean;
  /** Keyed discovery/market data (server routes /api/v1/discover, /api/v1/tokens). */
  serverDiscover: boolean;
  /** Keyed Jupiter quotes (server route /api/v1/quote). */
  serverQuote: boolean;
  /** Wallet history via a fast indexed method (Helius getTransactionsForAddress). */
  fastWalletHistory: boolean;
}

export function deriveCapabilities(c: ConfiguredProviders): Capabilities {
  const secondIntervals = new Set<Interval>();
  if (c.birdeye) ['1s', '15s'].forEach((i) => secondIntervals.add(i as Interval));
  if (c.solanatracker) ['1s', '5s', '15s'].forEach((i) => secondIntervals.add(i as Interval));
  if (c.coingecko === 'pro') ['1s', '15s'].forEach((i) => secondIntervals.add(i as Interval));
  return {
    configured: c,
    serverTrades: c.helius || c.customRpc || c.birdeye || c.solanatracker || c.coingecko === 'pro',
    serverCandles: c.birdeye || c.solanatracker || c.coingecko !== null,
    serverSecondIntervals: [...secondIntervals],
    serverHolders: c.helius || c.birdeye || c.solanatracker,
    serverRisk: c.solanatracker || c.birdeye,
    serverPulse: c.solanatracker || c.birdeye,
    serverDiscover: c.jupiter || c.coingecko !== null,
    serverQuote: c.jupiter,
    fastWalletHistory: c.helius,
  };
}

/** Browser-visible endpoints (NEXT_PUBLIC_*, safe to expose). */
export const PUBLIC_ENDPOINTS = {
  /** Browser-callable Solana JSON-RPC for light reads (getMultipleAccounts). */
  solanaRpc: process.env.NEXT_PUBLIC_SOLANA_BROWSER_RPC_URL?.trim() || 'https://solana-rpc.publicnode.com',
  /** Browser WebSocket for account/log subscriptions (best-effort; see README). */
  solanaWs: process.env.NEXT_PUBLIC_SOLANA_WS_URL?.trim() || 'wss://solana-rpc.publicnode.com',
  pumpPortalWs: process.env.NEXT_PUBLIC_PUMPPORTAL_WS_URL?.trim() || 'wss://pumpportal.fun/api/data',
  geckoTerminal: 'https://api.geckoterminal.com/api/v2',
  dexScreener: 'https://api.dexscreener.com',
  jupiter: 'https://api.jup.ag',
} as const;
