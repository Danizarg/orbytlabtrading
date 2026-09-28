import type { Portfolio, Sourced, TokenBalance } from '@/lib/core/types';
import type { PortfolioProvider, ProviderId } from '@/lib/core/providers';
import { num } from '@/lib/core/chain';
import { isSolanaAddress, LAMPORTS_PER_SOL, PROGRAMS } from '@/lib/core/solana';
import { ProviderError } from '@/lib/net/errors';
import { accountParsedInfo, type RpcClient, type RpcKeyedAccount } from './rpc';
import { rawToUi, toBigInt } from './units';

/**
 * Wallet holdings from raw RPC: native SOL (getBalance) plus token accounts
 * of BOTH token programs (getTokenAccountsByOwner takes one programId per
 * call). Balances are aggregated per mint and zero balances dropped (wallets
 * keep many empty accounts). No prices or metadata here: callers price the
 * tokens, so every token is counted as unpriced and totalUsd is omitted.
 */

interface MintAccumulator {
  raw: bigint;
  decimals: number;
  tokenProgram: TokenBalance['tokenProgram'];
}

function accumulate(into: Map<string, MintAccumulator>, accounts: RpcKeyedAccount[], tokenProgram: TokenBalance['tokenProgram']) {
  for (const { account } of accounts) {
    const parsed = accountParsedInfo(account);
    if (!parsed || parsed.type !== 'account') continue;
    const { info } = parsed;
    const mint = info.mint;
    const tokenAmount = info.tokenAmount;
    if (typeof mint !== 'string' || typeof tokenAmount !== 'object' || tokenAmount === null) continue;
    const amount = toBigInt((tokenAmount as Record<string, unknown>).amount);
    const decimals = num((tokenAmount as Record<string, unknown>).decimals);
    if (amount === undefined || decimals === undefined || !Number.isInteger(decimals)) continue;
    const prev = into.get(mint);
    if (prev) prev.raw += amount;
    else into.set(mint, { raw: amount, decimals, tokenProgram });
  }
}

export function createRpcPortfolioProvider(opts: { rpc: RpcClient; provider?: ProviderId }): PortfolioProvider {
  const { rpc } = opts;
  const id: ProviderId = opts.provider ?? rpc.provider;

  async function getPortfolio(address: string, signal?: AbortSignal): Promise<Sourced<Portfolio>> {
    if (!isSolanaAddress(address)) throw new ProviderError(id, 'not_found', `${rpc.label}: invalid wallet address`);
    const [lamports, splAccounts, token2022Accounts] = await Promise.all([
      rpc.getBalance(address, signal),
      rpc.getTokenAccountsByOwner(address, PROGRAMS.TOKEN, signal),
      rpc.getTokenAccountsByOwner(address, PROGRAMS.TOKEN_2022, signal),
    ]);
    const fetchedAt = Date.now();

    const byMint = new Map<string, MintAccumulator>();
    accumulate(byMint, splAccounts, 'spl-token');
    accumulate(byMint, token2022Accounts, 'token-2022');

    const tokens: TokenBalance[] = [];
    for (const [mint, acc] of byMint) {
      if (acc.raw <= 0n) continue;
      const amount = rawToUi(acc.raw, acc.decimals);
      if (amount === undefined || amount <= 0) continue;
      tokens.push({ mint, amount, decimals: acc.decimals, tokenProgram: acc.tokenProgram });
    }

    return {
      data: {
        address,
        sol: lamports / LAMPORTS_PER_SOL,
        tokens,
        pricedCount: 0,
        unpricedCount: tokens.length,
        updatedAt: fetchedAt,
      },
      source: id,
      fetchedAt,
      freshness: 'realtime',
    };
  }

  return { id, getPortfolio };
}
