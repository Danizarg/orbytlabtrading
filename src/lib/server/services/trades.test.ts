import { describe, expect, it, vi } from 'vitest';
import type { ProviderId, TradesQuery, TransactionProvider } from '@/lib/core/providers';
import type { MintInfo, Sourced, Trade } from '@/lib/core/types';
import { ChainError } from '@/lib/core/chain';
import { ProviderError } from '@/lib/net/errors';
import { BadRequestError, NotConfiguredError } from './errors';
import { enrichTradesUsd, loadTrades, TRADES_MC_NOTE, TRADES_SOL_USD_NOTE, tradesNeedSupply, tradesNeedUsd, type TradesDeps } from './trades';

const MINT = '4ov9rwwS4iBHeTWGCrVaQYW1HzWK51MSfs8csGAApump';
const POOL = '8HbgiXuiNbHRcxiNG8UBD8GLewoy6QVDnPFPgjFGmszf';

function trade(partial: Partial<Trade> & Pick<Trade, 'signature'>): Trade {
  return { timestamp: 1_759_000_000_000, side: 'buy', source: 'solana-rpc', ...partial };
}

function provider(id: ProviderId, impl: (q: TradesQuery) => Promise<Sourced<Trade[]>>): TransactionProvider & { calls: TradesQuery[] } {
  const calls: TradesQuery[] = [];
  return {
    id,
    calls,
    getTrades: (q) => {
      calls.push(q);
      return impl(q);
    },
  };
}

function sourced(data: Trade[], source: ProviderId, freshness: Sourced<Trade[]>['freshness'] = 'realtime'): Sourced<Trade[]> {
  return { data, source, fetchedAt: 1_759_000_001_000, freshness };
}

function mintInfo(supply: number): MintInfo {
  return { mint: MINT, decimals: 6, supply, tokenProgram: 'token-2022', mintAuthority: null, freezeAuthority: null, fetchedAt: 1 };
}

function deps(overrides: Partial<TradesDeps> = {}): TradesDeps {
  return {
    rpcTrades: null,
    birdeye: null,
    solanaTracker: null,
    coingeckoPro: null,
    solPriceUsd: vi.fn(async () => 200),
    mintInfo: vi.fn(async () => mintInfo(1_000_000_000)),
    ...overrides,
  };
}

describe('enrichTradesUsd', () => {
  it('derives USD value, price and market cap from SOL amounts, SOL/USD and supply', () => {
    const input = [trade({ signature: 's1', solAmount: 2, quoteAmount: 2, quoteSymbol: 'SOL', tokenAmount: 1_000_000 })];
    const { trades, usedSolPrice, usedSupply } = enrichTradesUsd(input, { solUsd: 150, supply: 1_000_000_000 });
    expect(trades[0]?.usdValue).toBe(300);
    expect(trades[0]?.priceUsd).toBeCloseTo(0.0003, 12);
    expect(trades[0]?.marketCapUsd).toBeCloseTo(300_000, 6);
    expect(usedSolPrice).toBe(true);
    expect(usedSupply).toBe(true);
    // Never mutates the input (values may be shared through the cache).
    expect(input[0]?.usdValue).toBeUndefined();
  });

  it('never overwrites provider values', () => {
    const input = [trade({ signature: 's1', solAmount: 2, tokenAmount: 10, usdValue: 1, priceUsd: 0.5, marketCapUsd: 42 })];
    const { trades, usedSolPrice, usedSupply } = enrichTradesUsd(input, { solUsd: 150, supply: 1_000 });
    expect(trades[0]).toBe(input[0]);
    expect(usedSolPrice).toBe(false);
    expect(usedSupply).toBe(false);
  });

  it('leaves USD fields absent without a SOL price, and skips non-SOL quotes', () => {
    const sol = trade({ signature: 's1', solAmount: 1, tokenAmount: 10 });
    const usdc = trade({ signature: 's2', quoteAmount: 5, quoteSymbol: 'USDC', tokenAmount: 10 });
    const { trades, usedSolPrice } = enrichTradesUsd([sol, usdc], { solUsd: undefined, supply: 100 });
    expect(trades[0]?.usdValue).toBeUndefined();
    expect(trades[0]?.priceUsd).toBeUndefined();
    expect(trades[0]?.marketCapUsd).toBeUndefined();
    expect(trades[1]).toBe(usdc);
    expect(usedSolPrice).toBe(false);
  });

  it('computes market cap from a provider USD price when supply is known', () => {
    const input = [trade({ signature: 's1', priceUsd: 0.002, quoteSymbol: 'USDC', quoteAmount: 2, tokenAmount: 1_000 })];
    const { trades, usedSupply } = enrichTradesUsd(input, { supply: 1_000_000_000 });
    expect(trades[0]?.marketCapUsd).toBeCloseTo(2_000_000, 6);
    expect(usedSupply).toBe(true);
  });

  it('ignores invalid inputs (zero token amount, non-positive price or supply)', () => {
    const input = [trade({ signature: 's1', solAmount: 1, tokenAmount: 0 })];
    const { trades } = enrichTradesUsd(input, { solUsd: -5, supply: 0 });
    expect(trades[0]).toBe(input[0]);
    const withPrice = enrichTradesUsd(input, { solUsd: 100, supply: Number.NaN }).trades[0];
    expect(withPrice?.usdValue).toBe(100);
    expect(withPrice?.priceUsd).toBeUndefined();
  });

  it('completes a USD pair from the trade itself instead of mixing in the current SOL price', () => {
    // The provider valued the trade at execution (SOL was ~140 then); today's 150 must not leak into the price.
    const input = [trade({ signature: 's1', solAmount: 2, quoteSymbol: 'SOL', tokenAmount: 1_000, usdValue: 280 })];
    const { trades, usedSolPrice } = enrichTradesUsd(input, { solUsd: 150 });
    expect(trades[0]?.usdValue).toBe(280);
    expect(trades[0]?.priceUsd).toBeCloseTo(0.28, 12);
    expect(usedSolPrice).toBe(false);

    const priced = enrichTradesUsd([trade({ signature: 's2', quoteSymbol: 'USDC', tokenAmount: 500, priceUsd: 0.01 })], {});
    expect(priced.trades[0]?.usdValue).toBeCloseTo(5, 12);
    expect(priced.usedSolPrice).toBe(false);
  });

  it('reports what needs fetching', () => {
    expect(tradesNeedUsd([trade({ signature: 'a', solAmount: 1 })])).toBe(true);
    expect(tradesNeedUsd([trade({ signature: 'a', solAmount: 1, usdValue: 5, priceUsd: 1 })])).toBe(false);
    // The trade's own USD value fills its price: no SOL price needed.
    expect(tradesNeedUsd([trade({ signature: 'a', solAmount: 1, tokenAmount: 10, usdValue: 5 })])).toBe(false);
    expect(tradesNeedSupply([trade({ signature: 'a', priceUsd: 1, marketCapUsd: 5 })])).toBe(false);
    expect(tradesNeedSupply([trade({ signature: 'a', priceUsd: 1 })])).toBe(true);
    expect(tradesNeedSupply([trade({ signature: 'a', quoteSymbol: 'USDC', usdValue: 5, tokenAmount: 10 })])).toBe(true);
  });
});

describe('loadTrades', () => {
  it('answers 501-style NotConfiguredError when no keyed feed exists', async () => {
    await expect(loadTrades({ mint: MINT, limit: 50 }, deps())).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it('requires a pool when only pool-bound feeds are configured', async () => {
    const rpc = provider('helius', async () => sourced([], 'helius'));
    await expect(loadTrades({ mint: MINT, limit: 50 }, deps({ rpcTrades: rpc }))).rejects.toBeInstanceOf(BadRequestError);
    expect(rpc.calls).toHaveLength(0);
  });

  it('skips pool-bound feeds without a pool and uses the next provider', async () => {
    const rpc = provider('helius', async () => sourced([], 'helius'));
    const bird = provider('birdeye', async () => sourced([trade({ signature: 'b1', usdValue: 5, priceUsd: 1, marketCapUsd: 9 })], 'birdeye', 'fast'));
    const result = await loadTrades({ mint: MINT, limit: 50 }, deps({ rpcTrades: rpc, birdeye: bird }));
    expect(rpc.calls).toHaveLength(0);
    expect(result.source).toBe('birdeye');
    expect(result.attempts).toEqual([{ provider: 'birdeye', ok: true }]);
  });

  it('fails over in order and enriches SOL-quoted RPC trades', async () => {
    const d = deps({
      rpcTrades: provider('helius', async () => {
        throw new ProviderError('helius', 'rate_limited', 'helius: HTTP 429');
      }),
      birdeye: provider('birdeye', async () => sourced([trade({ signature: 'x', solAmount: 1, quoteSymbol: 'SOL', tokenAmount: 1_000 })], 'birdeye', 'fast')),
    });
    const result = await loadTrades({ mint: MINT, pool: POOL, limit: 50 }, d);
    expect(result.source).toBe('birdeye');
    expect(result.attempts.map((a) => [a.provider, a.ok, a.code])).toEqual([
      ['helius', false, 'rate_limited'],
      ['birdeye', true, undefined],
    ]);
    expect(result.data[0]?.usdValue).toBe(200);
    expect(result.data[0]?.priceUsd).toBeCloseTo(0.2, 12);
    expect(result.data[0]?.marketCapUsd).toBeCloseTo(200_000_000, 3);
    expect(result.notes).toEqual([TRADES_SOL_USD_NOTE, TRADES_MC_NOTE]);
    expect(d.mintInfo).toHaveBeenCalledWith(MINT);
  });

  it('passes mint, pool and limit through and caps the result length', async () => {
    const many = Array.from({ length: 5 }, (_, i) => trade({ signature: `s${i}`, usdValue: 1, priceUsd: 1, marketCapUsd: 1 }));
    const st = provider('solanatracker', async () => sourced(many, 'solanatracker', 'fast'));
    const d = deps({ solanaTracker: st });
    const result = await loadTrades({ mint: MINT, pool: POOL, limit: 3 }, d);
    expect(st.calls[0]).toEqual({ mint: MINT, pool: POOL, limit: 3 });
    expect(result.data).toHaveLength(3);
    // Nothing to enrich: neither the SOL price nor the mint supply is fetched.
    expect(d.solPriceUsd).not.toHaveBeenCalled();
    expect(d.mintInfo).not.toHaveBeenCalled();
    expect(result.notes).toBeUndefined();
  });

  it('returns the newest trades first before capping, whatever order the provider used', async () => {
    const t = (signature: string, timestamp: number) => trade({ signature, timestamp, usdValue: 1, priceUsd: 1, marketCapUsd: 1 });
    const oldestFirst = [t('a', 1_000), t('b', 2_000), t('c', 3_000), t('d', 4_000)];
    const st = provider('solanatracker', async () => sourced(oldestFirst, 'solanatracker', 'fast'));
    const result = await loadTrades({ mint: MINT, pool: POOL, limit: 2 }, deps({ solanaTracker: st }));
    expect(result.data.map((x) => x.signature)).toEqual(['d', 'c']);
    // The provider's array (possibly shared through a cache) is left untouched.
    expect(oldestFirst.map((x) => x.signature)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('omits enrichment honestly when the SOL price is unavailable', async () => {
    const d = deps({
      coingeckoPro: provider('coingecko', async () => sourced([trade({ signature: 'x', solAmount: 1, tokenAmount: 10 })], 'coingecko')),
      solPriceUsd: vi.fn(async () => undefined),
      mintInfo: vi.fn(async () => undefined),
    });
    const result = await loadTrades({ mint: MINT, pool: POOL, limit: 10 }, d);
    expect(result.data[0]?.usdValue).toBeUndefined();
    expect(result.data[0]?.marketCapUsd).toBeUndefined();
    expect(result.notes).toBeUndefined();
  });

  it('throws a ChainError carrying every attempt when all feeds fail', async () => {
    const d = deps({
      birdeye: provider('birdeye', async () => {
        throw new ProviderError('birdeye', 'http', 'birdeye: HTTP 500', { status: 500 });
      }),
      solanaTracker: provider('solanatracker', async () => {
        throw new ProviderError('solanatracker', 'timeout', 'solanatracker: timeout');
      }),
    });
    const error = await loadTrades({ mint: MINT, limit: 10 }, d).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).attempts.map((a) => a.provider)).toEqual(['birdeye', 'solanatracker']);
  });
});
