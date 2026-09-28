import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeDex, normalizeLaunchpadName } from './dex';

const fixtureDir = (provider: string) => path.join(process.cwd(), 'tests/fixtures', provider);
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

/** Every Solana (dexId, labels) pair appearing in the DEX Screener fixtures. */
function dexScreenerPairs(): Array<{ dexId: string; labels?: string[] }> {
  const out = new Map<string, { dexId: string; labels?: string[] }>();
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    const rec = x as Record<string, unknown>;
    if (rec.chainId === 'solana' && typeof rec.dexId === 'string') {
      const labels = Array.isArray(rec.labels) ? rec.labels.filter((l): l is string => typeof l === 'string') : undefined;
      out.set(`${rec.dexId}|${String(labels)}`, labels ? { dexId: rec.dexId, labels } : { dexId: rec.dexId });
    }
    Object.values(rec).forEach(walk);
  };
  for (const f of readdirSync(fixtureDir('dexscreener'))) if (f.endsWith('.json')) walk(readJson(path.join(fixtureDir('dexscreener'), f)));
  return [...out.values()];
}

describe('normalizeDex — GeckoTerminal ids', () => {
  it.each([
    ['pump-fun', { dex: 'pumpfun', label: 'Pump.fun', isBondingCurve: true, launchpad: 'pump.fun' }],
    ['pumpswap', { dex: 'pumpswap', label: 'PumpSwap', isBondingCurve: false }],
    ['raydium-launchlab', { dex: 'launchlab', label: 'Raydium LaunchLab', isBondingCurve: true, launchpad: 'LaunchLab' }],
    ['letsbonk-fun', { dex: 'letsbonk', label: 'letsbonk.fun', isBondingCurve: true, launchpad: 'letsbonk' }],
    ['meteora-dbc', { dex: 'meteora-dbc', label: 'Meteora DBC', isBondingCurve: true, launchpad: 'Meteora DBC' }],
    ['bags-fm', { dex: 'bags', label: 'Bags', isBondingCurve: true, launchpad: 'bags' }],
    ['boop-fun', { dex: 'boop', label: 'Boop.fun', isBondingCurve: true, launchpad: 'boop' }],
    ['moonshot', { dex: 'moonshot', label: 'Moonshot', isBondingCurve: true, launchpad: 'moonshot' }],
    ['stonkfun', { dex: 'stonkfun', label: 'StonkFun', isBondingCurve: true, launchpad: 'stonkfun' }],
    ['meteora', { dex: 'meteora-dlmm', label: 'Meteora DLMM', isBondingCurve: false }],
    ['meteora-damm-v2', { dex: 'meteora-damm-v2', label: 'Meteora DAMM v2', isBondingCurve: false }],
    ['raydium', { dex: 'raydium', label: 'Raydium', isBondingCurve: false }],
    ['raydium-clmm', { dex: 'raydium-clmm', label: 'Raydium CLMM', isBondingCurve: false }],
    ['orca', { dex: 'orca', label: 'Orca', isBondingCurve: false }],
    ['metadao', { dex: 'metadao', label: 'MetaDAO', isBondingCurve: false }],
  ])('%s', (id, expected) => {
    expect(normalizeDex('geckoterminal', id)).toEqual(expected);
  });

  it('passes unknown ids through with a title-cased label', () => {
    expect(normalizeDex('geckoterminal', 'pancakeswap-v3-solana')).toEqual({ dex: 'pancakeswap-v3-solana', label: 'Pancakeswap V3 Solana', isBondingCurve: false });
    expect(normalizeDex('geckoterminal', 'saros_dlmm')).toEqual({ dex: 'saros_dlmm', label: 'Saros Dlmm', isBondingCurve: false });
  });

  it('gives every live GeckoTerminal Solana dex id a non-empty identity', () => {
    const doc = readJson(path.join(fixtureDir('geckoterminal'), 'dexes_solana_full.json')) as { data: Array<{ id: string }> };
    expect(doc.data.length).toBe(35);
    for (const { id } of doc.data) {
      const d = normalizeDex('geckoterminal', id);
      expect(d.dex, id).not.toBe('unknown');
      expect(d.label.length, id).toBeGreaterThan(0);
    }
  });
});

describe('normalizeDex — DEX Screener ids + labels', () => {
  it.each<[string, string[] | undefined, string, string]>([
    ['pumpfun', undefined, 'pumpfun', 'Pump.fun'],
    ['pumpswap', undefined, 'pumpswap', 'PumpSwap'],
    ['meteoradbc', undefined, 'meteora-dbc', 'Meteora DBC'],
    ['bags', undefined, 'bags', 'Bags'],
    ['launchlab', undefined, 'launchlab', 'Raydium LaunchLab'],
    ['raydium', undefined, 'raydium', 'Raydium'],
    ['raydium', ['CPMM'], 'raydium-cpmm', 'Raydium CPMM'],
    ['raydium', ['CLMM'], 'raydium-clmm', 'Raydium CLMM'],
    ['raydium', ['clmm'], 'raydium-clmm', 'Raydium CLMM'],
    ['meteora', ['DLMM'], 'meteora-dlmm', 'Meteora DLMM'],
    ['meteora', ['DYN'], 'meteora-damm', 'Meteora DAMM'],
    ['meteora', ['DYN2'], 'meteora-damm-v2', 'Meteora DAMM v2'],
    ['meteora', [], 'meteora', 'Meteora'],
    ['orca', ['wp'], 'orca', 'Orca'],
    ['metadao', undefined, 'metadao', 'MetaDAO'],
  ])('%s %j → %s', (dexId, labels, dex, label) => {
    const d = normalizeDex('dexscreener', dexId, labels);
    expect(d.dex).toBe(dex);
    expect(d.label).toBe(label);
  });

  it('marks bonding-curve venues as such', () => {
    for (const id of ['pumpfun', 'meteoradbc', 'bags', 'launchlab']) expect(normalizeDex('dexscreener', id).isBondingCurve, id).toBe(true);
    for (const id of ['pumpswap', 'raydium', 'meteora', 'orca']) expect(normalizeDex('dexscreener', id).isBondingCurve, id).toBe(false);
  });

  it('maps every Solana dexId / label combination in the real fixtures to a known venue', () => {
    const pairs = dexScreenerPairs();
    expect(pairs.length).toBeGreaterThanOrEqual(10);
    for (const { dexId, labels } of pairs) {
      const d = normalizeDex('dexscreener', dexId, labels);
      expect(d.label, `${dexId} ${String(labels)}`).not.toBe(d.dex); // known venues carry a curated label
    }
  });

  it('shortens address-like dex ids in the label but keeps the full id', () => {
    const programId = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
    const d = normalizeDex('dexscreener', programId);
    expect(d).toEqual({ dex: programId, label: 'LanM…J3uj', isBondingCurve: false });
  });

  it('passes unknown ids through', () => {
    expect(normalizeDex('dexscreener', 'fluxbeam')).toEqual({ dex: 'fluxbeam', label: 'FluxBeam', isBondingCurve: false });
    expect(normalizeDex('dexscreener', 'humidifi')).toEqual({ dex: 'humidifi', label: 'Humidifi', isBondingCurve: false });
  });
});

describe('normalizeDex — ORBYT ids and empty input', () => {
  it('uses normalized ids as-is', () => {
    expect(normalizeDex('orbyt', 'pumpfun').label).toBe('Pump.fun');
    expect(normalizeDex('orbyt', 'raydium-cpmm').label).toBe('Raydium CPMM');
    // GeckoTerminal aliases do not apply to ORBYT ids.
    expect(normalizeDex('orbyt', 'pump-fun')).toEqual({ dex: 'pump-fun', label: 'Pump Fun', isBondingCurve: false });
  });

  it('returns an explicit unknown identity for missing ids', () => {
    const unknown = { dex: 'unknown', label: 'Unknown', isBondingCurve: false };
    expect(normalizeDex('geckoterminal', undefined)).toEqual(unknown);
    expect(normalizeDex('dexscreener', null)).toEqual(unknown);
    expect(normalizeDex('orbyt', '   ')).toEqual(unknown);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeDex('geckoterminal', ' pump-fun ').dex).toBe('pumpfun');
  });
});

describe('normalizeLaunchpadName', () => {
  it.each([
    ['pump.fun', 'pump.fun'],
    ['Pump.fun', 'pump.fun'],
    ['pumpswap', 'pump.fun'],
    ['letsbonk.fun', 'letsbonk'],
    ['raydium-launchlab', 'LaunchLab'],
    ['met-dbc', 'Meteora DBC'],
    ['meteora', 'Meteora DBC'],
    ['bags.fm', 'bags'],
    ['moonshot', 'moonshot'],
    ['boop.fun', 'boop'],
    ['heaven', 'heaven'],
    ['StonkFun', 'StonkFun'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeLaunchpadName(raw)).toBe(expected);
  });

  it('returns undefined for missing input', () => {
    expect(normalizeLaunchpadName(undefined)).toBeUndefined();
    expect(normalizeLaunchpadName(null)).toBeUndefined();
    expect(normalizeLaunchpadName('')).toBeUndefined();
  });
});
