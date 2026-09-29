import { describe, expect, it } from 'vitest';
import type { HealthReport } from '@/data/sources';
import { deriveCapabilities, type ConfiguredProviders } from '@/lib/config/capabilities';
import type { StreamStatusEntry } from '@/lib/streams/status';
import {
  apiRow,
  browserRow,
  buildSystemHealth,
  cleanError,
  overallLevel,
  serverProviderRow,
  serverRows,
  streamRow,
  worstLevel,
  type ApiState,
} from './health';

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const idle: StreamStatusEntry = { badge: 'idle', status: 'closed', attempt: 0, consumers: 0 };
const live: StreamStatusEntry = { badge: 'live', status: 'open', attempt: 0, consumers: 1, lastMessageAt: NOW - 2_000 };

const configured = (patch: Partial<ConfiguredProviders> = {}): ConfiguredProviders => ({
  helius: false,
  birdeye: false,
  solanatracker: false,
  coingecko: null,
  jupiter: false,
  customRpc: false,
  ...patch,
});

function report(patch: Partial<HealthReport> = {}, providers: Partial<ConfiguredProviders> = {}): HealthReport {
  const c = configured(providers);
  return { configured: c, rpc: 'public', capabilities: deriveCapabilities(c), providers: [], ...patch };
}

const apiOk: ApiState = { hasData: true, updatedAt: NOW - 10_000, failed: false };

describe('levels', () => {
  it('picks the most severe level and treats offline browsers as offline', () => {
    expect(worstLevel([])).toBe('idle');
    expect(worstLevel(['idle', 'ok'])).toBe('ok');
    expect(worstLevel(['ok', 'degraded', 'idle'])).toBe('degraded');
    expect(worstLevel(['degraded', 'offline'])).toBe('offline');
    expect(overallLevel(['ok'], false)).toBe('offline');
    expect(overallLevel(['ok'], true)).toBe('ok');
  });

  it('strips provider prefixes from transport errors', () => {
    expect(cleanError('geckoterminal: rate limited or unreachable')).toBe('Rate limited or unreachable');
    expect(cleanError('solana-rpc: HTTP 500')).toBe('HTTP 500');
    expect(cleanError('birdeye defi/ohlcv: HTTP 429')).toBe('HTTP 429');
    expect(cleanError('timed out')).toBe('Timed out');
    expect(cleanError(undefined)).toBe('Error');
    expect(cleanError('  ')).toBe('Error');
  });
});

describe('streamRow', () => {
  it('maps stream badges to levels with honest details', () => {
    expect(streamRow('pp', 'PumpPortal', live, NOW)).toMatchObject({ level: 'ok', detail: 'Live · 2s ago' });
    expect(streamRow('pp', 'PumpPortal', { ...live, badge: 'connecting', status: 'connecting' }, NOW)).toMatchObject({ level: 'idle', detail: 'Connecting…' });
    expect(streamRow('pp', 'PumpPortal', { ...idle, badge: 'reconnecting', status: 'reconnecting', attempt: 2, nextRetryAt: NOW + 4_200, consumers: 1 }, NOW)).toMatchObject({
      level: 'degraded',
      detail: 'Reconnecting · 5s',
    });
    expect(streamRow('pp', 'PumpPortal', { ...idle, badge: 'offline', status: 'reconnecting', attempt: 3, nextRetryAt: NOW + 20_000, lastError: 'closed 1006', consumers: 1 }, NOW)).toMatchObject({
      level: 'offline',
      detail: 'Offline · retry 20s',
      title: 'closed 1006',
    });
    expect(streamRow('pp', 'PumpPortal', idle, NOW)).toMatchObject({ level: 'idle', detail: 'Not in use' });
  });

  it('omits ages before the clock is known (SSR/hydration)', () => {
    expect(streamRow('pp', 'PumpPortal', live, 0).detail).toBe('Live');
  });
});

describe('browserRow', () => {
  it('is idle until the provider is used', () => {
    expect(browserRow('jupiter', 'Jupiter', undefined, NOW)).toMatchObject({ level: 'idle', detail: 'No requests yet' });
    expect(browserRow('jupiter', 'Jupiter', { provider: 'jupiter' }, NOW)).toMatchObject({ level: 'idle' });
  });

  it('reports OK with age, cooldowns with remaining time, and failed last calls', () => {
    expect(browserRow('jupiter', 'Jupiter', { provider: 'jupiter', lastOkAt: NOW - 4_000 }, NOW)).toMatchObject({ level: 'ok', detail: 'OK · 4s ago' });
    const cooling = browserRow('geckoterminal', 'GeckoTerminal', { provider: 'geckoterminal', lastOkAt: NOW - 60_000, coolingDownUntil: NOW + 17_500, lastError: 'geckoterminal: rate limited or unreachable' }, NOW);
    expect(cooling).toMatchObject({ level: 'degraded', detail: 'Cooling down · 18s' });
    expect(cooling.title).toContain('Rate limited or unreachable');
    expect(cooling.title).toContain('last OK 1m ago');
    expect(browserRow('dexscreener', 'DEX Screener', { provider: 'dexscreener', lastOkAt: NOW - 1_000, lastError: 'dexscreener: HTTP 502' }, NOW)).toMatchObject({
      level: 'degraded',
      detail: 'HTTP 502',
    });
  });

  it('ignores an expired cooldown', () => {
    expect(browserRow('jupiter', 'Jupiter', { provider: 'jupiter', lastOkAt: NOW - 1_000, coolingDownUntil: NOW - 1 }, NOW)).toMatchObject({ level: 'ok' });
  });
});

describe('server rows', () => {
  it('never shows unconfigured providers as healthy', () => {
    expect(serverProviderRow('x', 'Helius', false, undefined, NOW)).toMatchObject({ level: 'idle', detail: 'Not configured' });
    expect(serverProviderRow('x', 'Helius', true, undefined, NOW)).toMatchObject({ level: 'idle', detail: 'Configured' });
    expect(serverProviderRow('x', 'CoinGecko', 'demo', { provider: 'coingecko', okCount: 3, errorCount: 0, lastOkAt: NOW - 5_000 }, NOW)).toMatchObject({
      level: 'ok',
      detail: 'Demo · OK · 5s ago',
    });
  });

  it('flags cooldowns and errors newer than the last success', () => {
    expect(serverProviderRow('x', 'Birdeye', true, { provider: 'birdeye', okCount: 1, errorCount: 2, coolingDownUntil: NOW + 30_000 }, NOW)).toMatchObject({
      level: 'degraded',
      detail: 'Cooling down · 30s',
    });
    expect(
      serverProviderRow('x', 'Birdeye', true, { provider: 'birdeye', okCount: 1, errorCount: 2, lastOkAt: NOW - 60_000, lastErrorAt: NOW - 1_000, lastError: 'birdeye: HTTP 500' }, NOW),
    ).toMatchObject({ level: 'degraded', detail: 'HTTP 500' });
    expect(
      serverProviderRow('x', 'Birdeye', true, { provider: 'birdeye', okCount: 5, errorCount: 1, lastOkAt: NOW - 1_000, lastErrorAt: NOW - 60_000, lastError: 'old' }, NOW),
    ).toMatchObject({ level: 'ok' });
  });

  it('lists RPC, every keyed provider and any extra server providers', () => {
    const rows = serverRows(
      report(
        {
          rpc: 'helius',
          providers: [
            { provider: 'solana-rpc', okCount: 2, errorCount: 0, lastOkAt: NOW - 3_000 },
            { provider: 'helius', okCount: 2, errorCount: 0, lastOkAt: NOW - 3_000 },
            { provider: 'dexscreener', okCount: 1, errorCount: 0, lastOkAt: NOW - 9_000 },
          ],
        },
        { helius: true, coingecko: 'pro' },
      ),
      NOW,
    );
    expect(rows.map((r) => [r.label, r.level, r.detail])).toEqual([
      ['Solana RPC (Helius)', 'ok', 'OK · 3s ago'],
      ['Helius', 'ok', 'OK · 3s ago'],
      ['Birdeye', 'idle', 'Not configured'],
      ['Solana Tracker', 'idle', 'Not configured'],
      ['CoinGecko', 'idle', 'Pro · Configured'],
      ['Jupiter API', 'idle', 'Not configured'],
      ['DEX Screener', 'ok', 'OK · 9s ago'],
    ]);
    expect(serverRows(undefined, NOW)).toEqual([]);
  });

  it('stops flagging an old server failure that had no traffic since', () => {
    const old = serverProviderRow('x', 'Birdeye', true, { provider: 'birdeye', okCount: 0, errorCount: 1, lastErrorAt: NOW - 12 * 60_000, lastError: 'birdeye: HTTP 500' }, NOW);
    expect(old).toMatchObject({ level: 'idle', detail: 'Error 12m ago' });
    expect(old.title).toContain('HTTP 500');
  });

  it('shows keyless server traffic to a provider that has no key (Jupiter SOL price)', () => {
    const rows = serverRows(
      report({ providers: [{ provider: 'jupiter', okCount: 0, errorCount: 1, lastErrorAt: NOW - 2_000, lastError: 'jupiter: rate limited' }] }),
      NOW,
    );
    expect(rows.find((r) => r.id === 'server:jupiter')).toMatchObject({ level: 'degraded', detail: 'Keyless · Rate limited' });
  });
});

describe('apiRow', () => {
  it('distinguishes checking, OK, and failed checks (with or without an older report)', () => {
    expect(apiRow({ hasData: false, failed: false }, NOW)).toMatchObject({ level: 'idle', detail: 'Checking…' });
    expect(apiRow(apiOk, NOW)).toMatchObject({ level: 'ok', detail: 'OK · checked 10s ago' });
    expect(apiRow({ hasData: false, failed: true, errorCode: 'not_found' }, NOW)).toMatchObject({ level: 'degraded', detail: 'Health route not found' });
    const stale = apiRow({ hasData: true, updatedAt: NOW - 120_000, failed: true, errorCode: 'network' }, NOW);
    expect(stale).toMatchObject({ level: 'degraded', detail: 'Unreachable' });
    expect(stale.title).toContain('2m ago');
  });
});

describe('buildSystemHealth', () => {
  const base = {
    now: NOW,
    online: true,
    streams: { pumpPortal: idle, solanaWs: idle },
    browser: [],
    api: apiOk,
    report: report(),
  };

  it('is operational when everything observed works and ignores unconfigured providers', () => {
    const health = buildSystemHealth({ ...base, browser: [{ provider: 'jupiter', lastOkAt: NOW - 1_000 }] });
    expect(health.overall).toBe('ok');
    expect(health.bar.map((b) => [b.id, b.level])).toEqual([
      ['jupiter', 'ok'],
      ['geckoterminal', 'idle'],
      ['dexscreener', 'idle'],
      ['pumpportal', 'idle'],
      ['solana', 'idle'],
    ]);
    expect(health.rpc).toBe('public');
  });

  it('is degraded when a keyless provider cools down', () => {
    const health = buildSystemHealth({ ...base, browser: [{ provider: 'geckoterminal', coolingDownUntil: NOW + 5_000, lastError: 'geckoterminal: rate limited' }] });
    expect(health.overall).toBe('degraded');
    expect(health.bar.find((b) => b.id === 'geckoterminal')?.level).toBe('degraded');
  });

  it('is offline when a stream in use is down or the browser is offline', () => {
    const offlineStream = buildSystemHealth({ ...base, streams: { pumpPortal: { ...idle, badge: 'offline', consumers: 1 }, solanaWs: idle } });
    expect(offlineStream.overall).toBe('offline');
    expect(offlineStream.bar.find((b) => b.id === 'pumpportal')?.level).toBe('offline');
    expect(buildSystemHealth({ ...base, online: false }).overall).toBe('offline');
  });

  it('combines browser RPC, Solana WS and server RPC into the Solana dot', () => {
    const health = buildSystemHealth({
      ...base,
      streams: { pumpPortal: idle, solanaWs: live },
      browser: [{ provider: 'solana-rpc', lastOkAt: NOW - 1_000 }],
      report: report({ providers: [{ provider: 'solana-rpc', okCount: 0, errorCount: 1, lastErrorAt: NOW - 500, lastError: 'solana-rpc: HTTP 429' }] }),
    });
    const solana = health.bar.find((b) => b.id === 'solana');
    expect(solana?.level).toBe('degraded');
    expect(solana?.title.split('\n')).toHaveLength(3);
  });

  it('marks the ORBYT API degraded when the health check fails', () => {
    const health = buildSystemHealth({ ...base, report: undefined, api: { hasData: false, failed: true, errorCode: 'network' } });
    expect(health.overall).toBe('degraded');
    expect(health.server).toEqual([]);
    expect(health.api.detail).toBe('Unreachable');
  });
});
