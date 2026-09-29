import 'server-only';
import { ChainError, fillMissing, type ChainAttempt, type ChainResult } from '@/lib/core/chain';
import type { ProviderId, TokenRiskProvider } from '@/lib/core/providers';
import type { RiskFlag, RiskReport, Sourced } from '@/lib/core/types';
import { describeError, isAbortError, isProviderError } from '@/lib/net/errors';
import { NotConfiguredError } from './errors';
import { leastFresh } from './envelope';

/**
 * /api/v1/risk: Solana Tracker and Birdeye risk reports fetched in parallel
 * and merged. The first provider's values win; the other only fills gaps.
 * Flags and sources are unions, so every signal stays attributed.
 */

export interface RiskDeps {
  solanaTracker: TokenRiskProvider | null;
  birdeye: TokenRiskProvider | null;
}

function flagKey(flag: RiskFlag): string {
  return `${flag.source}|${flag.level}|${flag.label}`;
}

/** Merge reports in precedence order (fillMissing for metrics, union for flags and sources). */
export function mergeRiskReports(reports: readonly RiskReport[]): RiskReport | undefined {
  const first = reports[0];
  if (!first) return undefined;
  let merged: RiskReport = { ...first };
  const flags: RiskFlag[] = [];
  const seenFlags = new Set<string>();
  const sources: ProviderId[] = [];
  let updatedAt = first.updatedAt;
  for (const report of reports) {
    if (report !== first) merged = fillMissing(merged, report);
    for (const flag of report.flags) {
      const key = flagKey(flag);
      if (seenFlags.has(key)) continue;
      seenFlags.add(key);
      flags.push(flag);
    }
    for (const source of report.sources) if (!sources.includes(source)) sources.push(source);
    // A merged report is only as recent as its oldest input.
    updatedAt = Math.min(updatedAt, report.updatedAt);
  }
  return { ...merged, mint: first.mint, flags, sources, updatedAt };
}

export async function loadRisk(mint: string, deps: RiskDeps): Promise<ChainResult<RiskReport>> {
  const providers = [deps.solanaTracker, deps.birdeye].filter((p): p is TokenRiskProvider => p !== null);
  if (!providers.length) {
    throw new NotConfiguredError('Server risk metrics need SOLANATRACKER_API_KEY or BIRDEYE_API_KEY. The browser uses public sources instead.');
  }
  const settled = await Promise.allSettled(providers.map((p) => p.getRisk(mint)));
  const attempts: ChainAttempt[] = [];
  const results: Sourced<RiskReport>[] = [];
  settled.forEach((outcome, i) => {
    const provider = providers[i];
    if (!provider) return;
    if (outcome.status === 'fulfilled') {
      if (outcome.value.data.mint === mint) {
        attempts.push({ provider: provider.id, ok: true });
        results.push(outcome.value);
      } else {
        attempts.push({ provider: provider.id, ok: false, error: `${provider.id}: report for a different token`, code: 'malformed' });
      }
    } else {
      if (isAbortError(outcome.reason)) throw outcome.reason;
      attempts.push({
        provider: provider.id,
        ok: false,
        error: describeError(outcome.reason),
        code: isProviderError(outcome.reason) ? outcome.reason.code : undefined,
      });
    }
  });
  const report = mergeRiskReports(results.map((r) => r.data));
  const [primary, ...others] = results;
  if (!primary || !report) throw new ChainError('risk', attempts);

  const notes = results.flatMap((r) => r.notes ?? []);
  return {
    data: report,
    source: primary.source,
    ...(others.length ? { contributors: others.map((r) => r.source) } : {}),
    fetchedAt: Math.min(...results.map((r) => r.fetchedAt)),
    freshness: leastFresh(results.map((r) => r.freshness)) ?? primary.freshness,
    ...(notes.length ? { notes } : {}),
    attempts,
  };
}
