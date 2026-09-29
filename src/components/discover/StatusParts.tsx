'use client';

import { RotateCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNow } from '@/client/hooks/useNow';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/components/ui/cn';
import type { ChainResult } from '@/lib/core/chain';
import { formatAge, formatDateTime } from '@/lib/core/format';
import { PROVIDER_LABELS, type ProviderId } from '@/lib/core/providers';
import type { TokenRow } from '@/lib/core/types';
import {
  describeAttempt,
  errorLines,
  showsGeckoData,
  visibleFailures,
  type EnrichmentSnapshot,
  type UniverseSummary,
} from '@/lib/services/discover';

/** "12s ago" that ticks on its own. */
export function Ago({ at }: { at?: number }) {
  const now = useNow();
  if (!at) return <span>—</span>;
  return <span title={formatDateTime(at)}>{now ? `${formatAge(at, now)} ago` : '—'}</span>;
}

/** "in 40s" countdown that ticks on its own (empty once due). */
function In({ at }: { at?: number }) {
  const now = useNow();
  if (!at || !now || at <= now) return null;
  return <span> · retry in {formatAge(now, at)}</span>;
}

/** Display name of the provider that produced a result ("Jupiter", "Jupiter via ORBYT API"). */
export function sourceName(result: Pick<ChainResult<unknown>, 'source'> | undefined, winner: ProviderId | undefined): string | undefined {
  if (!result) return undefined;
  const label = PROVIDER_LABELS[result.source];
  return winner === 'orbyt' && result.source !== 'orbyt' ? `${label} via ORBYT API` : label;
}

function Sep() {
  return (
    <span aria-hidden className="text-faint">
      ·
    </span>
  );
}

const FOOTER = 'flex h-7 shrink-0 items-center gap-2 overflow-x-auto border-t border-line bg-panel px-3 text-2xs whitespace-nowrap text-muted scrollbar-none';

/** Enrichment provenance and Ultra failure notice (shared by both footers). */
function EnrichmentParts({ enrichment, dexRows }: { enrichment?: EnrichmentSnapshot; dexRows?: boolean }) {
  return (
    <>
      {(enrichment?.ultraAt || enrichment?.dexAt || dexRows) && (
        <>
          <Sep />
          <span>
            {[enrichment?.ultraAt && 'Risk: Jupiter Ultra', (enrichment?.dexAt || dexRows) && 'Pools: DEX Screener'].filter(Boolean).join(' · ')}
          </span>
        </>
      )}
      {enrichment?.errors.ultra && (
        <>
          <Sep />
          <span className="text-warn" title="Sniper, insider and bundler shares come from Jupiter Ultra (deprecated endpoint)">
            Risk extras unavailable ({enrichment.errors.ultra})
          </span>
        </>
      )}
    </>
  );
}

/**
 * Panel footer for a named list: counts, source + age, fallbacks, enrichment
 * sources and licence attribution ("On-chain data powered by GeckoTerminal"
 * whenever GeckoTerminal data is on screen; DEX Screener as plain text only).
 */
export function SourceFooter({
  result,
  winner,
  enrichment,
  rows,
  count,
}: {
  result?: ChainResult<TokenRow[]>;
  winner?: ProviderId;
  enrichment?: EnrichmentSnapshot;
  rows?: readonly TokenRow[];
  count: ReactNode;
}) {
  const failures = visibleFailures(result?.attempts);
  const firstFailure = failures[0];
  const notes = result?.notes ?? [];
  const indexed = result?.freshness === 'indexed';
  const dexRows = rows?.some((r) => r.market.source === 'dexscreener') || result?.contributors?.includes('dexscreener');
  return (
    <footer className={FOOTER}>
      <span className="tabular">{count}</span>
      {result && (
        <>
          <Sep />
          <span title={indexed ? 'Indexed data: the provider caches it for about 30–60 s' : undefined}>
            Source: <span className="text-fg-dim">{sourceName(result, winner)}</span> · updated <Ago at={result.fetchedAt} />
          </span>
        </>
      )}
      {firstFailure && result && (
        <>
          <Sep />
          <span className="text-warn" title={failures.map(describeAttempt).join('\n')}>
            Fallback · {describeAttempt(firstFailure)}
          </span>
        </>
      )}
      <EnrichmentParts enrichment={enrichment} dexRows={dexRows} />
      {notes.length > 0 && (
        <>
          <Sep />
          <span title={notes.join('\n')}>{notes[notes.length - 1]}</span>
        </>
      )}
      {showsGeckoData(result, rows) && <span className="ml-auto pl-3">On-chain data powered by GeckoTerminal</span>}
    </footer>
  );
}

/**
 * Footer for the "All" universe: "Loaded N tokens · Jupiter 4/4 ·
 * GeckoTerminal 6/9 · DEX Screener 1/1 · updated 12s ago", per-source
 * detail in the tooltip, failing sources with their retry countdown, and
 * the GeckoTerminal attribution whenever its rows are on screen.
 */
export function UniverseFooter({
  summary,
  enrichment,
  visible,
  hidden,
  showsGecko,
}: {
  summary: UniverseSummary;
  enrichment?: EnrichmentSnapshot;
  /** Rows on screen after filters. */
  visible: number;
  /** Rows removed by filters. */
  hidden: number;
  showsGecko: boolean;
}) {
  const detail = summary.providers
    .map((p) => `${p.label}: ${p.ok} ok${p.stale ? `, ${p.stale} stale` : ''}${p.pending ? `, ${p.pending} loading` : ''}${p.failed ? `, ${p.failed} failed` : ''} of ${p.total}`)
    .join('\n');
  const worst = summary.providers.find((p) => p.error);
  return (
    <footer className={FOOTER}>
      <span className="tabular">
        Loaded <span className="text-fg-dim">{summary.loaded.toLocaleString('en-US')}</span> token{summary.loaded === 1 ? '' : 's'}
        {hidden > 0 && (
          <span className="text-faint">
            {' '}
            · {visible.toLocaleString('en-US')} shown · {hidden.toLocaleString('en-US')} filtered out
          </span>
        )}
      </span>
      <Sep />
      <span title={detail} className="tabular">
        Sources:{' '}
        {summary.providers.map((p, i) => (
          <span key={p.provider}>
            {i > 0 && ' · '}
            <span className={cn(p.failed || p.stale ? 'text-warn' : 'text-fg-dim')}>
              {p.label} {p.ok + p.stale}/{p.total}
            </span>
          </span>
        ))}
      </span>
      {summary.pending > 0 && (
        <>
          <Sep />
          <span>
            {summary.pending} source{summary.pending === 1 ? '' : 's'} loading
          </span>
        </>
      )}
      {summary.updatedAt !== undefined && (
        <>
          <Sep />
          <span>
            updated <Ago at={summary.updatedAt} />
          </span>
        </>
      )}
      {worst?.error && (
        <>
          <Sep />
          <span className="text-warn" title={summary.errors.join('\n')}>
            {worst.error}
            {summary.errors.length > 1 && ` (+${summary.errors.length - 1})`}
            <In at={worst.retryAt} />
          </span>
        </>
      )}
      <EnrichmentParts enrichment={enrichment} />
      {showsGecko && <span className="ml-auto pl-3">On-chain data powered by GeckoTerminal</span>}
    </footer>
  );
}

/** Thin banner when a refresh failed but earlier data is still on screen. */
export function RefreshWarning({ error, lines, updatedAt }: { error?: unknown; lines?: readonly string[]; updatedAt?: number }) {
  const text = lines ?? errorLines(error);
  return (
    <div role="status" className="flex h-7 shrink-0 items-center gap-2 overflow-x-auto border-b border-line bg-warn-soft px-3 text-2xs whitespace-nowrap text-warn scrollbar-none">
      <TriangleAlert aria-hidden className="size-3 shrink-0" />
      <span>Refresh failed · {text.join(' · ')}</span>
      <span className="text-warn/80">
        · showing data from <Ago at={updatedAt} /> · retrying automatically
      </span>
    </div>
  );
}

/** Full error state (nothing to show yet): which providers failed and a manual retry. */
export function LoadError({
  what,
  error,
  lines,
  onRetry,
  retrying,
}: {
  what: string;
  error?: unknown;
  /** Pre-built lines (universe sources); `error` is used otherwise. */
  lines?: readonly string[];
  onRetry: () => void;
  retrying?: boolean;
}) {
  const text = lines ?? errorLines(error);
  return (
    <EmptyState tone="error" title={`${what} unavailable`}>
      <ul className="flex flex-col gap-0.5">
        {text.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="mt-2 text-faint">Keyless providers limit requests per browser. ORBYT retries automatically.</p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-line-strong px-2.5 py-1 text-2xs text-muted hover:bg-hover hover:text-fg"
      >
        <RotateCw aria-hidden className={retrying ? 'size-3 motion-safe:animate-spin' : 'size-3'} /> Retry now
      </button>
    </EmptyState>
  );
}
