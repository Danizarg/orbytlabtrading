import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '@/lib/net/errors';

const { browserRpc, server } = await import('../sources');
const { loadSolBalance, tokenBalanceFrom } = await import('./useWalletBalances');

const OWNER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

beforeEach(() => vi.restoreAllMocks());

describe('loadSolBalance', () => {
  it('reads exact lamports from the browser RPC', async () => {
    vi.spyOn(browserRpc, 'getBalance').mockResolvedValue(1_234_567_891);
    const portfolio = vi.spyOn(server.portfolio, 'getPortfolio');
    const reading = await loadSolBalance(OWNER);
    expect(reading).toMatchObject({ lamports: 1_234_567_891n, sol: 1.234567891, source: 'solana-rpc' });
    expect(portfolio).not.toHaveBeenCalled();
  });

  it('falls back to the server portfolio route', async () => {
    vi.spyOn(browserRpc, 'getBalance').mockRejectedValue(new ProviderError('solana-rpc', 'rate_limited', 'browser-rpc: HTTP 429'));
    vi.spyOn(server.portfolio, 'getPortfolio').mockResolvedValue({
      data: { address: OWNER, sol: 2.5, tokens: [], pricedCount: 0, unpricedCount: 0, updatedAt: 5 },
      source: 'orbyt',
      fetchedAt: 5,
      freshness: 'realtime',
    });
    await expect(loadSolBalance(OWNER)).resolves.toMatchObject({ lamports: 2_500_000_000n, sol: 2.5, source: 'orbyt', fetchedAt: 5 });
  });

  it('propagates aborts without trying the fallback', async () => {
    vi.spyOn(browserRpc, 'getBalance').mockRejectedValue(new ProviderError('solana-rpc', 'aborted', 'aborted'));
    const portfolio = vi.spyOn(server.portfolio, 'getPortfolio');
    await expect(loadSolBalance(OWNER)).rejects.toMatchObject({ code: 'aborted' });
    expect(portfolio).not.toHaveBeenCalled();
  });
});

describe('tokenBalanceFrom', () => {
  it('finds the token balance', () => {
    expect(tokenBalanceFrom([{ mint: MINT, amount: 1_000.5, decimals: 5 }], MINT)).toEqual({ amount: 1_000.5, decimals: 5, held: true });
  });

  it('a complete portfolio without the token means a zero balance', () => {
    expect(tokenBalanceFrom([], MINT)).toEqual({ amount: 0, held: false });
  });

  it('a portfolio that skipped unreadable balances leaves it unknown', () => {
    expect(tokenBalanceFrom([], MINT, ['2 token balances could not be read and are omitted'])).toEqual({ amount: undefined, held: false });
  });
});
