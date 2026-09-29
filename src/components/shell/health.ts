import type { HealthReport, ServerProviderHealth } from '@/data/sources';
import { formatAge, formatDuration, formatTime } from '@/lib/core/format';
import { PROVIDER_LABELS, type ProviderId } from '@/lib/core/providers';
import type { BrowserProviderHealth } from '@/lib/net/browser';
import type { ProviderErrorCode } from '@/lib/net/errors';
import type { StreamStatusEntry, StreamStatusSnapshot } from '@/lib/streams/status';

/**
 * Pure health model behind the header status popover and the status bar.
 * Every row states what is actually known (last OK, cooldown, error) and
 * nothing is shown as healthy before it has been observed working.
 *
 * Levels: ok (observed working) · degraded (cooling down, reconnecting, last
 * call failed) · offline (stream unavailable after retries, browser offline)
 * · idle (not used yet / not configured).
 */

export type HealthLevel = 'ok' | 'degraded' | 'offline' | 'idle';

export interface HealthRow {
  id: string;
  label: string;
  level: HealthLevel;
  /** Terse state, e.g. "OK · 4s ago", "Cooling down · 18s". */
  detail: string;
  /** Longer explanation for tooltips. */
  title?: string;
}

export const LEVEL_LABEL: Record<HealthLevel, string> = {
  ok: 'Operational',
  degraded: 'Degraded',
  offline: 'Offline',
  idle: 'Idle',
};

const SEVERITY: Record<HealthLevel, number> = { idle: 0, ok: 1, degraded: 2, offline: 3 };

/** Most severe level; `idle` only when nothing has been observed at all. */
export function worstLevel(levels: readonly HealthLevel[]): HealthLevel {
  let worst: HealthLevel = 'idle';
  for (const level of levels) if (SEVERITY[level] > SEVERITY[worst]) worst = level;
  return worst;
}

/** Header dot: red when the browser is offline or a stream in use is down. */
export function overallLevel(levels: readonly HealthLevel[], online = true): HealthLevel {
  return online ? worstLevel(levels) : 'offline';
}

const secondsUntil = (at: number, now: number) => Math.max(1, Math.ceil((at - now) / 1000));

/** "geckoterminal: rate limited or unreachable" → "Rate limited or unreachable". */
export function cleanError(message: string | undefined): string {
  const raw = message?.trim();
  if (!raw) return 'Error';
  // Drop the leading "provider label: " the transports prepend.
  const text = raw.replace(/^[^:]{1,60}:\s+/, '').trim() || raw;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const ago = (at: number | undefined, now: number) => (at && now ? `${formatAge(at, now)} ago` : undefined);

// ---------------------------------------------------------------------------
// Streams (PumpPortal, Solana WS)
// ---------------------------------------------------------------------------

export function streamRow(id: string, label: string, entry: StreamStatusEntry, now: number): HealthRow {
  const retry = entry.nextRetryAt && now && entry.nextRetryAt > now ? formatDuration(secondsUntil(entry.nextRetryAt, now)) : undefined;
  switch (entry.badge) {
    case 'live': {
      const last = ago(entry.lastMessageAt, now);
      return { id, label, level: 'ok', detail: last ? `Live · ${last}` : 'Live' };
    }
    case 'connecting':
      return { id, label, level: 'idle', detail: 'Connecting…' };
    case 'reconnecting':
      return {
        id,
        label,
        level: 'degraded',
        detail: retry ? `Reconnecting · ${retry}` : 'Reconnecting',
        title: [`Attempt ${entry.attempt}`, entry.lastError].filter(Boolean).join(' · '),
      };
    case 'offline':
      return {
        id,
        label,
        level: 'offline',
        detail: retry ? `Offline · retry ${retry}` : 'Offline',
        title: entry.lastError ?? `Unavailable after ${entry.attempt} attempts`,
      };
    default:
      return { id, label, level: 'idle', detail: 'Not in use', title: 'Opens only while a page subscribes to it' };
  }
}

// ---------------------------------------------------------------------------
// Keyless providers called from this browser
// ---------------------------------------------------------------------------

export const BROWSER_PROVIDERS: readonly { id: ProviderId; label: string }[] = [
  { id: 'jupiter', label: 'Jupiter' },
  { id: 'geckoterminal', label: 'GeckoTerminal' },
  { id: 'dexscreener', label: 'DEX Screener' },
  { id: 'solana-rpc', label: 'Solana RPC' },
];

export function browserRow(id: ProviderId, label: string, health: BrowserProviderHealth | undefined, now: number): HealthRow {
  if (!health) return { id, label, level: 'idle', detail: 'No requests yet' };
  const lastOk = ago(health.lastOkAt, now);
  if (health.coolingDownUntil && (!now || health.coolingDownUntil > now)) {
    return {
      id,
      label,
      level: 'degraded',
      detail: now ? `Cooling down · ${formatDuration(secondsUntil(health.coolingDownUntil, now))}` : 'Cooling down',
      title: `${cleanError(health.lastError ?? 'rate limited')} · requests resume at ${formatTime(health.coolingDownUntil)}${lastOk ? ` · last OK ${lastOk}` : ''}`,
    };
  }
  // The transport clears lastError on the next success, so a set value means the latest call failed.
  if (health.lastError) {
    return { id, label, level: 'degraded', detail: cleanError(health.lastError), title: lastOk ? `Last OK ${lastOk}` : 'No successful request yet' };
  }
  if (health.lastOkAt) return { id, label, level: 'ok', detail: lastOk ? `OK · ${lastOk}` : 'OK' };
  return { id, label, level: 'idle', detail: 'No requests yet' };
}

// ---------------------------------------------------------------------------
// ORBYT server (/api/v1/health)
// ---------------------------------------------------------------------------

type KeyedId = 'helius' | 'birdeye' | 'solanatracker' | 'coingecko' | 'jupiter';

export const KEYED_PROVIDERS: readonly { id: KeyedId; label: string }[] = [
  { id: 'helius', label: 'Helius' },
  { id: 'birdeye', label: 'Birdeye' },
  { id: 'solanatracker', label: 'Solana Tracker' },
  { id: 'coingecko', label: 'CoinGecko' },
  { id: 'jupiter', label: 'Jupiter API' },
];

const RPC_LABEL: Record<HealthReport['rpc'], string> = { public: 'public', helius: 'Helius', custom: 'custom' };

/** A server-side failure older than this, with no request since, no longer marks the provider degraded. */
export const SERVER_ERROR_FRESH_MS = 5 * 60_000;

export function serverProviderRow(
  id: string,
  label: string,
  configured: boolean | string,
  health: ServerProviderHealth | undefined,
  now: number,
): HealthRow {
  if (!configured) return { id, label, level: 'idle', detail: 'Not configured' };
  const plan = typeof configured === 'string' ? `${configured.charAt(0).toUpperCase()}${configured.slice(1)} · ` : '';
  const lastOk = ago(health?.lastOkAt, now);
  if (health?.coolingDownUntil && (!now || health.coolingDownUntil > now)) {
    return {
      id,
      label,
      level: 'degraded',
      detail: `${plan}Cooling down${now ? ` · ${formatDuration(secondsUntil(health.coolingDownUntil, now))}` : ''}`,
      title: [cleanError(health.lastError ?? 'rate limited'), lastOk && `last OK ${lastOk}`].filter(Boolean).join(' · '),
    };
  }
  if (health?.lastErrorAt && health.lastErrorAt > (health.lastOkAt ?? 0)) {
    const title = [`${health.errorCount} errors, ${health.okCount} OK since start`, lastOk && `last OK ${lastOk}`].filter(Boolean).join(' · ');
    // An old failure with no traffic since says nothing about now: report it without flagging degradation.
    if (now && now - health.lastErrorAt > SERVER_ERROR_FRESH_MS) {
      return { id, label, level: 'idle', detail: `${plan}Error ${ago(health.lastErrorAt, now) ?? ''}`.trim(), title: `${cleanError(health.lastError)} · ${title}` };
    }
    return { id, label, level: 'degraded', detail: `${plan}${cleanError(health.lastError)}`, title };
  }
  if (health?.lastOkAt) return { id, label, level: 'ok', detail: `${plan}OK${lastOk ? ` · ${lastOk}` : ''}` };
  return { id, label, level: 'idle', detail: `${plan}Configured`, title: 'No server requests yet' };
}

export function serverRows(report: HealthReport | undefined, now: number): HealthRow[] {
  if (!report) return [];
  const byId = new Map<string, ServerProviderHealth>(report.providers.map((p) => [p.provider, p]));
  const rows: HealthRow[] = [serverProviderRow('server:solana-rpc', `Solana RPC (${RPC_LABEL[report.rpc] ?? report.rpc})`, true, byId.get('solana-rpc'), now)];
  for (const { id, label } of KEYED_PROVIDERS) {
    const health = byId.get(id);
    // No key, yet the server still calls it keyless (Jupiter for the SOL price): show that traffic honestly.
    const configured = report.configured[id] || (health ? 'keyless' : false);
    rows.push(serverProviderRow(`server:${id}`, label, configured, health, now));
  }
  const known = new Set<string>(['solana-rpc', ...KEYED_PROVIDERS.map((p) => p.id)]);
  for (const entry of report.providers) {
    if (known.has(entry.provider)) continue;
    const label = PROVIDER_LABELS[entry.provider as ProviderId] ?? entry.provider;
    rows.push(serverProviderRow(`server:${entry.provider}`, label, true, entry, now));
  }
  return rows;
}

export interface ApiState {
  /** A health report has been received at least once. */
  hasData: boolean;
  /** When the last successful health check completed (ms). */
  updatedAt?: number;
  /** The latest check failed. */
  failed: boolean;
  errorCode?: ProviderErrorCode | string;
}

const API_ERROR: Partial<Record<string, string>> = {
  not_found: 'Health route not found',
  network: 'Unreachable',
  timeout: 'Timed out',
  rate_limited: 'Busy',
  malformed: 'Unexpected response',
};

export function apiRow(state: ApiState, now: number): HealthRow {
  const id = 'server:api';
  const label = 'ORBYT API';
  const checked = ago(state.updatedAt, now);
  if (state.failed) {
    const reason = API_ERROR[state.errorCode ?? ''] ?? 'Error';
    return {
      id,
      label,
      level: 'degraded',
      detail: reason,
      title: state.hasData && checked ? `Showing the report from ${checked}` : 'Server-side provider status unavailable',
    };
  }
  if (!state.hasData) return { id, label, level: 'idle', detail: 'Checking…' };
  return { id, label, level: 'ok', detail: checked ? `OK · checked ${checked}` : 'OK' };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface BarEntry {
  id: 'jupiter' | 'geckoterminal' | 'dexscreener' | 'pumpportal' | 'solana';
  label: string;
  level: HealthLevel;
  title: string;
}

export interface SystemHealth {
  overall: HealthLevel;
  online: boolean;
  streams: HealthRow[];
  browser: HealthRow[];
  api: HealthRow;
  server: HealthRow[];
  rpc?: HealthReport['rpc'];
  /** Status-bar dots, in attribution order. */
  bar: BarEntry[];
}

export interface SystemHealthInput {
  now: number;
  online: boolean;
  streams: StreamStatusSnapshot;
  browser: readonly BrowserProviderHealth[];
  api: ApiState;
  report?: HealthReport;
}

const rowTitle = (row: HealthRow) => `${row.label}: ${row.detail}${row.title ? ` (${row.title})` : ''}`;

export function buildSystemHealth(input: SystemHealthInput): SystemHealth {
  const { now } = input;
  const byProvider = new Map(input.browser.map((h) => [h.provider, h]));
  const streams = [streamRow('pumpportal', 'PumpPortal', input.streams.pumpPortal, now), streamRow('solana-ws', 'Solana WebSocket', input.streams.solanaWs, now)];
  const browser = BROWSER_PROVIDERS.map(({ id, label }) => browserRow(id, label, byProvider.get(id), now));
  const api = apiRow(input.api, now);
  const server = serverRows(input.report, now);

  const find = (rows: HealthRow[], id: string) => rows.find((r) => r.id === id);
  const barFor = (id: BarEntry['id'], label: string, rows: (HealthRow | undefined)[]): BarEntry => {
    const present = rows.filter((r): r is HealthRow => r !== undefined);
    return { id, label, level: worstLevel(present.map((r) => r.level)), title: present.map(rowTitle).join('\n') };
  };
  const bar: BarEntry[] = [
    barFor('jupiter', 'Jupiter', [find(browser, 'jupiter')]),
    barFor('geckoterminal', 'GeckoTerminal', [find(browser, 'geckoterminal')]),
    barFor('dexscreener', 'DEX Screener', [find(browser, 'dexscreener')]),
    barFor('pumpportal', 'PumpPortal', [find(streams, 'pumpportal')]),
    barFor('solana', 'Solana RPC', [find(browser, 'solana-rpc'), find(streams, 'solana-ws'), find(server, 'server:solana-rpc')]),
  ];

  const levels = [...streams, ...browser, api, ...server].map((r) => r.level);
  return { overall: overallLevel(levels, input.online), online: input.online, streams, browser, api, server, rpc: input.report?.rpc, bar };
}
