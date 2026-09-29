'use client';

import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatPct } from '@/lib/core/format';
import type { ProviderId } from '@/lib/core/providers';
import type { ChainAttempt } from '@/lib/core/chain';
import type { Freshness, RiskLevel, RiskReport } from '@/lib/core/types';
import { displayFlags, errorLines, providerLabel, riskTone, type RiskMetricKey } from '@/lib/services/token';
import { Dash, ErrorLines, Pane, SourceLine } from './parts';

const METRICS: ReadonlyArray<{ key: RiskMetricKey; label: string; field: keyof RiskReport }> = [
  { key: 'top10', label: 'Top10', field: 'top10Pct' },
  { key: 'dev', label: 'Dev', field: 'devHoldingPct' },
  { key: 'snipers', label: 'Snipers', field: 'snipersPct' },
  { key: 'insiders', label: 'Insiders', field: 'insidersPct' },
  { key: 'bundlers', label: 'Bundlers', field: 'bundlersPct' },
  { key: 'bots', label: 'Bots', field: 'botHoldersPct' },
];

const TONE = { ok: 'text-fg-dim', warn: 'text-warn', danger: 'text-down', unknown: 'text-faint' } as const;

const LEVEL_ICON: Record<RiskLevel, typeof Info> = { info: Info, good: CircleCheck, warn: TriangleAlert, danger: CircleAlert };
const LEVEL_CLASS: Record<RiskLevel, string> = { info: 'text-info', good: 'text-up', warn: 'text-warn', danger: 'text-down' };

function Authority({ label, disabled, fromChain }: { label: string; disabled: boolean | undefined; fromChain: boolean }) {
  return (
    <div className="flex h-6 items-center justify-between text-xs" title={fromChain ? `${label} read from the mint account on-chain` : `${label} as reported by the provider`}>
      <span className="text-muted">{label}</span>
      {disabled === undefined ? (
        <Dash />
      ) : disabled ? (
        <span className="inline-flex items-center gap-1 text-up">
          <CircleCheck aria-hidden className="size-3" /> Revoked
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-down">
          <CircleAlert aria-hidden className="size-3" /> Enabled
        </span>
      )}
    </div>
  );
}

export function RiskCard({
  risk,
  fetchedAt,
  freshness,
  attempts,
  notes,
  error,
  isPending,
  authoritiesFromChain,
  className,
}: {
  risk?: RiskReport;
  fetchedAt?: number;
  freshness?: Freshness;
  attempts?: readonly ChainAttempt[];
  notes?: readonly string[];
  error?: unknown;
  isPending: boolean;
  authoritiesFromChain: boolean;
  className?: string;
}) {
  const flags = displayFlags(risk);
  const sources: ProviderId[] = risk?.sources ?? [];
  return (
    <Pane title="Audit" className={className} actions={<FreshnessBadge updatedAt={fetchedAt} error={error ? 'Risk data unavailable' : undefined} />}>
      <div className="px-3 py-2">
        {!risk && isPending && (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        )}
        {!risk && !isPending && error !== undefined && <ErrorLines lines={errorLines(error)} />}
        {!risk && !isPending && error === undefined && <p className="text-2xs text-faint">No audit data reported for this token.</p>}
        {risk && (
          <>
            <div className="grid grid-cols-3 gap-x-3 gap-y-1">
              {METRICS.map((m) => {
                const value = risk[m.field];
                const pct = typeof value === 'number' ? value : undefined;
                const tone = riskTone(m.key, pct);
                return (
                  <div key={m.key} className="flex h-6 items-center justify-between text-xs" title={`${m.label} share of supply`}>
                    <span className="text-muted">{m.label}</span>
                    <span className={cn('tabular', TONE[tone])}>{pct === undefined ? <Dash /> : formatPct(pct, { signed: false, decimals: 1 })}</span>
                  </div>
                );
              })}
            </div>
            <div className="mt-1 border-t border-line pt-1">
              <Authority label="Mint authority" disabled={risk.mintAuthorityDisabled} fromChain={authoritiesFromChain} />
              <Authority label="Freeze authority" disabled={risk.freezeAuthorityDisabled} fromChain={authoritiesFromChain} />
              {(risk.organicScore !== undefined || risk.providerScore || risk.devLaunches !== undefined) && (
                <div className="flex h-6 items-center gap-3 text-2xs text-muted">
                  {risk.organicScore !== undefined && (
                    <span title="Jupiter organic activity score (0–100)">
                      Organic <span className="tabular text-fg-dim">{Math.round(risk.organicScore)}</span>
                    </span>
                  )}
                  {risk.providerScore && (
                    <span title={`${risk.providerScore.label} (max ${risk.providerScore.max})`}>
                      {risk.providerScore.label} <span className="tabular text-fg-dim">{Math.round(risk.providerScore.value)}</span>
                    </span>
                  )}
                  {risk.devLaunches !== undefined && (
                    <span title="Tokens launched by the creator">
                      Dev launches <span className="tabular text-fg-dim">{risk.devLaunches}</span>
                    </span>
                  )}
                </div>
              )}
            </div>
            {flags.length > 0 && (
              <ul className="mt-1 space-y-0.5 border-t border-line pt-1">
                {flags.map((f) => {
                  const Icon = LEVEL_ICON[f.level];
                  return (
                    <li key={`${f.label}-${f.source}`} className="flex items-start gap-1.5 text-2xs" title={f.detail ? `${f.detail} · ${providerLabel(f.source)}` : providerLabel(f.source)}>
                      <Icon aria-hidden className={cn('mt-0.5 size-3 shrink-0', LEVEL_CLASS[f.level])} />
                      <span className="text-fg-dim">{f.label}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
      {risk && (
        <SourceLine
          source={sources[0]}
          contributors={sources.slice(1)}
          fetchedAt={fetchedAt}
          freshness={freshness}
          attempts={attempts}
          notes={notes}
          className="border-t border-line"
        />
      )}
    </Pane>
  );
}
