'use client';

import { RotateCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNow } from '@/client/hooks/useNow';
import { EmptyState } from '@/components/ui/EmptyState';
import type { ChainResult } from '@/lib/core/chain';
import { formatAge, formatDateTime } from '@/lib/core/format';
import { PROVIDER_LABELS, type ProviderId } from '@/lib/core/providers';
import type { TokenRow } from '@/lib/core/types';
import { describeAttempt, errorLines, showsGeckoData, visibleFailures, type EnrichmentSnapshot } from '@/lib/services/discover';

/** "12s ago" that ticks on its own. */
export function Ago({ at }: { at?: number }) {
  const now = useNow();
  if (!at) return <span>—</span>;
  return <span title={formatDateTime(at)}>{now ? `${formatAge(at, now)} ago` : '—'}</span>;
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

/**
 * Panel footer: counts, source + age, fallbacks, enrichment sources and
 * licence attribution ("On-chain data powered by GeckoTerminal" whenever
 * GeckoTerminal data is on screen; DEX Screener as plain text only).
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
    <footer className="flex h-7 shrink-0 items-center gap-2 overflow-x-auto border-t border-line bg-panel px-3 text-2xs whitespace-nowrap text-muted scrollbar-none">
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

/** Thin banner when a refresh failed but earlier data is still on screen. */
export function RefreshWarning({ error, updatedAt }: { error: unknown; updatedAt?: number }) {
  return (
    <div role="status" className="flex h-7 shrink-0 items-center gap-2 overflow-x-auto border-b border-line bg-warn-soft px-3 text-2xs whitespace-nowrap text-warn scrollbar-none">
      <TriangleAlert aria-hidden className="size-3 shrink-0" />
      <span>Refresh failed · {errorLines(error).join(' · ')}</span>
      <span className="text-warn/80">
        · showing data from <Ago at={updatedAt} /> · retrying automatically
      </span>
    </div>
  );
}

/** Full error state (nothing to show yet): which providers failed and a manual retry. */
export function LoadError({ what, error, onRetry, retrying }: { what: string; error: unknown; onRetry: () => void; retrying?: boolean }) {
  return (
    <EmptyState tone="error" title={`${what} unavailable`}>
      <ul className="flex flex-col gap-0.5">
        {errorLines(error).map((line) => (
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
