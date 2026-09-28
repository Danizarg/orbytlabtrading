import 'server-only';
import { getMintInfo } from '@/lib/providers/solana';
import type { MintInfo } from '@/lib/core/types';
import { cached, TTL } from '@/lib/server/cache';
import { env, rpcKind } from '@/lib/server/env';
import {
  birdeye,
  geckoKeyed,
  helius,
  jupiterKeyed,
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
import type { HoldersDeps } from './holders';
import type { CurvesDeps, MintDeps } from './onchain';
import type { PortfolioDeps } from './portfolio';
import type { PulseDeps } from './pulse';
import type { QuoteDeps } from './quote';
import type { RiskDeps } from './risk';
import type { TradesDeps } from './trades';

/**
 * Service dependencies wired to the lazily built server registry. Each route
 * asks only for what it uses, so unrelated providers are never constructed.
 */

export function tradesDeps(): TradesDeps {
  const gecko = geckoKeyed();
  return {
    rpcTrades: serverRpcTrades(),
    birdeye: birdeye(),
    solanaTracker: solanaTracker(),
    coingeckoPro: gecko?.plan === 'pro' ? gecko : null,
    solPriceUsd,
    mintInfo,
  };
}

export function candlesDeps(): CandlesDeps {
  return { birdeye: birdeye(), solanaTracker: solanaTracker(), coingecko: geckoKeyed() };
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
  return { jupiter: jupiterKeyed(), coingecko: geckoKeyed() };
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
