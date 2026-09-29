import 'server-only';
import type { PortfolioProvider, PriceProvider, ProviderId } from '@/lib/core/providers';
import type { Portfolio, Sourced, TokenBalance } from '@/lib/core/types';
import { isAbortError } from '@/lib/net/errors';

/**
 * /api/v1/wallet/[address]/portfolio: balances from the server RPC (native
 * SOL + both token programs). With a keyed server price source the balances
 * are priced here; otherwise they are returned unpriced and the browser
 * prices them from its own keyless quota.
 */

/** Tokens priced server-side per request (2 Price V3 calls): the rest stay unpriced for the client. */
export const PORTFOLIO_MAX_PRICED = 100;

export interface PortfolioDeps {
  portfolio: PortfolioProvider;
  /** Keyed price source (Jupiter with the deployment key); null → balances only. */
  prices: PriceProvider | null;
  solPriceUsd: () => Promise<number | undefined>;
}

function positive(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Price a portfolio from real quotes only. Tokens without a price stay
 * unpriced (counted, excluded from the total). The total needs the SOL price
 * unless the wallet holds no SOL; otherwise it is omitted. Returns a new object.
 */
export function pricePortfolio(portfolio: Portfolio, prices: Readonly<Record<string, number>>, solPriceUsd: number | undefined): Portfolio {
  let pricedCount = 0;
  let tokenValue = 0;
  const tokens = portfolio.tokens.map((token): TokenBalance => {
    const price = prices[token.mint] ?? token.priceUsd;
    if (!positive(price)) {
      const { priceUsd: _p, valueUsd: _v, ...rest } = token;
      return rest;
    }
    const valueUsd = token.amount * price;
    pricedCount++;
    tokenValue += valueUsd;
    return { ...token, priceUsd: price, valueUsd };
  });
  const solPrice = positive(solPriceUsd) ? solPriceUsd : undefined;
  const out: Portfolio = {
    ...portfolio,
    tokens,
    pricedCount,
    unpricedCount: tokens.length - pricedCount,
  };
  delete out.solPriceUsd;
  delete out.totalUsd;
  if (solPrice !== undefined) out.solPriceUsd = solPrice;
  // SOL must be valued (or absent), and something must actually have been valued:
  // a wallet whose tokens all failed to price gets no total rather than a made-up $0.
  const solValued = solPrice !== undefined || portfolio.sol === 0;
  const somethingValued = pricedCount > 0 || (portfolio.sol > 0 && solPrice !== undefined) || tokens.length === 0;
  if (solValued && somethingValued) out.totalUsd = (solPrice !== undefined ? portfolio.sol * solPrice : 0) + tokenValue;
  return out;
}

export async function loadPortfolio(address: string, deps: PortfolioDeps): Promise<Sourced<Portfolio>> {
  const base = await deps.portfolio.getPortfolio(address);
  // No keyed price source: balances only (pricedCount 0, no total); the client prices them.
  if (!deps.prices) return base;

  const toPrice = base.data.tokens.slice(0, PORTFOLIO_MAX_PRICED).map((t) => t.mint);
  const [pricesSettled, solSettled] = await Promise.allSettled([
    toPrice.length ? deps.prices.getPrices(toPrice) : Promise.resolve(undefined),
    deps.solPriceUsd(),
  ]);
  for (const s of [pricesSettled, solSettled]) {
    if (s.status === 'rejected' && isAbortError(s.reason)) throw s.reason;
  }
  const quoted = pricesSettled.status === 'fulfilled' ? pricesSettled.value : undefined;
  const solPrice = solSettled.status === 'fulfilled' ? solSettled.value : undefined;
  const priced = pricePortfolio(base.data, quoted?.data ?? {}, solPrice);

  const notes = [...(base.notes ?? [])];
  const skipped = Math.max(0, base.data.tokens.length - toPrice.length);
  if (pricesSettled.status === 'rejected') notes.push('Token prices unavailable right now; balances shown unpriced.');
  if (skipped > 0) notes.push(`${skipped} token balance${skipped === 1 ? '' : 's'} not priced server-side.`);
  if (solPrice === undefined && base.data.sol > 0) notes.push('SOL price unavailable; portfolio total omitted.');

  const contributors: ProviderId[] = [...(base.contributors ?? [])];
  if (quoted && priced.pricedCount > 0 && quoted.source !== base.source && !contributors.includes(quoted.source)) contributors.push(quoted.source);
  return {
    ...base,
    data: priced,
    ...(contributors.length ? { contributors } : {}),
    ...(notes.length ? { notes } : {}),
  };
}
