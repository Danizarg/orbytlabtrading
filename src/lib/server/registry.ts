import 'server-only';
import { createBirdeye, type BirdeyeAdapter } from '@/lib/providers/birdeye';
import { createDexScreener, type DexScreenerAdapter } from '@/lib/providers/dexscreener';
import { createGeckoTerminal, type GeckoTerminalAdapter } from '@/lib/providers/geckoterminal';
import { createHelius, type HeliusAdapter } from '@/lib/providers/helius';
import { createJupiter, type JupiterAdapter } from '@/lib/providers/jupiter';
import {
  createPumpCurveProvider,
  createRpcActivityProvider,
  createRpcClient,
  createRpcPortfolioProvider,
  createRpcTradesProvider,
  getMintInfo,
  type RpcClient,
} from '@/lib/providers/solana';
import { createSolanaTracker, type SolanaTrackerAdapter } from '@/lib/providers/solanatracker';
import type { BondingCurveProvider, PortfolioProvider, ProviderId, TransactionProvider, WalletActivityProvider } from '@/lib/core/providers';
import type { MintInfo } from '@/lib/core/types';
import { MINTS } from '@/lib/core/solana';
import { ProviderError } from '@/lib/net/errors';
import type { JsonFetcher, JsonRequest } from '@/lib/net/types';
import { cached, TTL } from './cache';
import { env, rpcKind, serverRpcUrl } from './env';
import { fetchJson, serverFetcher } from './http';

/**
 * Server-side provider instances, built lazily from environment variables and
 * memoised per serverless worker. Keyed providers are `null` when their key is
 * absent, so routes can decide between serving and answering 501.
 */

function memo<T>(factory: () => T): () => T {
  let value: T | undefined;
  let built = false;
  return () => {
    if (!built) {
      value = factory();
      built = true;
    }
    return value as T;
  };
}

export const serverRpc = memo<RpcClient>(() =>
  createRpcClient({
    url: serverRpcUrl(),
    fetcher: serverFetcher,
    provider: rpcKind() === 'helius' ? 'helius' : 'solana-rpc',
    label: rpcKind() === 'public' ? 'solana-rpc' : `solana-rpc (${rpcKind()})`,
  }),
);

export const serverCurves = memo<BondingCurveProvider>(() => createPumpCurveProvider({ rpc: serverRpc() }));

export const serverPortfolio = memo<PortfolioProvider>(() => createRpcPortfolioProvider({ rpc: serverRpc() }));

export const serverActivity = memo<WalletActivityProvider>(() =>
  createRpcActivityProvider({ rpc: serverRpc(), useHeliusHistory: rpcKind() === 'helius' && !env.solanaRpcUrl() }),
);

/**
 * RPC-derived trade feed. Only offered with a private RPC: the public mainnet
 * endpoint allows 10 getTransaction calls per 10 s per IP, far too few for a feed.
 */
export const serverRpcTrades = memo<TransactionProvider | null>(() =>
  rpcKind() === 'public' ? null : createRpcTradesProvider({ rpc: serverRpc(), provider: rpcKind() === 'helius' ? 'helius' : 'solana-rpc' }),
);

export const helius = memo<HeliusAdapter | null>(() => {
  const apiKey = env.heliusApiKey();
  return apiKey ? createHelius({ apiKey, fetcher: serverFetcher }) : null;
});

export const birdeye = memo<BirdeyeAdapter | null>(() => {
  const apiKey = env.birdeyeApiKey();
  return apiKey ? createBirdeye({ apiKey, fetcher: serverFetcher }) : null;
});

export const solanaTracker = memo<SolanaTrackerAdapter | null>(() => {
  const apiKey = env.solanaTrackerApiKey();
  return apiKey ? createSolanaTracker({ apiKey, fetcher: serverFetcher }) : null;
});

/** CoinGecko on-chain (Demo or paid) — the keyed GeckoTerminal data plane. */
export const geckoKeyed = memo<GeckoTerminalAdapter | null>(() => {
  const apiKey = env.coingeckoApiKey();
  return apiKey ? createGeckoTerminal({ fetcher: serverFetcher, plan: env.coingeckoPlan(), apiKey }) : null;
});

/** Jupiter with the deployment's key (null without one — keyless server calls share cloud IPs). */
export const jupiterKeyed = memo<JupiterAdapter | null>(() => {
  const apiKey = env.jupiterApiKey();
  return apiKey ? createJupiter({ fetcher: serverFetcher, apiKey }) : null;
});

/**
 * Local sliding-window cap in front of the server transport for keyless
 * upstreams. It fails fast (rate_limited) instead of queueing, so a chain
 * moves on to its next source at once, and it keeps a keyless caller below
 * the per-IP limit even when a keyed caller shares the provider's budget in
 * http.ts (both use the same ProviderId).
 */
export function limitedFetcher(limit: number, windowMs: number, base: JsonFetcher = serverFetcher): JsonFetcher {
  const stamps: number[] = [];
  return <T,>(provider: ProviderId, url: string, init?: JsonRequest): Promise<T> => {
    const now = Date.now();
    while (stamps.length && now - (stamps[0] ?? now) >= windowMs) stamps.shift();
    if (stamps.length >= limit) {
      return Promise.reject(new ProviderError(provider, 'rate_limited', `${provider}: keyless server budget exhausted`, { retryAfterMs: windowMs - (now - (stamps[0] ?? now)) }));
    }
    stamps.push(now);
    return base<T>(provider, url, init);
  };
}

/**
 * Keyless Jupiter from the server: the cached SOL price and the /api/v1/tokens
 * fallback. Jupiter's keyless limit is 5 requests / 10 s per IP; this worker
 * stays at 4 and fails fast beyond that.
 */
export const jupiterKeyless = memo<JupiterAdapter>(() => createJupiter({ fetcher: limitedFetcher(4, 10_000) }));

/**
 * Server transport for keyless GeckoTerminal with a bounded wait: when the
 * 8 calls / min budget is spent, a call waits at most `budgetMs` for a slot
 * (instead of the default 2 × timeout) and then fails fast as rate_limited.
 * A route answers 503 or its last good response within seconds instead of
 * queueing past its maxDuration (the candles route may need two calls).
 */
export const KEYLESS_GECKO_REQUEST = { budgetMs: 3_000, timeoutMs: 7_000 } as const;
const keylessGeckoFetcher: JsonFetcher = (provider, url, init) =>
  fetchJson(provider, url, { ...init, timeoutMs: init?.timeoutMs ?? KEYLESS_GECKO_REQUEST.timeoutMs, budgetMs: KEYLESS_GECKO_REQUEST.budgetMs });

/**
 * Keyless GeckoTerminal from the server: candles and pools fallbacks for
 * visitors whose own GeckoTerminal quota is spent, plus the last-resort SOL
 * price. Uses the conservative 'geckoterminal' budget in http.ts (8 calls /
 * min per worker) with a bounded wait; routes put CDN s-maxage in front so
 * one upstream call serves every visitor.
 */
export const geckoKeyless = memo<GeckoTerminalAdapter>(() => createGeckoTerminal({ fetcher: keylessGeckoFetcher }));

export const dexServer = memo<DexScreenerAdapter>(() => createDexScreener({ fetcher: serverFetcher }));

/**
 * Current SOL/USD price for server-side USD enrichment, cached 30 s per worker.
 * Returns undefined when no source answers (callers then omit USD values).
 */
export async function solPriceUsd(): Promise<number | undefined> {
  try {
    const result = await cached('sol-price-usd', { ttlMs: 30_000, staleMs: 5 * 60_000 }, async () => {
      const sources = [jupiterKeyed(), jupiterKeyless()].filter((s): s is JupiterAdapter => !!s);
      for (const jup of sources) {
        try {
          const r = await jup.getSolPrice();
          if (Number.isFinite(r.data.priceUsd) && r.data.priceUsd > 0) return r.data.priceUsd;
        } catch {
          /* try next source */
        }
      }
      const gecko = geckoKeyed() ?? geckoKeyless();
      const markets = await gecko.getMarkets([MINTS.SOL]);
      const price = markets.data[MINTS.SOL]?.priceUsd;
      if (typeof price === 'number' && price > 0) return price;
      throw new Error('SOL price unavailable');
    });
    return result.value;
  } catch {
    return undefined;
  }
}

/** Mint info (supply/decimals/authorities), cached 60 s per worker. */
export async function mintInfo(mint: string): Promise<MintInfo | undefined> {
  try {
    const result = await cached(`mint:${mint}`, { ttlMs: TTL.holders, staleMs: TTL.metadata }, () => getMintInfo(serverRpc(), mint));
    return result.value;
  } catch {
    return undefined;
  }
}
