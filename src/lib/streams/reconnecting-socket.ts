/**
 * Generic reconnecting WebSocket for browser streams (PumpPortal, Solana
 * PubSub). Vercel functions cannot hold sockets, so every stream in ORBYT is
 * opened by the visitor's browser.
 *
 * Behaviour:
 * - Exponential backoff with jitter between attempts (1 s → 30 s by default).
 *   The attempt counter only resets once a connection has stayed open for
 *   `stableAfterMs`, so a server that accepts and immediately drops us
 *   (rebalancing, temporary bans) cannot cause a tight reconnect loop.
 * - Idle watchdog: while open, if no frame arrives for `idleTimeoutMs` the
 *   socket is abandoned and reconnected (detects half-open connections).
 * - Optional application-level keepalive (browsers cannot send WS pings).
 * - Frames sent while connecting are queued and flushed after `onOpen`.
 * - Ref-counted consumers (`acquire()`): the connection opens on the first
 *   consumer and closes `lingerMs` after the last one leaves, so React
 *   StrictMode's mount → unmount → mount does not tear it down.
 * - Keeps streaming while the tab is hidden (no visibility pausing).
 *
 * Status notes never contain the URL (a configured URL may carry an API key).
 */

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** The subset of the DOM WebSocket used here; the browser WebSocket satisfies it. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

/** WebSocket.OPEN (kept local so this module does not need a global WebSocket to load). */
const WS_OPEN = 1;

export interface BackoffOptions {
  /** First retry delay (ms). Default 1000. */
  initialMs?: number;
  /** Ceiling for any delay (ms). Default 30000. */
  maxMs?: number;
  /** Growth per consecutive failure. Default 2. */
  factor?: number;
  /** Symmetric jitter as a fraction of the delay (0.25 = ±25%). Default 0.25. */
  jitter?: number;
}

export interface KeepaliveOptions {
  intervalMs: number;
  /** Frame to send; the server's reply counts as activity for the idle watchdog. */
  message: () => string;
}

export interface ReconnectingSocketOptions {
  url: string;
  /** Short name used in status notes instead of the URL. */
  label?: string;
  /** Injectable constructor (tests). Defaults to the global WebSocket at connect time. */
  WebSocketImpl?: WebSocketCtor;
  /** Runs after every successful open (first connect and each reconnect): (re)subscribe here. */
  onOpen?: () => void;
  /** Text frames only; binary frames are ignored. */
  onMessage?: (data: string) => void;
  onStatus?: (status: SocketStatus) => void;
  backoff?: BackoffOptions;
  /** Open time after which the backoff resets (ms). Default 10000. */
  stableAfterMs?: number;
  /** Abandon an attempt that has not opened after this long (ms). Default 15000. */
  connectTimeoutMs?: number;
  /** Reconnect when no frame arrives for this long while open (ms). 0 disables. Default 0. */
  idleTimeoutMs?: number;
  keepalive?: KeepaliveOptions;
  /** Delay before closing after the last consumer releases (ms). Default 3000. */
  lingerMs?: number;
  /** Max frames queued while not open; oldest are dropped first. Default 500. */
  maxQueue?: number;
  /** Minimum spacing of state emissions caused only by message activity (ms). Default 1000. */
  activityThrottleMs?: number;
  /** Injectable randomness for jitter (tests). */
  random?: () => number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface SocketState {
  status: SocketStatus;
  /** When the last frame was received (ms). Refreshed at most once per `activityThrottleMs`. */
  lastMessageAt?: number;
  /** When the current connection opened (ms). */
  openedAt?: number;
  /** Consecutive failed / unstable connection attempts. */
  attempt: number;
  /** When the next reconnect attempt is scheduled (ms). */
  nextRetryAt?: number;
  /** User-safe description of the last drop or error (never the URL). */
  lastError?: string;
  /** Consumers currently holding the connection via `acquire()`. */
  consumers: number;
}

type Timer = ReturnType<typeof setTimeout>;

/** Log a consumer callback failure without letting it break the stream. */
export function reportListenerError(error: unknown): void {
  console.error('[orbyt:streams] listener failed', error);
}

export class ReconnectingSocket {
  private readonly opts: ReconnectingSocketOptions;
  private readonly label: string;
  private readonly now: () => number;
  private readonly random: () => number;

  private ws: WebSocketLike | null = null;
  private running = false;
  private retrying = false;
  private status: SocketStatus = 'closed';
  private attempt = 0;
  private openedAt?: number;
  private lastMessageAt?: number;
  private lastActivityAt = 0;
  private lastActivityEmitAt = 0;
  private nextRetryAt?: number;
  private lastError?: string;
  private idleTimeoutMs: number;
  private queue: string[] = [];
  private refs = 0;

  private reconnectTimer?: Timer;
  private connectTimer?: Timer;
  private stableTimer?: Timer;
  private idleTimer?: Timer;
  private keepaliveTimer?: ReturnType<typeof setInterval>;
  private lingerTimer?: Timer;

  private snapshot: SocketState;
  private readonly stateListeners = new Set<(state: SocketState) => void>();
  private readonly statusListeners = new Set<(status: SocketStatus) => void>();

  constructor(options: ReconnectingSocketOptions) {
    this.opts = options;
    this.label = options.label ?? 'stream';
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? (() => Math.random());
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
    this.snapshot = this.buildSnapshot();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Start connecting (no-op when already running). */
  start(): void {
    this.clearLinger();
    if (this.running) return;
    this.running = true;
    this.retrying = false;
    this.attempt = 0;
    this.lastError = undefined;
    this.connect();
  }

  /** Stop: close the connection, cancel every timer and stop reconnecting. `start()` may restart it. */
  close(): void {
    this.running = false;
    this.retrying = false;
    this.clearLinger();
    this.clearTimer('reconnectTimer');
    this.clearConnectionTimers();
    this.dropSocket(1000, 'client closed');
    this.queue = [];
    this.openedAt = undefined;
    this.nextRetryAt = undefined;
    this.setStatus('closed', true);
  }

  /**
   * Register a consumer. The first consumer starts the connection; the
   * returned release function is idempotent and closes the connection
   * `lingerMs` after the last consumer releases.
   */
  acquire(): () => void {
    this.refs++;
    this.clearLinger();
    if (!this.running) this.start();
    else this.emitState();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refs = Math.max(0, this.refs - 1);
      this.emitState();
      if (this.refs === 0) this.scheduleLinger();
    };
  }

  /** Send now when open, otherwise queue until the next open (only while running). Returns true when sent immediately. */
  send(data: string): boolean {
    if (this.sendNow(data)) return true;
    if (!this.running) return false;
    this.queue.push(data);
    const max = this.opts.maxQueue ?? 500;
    if (this.queue.length > max) this.queue.splice(0, this.queue.length - max);
    return false;
  }

  /** Send only when open; never queues. Returns whether the frame was handed to the socket. */
  sendNow(data: string): boolean {
    const ws = this.ws;
    if (!ws || this.status !== 'open' || ws.readyState !== WS_OPEN) return false;
    try {
      ws.send(data);
      return true;
    } catch {
      return false;
    }
  }

  isOpen(): boolean {
    return this.status === 'open' && this.ws?.readyState === WS_OPEN;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Drop the current connection (if any) and reconnect immediately. */
  reconnectNow(reason = 'manual reconnect'): void {
    if (!this.running) return;
    this.clearTimer('reconnectTimer');
    this.clearConnectionTimers();
    this.dropSocket(4000, reason);
    this.retrying = true;
    this.lastError = reason;
    this.nextRetryAt = undefined;
    this.connect();
  }

  /** Change the idle watchdog (ms; 0 disables). Re-arms immediately when open. */
  setIdleTimeout(ms: number): void {
    if (ms === this.idleTimeoutMs) return;
    this.idleTimeoutMs = ms;
    if (this.status === 'open') this.armIdle();
  }

  getIdleTimeout(): number {
    return this.idleTimeoutMs;
  }

  getStatus(): SocketStatus {
    return this.status;
  }

  /** Immutable snapshot; the same object is returned until something changes. */
  getState(): SocketState {
    return this.snapshot;
  }

  onStatus(listener: (status: SocketStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onState(listener: (state: SocketState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private resolveImpl(): WebSocketCtor | undefined {
    if (this.opts.WebSocketImpl) return this.opts.WebSocketImpl;
    const g = globalThis as { WebSocket?: WebSocketCtor };
    return typeof g.WebSocket === 'function' ? g.WebSocket : undefined;
  }

  private connect(): void {
    this.clearTimer('reconnectTimer');
    this.nextRetryAt = undefined;
    const Impl = this.resolveImpl();
    if (!Impl) {
      // SSR or an environment without WebSocket: stay closed, never retry.
      this.running = false;
      this.lastError = `${this.label}: WebSocket unavailable`;
      this.setStatus('closed', true);
      return;
    }
    this.setStatus(this.retrying ? 'reconnecting' : 'connecting', true);
    let ws: WebSocketLike;
    try {
      ws = new Impl(this.opts.url);
    } catch {
      this.handleDrop(`${this.label}: could not open connection`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws === ws) this.handleOpen();
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.handleMessage(ev.data);
    };
    ws.onerror = () => {
      // A close event always follows; only record the note here.
      if (this.ws === ws) this.lastError = `${this.label}: connection error`;
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) this.handleDrop(`${this.label}: closed (${ev.code}${ev.reason ? ` ${ev.reason.slice(0, 80)}` : ''})`);
    };
    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined;
      if (this.ws === ws && this.status !== 'open') this.handleDrop(`${this.label}: connect timeout`);
    }, this.opts.connectTimeoutMs ?? 15_000);
  }

  private handleOpen(): void {
    this.clearTimer('connectTimer');
    const t = this.now();
    this.openedAt = t;
    this.lastActivityAt = t;
    this.retrying = false;
    this.lastError = undefined;
    this.setStatus('open', true);
    this.stableTimer = setTimeout(() => {
      this.stableTimer = undefined;
      if (this.attempt !== 0) {
        this.attempt = 0;
        this.emitState();
      }
    }, this.opts.stableAfterMs ?? 10_000);
    this.armIdle();
    this.armKeepalive();
    try {
      this.opts.onOpen?.();
    } catch (error) {
      reportListenerError(error);
    }
    if (this.queue.length && this.isOpen()) {
      const pending = this.queue;
      this.queue = [];
      for (const frame of pending) this.sendNow(frame);
    }
  }

  private handleMessage(data: unknown): void {
    const t = this.now();
    this.lastActivityAt = t;
    this.lastMessageAt = t;
    if (t - this.lastActivityEmitAt >= (this.opts.activityThrottleMs ?? 1_000)) {
      this.lastActivityEmitAt = t;
      this.emitState();
    }
    if (typeof data !== 'string') return;
    try {
      this.opts.onMessage?.(data);
    } catch (error) {
      reportListenerError(error);
    }
  }

  /** The current connection ended unexpectedly (close, error, timeout, idle). */
  private handleDrop(reason: string): void {
    this.clearConnectionTimers();
    this.dropSocket(4000, 'reconnecting');
    this.openedAt = undefined;
    this.lastError = reason;
    if (!this.running) {
      this.setStatus('closed', true);
      return;
    }
    this.retrying = true;
    const delay = this.nextDelay();
    this.attempt++;
    this.nextRetryAt = this.now() + delay;
    this.setStatus('reconnecting', true);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.running) this.connect();
    }, delay);
  }

  /** Backoff delay for the current attempt: min(max, initial × factor^attempt) with ±jitter, capped at max. */
  private nextDelay(): number {
    const b = this.opts.backoff ?? {};
    const initial = b.initialMs ?? 1_000;
    const max = b.maxMs ?? 30_000;
    const factor = b.factor ?? 2;
    const jitter = b.jitter ?? 0.25;
    const base = Math.min(max, initial * Math.pow(factor, this.attempt));
    const jittered = base * (1 + jitter * (2 * this.random() - 1));
    return Math.round(Math.min(max, Math.max(0, jittered)));
  }

  /** Detach handlers first so a late event from the old socket cannot affect the new one. */
  private dropSocket(code: number, reason: string): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close(code, reason);
    } catch {
      // Already closed / invalid state: nothing to clean up.
    }
  }

  private armIdle(): void {
    this.clearTimer('idleTimer');
    const ms = this.idleTimeoutMs;
    if (!ms || ms <= 0 || this.status !== 'open') return;
    const check = () => {
      this.idleTimer = undefined;
      if (this.status !== 'open') return;
      const idleFor = this.now() - this.lastActivityAt;
      if (idleFor >= ms) {
        this.handleDrop(`${this.label}: no data for ${Math.round(ms / 1000)} s`);
        return;
      }
      this.idleTimer = setTimeout(check, ms - idleFor);
    };
    this.idleTimer = setTimeout(check, ms);
  }

  private armKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
    const ka = this.opts.keepalive;
    if (!ka || ka.intervalMs <= 0) return;
    this.keepaliveTimer = setInterval(() => {
      if (!this.isOpen()) return;
      let frame: string;
      try {
        frame = ka.message();
      } catch (error) {
        reportListenerError(error);
        return;
      }
      this.sendNow(frame);
    }, ka.intervalMs);
  }

  private scheduleLinger(): void {
    this.clearLinger();
    const ms = this.opts.lingerMs ?? 3_000;
    if (ms <= 0) {
      if (this.refs === 0) this.close();
      return;
    }
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = undefined;
      if (this.refs === 0) this.close();
    }, ms);
  }

  private clearLinger(): void {
    this.clearTimer('lingerTimer');
  }

  private clearConnectionTimers(): void {
    this.clearTimer('connectTimer');
    this.clearTimer('stableTimer');
    this.clearTimer('idleTimer');
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
  }

  private clearTimer(name: 'reconnectTimer' | 'connectTimer' | 'stableTimer' | 'idleTimer' | 'lingerTimer'): void {
    const t = this[name];
    if (t !== undefined) clearTimeout(t);
    this[name] = undefined;
  }

  // -------------------------------------------------------------------------
  // State emission
  // -------------------------------------------------------------------------

  private buildSnapshot(): SocketState {
    return {
      status: this.status,
      lastMessageAt: this.lastMessageAt,
      openedAt: this.openedAt,
      attempt: this.attempt,
      nextRetryAt: this.nextRetryAt,
      lastError: this.lastError,
      consumers: this.refs,
    };
  }

  /** Update status; `forceState` also re-emits the snapshot when only other fields changed. */
  private setStatus(status: SocketStatus, forceState = false): void {
    const changed = status !== this.status;
    this.status = status;
    if (changed) {
      try {
        this.opts.onStatus?.(status);
      } catch (error) {
        reportListenerError(error);
      }
      for (const listener of [...this.statusListeners]) {
        try {
          listener(status);
        } catch (error) {
          reportListenerError(error);
        }
      }
    }
    if (changed || forceState) this.emitState();
  }

  private emitState(): void {
    this.snapshot = this.buildSnapshot();
    const snapshot = this.snapshot;
    for (const listener of [...this.stateListeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        reportListenerError(error);
      }
    }
  }
}
