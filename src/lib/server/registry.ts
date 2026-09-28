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
import type { BondingCurveProvider, PortfolioProvider, TransactionProvider, WalletActivityProvider } from '@/lib/core/providers';
import type { MintInfo } from '@/lib/core/types';
import { MINTS } from '@/lib/core/solana';
import { cached, TTL } from './cache';
import { env, rpcKind, serverRpcUrl } from './env';
import { serverFetcher } from './http';

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

/** Keyless Jupiter from the server: used sparingly (cached SOL price only). */
const jupiterKeyless = memo<JupiterAdapter>(() => createJupiter({ fetcher: serverFetcher }));

/** Keyless GeckoTerminal from the server: last-resort SOL price only. */
const geckoKeyless = memo<GeckoTerminalAdapter>(() => createGeckoTerminal({ fetcher: serverFetcher }));

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
