'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useCapabilities } from '@/client/capabilities';
import { ChainError, type ChainAttempt } from '@/lib/core/chain';
import type { ProviderId } from '@/lib/core/providers';
import type { Freshness, MintInfo, RiskReport, Sourced } from '@/lib/core/types';
import { describeError, isAbortError, isProviderError } from '@/lib/net/errors';
import { applyOnchainAuthorities, mergeRiskReports } from '@/lib/services/token';
import { POLL } from '../query';
import { jup, server } from '../sources';

/**
 * Risk / audit data merged from every source that answers (not a failover
 * chain: each provider knows different things). Precedence: keyed server
 * route (snipers / insiders / bundlers) → Jupiter (audit + Ultra extras) →
 * GeckoTerminal token info (passed in, shared with the overview). Mint and
 * freeze authorities come from the on-chain mint account when known.
 */

export const riskKey = (mint: string, serverRisk: boolean) => ['token-risk', mint, serverRisk] as const;

export interface RiskFetch {
  reports: Sourced<RiskReport>[];
  attempts: ChainAttempt[];
}

export async function loadRisk(mint: string, serverRisk: boolean, signal?: AbortSignal): Promise<RiskFetch> {
  const steps: Array<{ id: ProviderId; run: () => Promise<Sourced<RiskReport>> }> = [];
  if (serverRisk) steps.push({ id: 'orbyt', run: () => server.risk.getRisk(mint, signal) });
  steps.push({ id: 'jupiter', run: () => jup.getRisk(mint, signal) });

  const settled = await Promise.allSettled(steps.map((s) => s.run()));
  const reports: Sourced<RiskReport>[] = [];
  const attempts: ChainAttempt[] = [];
  settled.forEach((result, i) => {
    const step = steps[i];
    if (!step) return;
    if (result.status === 'fulfilled') {
      reports.push(result.value);
      attempts.push({ provider: step.id, ok: true });
    } else {
      if (isAbortError(result.reason)) throw result.reason;
      attempts.push({
        provider: step.id,
        ok: false,
        error: describeError(result.reason),
        code: isProviderError(result.reason) ? result.reason.code : undefined,
      });
    }
  });
  if (!reports.length) throw new ChainError('risk', attempts);
  return { reports, attempts };
}

export interface RiskInput {
  /** GeckoTerminal risk from the shared token-info query. */
  gecko?: Sourced<RiskReport>;
  geckoError?: unknown;
  mintInfo?: MintInfo;
}

export function useRisk(mint: string, input: RiskInput) {
  const { serverRisk } = useCapabilities();
  const query = useQuery({
    queryKey: riskKey(mint, serverRisk),
    queryFn: ({ signal }) => loadRisk(mint, serverRisk, signal),
    refetchInterval: POLL.slow,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });

  const { gecko, mintInfo } = input;
  const reports = query.data?.reports;
  const risk = useMemo(() => {
    const merged = mergeRiskReports(mint, [...(reports ?? []).map((r) => r.data), gecko?.data]);
    return applyOnchainAuthorities(mint, merged, mintInfo);
  }, [mint, reports, gecko, mintInfo]);

  const sources = [...(reports ?? []), ...(gecko ? [gecko] : [])];
  const fetchedAt = sources.length ? Math.max(...sources.map((s) => s.fetchedAt)) : undefined;
  const freshness: Freshness | undefined = sources.some((s) => s.freshness === 'indexed') ? 'indexed' : sources[0]?.freshness;
  const notes = [...new Set(sources.flatMap((s) => s.notes ?? []))];

  return {
    risk,
    query,
    attempts: query.data?.attempts ?? (query.error instanceof ChainError ? query.error.attempts : []),
    fetchedAt,
    freshness,
    notes,
    /** Nothing at all answered (not even GeckoTerminal). */
    error: !sources.length && !mintInfo ? (query.error ?? input.geckoError) : undefined,
    isPending: query.isPending && !gecko,
  };
}
