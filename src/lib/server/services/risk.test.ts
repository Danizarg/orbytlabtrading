import { describe, expect, it } from 'vitest';
import { ChainError } from '@/lib/core/chain';
import type { ProviderId, TokenRiskProvider } from '@/lib/core/providers';
import type { RiskReport, Sourced } from '@/lib/core/types';
import { ProviderError } from '@/lib/net/errors';
import { NotConfiguredError } from './errors';
import { loadRisk, mergeRiskReports } from './risk';

const MINT = '4ov9rwwS4iBHeTWGCrVaQYW1HzWK51MSfs8csGAApump';

function report(source: ProviderId, partial: Partial<RiskReport> = {}): RiskReport {
  return { mint: MINT, flags: [], sources: [source], updatedAt: 10_000, ...partial };
}

function riskProvider(id: ProviderId, impl: () => Promise<Sourced<RiskReport>>): TokenRiskProvider {
  return { id, getRisk: impl };
}

function sourced(data: RiskReport, source: ProviderId, fetchedAt = 10_000, notes?: string[]): Sourced<RiskReport> {
  return { data, source, fetchedAt, freshness: 'indexed', ...(notes ? { notes } : {}) };
}

describe('mergeRiskReports', () => {
  it('keeps the first report values and fills gaps from the next', () => {
    const st = report('solanatracker', { top10Pct: 40, snipersPct: 3, providerScore: { value: 7, max: 10, label: 'Solana Tracker score' } });
    const be = report('birdeye', { top10Pct: 55, insidersPct: 12, mintAuthorityDisabled: true, updatedAt: 8_000 });
    const merged = mergeRiskReports([st, be]);
    expect(merged).toMatchObject({
      mint: MINT,
      top10Pct: 40,
      snipersPct: 3,
      insidersPct: 12,
      mintAuthorityDisabled: true,
      providerScore: { value: 7, max: 10, label: 'Solana Tracker score' },
      sources: ['solanatracker', 'birdeye'],
      updatedAt: 8_000,
    });
  });

  it('unions flags with attribution and drops exact duplicates only', () => {
    const a = report('solanatracker', {
      flags: [
        { level: 'warn', label: 'Top 10 holders own 60%', source: 'solanatracker' },
        { level: 'warn', label: 'Top 10 holders own 60%', source: 'solanatracker' },
      ],
    });
    const b = report('birdeye', { flags: [{ level: 'warn', label: 'Top 10 holders own 60%', source: 'birdeye' }] });
    const merged = mergeRiskReports([a, b]);
    expect(merged?.flags.map((f) => f.source)).toEqual(['solanatracker', 'birdeye']);
  });

  it('returns undefined for no reports', () => {
    expect(mergeRiskReports([])).toBeUndefined();
  });
});

describe('loadRisk', () => {
  it('is not configured without Solana Tracker or Birdeye', async () => {
    await expect(loadRisk(MINT, { solanaTracker: null, birdeye: null })).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it('merges both providers with Solana Tracker first', async () => {
    const result = await loadRisk(MINT, {
      solanaTracker: riskProvider('solanatracker', async () => sourced(report('solanatracker', { devHoldingPct: 2 }), 'solanatracker', 12_000)),
      birdeye: riskProvider('birdeye', async () =>
        sourced(report('birdeye', { devHoldingPct: 9, bundlersPct: 4 }), 'birdeye', 11_000, ['Holder profile unavailable (birdeye: rate limited).']),
      ),
    });
    expect(result.source).toBe('solanatracker');
    expect(result.contributors).toEqual(['birdeye']);
    expect(result.data).toMatchObject({ devHoldingPct: 2, bundlersPct: 4, sources: ['solanatracker', 'birdeye'] });
    expect(result.fetchedAt).toBe(11_000);
    expect(result.freshness).toBe('indexed');
    expect(result.notes).toEqual(['Holder profile unavailable (birdeye: rate limited).']);
    expect(result.attempts).toEqual([
      { provider: 'solanatracker', ok: true },
      { provider: 'birdeye', ok: true },
    ]);
  });

  it('serves one provider when the other fails, recording the failure', async () => {
    const result = await loadRisk(MINT, {
      solanaTracker: riskProvider('solanatracker', async () => {
        throw new ProviderError('solanatracker', 'rate_limited', 'solanatracker: HTTP 429');
      }),
      birdeye: riskProvider('birdeye', async () => sourced(report('birdeye', { top10Pct: 20 }), 'birdeye')),
    });
    expect(result.source).toBe('birdeye');
    expect(result.contributors).toBeUndefined();
    expect(result.attempts[0]).toMatchObject({ provider: 'solanatracker', ok: false, code: 'rate_limited', error: 'solanatracker: rate limited' });
  });

  it('rejects a report for a different token', async () => {
    const other = { ...report('birdeye'), mint: 'GJJ6TADXU6TdvBR8siNxLqYzbcwc6ixgxFCg7Ystpump' };
    const error = await loadRisk(MINT, { solanaTracker: null, birdeye: riskProvider('birdeye', async () => sourced(other, 'birdeye')) }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ChainError);
  });

  it('throws a ChainError with all attempts when both fail', async () => {
    const error = await loadRisk(MINT, {
      solanaTracker: riskProvider('solanatracker', async () => {
        throw new ProviderError('solanatracker', 'not_found', 'solanatracker: not found');
      }),
      birdeye: riskProvider('birdeye', async () => {
        throw new ProviderError('birdeye', 'not_found', 'birdeye: not found');
      }),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).allNotFound).toBe(true);
  });
});
