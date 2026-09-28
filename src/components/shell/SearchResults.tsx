'use client';

import { BadgeCheck, Boxes, ChartCandlestick, CornerDownLeft, ExternalLink, Receipt, RotateCw, Wallet } from 'lucide-react';
import Link from 'next/link';
import type { MouseEvent, ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { Skeleton } from '@/components/ui/Skeleton';
import { TokenAvatar } from '@/components/ui/TokenAvatar';
import type { UseSearchResult } from '@/data/hooks/useSearch';
import { formatUsd } from '@/lib/core/format';
import { shortAddress } from '@/lib/core/solana';
import {
  addressGroupTitle,
  answeringProviders,
  describeFailures,
  GROUP_TITLE,
  groupOptions,
  SEARCH_PROVIDER_LABEL,
  stageBadge,
  type SearchOption,
} from './search-options';

export type SearchVariant = 'inline' | 'sheet';

const TOKEN_GRID = 'grid grid-cols-[32px_minmax(0,1fr)_64px_64px] items-center gap-x-3 px-3';
const ACTION_GRID = 'grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-x-3 px-3';

export interface SearchResultsProps {
  variant: SearchVariant;
  listboxId: string;
  optionId: (index: number) => string;
  options: SearchOption[];
  active: number;
  search: UseSearchResult;
  onHover: (index: number) => void;
  onPick: (option: SearchOption, event: MouseEvent<HTMLAnchorElement>) => void;
  onClearRecent: () => void;
}

/** Listbox (options only, per ARIA), then status / empty / error lines and a footer with provenance. */
export function SearchResults({ variant, listboxId, optionId, options, active, search, onHover, onPick, onClearRecent }: SearchResultsProps) {
  const groups = groupOptions(options);
  const rowHeight = variant === 'sheet' ? 'h-12' : 'h-10';
  const showingRecent = groups.some((g) => g.group === 'recent');
  const providers = answeringProviders(search.attempts, search.hits);
  const failures = search.hits.length ? describeFailures(search.attempts) : '';
  const tokenCount = search.hits.length;

  return (
    <>
      <div id={listboxId} role="listbox" aria-label="Search results" className={cn(options.length > 0 && 'py-1')}>
        {groups.map(({ group, items }) => (
          <div key={group} role="group" aria-label={groupTitle(group, items, search)}>
            {group === 'tokens' ? (
              <div aria-hidden className={cn(TOKEN_GRID, 'h-6 text-2xs font-semibold tracking-wide text-faint uppercase')}>
                <span className="col-span-2">{GROUP_TITLE[group]}</span>
                <span className="text-right">MC</span>
                <span className="text-right">Liq</span>
              </div>
            ) : (
              <div aria-hidden className="flex h-6 items-center px-3 text-2xs font-semibold tracking-wide text-faint uppercase">
                {groupTitle(group, items, search)}
              </div>
            )}
            {items.map(({ option, index }) =>
              option.kind === 'action' ? (
                <ActionOption
                  key={option.key}
                  id={optionId(index)}
                  option={option}
                  active={index === active}
                  rowHeight={rowHeight}
                  onHover={() => onHover(index)}
                  onPick={onPick}
                />
              ) : (
                <TokenOption
                  key={option.key}
                  id={optionId(index)}
                  option={option}
                  active={index === active}
                  stale={search.isStale && option.group === 'tokens'}
                  rowHeight={rowHeight}
                  onHover={() => onHover(index)}
                  onPick={onPick}
                />
              ),
            )}
          </div>
        ))}
      </div>

      <StatusLine search={search} variant={variant} hasOptions={options.length > 0} />

      <span className="sr-only" aria-live="polite">
        {liveText(search, tokenCount)}
      </span>

      {(variant === 'inline' || providers.length > 0 || showingRecent) && (
        <div className="sticky bottom-0 flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-panel px-3 py-1.5 text-2xs text-faint">
          {variant === 'inline' && (
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              <span>navigate</span>
              <Kbd>↵</Kbd>
              <span>open</span>
              <Kbd>esc</Kbd>
              <span>close</span>
            </span>
          )}
          <span className="ml-auto flex min-w-0 items-center gap-2">
            {failures && <span className="truncate text-warn">{failures}</span>}
            {providers.length > 0 && <span className="shrink-0">via {providers.map((p) => SEARCH_PROVIDER_LABEL[p]).join(' · ')}</span>}
            {providers.includes('geckoterminal') && (
              <a href="https://www.geckoterminal.com" target="_blank" rel="noopener noreferrer" className="shrink-0 hover:text-fg hover:underline">
                On-chain data powered by GeckoTerminal
              </a>
            )}
            {showingRecent && (
              <button type="button" onClick={onClearRecent} className="shrink-0 rounded px-1 text-muted hover:bg-hover hover:text-fg">
                Clear recent
              </button>
            )}
          </span>
        </div>
      )}
    </>
  );
}

/** Address classes that can be (or lead to) a token, so an empty lookup is worth reporting. */
const TOKEN_LIKE: ReadonlySet<string> = new Set(['mint', 'program-account', 'unknown']);

/** Screen-reader summary of the lookup outcome. */
function liveText(search: UseSearchResult, count: number): string {
  if (search.isLoading || (search.parsed.kind !== 'text' && search.parsed.kind !== 'address')) return '';
  if (search.offline) return 'Offline';
  if (search.error) return 'Search unavailable';
  if (search.parsed.kind === 'address' && !count && search.account && !TOKEN_LIKE.has(search.account.kind)) return addressGroupTitle(search.account);
  return `${count} token${count === 1 ? '' : 's'} found`;
}

function groupTitle(group: SearchOption['group'], items: { option: SearchOption }[], search: UseSearchResult): string {
  if (group === 'address') return addressGroupTitle(search.account);
  const first = items[0]?.option;
  return first?.kind === 'action' && first.action.kind === 'tx' ? 'Transaction' : GROUP_TITLE[group];
}

function StatusLine({ search, variant, hasOptions }: { search: UseSearchResult; variant: SearchVariant; hasOptions: boolean }) {
  const { parsed, error, isLoading, hits } = search;
  if (parsed.kind === 'short') return <Hint>Type at least 2 characters</Hint>;
  if (parsed.kind === 'empty') {
    return hasOptions ? null : <Hint>Name, symbol, mint or wallet address. Pasted links from DEX Screener, pump.fun or Solscan work too.</Hint>;
  }
  if (parsed.kind === 'signature') return null;
  // A wallet, unused address, token account or program is not a token: its shortcuts say it all.
  if (parsed.kind === 'address' && !hits.length && search.account && !TOKEN_LIKE.has(search.account.kind)) return null;
  if (search.offline) return <Hint>Offline · search resumes when the connection returns.</Hint>;
  if (error) {
    return (
      <div role="alert" className="flex items-center gap-2 px-3 py-2.5 text-xs">
        <span className="min-w-0 flex-1 text-warn">Search unavailable · {describeFailures(error.attempts) || 'no provider answered'}</span>
        <button
          type="button"
          onClick={search.retry}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line-strong px-2 py-1 text-2xs text-muted hover:bg-hover hover:text-fg"
        >
          <RotateCw className="size-3" aria-hidden /> Retry
        </button>
      </div>
    );
  }
  if (isLoading && !hits.length) {
    return (
      <div aria-hidden className="py-1">
        {Array.from({ length: parsed.kind === 'address' ? 1 : 3 }, (_, i) => (
          <div key={i} className={cn(TOKEN_GRID, variant === 'sheet' ? 'h-12' : 'h-10')}>
            <span className="mx-1 size-6 overflow-hidden rounded-full">
              <Skeleton className="size-full" />
            </span>
            <span className="space-y-1.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-2.5 w-32" />
            </span>
            <span className="flex justify-end">
              <Skeleton className="h-3 w-10" />
            </span>
            <span className="flex justify-end">
              <Skeleton className="h-3 w-10" />
            </span>
          </div>
        ))}
      </div>
    );
  }
  if (!isLoading && !hits.length) {
    return <Hint>{parsed.kind === 'address' ? 'No token found for this address.' : `No tokens match “${parsed.text}”.`}</Hint>;
  }
  return null;
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="px-3 py-3 text-xs text-muted">{children}</p>;
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-line-strong px-1 font-sans text-2xs leading-none text-muted">{children}</kbd>;
}

interface OptionProps<K extends SearchOption['kind']> {
  id: string;
  option: Extract<SearchOption, { kind: K }>;
  active: boolean;
  rowHeight: string;
  onHover: () => void;
  onPick: (option: SearchOption, event: MouseEvent<HTMLAnchorElement>) => void;
}

const ACTION_ICON = { token: ChartCandlestick, wallet: Wallet, tx: Receipt, account: Boxes } as const;

function ActionOption({ id, option, active, rowHeight, onHover, onPick }: OptionProps<'action'>) {
  const Icon = ACTION_ICON[option.action.kind];
  const className = cn(ACTION_GRID, rowHeight, 'outline-none', active ? 'bg-hover' : 'hover:bg-hover');
  const body = (
    <>
      <span className="flex size-8 items-center justify-center rounded-md border border-line bg-panel-2 text-muted">
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] leading-5 font-medium text-fg">{option.action.label}</span>
        <span className="block truncate font-mono text-2xs text-faint" title={option.action.value}>
          {option.action.value}
        </span>
      </span>
      <span className="flex items-center gap-1.5 text-2xs text-faint">
        {option.external ? <ExternalLink className="size-3" aria-hidden /> : <span className="font-mono">/{option.href.split('/')[1]}</span>}
        {active && (
          <span className="hidden size-4 items-center justify-center rounded border border-line-strong text-muted sm:flex">
            <CornerDownLeft className="size-2.5" aria-hidden />
          </span>
        )}
      </span>
    </>
  );
  if (option.external) {
    return (
      <a
        id={id}
        role="option"
        aria-selected={active}
        tabIndex={-1}
        href={option.href}
        target="_blank"
        rel="noopener noreferrer"
        onMouseMove={active ? undefined : onHover}
        onClick={(e) => onPick(option, e)}
        className={className}
      >
        {body}
      </a>
    );
  }
  return (
    <Link
      id={id}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      href={option.href}
      prefetch={false}
      onMouseMove={active ? undefined : onHover}
      onClick={(e) => onPick(option, e)}
      className={className}
    >
      {body}
    </Link>
  );
}

function TokenOption({ id, option, active, stale, rowHeight, onHover, onPick }: OptionProps<'token'> & { stale: boolean }) {
  const t = option.token;
  const badge = stageBadge(t.launchpad);
  const recent = option.group === 'recent';
  const progress = t.launchpad?.stage === 'bonding' ? t.launchpad.progressPct : undefined;
  return (
    <Link
      id={id}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      href={option.href}
      prefetch={false}
      onMouseMove={active ? undefined : onHover}
      onClick={(e) => onPick(option, e)}
      className={cn(TOKEN_GRID, rowHeight, 'text-xs outline-none transition-opacity', active ? 'bg-hover' : 'hover:bg-hover', stale && 'opacity-50')}
    >
      <TokenAvatar src={t.image} symbol={t.symbol} size={24} progress={progress} />
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-1.5 leading-5">
          <span className="truncate text-[13px] font-semibold text-fg" title={t.symbol}>
            {t.symbol ?? shortAddress(t.mint)}
          </span>
          {t.verified && (
            <span title="Verified on Jupiter" className="flex shrink-0 text-info">
              <BadgeCheck className="size-3.5" aria-hidden />
              <span className="sr-only">Verified</span>
            </span>
          )}
          {badge && (
            <span
              className={cn(
                'shrink-0 rounded px-1 text-2xs leading-4 font-medium',
                badge.tone === 'bonding' ? 'bg-warn-soft text-warn' : 'bg-panel-3 text-muted',
              )}
            >
              {badge.text}
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-2xs">
          {t.name && (
            <span className="truncate text-muted" title={t.name}>
              {t.name}
            </span>
          )}
          <span className="shrink-0 font-mono text-faint">{shortAddress(t.mint)}</span>
        </span>
      </span>
      {recent ? (
        <span className="col-span-2" />
      ) : (
        <>
          <Metric label="Market cap" value={t.marketCapUsd} />
          <Metric label="Liquidity" value={t.liquidityUsd} />
        </>
      )}
    </Link>
  );
}

function Metric({ label, value }: { label: string; value: number | undefined }) {
  return (
    <span className={cn('text-right tabular', value === undefined ? 'text-faint' : 'text-fg-dim')}>
      <span className="sr-only">{label} </span>
      {formatUsd(value)}
    </span>
  );
}
