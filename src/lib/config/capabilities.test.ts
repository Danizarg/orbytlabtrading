import { describe, expect, it } from 'vitest';
import { deriveCapabilities, type ConfiguredProviders } from './capabilities';

const NONE: ConfiguredProviders = { helius: false, birdeye: false, solanatracker: false, coingecko: null, jupiter: false, customRpc: false };
const ALL: ConfiguredProviders = { helius: true, birdeye: true, solanatracker: true, coingecko: 'pro', jupiter: true, customRpc: true };

describe('deriveCapabilities', () => {
  it('advertises the keyless server fallbacks on every deployment, keys or not', () => {
    for (const configured of [NONE, ALL, { ...NONE, coingecko: 'demo' as const }]) {
      const caps = deriveCapabilities(configured);
      expect(caps.serverCandlesKeyless).toBe(true);
      expect(caps.serverPools).toBe(true);
      expect(caps.serverTokensKeyless).toBe(true);
    }
  });

  it('keeps the keyed capabilities keyed-only (unchanged semantics)', () => {
    const none = deriveCapabilities(NONE);
    expect(none).toMatchObject({
      configured: NONE,
      serverTrades: false,
      serverCandles: false,
      serverSecondIntervals: [],
      serverHolders: false,
      serverRisk: false,
      serverPulse: false,
      serverDiscover: false,
      serverQuote: false,
      fastWalletHistory: false,
    });

    const all = deriveCapabilities(ALL);
    expect(all).toMatchObject({
      serverTrades: true,
      serverCandles: true,
      serverHolders: true,
      serverRisk: true,
      serverPulse: true,
      serverDiscover: true,
      serverQuote: true,
      fastWalletHistory: true,
    });
    expect([...all.serverSecondIntervals].sort()).toEqual(['15s', '1s', '5s']);
  });

  it('derives candles and discovery from a CoinGecko Demo key alone', () => {
    const caps = deriveCapabilities({ ...NONE, coingecko: 'demo' });
    expect(caps.serverCandles).toBe(true);
    expect(caps.serverSecondIntervals).toEqual([]);
    expect(caps.serverDiscover).toBe(true);
    expect(caps.serverTrades).toBe(false);
  });

  it('stays serialisable booleans only (sent to the browser)', () => {
    const json = JSON.stringify(deriveCapabilities(ALL));
    expect(JSON.parse(json)).toEqual(deriveCapabilities(ALL));
  });
});
