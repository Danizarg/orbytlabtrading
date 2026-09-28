/**
 * PumpPortal real-time data stream (browser-side, keyless).
 *
 * Verified 2026-09-28 against wss://pumpportal.fun/api/data:
 * - Free methods: subscribeNewToken, unsubscribeNewToken, subscribeMigration.
 *   There is NO unsubscribeMigration (sending it returns an `{errors}` frame),
 *   so migration events are simply dropped locally when nobody listens.
 * - subscribeTokenTrade / subscribeAccountTrade need a funded API key and are
 *   deliberately not implemented (keys must never reach the browser).
 * - PumpPortal asks for ONE connection per client; subscriptions accumulate
 *   on it. We keep one shared connection per tab (module singleton) and
 *   re-send the wanted subscriptions after every reconnect.
 * - Frames have no timestamp: `receivedAt` is our receipt time.
 * - `bondingCurveKey` was wrong in the wild (1/40), so it is never exposed:
 *   derive PDA(['bonding-curve', mint], pump program) instead.
 * - `marketCapSol` assumes a 1B supply and SOL quote: wrong ×2 for mayhem
 *   coins and meaningless for non-SOL-quote coins. The stream cannot identify
 *   a non-SOL quote (a live PUMP-paired coin was reported with SOL-shaped
 *   values), so treat stream SOL figures as provisional until the on-chain
 *   BondingCurve (quote_mint) is read.
 * - pool 'bonk' creates use a different schema and one live sample was an
 *   existing xStock mislabelled as a launch: surfaced only with mint + name +
 *   symbol, flagged `unverified`, without numeric fields.
 *
 * No throttling here; the UI throttles rendering (~42 pump creates/min).
 */

import { PUBLIC_ENDPOINTS } from '@/lib/config/capabilities';
import { num } from '@/lib/core/chain';
import { isSignature, isSolanaAddress } from '@/lib/core/solana';
import {
  ReconnectingSocket,
  reportListenerError,
  type BackoffOptions,
  type SocketState,
  type WebSocketCtor,
} from './reconnecting-socket';

// ---------------------------------------------------------------------------
// Normalized events
// ---------------------------------------------------------------------------

export type PumpPortalCreatePool = 'pump' | 'bonk';

export interface NewTokenEvent {
  mint: string;
  name?: string;
  symbol?: string;
  /** Off-chain metadata JSON URL (untrusted; fetch it for the image). */
  uri?: string;
  /** Transaction signer (`traderPublicKey`) = creator / dev wallet. */
  creator?: string;
  /** SOL the creator put into the curve in the create tx (`solAmount`, excl. fees). */
  devBuySol?: number;
  /** Tokens the creator bought in the create tx (`initialBuy`, UI units). */
  initialBuyTokens?: number;
  /** PumpPortal market cap in SOL (1B-supply formula). Only for non-mayhem pump.fun creates. */
  marketCapSol?: number;
  /** Bonding-curve progress 0–100 at creation, from vTokensInBondingCurve. Only for non-mayhem pump.fun creates. */
  progressPct?: number;
  /** pump.fun mayhem mode (2B supply, agent-adjusted reserves). */
  isMayhemMode?: boolean;
  /** Launchpad display id, matching LaunchpadState.launchpad. */
  launchpad: 'pump.fun' | 'letsbonk';
  pool: PumpPortalCreatePool;
  /** True for pool 'bonk': schema unverified and known to include mislabelled pool creations. */
  unverified?: boolean;
  signature: string;
  /** When this browser received the frame (ms); frames carry no timestamp. */
  receivedAt: number;
  source: 'pumpportal';
}

export interface MigrationEvent {
  mint: string;
  signature: string;
  /** Destination venue as reported; 'pump-amm' (PumpSwap) in every observed event. */
  pool: string;
  /** When this browser received the frame (ms). */
  receivedAt: number;
  source: 'pumpportal';
}

export type PumpPortalFrame =
  | { kind: 'newToken'; event: NewTokenEvent }
  | { kind: 'migration'; event: MigrationEvent }
  | { kind: 'notice'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'ignored'; reason: string };

// ---------------------------------------------------------------------------
// pump.fun curve constants (UI token units, 6 decimals applied)
// ---------------------------------------------------------------------------

/** Tokens sellable on a pump.fun curve (initial real token reserves). */
export const PUMP_CURVE_REAL_TOKENS = 793_100_000;
/** virtual − real token reserves; constant for every pump.fun curve (SOL, PUMP-paired and mayhem verified). */
export const PUMP_CURVE_VIRTUAL_OFFSET_TOKENS = 279_900_000;
/** Initial virtual SOL reserves of a SOL-quoted curve. */
const PUMP_INITIAL_VIRTUAL_SOL = 30;

/** Bonding progress 0–100 from virtual token reserves: (1 − (vTokens − 279.9M) / 793.1M) × 100, clamped. */
export function pumpProgressFromVirtualTokens(vTokens: number): number | undefined {
  if (!Number.isFinite(vTokens) || vTokens <= 0) return undefined;
  const pct = (1 - (vTokens - PUMP_CURVE_VIRTUAL_OFFSET_TOKENS) / PUMP_CURVE_REAL_TOKENS) * 100;
  return Math.min(100, Math.max(0, pct));
}

// ---------------------------------------------------------------------------
// Frame parsing
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t ? t : undefined;
}

/** Metadata URIs are third-party content: accept only web / IPFS / Arweave schemes. */
function metadataUri(value: unknown): string | undefined {
  const t = text(value);
  return t && /^(https?|ipfs|ar):\/\//i.test(t) ? t : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

/**
 * Sanity check that the stream's SOL figures follow the SOL-curve shape
 * (vSolInBondingCurve = 30 + solAmount). Held for all 39 live pump creates;
 * a curve reported with real non-SOL quote reserves would fail it.
 */
function solShapeConsistent(vSol: number | undefined, solAmount: number | undefined): boolean {
  if (vSol === undefined || solAmount === undefined) return false;
  return Math.abs(vSol - solAmount - PUMP_INITIAL_VIRTUAL_SOL) < 1e-6;
}

export function normalizeNewTokenEvent(raw: Raw, receivedAt: number): NewTokenEvent | null {
  const mint = raw.mint;
  const signature = raw.signature;
  if (!isSolanaAddress(mint) || !isSignature(signature)) return null;
  const pool = raw.pool;
  const creator = isSolanaAddress(raw.traderPublicKey) ? raw.traderPublicKey : undefined;
  const name = text(raw.name);
  const symbol = text(raw.symbol);
  const uri = metadataUri(raw.uri);

  if (pool === 'pump') {
    const isMayhemMode = typeof raw.is_mayhem_mode === 'boolean' ? raw.is_mayhem_mode : undefined;
    const solAmount = nonNegative(raw.solAmount);
    const vSol = num(raw.vSolInBondingCurve);
    const vTokens = num(raw.vTokensInBondingCurve);
    const solOk = solShapeConsistent(vSol, solAmount);
    // Mayhem status must be known to be false: mayhem coins have 2B supply.
    const standard = isMayhemMode === false;
    const marketCapSol = num(raw.marketCapSol);
    const event: NewTokenEvent = {
      mint,
      launchpad: 'pump.fun',
      pool: 'pump',
      signature,
      receivedAt,
      source: 'pumpportal',
    };
    if (name) event.name = name;
    if (symbol) event.symbol = symbol;
    if (uri) event.uri = uri;
    if (creator) event.creator = creator;
    if (solOk && solAmount !== undefined) event.devBuySol = solAmount;
    const initialBuy = nonNegative(raw.initialBuy);
    if (initialBuy !== undefined) event.initialBuyTokens = initialBuy;
    if (standard && solOk && marketCapSol !== undefined && marketCapSol > 0) event.marketCapSol = marketCapSol;
    if (standard && vTokens !== undefined) {
      const progress = pumpProgressFromVirtualTokens(vTokens);
      if (progress !== undefined) event.progressPct = progress;
    }
    if (isMayhemMode !== undefined) event.isMayhemMode = isMayhemMode;
    return event;
  }

  if (pool === 'bonk') {
    // Unverified schema: require identity fields, expose no amounts.
    if (!name || !symbol) return null;
    const event: NewTokenEvent = {
      mint,
      name,
      symbol,
      launchpad: 'letsbonk',
      pool: 'bonk',
      unverified: true,
      signature,
      receivedAt,
      source: 'pumpportal',
    };
    if (uri) event.uri = uri;
    if (creator) event.creator = creator;
    return event;
  }

  return null;
}

export function normalizeMigrationEvent(raw: Raw, receivedAt: number): MigrationEvent | null {
  const mint = raw.mint;
  const signature = raw.signature;
  const pool = text(raw.pool);
  if (!isSolanaAddress(mint) || !isSignature(signature) || !pool) return null;
  return { mint, signature, pool, receivedAt, source: 'pumpportal' };
}

/** Parse one text frame. Never throws: bad JSON and unknown shapes come back as `ignored`. */
export function parsePumpPortalFrame(data: string, receivedAt: number): PumpPortalFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { kind: 'ignored', reason: 'invalid JSON' };
  }
  if (!isRecord(parsed)) return { kind: 'ignored', reason: 'not an object' };

  const errors = parsed.errors;
  if (errors !== undefined) {
    const message = typeof errors === 'string' ? errors : Array.isArray(errors) ? errors.filter((e) => typeof e === 'string').join('; ') : 'server error';
    return { kind: 'error', message: message || 'server error' };
  }

  const txType = parsed.txType;
  if (txType === undefined) {
    const message = text(parsed.message);
    return message ? { kind: 'notice', message } : { kind: 'ignored', reason: 'unrecognized frame' };
  }
  if (txType === 'create') {
    const event = normalizeNewTokenEvent(parsed, receivedAt);
    return event ? { kind: 'newToken', event } : { kind: 'ignored', reason: 'incomplete create event' };
  }
  if (txType === 'migrate') {
    const event = normalizeMigrationEvent(parsed, receivedAt);
    return event ? { kind: 'migration', event } : { kind: 'ignored', reason: 'incomplete migrate event' };
  }
  return { kind: 'ignored', reason: `unsupported txType ${String(txType).slice(0, 32)}` };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface PumpPortalStatus extends SocketState {
  /** Subscriptions active on the current connection. */
  subscribed: { newToken: boolean; migration: boolean };
  /** Last informational server message (e.g. subscription acks). */
  lastNotice?: string;
  /** Last `{errors}` frame from the server. */
  lastServerError?: string;
}

export interface PumpPortalClient {
  onNewToken(listener: (event: NewTokenEvent) => void): () => void;
  onMigration(listener: (event: MigrationEvent) => void): () => void;
  getStatus(): PumpPortalStatus;
  onStatus(listener: (status: PumpPortalStatus) => void): () => void;
  /** Stop listening entirely and close the connection (tests / teardown). */
  dispose(): void;
}

export interface PumpPortalClientOptions {
  url?: string;
  WebSocketImpl?: WebSocketCtor;
  backoff?: BackoffOptions;
  /** Idle watchdog while new-token events are subscribed (≈42 creates/min live). Default 90 s. */
  idleTimeoutMs?: number;
  /** Idle watchdog when only migrations are subscribed (sparse). Default 15 min. */
  migrationOnlyIdleTimeoutMs?: number;
  lingerMs?: number;
  stableAfterMs?: number;
  connectTimeoutMs?: number;
  random?: () => number;
  now?: () => number;
}

export function createPumpPortalClient(options: PumpPortalClientOptions = {}): PumpPortalClient {
  const now = options.now ?? (() => Date.now());
  const newTokenListeners = new Set<(event: NewTokenEvent) => void>();
  const migrationListeners = new Set<(event: MigrationEvent) => void>();
  const statusListeners = new Set<(status: PumpPortalStatus) => void>();
  /** What the server has been asked for on the current connection. */
  const server = { newToken: false, migration: false };
  let lastNotice: string | undefined;
  let lastServerError: string | undefined;
  let release: (() => void) | null = null;
  let snapshot: PumpPortalStatus | null = null;

  const socket = new ReconnectingSocket({
    url: options.url ?? PUBLIC_ENDPOINTS.pumpPortalWs,
    label: 'PumpPortal',
    WebSocketImpl: options.WebSocketImpl,
    backoff: options.backoff,
    lingerMs: options.lingerMs,
    stableAfterMs: options.stableAfterMs,
    connectTimeoutMs: options.connectTimeoutMs,
    random: options.random,
    now,
    onOpen: () => {
      // Subscriptions do not survive a reconnect: re-send what is wanted.
      server.newToken = false;
      server.migration = false;
      sync();
    },
    onMessage: handleMessage,
  });
  socket.onState(() => {
    if (socket.getStatus() !== 'open' && (server.newToken || server.migration)) {
      server.newToken = false;
      server.migration = false;
    }
    emit();
  });

  function send(method: 'subscribeNewToken' | 'unsubscribeNewToken' | 'subscribeMigration'): boolean {
    return socket.sendNow(JSON.stringify({ method }));
  }

  /** Reconcile server-side subscriptions with local listeners (only while open). */
  function sync(): void {
    const wantNew = newTokenListeners.size > 0;
    const wantMigration = migrationListeners.size > 0;
    socket.setIdleTimeout(
      wantNew ? (options.idleTimeoutMs ?? 90_000) : wantMigration ? (options.migrationOnlyIdleTimeoutMs ?? 900_000) : 0,
    );
    if (!socket.isOpen()) return;
    let changed = false;
    if (wantNew && !server.newToken && send('subscribeNewToken')) {
      server.newToken = true;
      changed = true;
    } else if (!wantNew && server.newToken && send('unsubscribeNewToken')) {
      server.newToken = false;
      changed = true;
    }
    // No unsubscribeMigration exists: once subscribed, stay subscribed for this connection.
    if (wantMigration && !server.migration && send('subscribeMigration')) {
      server.migration = true;
      changed = true;
    }
    if (changed) emit();
  }

  function retainIfNeeded(): void {
    const wanted = newTokenListeners.size + migrationListeners.size > 0;
    if (wanted && !release) release = socket.acquire();
    else if (!wanted && release) {
      const r = release;
      release = null;
      r();
    }
  }

  function handleMessage(data: string): void {
    const frame = parsePumpPortalFrame(data, now());
    switch (frame.kind) {
      case 'newToken':
        for (const listener of [...newTokenListeners]) {
          try {
            listener(frame.event);
          } catch (error) {
            reportListenerError(error);
          }
        }
        return;
      case 'migration':
        for (const listener of [...migrationListeners]) {
          try {
            listener(frame.event);
          } catch (error) {
            reportListenerError(error);
          }
        }
        return;
      case 'notice':
        if (frame.message !== lastNotice) {
          lastNotice = frame.message;
          emit();
        }
        return;
      case 'error':
        if (frame.message !== lastServerError) {
          lastServerError = frame.message;
          emit();
        }
        return;
      default:
        return;
    }
  }

  function buildStatus(): PumpPortalStatus {
    return {
      ...socket.getState(),
      subscribed: { newToken: server.newToken, migration: server.migration },
      lastNotice,
      lastServerError,
    };
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

  function addListener<T>(set: Set<T>, listener: T): () => void {
    set.add(listener);
    retainIfNeeded();
    sync();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      set.delete(listener);
      sync();
      retainIfNeeded();
    };
  }

  return {
    onNewToken: (listener) => addListener(newTokenListeners, listener),
    onMigration: (listener) => addListener(migrationListeners, listener),
    getStatus: () => (snapshot ??= buildStatus()),
    onStatus(listener) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    dispose() {
      newTokenListeners.clear();
      migrationListeners.clear();
      if (release) {
        const r = release;
        release = null;
        r();
      }
      socket.close();
    },
  };
}

let shared: PumpPortalClient | null = null;

/** The tab-wide PumpPortal client (created lazily; the socket opens on the first listener). */
export function getPumpPortal(): PumpPortalClient {
  return (shared ??= createPumpPortalClient());
}

/** Tab-wide singleton facade: `pumpPortal.onNewToken(cb)` etc. */
export const pumpPortal: PumpPortalClient = {
  onNewToken: (listener) => getPumpPortal().onNewToken(listener),
  onMigration: (listener) => getPumpPortal().onMigration(listener),
  getStatus: () => getPumpPortal().getStatus(),
  onStatus: (listener) => getPumpPortal().onStatus(listener),
  dispose: () => getPumpPortal().dispose(),
};
