import 'server-only';
import { ChainError, fillMissing, runChain, type ChainAttempt, type ChainResult } from '@/lib/core/chain';
import type { DiscoverList, DiscoverQuery, DiscoverWindow, ProviderId, TokenDiscoveryProvider, TokenRowsProvider } from '@/lib/core/providers';
import type { Sourced, TokenRow } from '@/lib/core/types';
import { describeError, isAbortError, isProviderError } from '@/lib/net/errors';
import type { JupiterAdapter, JupiterUltraInfo } from '@/lib/providers/jupiter';
import { NotConfiguredError } from './errors';
import { leastFresh } from './envelope';

/**
 * /api/v1/discover and /api/v1/tokens: keyed discovery and batch token rows
 * (server Jupiter key → CoinGecko key). Discovery rows are enriched with
 * Jupiter Ultra holder-risk extras when available (optional).
 */

export const DISCOVER_LISTS: readonly DiscoverList[] = ['trending', 'top', 'organic', 'new'];
export const DISCOVER_WINDOWS: readonly DiscoverWindow[] = ['5m', '1h', '6h', '24h'];
export const DISCOVER_DEFAULT_LIMIT = 50;
export const DISCOVER_MAX_LIMIT = 100;
export const TOKENS_MAX_MINTS = 100;

export const ULTRA_UNAVAILABLE_NOTE = 'Jupiter Ultra enrichment unavailable: sniper, insider and bundler data omitted';

export interface DiscoverDeps {
  jupiter: (TokenDiscoveryProvider & Pick<JupiterAdapter, 'getUltraInfo'>) | null;
  coingecko: TokenDiscoveryProvider | null;
}

export interface TokenRowsDeps {
  jupiter: TokenRowsProvider | null;
  coingecko: TokenRowsProvider | null;
}

/**
 * Fill row gaps from Jupiter Ultra: holder-risk percentages (never
 * overwriting the row's own values) and bonding progress for rows already
 * known to be on a launchpad curve. Returns new rows; `changed` tells whether
 * Ultra contributed anything.
 */
export function applyUltraInfo(rows: readonly TokenRow[], info: Readonly<Record<string, JupiterUltraInfo>>): { rows: TokenRow[]; changed: boolean } {
  let changed = false;
  const out = rows.map((row) => {
    const extra = info[row.token.mint];
    if (!extra) return row;
    let next = row;
    const riskKeys = Object.keys(extra.risk) as Array<keyof JupiterUltraInfo['risk']>;
    if (riskKeys.some((k) => extra.risk[k] !== undefined && row.risk?.[k] === undefined)) {
      next = { ...next, risk: fillMissing({ ...(row.risk ?? {}) }, extra.risk) };
    }
    const launchpad = row.token.launchpad;
    if (launchpad?.stage === 'bonding' && launchpad.progressPct === undefined && extra.progressPct !== undefined) {
      next = {
        ...next,
        token: { ...next.token, launchpad: { ...launchpad, progressPct: Math.min(100, Math.max(0, extra.progressPct)), progressSource: 'jupiter' } },
      };
    }
    if (next !== row) changed = true;
    return next;
  });
  return { rows: out, changed };
}

/** Lists the CoinGecko on-chain API ranks (it has no organic-score ranking). */
export const COINGECKO_DISCOVER_LISTS: readonly DiscoverList[] = ['trending', 'top', 'new'];

export async function loadDiscover(query: DiscoverQuery, deps: DiscoverDeps): Promise<ChainResult<TokenRow[]>> {
  if (!deps.jupiter && !deps.coingecko) {
    throw new NotConfiguredError('Server discovery needs JUPITER_API_KEY or COINGECKO_API_KEY. The browser uses public sources instead.');
  }
  const coingecko = deps.coingecko && COINGECKO_DISCOVER_LISTS.includes(query.list) ? deps.coingecko : null;
  const providers = [deps.jupiter, coingecko].filter((p): p is TokenDiscoveryProvider => p !== null);
  if (!providers.length) {
    throw new NotConfiguredError(`Server discovery of the ${query.list} list needs JUPITER_API_KEY. The browser uses public sources instead.`);
  }
  const result = await runChain(
    `discover ${query.list}`,
    providers.map((p) => ({ id: p.id, run: () => p.discover(query) })),
    { accept: (r) => r.data.length > 0 },
  );
  if (!deps.jupiter || !result.data.length) return result;

  let ultra: Sourced<Record<string, JupiterUltraInfo>> | undefined;
  try {
    ultra = await deps.jupiter.getUltraInfo(result.data.map((r) => r.token.mint));
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { ...result, notes: [...(result.notes ?? []), ULTRA_UNAVAILABLE_NOTE] };
  }
  const enriched = applyUltraInfo(result.data, ultra.data);
  if (!enriched.changed) return result;
  const contributors: ProviderId[] = [...(result.contributors ?? [])];
  if (ultra.source !== result.source && !contributors.includes(ultra.source)) contributors.push(ultra.source);
  return { ...result, data: enriched.rows, ...(contributors.length ? { contributors } : {}) };
}

/**
 * Rows for arbitrary mints with coverage failover: each provider is asked only
 * for the mints still missing, so a token one index lacks can come from the
 * next. Rows keep the requested order; unknown mints are simply absent.
 */
export async function loadTokenRows(mints: readonly string[], deps: TokenRowsDeps): Promise<ChainResult<TokenRow[]>> {
  const providers = [deps.jupiter, deps.coingecko].filter((p): p is TokenRowsProvider => p !== null);
  if (!providers.length) {
    throw new NotConfiguredError('Server token rows need JUPITER_API_KEY or COINGECKO_API_KEY. The browser uses public sources instead.');
  }
  const wanted = new Set(mints);
  const byMint = new Map<string, TokenRow>();
  const attempts: ChainAttempt[] = [];
  const contributing: Sourced<TokenRow[]>[] = [];
  let firstOk: Sourced<TokenRow[]> | undefined;

  for (const provider of providers) {
    const missing = mints.filter((m) => !byMint.has(m));
    if (!missing.length) break;
    try {
      const result = await provider.getRows(missing);
      attempts.push({ provider: provider.id, ok: true });
      firstOk ??= result;
      let added = 0;
      for (const row of result.data) {
        const mint = row.token.mint;
        if (!wanted.has(mint) || byMint.has(mint)) continue;
        byMint.set(mint, row);
        added++;
      }
      if (added > 0) contributing.push(result);
    } catch (error) {
      if (isAbortError(error)) throw error;
      attempts.push({
        provider: provider.id,
        ok: false,
        error: describeError(error),
        code: isProviderError(error) ? error.code : undefined,
      });
    }
  }
  if (!firstOk) throw new ChainError('tokens', attempts);

  const rows = mints.map((m) => byMint.get(m)).filter((r): r is TokenRow => r !== undefined);
  const primary = contributing[0] ?? firstOk;
  const parts = contributing.length ? contributing : [firstOk];
  const contributors = contributing.slice(1).map((r) => r.source).filter((s) => s !== primary.source);
  const notes = parts.flatMap((r) => r.notes ?? []);
  return {
    data: rows,
    source: primary.source,
    ...(contributors.length ? { contributors } : {}),
    fetchedAt: Math.min(...parts.map((r) => r.fetchedAt)),
    freshness: leastFresh(parts.map((r) => r.freshness)) ?? primary.freshness,
    ...(notes.length ? { notes } : {}),
    attempts,
  };
}
