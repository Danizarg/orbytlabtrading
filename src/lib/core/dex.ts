/**
 * DEX / launchpad identity normalization across providers.
 *
 * GeckoTerminal and DEX Screener name the same venues differently
 * (e.g. 'pump-fun' vs 'pumpfun', 'meteora-dbc' vs 'meteoradbc'). Adapters map
 * raw ids through `normalizeDex` so the UI sees one vocabulary. Unknown ids
 * pass through (DEX Screener can even emit raw program addresses).
 */

export interface DexIdentity {
  /** Normalized id used across ORBYT. */
  dex: string;
  label: string;
  /** Launchpad bonding curve (not a free-trading AMM). */
  isBondingCurve: boolean;
  /** Launchpad this venue belongs to (bonding curves) — display name. */
  launchpad?: string;
}

const KNOWN: Record<string, DexIdentity> = {
  pumpfun: { dex: 'pumpfun', label: 'Pump.fun', isBondingCurve: true, launchpad: 'pump.fun' },
  pumpswap: { dex: 'pumpswap', label: 'PumpSwap', isBondingCurve: false },
  launchlab: { dex: 'launchlab', label: 'Raydium LaunchLab', isBondingCurve: true, launchpad: 'LaunchLab' },
  letsbonk: { dex: 'letsbonk', label: 'letsbonk.fun', isBondingCurve: true, launchpad: 'letsbonk' },
  'meteora-dbc': { dex: 'meteora-dbc', label: 'Meteora DBC', isBondingCurve: true, launchpad: 'Meteora DBC' },
  bags: { dex: 'bags', label: 'Bags', isBondingCurve: true, launchpad: 'bags' },
  moonshot: { dex: 'moonshot', label: 'Moonshot', isBondingCurve: true, launchpad: 'moonshot' },
  moonit: { dex: 'moonit', label: 'Moonit', isBondingCurve: true, launchpad: 'moonit' },
  boop: { dex: 'boop', label: 'Boop.fun', isBondingCurve: true, launchpad: 'boop' },
  heaven: { dex: 'heaven', label: 'Heaven', isBondingCurve: true, launchpad: 'heaven' },
  stonkfun: { dex: 'stonkfun', label: 'StonkFun', isBondingCurve: true, launchpad: 'stonkfun' },
  raydium: { dex: 'raydium', label: 'Raydium', isBondingCurve: false },
  'raydium-cpmm': { dex: 'raydium-cpmm', label: 'Raydium CPMM', isBondingCurve: false },
  'raydium-clmm': { dex: 'raydium-clmm', label: 'Raydium CLMM', isBondingCurve: false },
  'meteora-dlmm': { dex: 'meteora-dlmm', label: 'Meteora DLMM', isBondingCurve: false },
  'meteora-damm': { dex: 'meteora-damm', label: 'Meteora DAMM', isBondingCurve: false },
  'meteora-damm-v2': { dex: 'meteora-damm-v2', label: 'Meteora DAMM v2', isBondingCurve: false },
  meteora: { dex: 'meteora', label: 'Meteora', isBondingCurve: false },
  orca: { dex: 'orca', label: 'Orca', isBondingCurve: false },
  fluxbeam: { dex: 'fluxbeam', label: 'FluxBeam', isBondingCurve: false },
  metadao: { dex: 'metadao', label: 'MetaDAO', isBondingCurve: false },
};

/** GeckoTerminal dex ids → normalized ids. */
const GECKO_ALIASES: Record<string, string> = {
  'pump-fun': 'pumpfun',
  pumpswap: 'pumpswap',
  'raydium-launchlab': 'launchlab',
  'letsbonk-fun': 'letsbonk',
  'meteora-dbc': 'meteora-dbc',
  'bags-fm': 'bags',
  'boop-fun': 'boop',
  moonshot: 'moonshot',
  moonit: 'moonit',
  heaven: 'heaven',
  stonkfun: 'stonkfun',
  raydium: 'raydium',
  'raydium-clmm': 'raydium-clmm',
  meteora: 'meteora-dlmm',
  'meteora-damm-v2': 'meteora-damm-v2',
  orca: 'orca',
  fluxbeam: 'fluxbeam',
  metadao: 'metadao',
};

/** DEX Screener dexId (+ labels) → normalized ids. */
function fromDexScreener(dexId: string, labels: readonly string[] = []): string {
  const l = labels.map((x) => x.toUpperCase());
  switch (dexId) {
    case 'pumpfun':
      return 'pumpfun';
    case 'pumpswap':
      return 'pumpswap';
    case 'meteoradbc':
      return 'meteora-dbc';
    case 'bags':
      return 'bags';
    case 'launchlab':
      return 'launchlab';
    case 'raydium':
      return l.includes('CPMM') ? 'raydium-cpmm' : l.includes('CLMM') ? 'raydium-clmm' : 'raydium';
    case 'meteora':
      return l.includes('DLMM') ? 'meteora-dlmm' : l.includes('DYN2') ? 'meteora-damm-v2' : l.includes('DYN') ? 'meteora-damm' : 'meteora';
    default:
      return dexId;
  }
}

function titleCase(id: string): string {
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id)) return `${id.slice(0, 4)}…${id.slice(-4)}`;
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

export function normalizeDex(source: 'geckoterminal' | 'dexscreener' | 'orbyt', rawId: string | undefined | null, labels?: readonly string[]): DexIdentity {
  const raw = (rawId ?? '').trim();
  if (!raw) return { dex: 'unknown', label: 'Unknown', isBondingCurve: false };
  const id = source === 'geckoterminal' ? (GECKO_ALIASES[raw] ?? raw) : source === 'dexscreener' ? fromDexScreener(raw, labels) : raw;
  return KNOWN[id] ?? { dex: id, label: titleCase(id), isBondingCurve: false };
}

/** Display name for a Jupiter / provider `launchpad` string (e.g. 'pump.fun', 'met-dbc'). */
export function normalizeLaunchpadName(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase();
  if (v.includes('pump')) return 'pump.fun';
  if (v.includes('bonk')) return 'letsbonk';
  if (v.includes('launchlab') || v.includes('raydium')) return 'LaunchLab';
  if (v.includes('dbc') || v.includes('meteora')) return 'Meteora DBC';
  if (v.includes('bags')) return 'bags';
  if (v.includes('moonshot')) return 'moonshot';
  if (v.includes('boop')) return 'boop';
  return raw;
}
