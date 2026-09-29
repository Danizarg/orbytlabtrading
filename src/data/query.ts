/**
 * Polling cadences (ms), matched to how fresh each source actually is.
 * Polling an indexed source faster than its cache only burns rate limits.
 */
export const POLL = {
  /** On-chain reads (bonding curves) and server RPC trade feeds. */
  realtime: 3_000,
  /** Provider data cached ~5–15 s (Jupiter, keyed REST). */
  fast: 10_000,
  /** Discovery lists. */
  discovery: 15_000,
  /** Aggregator/indexer data cached 30–60 s (GeckoTerminal, DEX Screener). */
  indexed: 30_000,
  /** Slow-changing enrichment (risk, holders, pools). */
  slow: 60_000,
} as const;

/** Stable React Query keys shared across features. */
export const qk = {
  solPrice: () => ['sol-price'] as const,
  health: () => ['health'] as const,
};
