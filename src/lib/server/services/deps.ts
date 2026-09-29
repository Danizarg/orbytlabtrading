import 'server-only';
import { ChainError } from '@/lib/core/chain';
import { getMintInfo } from '@/lib/providers/solana';
import type { MintInfo } from '@/lib/core/types';
import { cached, TTL } from '@/lib/server/cache';
import { env, rpcKind } from '@/lib/server/env';
import { selectPrimaryPool } from '@/lib/services/token';
import {
  birdeye,
  dexServer,
  geckoKeyed,
  geckoKeyless,
  helius,
  jupiterKeyed,
  jupiterKeyless,
  mintInfo,
  serverActivity,
  serverCurves,
  serverPortfolio,
  serverRpc,
  serverRpcTrades,
  solanaTracker,
  solPriceUsd,
} from '@/lib/server/registry';
import type { ActivityDeps } from './activity';
import type { CandlesDeps } from './candles';
import type { DiscoverDeps, TokenRowsDeps } from './discover';
import { withCache } from './envelope';
import type { HoldersDeps } from './holders';
import type { CurvesDeps, MintDeps } from './onchain';
import { loadPools, POOLS_TTL_MS, type PoolsDeps } from './pools';
import type { PortfolioDeps } from './portfolio';
import type { PulseDeps } from './pulse';
import type { QuoteDeps } from './quote';
import type { RiskDeps } from './risk';
import type { TradesDeps } from './trades';

/**
 * Service dependencies wired to the lazily built server registry. Each route
 * asks only for what it uses, so unrelated providers are never constructed.
 */

/**
 * True when server RPC calls actually go to the public mainnet endpoint.
 * rpcKind() reports 'helius' when SOLANA_RPC_URL is set to the public URL
 * alongside a Helius key, yet serverRpcUrl() then uses that public URL.
 */
export function serverRpcIsPublic(): boolean {
  const kind = rpcKind();
  return kind === 'public' || (kind !== 'custom' && env.solanaRpcUrl() !== undefined);
}

export function tradesDeps(): TradesDeps {
  const gecko = geckoKeyed();
  return {
    // The public RPC's 10 getTransaction / 10 s per IP cannot sustain a trade feed.
    rpcTrades: serverRpcIsPublic() ? null : serverRpcTrades(),
    birdeye: birdeye(),
    solanaTracker: solanaTracker(),
    coingeckoPro: gecko?.plan === 'pro' ? gecko : null,
    solPriceUsd,
    mintInfo,
  };
}

export function candlesDeps(): CandlesDeps {
  return { birdeye: birdeye(), solanaTracker: solanaTracker(), coingecko: geckoKeyed(), geckoKeyless: geckoKeyless(), resolvePool: primaryPoolOf };
}

/** DEX Screener (cheap) and GeckoTerminal: keyed CoinGecko when configured, else keyless. */
export function poolsDeps(): PoolsDeps {
  return { dex: dexServer(), gecko: geckoKeyed() ?? geckoKeyless() };
}

/** Pool-list cache shared by /api/v1/pools and the candles pool lookup (same key, same lifetimes). */
export function cachedPools(mint: string) {
  return withCache(`pools:${mint}`, POOLS_TTL_MS, 5 * 60_000, () => loadPools(mint, poolsDeps()));
}

/**
 * The pool the trade page would chart (most liquid active pool, or the curve), from the cached pool list.
 * `undefined` only when every source answered and none lists a pool; a failed lookup (rate limit,
 * timeout) throws, so the candles route reports a retryable failure instead of "not configured".
 */
export async function primaryPoolOf(mint: string): Promise<string | undefined> {
  try {
    const { value } = await cachedPools(mint);
    return selectPrimaryPool(mint, value.data).primary?.address;
  } catch (error) {
    if (error instanceof ChainError && error.allNotFound) return undefined;
    throw error;
  }
}

export function holdersDeps(): HoldersDeps {
  return { helius: helius(), birdeye: birdeye(), solanaTracker: solanaTracker(), coingecko: geckoKeyed() };
}

export function riskDeps(): RiskDeps {
  return { solanaTracker: solanaTracker(), birdeye: birdeye() };
}

export function pulseDeps(): PulseDeps {
  return { solanaTracker: solanaTracker(), birdeye: birdeye() };
}

export function discoverDeps(): DiscoverDeps {
  return { jupiter: jupiterKeyed(), coingecko: geckoKeyed() };
}

export function tokenRowsDeps(): TokenRowsDeps {
  return { jupiter: jupiterKeyed(), coingecko: geckoKeyed(), jupiterKeyless: jupiterKeyless(), dex: dexServer() };
}

export function quoteDeps(): QuoteDeps {
  return { jupiter: jupiterKeyed() };
}

export function portfolioDeps(): PortfolioDeps {
  return { portfolio: serverPortfolio(), prices: jupiterKeyed(), solPriceUsd };
}

/** Mirrors the registry: Helius indexed history only when Helius is the RPC (no SOLANA_RPC_URL override). */
export function activityDeps(): ActivityDeps {
  return { activity: serverActivity(), heliusHistory: rpcKind() === 'helius' && !env.solanaRpcUrl() };
}

export function curvesDeps(): CurvesDeps {
  return { curves: serverCurves() };
}

export function mintDeps(): MintDeps {
  const rpc = serverRpc();
  return {
    provider: rpc.provider,
    // Same key and lifetimes as registry.mintInfo(), so trade enrichment and this route share one entry.
    getMintInfo: async (mint: string): Promise<{ value: MintInfo; stale: boolean }> => {
      const hit = await cached(`mint:${mint}`, { ttlMs: TTL.holders, staleMs: TTL.metadata }, () => getMintInfo(rpc, mint));
      return { value: hit.value, stale: hit.stale };
    },
  };
}
