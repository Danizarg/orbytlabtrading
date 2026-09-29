import { describe, expect, it, vi } from 'vitest';
import type { PortfolioProvider, PriceProvider } from '@/lib/core/providers';
import type { Portfolio, Sourced, TokenBalance } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import { loadPortfolio, PORTFOLIO_MAX_PRICED, pricePortfolio } from './portfolio';

const WALLET = '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A';
const A = '4ov9rwwS4iBHeTWGCrVaQYW1HzWK51MSfs8csGAApump';
const B = 'GJJ6TADXU6TdvBR8siNxLqYzbcwc6ixgxFCg7Ystpump';

function balance(mint: string, amount: number): TokenBalance {
  return { mint, amount, decimals: 6, tokenProgram: 'spl-token' };
}

function portfolio(tokens: TokenBalance[], sol = 2): Portfolio {
  return { address: WALLET, sol, tokens, pricedCount: 0, unpricedCount: tokens.length, updatedAt: 1_000 };
}

function rpcPortfolio(p: Portfolio): PortfolioProvider {
  return { id: 'solana-rpc', getPortfolio: async () => ({ data: p, source: 'solana-rpc', fetchedAt: 1_000, freshness: 'realtime' }) };
}

function prices(impl: (mints: string[]) => Promise<Sourced<Record<string, number>>>) {
  const getPrices = vi.fn(impl);
  const provider: PriceProvider = { id: 'jupiter', getPrices };
  return Object.assign(provider, { getPrices });
}

describe('pricePortfolio', () => {
  it('values priced tokens and SOL, excluding unpriced tokens from the total', () => {
    const out = pricePortfolio(portfolio([balance(A, 1_000), balance(B, 50)]), { [A]: 0.5 }, 100);
    expect(out.tokens[0]).toMatchObject({ mint: A, priceUsd: 0.5, valueUsd: 500 });
    expect(out.tokens[1]?.priceUsd).toBeUndefined();
    expect(out.tokens[1]?.valueUsd).toBeUndefined();
    expect(out.pricedCount).toBe(1);
    expect(out.unpricedCount).toBe(1);
    expect(out.solPriceUsd).toBe(100);
    expect(out.totalUsd).toBe(2 * 100 + 500);
  });

  it('omits the total when SOL is held but its price is unknown', () => {
    const out = pricePortfolio(portfolio([balance(A, 10)], 1.5), { [A]: 2 }, undefined);
    expect(out.totalUsd).toBeUndefined();
    expect(out.solPriceUsd).toBeUndefined();
    expect(out.pricedCount).toBe(1);
  });

  it('can total a wallet with no SOL without the SOL price', () => {
    expect(pricePortfolio(portfolio([balance(A, 10)], 0), { [A]: 2 }, undefined).totalUsd).toBe(20);
  });

  it('never reports a $0 total when nothing could be valued', () => {
    // No SOL, one token, no price: the total is unknown, not zero.
    expect(pricePortfolio(portfolio([balance(A, 10)], 0), {}, 150).totalUsd).toBeUndefined();
    expect(pricePortfolio(portfolio([balance(A, 10)], 0), {}, undefined).totalUsd).toBeUndefined();
    // A genuinely empty wallet is worth exactly zero.
    expect(pricePortfolio(portfolio([], 0), {}, undefined).totalUsd).toBe(0);
  });

  it('ignores zero, negative and non-finite prices', () => {
    const out = pricePortfolio(portfolio([balance(A, 10), balance(B, 10)]), { [A]: 0, [B]: Number.NaN }, 100);
    expect(out.pricedCount).toBe(0);
    expect(out.unpricedCount).toBe(2);
    expect(out.totalUsd).toBe(200);
  });

  it('does not mutate its input', () => {
    const input = portfolio([balance(A, 10)]);
    pricePortfolio(input, { [A]: 1 }, 100);
    expect(input.tokens[0]?.priceUsd).toBeUndefined();
    expect(input.totalUsd).toBeUndefined();
  });
});

describe('loadPortfolio', () => {
  it('returns RPC balances unpriced without a keyed price source', async () => {
    const base = portfolio([balance(A, 10)]);
    const solPriceUsd = vi.fn(async () => 100);
    const result = await loadPortfolio(WALLET, { portfolio: rpcPortfolio(base), prices: null, solPriceUsd });
    expect(result.data).toBe(base);
    expect(result.data.totalUsd).toBeUndefined();
    expect(solPriceUsd).not.toHaveBeenCalled();
  });

  it('prices balances with the keyed source and credits it', async () => {
    const p = prices(async () => ({ data: { [A]: 3 }, source: 'jupiter', fetchedAt: 900, freshness: 'fast' }));
    const result = await loadPortfolio(WALLET, { portfolio: rpcPortfolio(portfolio([balance(A, 10), balance(B, 1)])), prices: p, solPriceUsd: async () => 150 });
    expect(p.getPrices).toHaveBeenCalledWith([A, B]);
    expect(result.source).toBe('solana-rpc');
    expect(result.contributors).toEqual(['jupiter']);
    expect(result.data).toMatchObject({ pricedCount: 1, unpricedCount: 1, solPriceUsd: 150, totalUsd: 2 * 150 + 30 });
    expect(result.notes).toBeUndefined();
  });

  it('caps server-side pricing and says how many were left for the client', async () => {
    const tokens = Array.from({ length: PORTFOLIO_MAX_PRICED + 3 }, (_, i) => balance(i % 2 ? A : B, i + 1));
    const p = prices(async () => ({ data: {}, source: 'jupiter', fetchedAt: 900, freshness: 'fast' }));
    const result = await loadPortfolio(WALLET, { portfolio: rpcPortfolio(portfolio(tokens)), prices: p, solPriceUsd: async () => 150 });
    expect(p.getPrices.mock.calls[0]?.[0]).toHaveLength(PORTFOLIO_MAX_PRICED);
    expect(result.notes).toContain('3 token balances not priced server-side.');
    expect(result.contributors).toBeUndefined();
  });

  it('degrades to unpriced balances when pricing fails', async () => {
    const p = prices(async () => {
      throw new ProviderError('jupiter', 'rate_limited', 'jupiter: HTTP 429');
    });
    const result = await loadPortfolio(WALLET, { portfolio: rpcPortfolio(portfolio([balance(A, 10)], 0)), prices: p, solPriceUsd: async () => undefined });
    expect(result.data.pricedCount).toBe(0);
    expect(result.data.unpricedCount).toBe(1);
    expect(result.data.totalUsd).toBeUndefined();
    expect(result.notes).toEqual(['Token prices unavailable right now; balances shown unpriced.']);
  });

  it('notes an omitted total when the SOL price is unavailable', async () => {
    const p = prices(async () => ({ data: { [A]: 1 }, source: 'jupiter', fetchedAt: 900, freshness: 'fast' }));
    const result = await loadPortfolio(WALLET, { portfolio: rpcPortfolio(portfolio([balance(A, 10)], 1)), prices: p, solPriceUsd: async () => undefined });
    expect(result.data.totalUsd).toBeUndefined();
    expect(result.notes).toEqual(['SOL price unavailable; portfolio total omitted.']);
  });
});
