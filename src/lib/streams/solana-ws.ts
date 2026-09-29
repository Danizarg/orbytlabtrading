/**
 * Solana JSON-RPC PubSub client for the browser (logsSubscribe,
 * accountSubscribe) over ONE shared connection per tab.
 *
 * Default endpoint: PUBLIC_ENDPOINTS.solanaWs (wss://solana-rpc.publicnode.com),
 * the only keyless WS that accepts a browser Origin (api.mainnet-beta returns
 * 403). It is BEST-EFFORT: in live tests it delivered only ~40% of the
 * notifications the official WS did, so consumers must also poll and treat
 * notifications as "something changed, refresh" hints.
 *
 * Verified live 2026-09-28 on publicnode:
 * - A connection with no traffic is closed after 60 s: an error frame
 *   `{"error":{"code":-32701,"message":"connection timeout exceeded"}}` then
 *   close code 1013. `getHealth` is answered over WS (`{"result":"ok"}`), so
 *   we send it every 25 s as a keepalive; the reply also feeds the idle
 *   watchdog. (Plain Agave nodes answer "Method not found", which is still a
 *   reply.)
 * - Subscription ids are per connection: everything is re-subscribed after a
 *   reconnect and the request id → subscription id map is rebuilt.
 *
 * `logsSubscribe` `mentions` accepts exactly one address, and notifications
 * include FAILED transactions (`err` non-null); filter as needed.
 */

import { PUBLIC_ENDPOINTS } from '@/lib/config/capabilities';
import { LAMPORTS_PER_SOL, isSignature, isSolanaAddress } from '@/lib/core/solana';
import { num } from '@/lib/core/chain';
import {
  ReconnectingSocket,
  reportListenerError,
  type BackoffOptions,
  type SocketState,
  type WebSocketCtor,
} from './reconnecting-socket';

export type Commitment = 'processed' | 'confirmed' | 'finalized';
export type AccountEncoding = 'base64' | 'jsonParsed';

export interface LogsNotification {
  signature: string;
  /** null for success; otherwise the transaction error as reported (e.g. `{InstructionError:[4,{Custom:7}]}`). */
  err: unknown;
  /** Program log lines (may be truncated by the node on large transactions). */
  logs: string[];
  slot?: number;
  /** When this browser received the notification (ms). */
  receivedAt: number;
  source: 'solana-ws';
}

export type AccountData =
  | { encoding: 'base64'; base64: string }
  | { encoding: 'jsonParsed'; program: string; parsed: unknown; space?: number };

export interface AccountUpdate {
  address: string;
  /** False when the node reported no account (e.g. closed). */
  exists: boolean;
  slot?: number;
  /** Raw lamports as reported by the node. */
  lamports?: number;
  /** Balance in SOL (lamports / 1e9). */
  sol?: number;
  /** Owning program. */
  owner?: string;
  /**
   * Account data. A `jsonParsed` subscription falls back to base64 when the
   * node has no parser for the owning program.
   */
  data?: AccountData;
  space?: number;
  /** When this browser received the notification (ms). */
  receivedAt: number;
  source: 'solana-ws';
}

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function slotOf(result: Raw): number | undefined {
  return isRecord(result.context) ? num(result.context.slot) : undefined;
}

/** Normalize `params.result` of a logsNotification; null when malformed. */
export function parseLogsNotification(result: unknown, receivedAt: number): LogsNotification | null {
  if (!isRecord(result) || !isRecord(result.value)) return null;
  const value = result.value;
  if (!isSignature(value.signature) || !Array.isArray(value.logs)) return null;
  const out: LogsNotification = {
    signature: value.signature,
    err: value.err ?? null,
    logs: value.logs.filter((line): line is string => typeof line === 'string'),
    receivedAt,
    source: 'solana-ws',
  };
  const slot = slotOf(result);
  if (slot !== undefined) out.slot = slot;
  return out;
}

function parseAccountData(data: unknown): AccountData | undefined {
  if (Array.isArray(data)) {
    const [payload, encoding] = data as unknown[];
    return typeof payload === 'string' && encoding === 'base64' ? { encoding: 'base64', base64: payload } : undefined;
  }
  if (isRecord(data) && typeof data.program === 'string' && 'parsed' in data) {
    const out: AccountData = { encoding: 'jsonParsed', program: data.program, parsed: data.parsed };
    const space = num(data.space);
    if (space !== undefined) out.space = space;
    return out;
  }
  return undefined;
}

/** Normalize `params.result` of an accountNotification; null when malformed. */
export function parseAccountNotification(result: unknown, address: string, receivedAt: number): AccountUpdate | null {
  if (!isRecord(result) || !('value' in result)) return null;
  const slot = slotOf(result);
  const value = result.value;
  const out: AccountUpdate = { address, exists: false, receivedAt, source: 'solana-ws' };
  if (slot !== undefined) out.slot = slot;
  if (value === null) return out;
  if (!isRecord(value)) return null;
  out.exists = true;
  const lamports = num(value.lamports);
  if (lamports !== undefined) {
    out.lamports = lamports;
    out.sol = lamports / LAMPORTS_PER_SOL;
  }
  if (typeof value.owner === 'string') out.owner = value.owner;
  const data = parseAccountData(value.data);
  if (data) out.data = data;
  const space = num(value.space);
  if (space !== undefined) out.space = space;
  return out;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

interface BaseEntry {
  key: string;
  address: string;
  commitment: Commitment;
  /** Server subscription id on the current connection. */
  subId?: number;
  /** In-flight subscribe request id. */
  requestId?: number;
}

interface LogsEntry extends BaseEntry {
  kind: 'logs';
  listeners: Set<(notification: LogsNotification) => void>;
}

interface AccountEntry extends BaseEntry {
  kind: 'account';
  encoding: AccountEncoding;
  listeners: Set<(update: AccountUpdate) => void>;
}

type Entry = LogsEntry | AccountEntry;

export interface SolanaWsStatus extends SocketState {
  /** Distinct subscriptions wanted by local listeners. */
  subscriptions: number;
  /** Subscriptions confirmed by the server on the current connection. */
  confirmed: number;
  /** Last JSON-RPC error reported by the server. */
  lastServerError?: string;
}

export interface SolanaWsClient {
  /** logsSubscribe({ mentions: [address] }). Identical subscriptions share one server subscription. */
  logsSubscribe(address: string, listener: (notification: LogsNotification) => void, options?: { commitment?: Commitment }): () => void;
  accountSubscribe(
    address: string,
    listener: (update: AccountUpdate) => void,
    options?: { encoding?: AccountEncoding; commitment?: Commitment },
  ): () => void;
  getStatus(): SolanaWsStatus;
  onStatus(listener: (status: SolanaWsStatus) => void): () => void;
  /** Drop every subscription and close the connection (tests / teardown). */
  dispose(): void;
}

export interface SolanaWsClientOptions {
  url?: string;
  WebSocketImpl?: WebSocketCtor;
  backoff?: BackoffOptions;
  /** Keepalive (getHealth) interval (ms). Default 25 s; publicnode drops silent connections at 60 s. */
  keepaliveMs?: number;
  /** Reconnect when nothing (including keepalive replies) arrives for this long (ms). Default 65 s. */
  idleTimeoutMs?: number;
  lingerMs?: number;
  stableAfterMs?: number;
  connectTimeoutMs?: number;
  random?: () => number;
  now?: () => number;
}

export function createSolanaWsClient(options: SolanaWsClientOptions = {}): SolanaWsClient {
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();
  const bySubId = new Map<number, Entry>();
  /** Subscribe request id → entry. Other replies (keepalive, unsubscribe) are ignored. */
  const pending = new Map<number, Entry>();
  const statusListeners = new Set<(status: SolanaWsStatus) => void>();
  let nextId = 1;
  let lastServerError: string | undefined;
  let release: (() => void) | null = null;
  let snapshot: SolanaWsStatus | null = null;

  const socket = new ReconnectingSocket({
    url: options.url ?? PUBLIC_ENDPOINTS.solanaWs,
    label: 'Solana WS',
    WebSocketImpl: options.WebSocketImpl,
    backoff: options.backoff,
    idleTimeoutMs: options.idleTimeoutMs ?? 65_000,
    keepalive: {
      intervalMs: options.keepaliveMs ?? 25_000,
      message: () => JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'getHealth' }),
    },
    lingerMs: options.lingerMs,
    stableAfterMs: options.stableAfterMs,
    connectTimeoutMs: options.connectTimeoutMs,
    random: options.random,
    now,
    onOpen: () => {
      // Subscription ids do not survive a reconnect: subscribe everything again.
      resetConnectionState();
      for (const entry of entries.values()) subscribeEntry(entry);
      emit();
    },
    onMessage: handleMessage,
  });
  socket.onState((state) => {
    if (state.status !== 'open') resetConnectionState();
    emit();
  });

  function resetConnectionState(): void {
    pending.clear();
    bySubId.clear();
    for (const entry of entries.values()) {
      entry.subId = undefined;
      entry.requestId = undefined;
    }
  }

  function subscribeEntry(entry: Entry): void {
    if (!socket.isOpen() || entry.requestId !== undefined || entry.subId !== undefined) return;
    const id = nextId++;
    const request =
      entry.kind === 'logs'
        ? { jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [entry.address] }, { commitment: entry.commitment }] }
        : { jsonrpc: '2.0', id, method: 'accountSubscribe', params: [entry.address, { encoding: entry.encoding, commitment: entry.commitment }] };
    if (socket.sendNow(JSON.stringify(request))) {
      entry.requestId = id;
      pending.set(id, entry);
    }
  }

  function unsubscribeServer(kind: Entry['kind'], subId: number): void {
    const method = kind === 'logs' ? 'logsUnsubscribe' : 'accountUnsubscribe';
    socket.sendNow(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: [subId] }));
  }

  function handleResponse(id: number, msg: Raw): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    const current = entries.get(entry.key) === entry && entry.requestId === id;
    if (current) entry.requestId = undefined;
    const result = msg.result;
    if (typeof result === 'number' && Number.isInteger(result)) {
      if (!current) {
        // Last listener left before the ack: drop the orphaned server subscription.
        unsubscribeServer(entry.kind, result);
        return;
      }
      entry.subId = result;
      bySubId.set(result, entry);
      emit();
      return;
    }
    const error = isRecord(msg.error) && typeof msg.error.message === 'string' ? msg.error.message : 'subscription rejected';
    lastServerError = `${entry.kind === 'logs' ? 'logsSubscribe' : 'accountSubscribe'}: ${error.slice(0, 160)}`;
    emit();
  }

  function handleMessage(data: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(msg)) return;
    if (typeof msg.id === 'number') {
      handleResponse(msg.id, msg);
      return;
    }
    if (msg.method === 'logsNotification' || msg.method === 'accountNotification') {
      const params = msg.params;
      if (!isRecord(params) || typeof params.subscription !== 'number') return;
      const entry = bySubId.get(params.subscription);
      if (!entry) return;
      const receivedAt = now();
      if (entry.kind === 'logs' && msg.method === 'logsNotification') {
        const notification = parseLogsNotification(params.result, receivedAt);
        if (notification) fanOut(entry.listeners, notification);
      } else if (entry.kind === 'account' && msg.method === 'accountNotification') {
        const update = parseAccountNotification(params.result, entry.address, receivedAt);
        if (update) fanOut(entry.listeners, update);
      }
      return;
    }
    // Server-level error without an id (e.g. publicnode's idle timeout notice).
    if (isRecord(msg.error) && typeof msg.error.message === 'string') {
      lastServerError = msg.error.message.slice(0, 160);
      emit();
    }
  }

  function fanOut<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (error) {
        reportListenerError(error);
      }
    }
  }

  function retainIfNeeded(): void {
    if (entries.size > 0 && !release) release = socket.acquire();
    else if (entries.size === 0 && release) {
      const r = release;
      release = null;
      r();
    }
  }

  function removeEntryIfUnused(entry: Entry): void {
    if (entry.listeners.size > 0 || entries.get(entry.key) !== entry) return;
    entries.delete(entry.key);
    if (entry.subId !== undefined) {
      bySubId.delete(entry.subId);
      unsubscribeServer(entry.kind, entry.subId);
      entry.subId = undefined;
    }
    // An in-flight subscribe stays in `pending`; its ack is unsubscribed as an orphan.
    entry.requestId = undefined;
    emit();
    retainIfNeeded();
  }

  function assertAddress(address: string): void {
    if (!isSolanaAddress(address)) throw new TypeError('solana-ws: invalid address');
  }

  function buildStatus(): SolanaWsStatus {
    return { ...socket.getState(), subscriptions: entries.size, confirmed: bySubId.size, lastServerError };
  }

  function emit(): void {
    snapshot = buildStatus();
    const s = snapshot;
    for (const listener of [...statusListeners]) {
      try {
        listener(s);
      } catch (error) {
        reportListenerError(error);
      }
    }
  }

  return {
    logsSubscribe(address, listener, opts = {}) {
      assertAddress(address);
      const commitment = opts.commitment ?? 'confirmed';
      const key = `logs:${address}:${commitment}`;
      let entry = entries.get(key);
      if (!entry || entry.kind !== 'logs') {
        entry = { kind: 'logs', key, address, commitment, listeners: new Set() };
        entries.set(key, entry);
      }
      const logsEntry: LogsEntry = entry;
      logsEntry.listeners.add(listener);
      retainIfNeeded();
      subscribeEntry(logsEntry);
      emit();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        logsEntry.listeners.delete(listener);
        removeEntryIfUnused(logsEntry);
      };
    },
    accountSubscribe(address, listener, opts = {}) {
      assertAddress(address);
      const encoding = opts.encoding ?? 'base64';
      const commitment = opts.commitment ?? 'confirmed';
      const key = `account:${address}:${encoding}:${commitment}`;
      let entry = entries.get(key);
      if (!entry || entry.kind !== 'account') {
        entry = { kind: 'account', key, address, encoding, commitment, listeners: new Set() };
        entries.set(key, entry);
      }
      const accountEntry: AccountEntry = entry;
      accountEntry.listeners.add(listener);
      retainIfNeeded();
      subscribeEntry(accountEntry);
      emit();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        accountEntry.listeners.delete(listener);
        removeEntryIfUnused(accountEntry);
      };
    },
    getStatus: () => (snapshot ??= buildStatus()),
    onStatus(listener) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    dispose() {
      entries.clear();
      resetConnectionState();
      if (release) {
        const r = release;
        release = null;
        r();
      }
      socket.close();
    },
  };
}

let shared: SolanaWsClient | null = null;

/** The tab-wide Solana PubSub client (created lazily; the socket opens on the first subscription). */
export function getSolanaWs(): SolanaWsClient {
  return (shared ??= createSolanaWsClient());
}

/** Tab-wide singleton facade. */
export const solanaWs: SolanaWsClient = {
  logsSubscribe: (address, listener, options) => getSolanaWs().logsSubscribe(address, listener, options),
  accountSubscribe: (address, listener, options) => getSolanaWs().accountSubscribe(address, listener, options),
  getStatus: () => getSolanaWs().getStatus(),
  onStatus: (listener) => getSolanaWs().onStatus(listener),
  dispose: () => getSolanaWs().dispose(),
};
