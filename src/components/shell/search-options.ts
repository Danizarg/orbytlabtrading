import type { AccountClass, AddressAction, RankedHit, SearchAttempt, SearchProviderId } from '@/data/hooks/useSearch';
import type { LaunchpadState } from '@/lib/core/types';
import type { ProviderErrorCode } from '@/lib/net/errors';
import type { RecentToken } from './recent';

/** Identity + headline numbers shown in a token option. */
export interface TokenOptionData {
  mint: string;
  symbol?: string;
  name?: string;
  image?: string;
  marketCapUsd?: number;
  liquidityUsd?: number;
  verified?: boolean;
  launchpad?: LaunchpadState;
}

export type SearchOption =
  | { key: string; kind: 'action'; group: 'address' | 'explorer'; href: string; external: boolean; action: AddressAction }
  | { key: string; kind: 'token'; group: 'tokens' | 'recent'; href: string; external: false; token: TokenOptionData };

export type SearchGroup = SearchOption['group'];

export const GROUP_TITLE: Record<SearchGroup, string> = { address: 'Address', tokens: 'Tokens', recent: 'Recent', explorer: 'Explorer' };

/** Group heading for address shortcuts, named after what the address is on-chain once known. */
export function addressGroupTitle(account: AccountClass | undefined): string {
  switch (account?.kind) {
    case 'mint':
      return 'Token mint';
    case 'token-account':
      return 'Token account';
    case 'wallet':
      return 'Wallet';
    case 'empty':
      return 'Unused address';
    case 'program':
      return 'Program';
    case 'program-account':
      return 'Program account';
    default:
      return GROUP_TITLE.address;
  }
}

const actionOption = (action: AddressAction): SearchOption => ({
  key: `action:${action.kind}:${action.value}`,
  kind: 'action',
  group: action.external ? 'explorer' : 'address',
  href: action.href,
  external: action.external,
  action,
});

/**
 * Options in keyboard order: in-app address shortcuts, then token hits (or
 * recent tokens for an empty query), then explorer links. A pool address
 * therefore opens the token it trades on Enter, not Solscan.
 */
export function buildOptions(input: { actions: readonly AddressAction[]; hits: readonly RankedHit[]; recent: readonly RecentToken[] }): SearchOption[] {
  const options: SearchOption[] = input.actions.filter((a) => !a.external).map(actionOption);
  const tokens = input.hits.length ? input.hits : input.recent;
  const group = input.hits.length ? 'tokens' : 'recent';
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token.mint)) continue;
    seen.add(token.mint);
    options.push({ key: `${group}:${token.mint}`, kind: 'token', group, href: `/trade/${token.mint}`, external: false, token: toOptionData(token) });
  }
  for (const action of input.actions) if (action.external) options.push(actionOption(action));
  return options;
}

function toOptionData(token: RankedHit | RecentToken): TokenOptionData {
  const data: TokenOptionData = { mint: token.mint };
  if (token.symbol) data.symbol = token.symbol;
  if (token.name) data.name = token.name;
  if (token.image) data.image = token.image;
  if ('source' in token) {
    if (token.marketCapUsd !== undefined) data.marketCapUsd = token.marketCapUsd;
    if (token.liquidityUsd !== undefined) data.liquidityUsd = token.liquidityUsd;
    if (token.verified !== undefined) data.verified = token.verified;
    if (token.launchpad) data.launchpad = token.launchpad;
  }
  return data;
}

/** Contiguous runs of options per group, with each option's global index. */
export function groupOptions(options: readonly SearchOption[]): { group: SearchGroup; items: { option: SearchOption; index: number }[] }[] {
  const out: { group: SearchGroup; items: { option: SearchOption; index: number }[] }[] = [];
  options.forEach((option, index) => {
    const last = out.at(-1);
    if (last && last.group === option.group) last.items.push({ option, index });
    else out.push({ group: option.group, items: [{ option, index }] });
  });
  return out;
}

/** Launch-stage chip text: "pump.fun 64%", "Migrated · pump.fun"; nothing for plain AMM tokens. */
export function stageBadge(launchpad: LaunchpadState | undefined): { text: string; tone: 'bonding' | 'migrated' } | null {
  if (!launchpad) return null;
  if (launchpad.stage === 'bonding') {
    const pct = launchpad.progressPct !== undefined && Number.isFinite(launchpad.progressPct) ? ` ${Math.floor(Math.min(100, Math.max(0, launchpad.progressPct)))}%` : '';
    return { text: `${launchpad.launchpad ?? 'Bonding'}${pct}`, tone: 'bonding' };
  }
  if (launchpad.stage === 'graduated') return { text: launchpad.launchpad ? `Migrated · ${launchpad.launchpad}` : 'Migrated', tone: 'migrated' };
  return null;
}

export const SEARCH_PROVIDER_LABEL: Record<SearchProviderId, string> = {
  jupiter: 'Jupiter',
  dexscreener: 'DEX Screener',
  geckoterminal: 'GeckoTerminal',
};

const REASON: Record<ProviderErrorCode, string> = {
  rate_limited: 'rate limited',
  timeout: 'timed out',
  network: 'unreachable',
  http: 'error',
  not_found: 'no match',
  malformed: 'bad response',
  not_configured: 'not configured',
  unsupported: 'unsupported',
  aborted: 'cancelled',
};

/** "Jupiter rate limited · DEX Screener unreachable" for failed attempts. */
export function describeFailures(attempts: readonly SearchAttempt[]): string {
  return attempts
    .filter((a) => !a.ok)
    .map((a) => `${SEARCH_PROVIDER_LABEL[a.provider]} ${a.code ? REASON[a.code] : 'unavailable'}`)
    .join(' · ');
}

/** Providers whose answers are on screen, primary first. */
export function answeringProviders(attempts: readonly SearchAttempt[], hits: readonly RankedHit[]): SearchProviderId[] {
  const used = new Set<string>(hits.flatMap((h) => h.sources));
  return attempts.filter((a) => a.ok && used.has(a.provider)).map((a) => a.provider);
}
