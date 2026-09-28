import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReconnectingSocket, type ReconnectingSocketOptions, type SocketStatus } from './reconnecting-socket';
import { FakeWebSocket } from './testing/fake-websocket';

function make(overrides: Partial<ReconnectingSocketOptions> = {}) {
  const messages: string[] = [];
  const statuses: SocketStatus[] = [];
  const onOpen = vi.fn();
  const socket = new ReconnectingSocket({
    url: 'wss://example.test/stream?api-key=SECRET',
    label: 'Test',
    WebSocketImpl: FakeWebSocket,
    random: () => 0.5,
    onOpen,
    onMessage: (data) => messages.push(data),
    onStatus: (s) => statuses.push(s),
    ...overrides,
  });
  return { socket, messages, statuses, onOpen };
}

/** Advance to the next reconnect and return the newly constructed socket. */
function expectReconnectAfter(ms: number): FakeWebSocket {
  const before = FakeWebSocket.instances.length;
  vi.advanceTimersByTime(ms - 1);
  expect(FakeWebSocket.instances.length).toBe(before);
  vi.advanceTimersByTime(1);
  expect(FakeWebSocket.instances.length).toBe(before + 1);
  return FakeWebSocket.last();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ReconnectingSocket lifecycle', () => {
  it('connects on start, reports connecting → open and runs onOpen', () => {
    const { socket, statuses, onOpen } = make();
    expect(socket.getStatus()).toBe('closed');
    socket.start();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.last().url).toBe('wss://example.test/stream?api-key=SECRET');
    expect(socket.getStatus()).toBe('connecting');
    FakeWebSocket.last().serverOpen();
    expect(socket.getStatus()).toBe('open');
    expect(socket.isOpen()).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['connecting', 'open']);
    expect(socket.getState().openedAt).toBe(Date.now());
  });

  it('delivers text frames and ignores binary frames', () => {
    const { socket, messages } = make();
    socket.start();
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    ws.serverMessage('{"a":1}');
    ws.serverBinary();
    expect(messages).toEqual(['{"a":1}']);
  });

  it('never puts the URL (which may carry a key) into status notes', () => {
    const { socket } = make();
    socket.start();
    FakeWebSocket.last().serverClose(1006);
    const note = socket.getState().lastError ?? '';
    expect(note).toContain('Test');
    expect(note).not.toContain('SECRET');
    expect(note).not.toContain('example.test');
  });
});

describe('backoff', () => {
  it('grows exponentially from 1 s and caps at 30 s', () => {
    const { socket, statuses } = make();
    socket.start();
    FakeWebSocket.last().serverClose();
    expect(socket.getStatus()).toBe('reconnecting');
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const [i, delay] of delays.entries()) {
      expect(socket.getState().nextRetryAt).toBe(Date.now() + delay);
      expect(socket.getState().attempt).toBe(i + 1);
      const ws = expectReconnectAfter(delay);
      expect(socket.getStatus()).toBe('reconnecting');
      ws.serverClose();
    }
    expect(statuses[0]).toBe('connecting');
    expect(statuses).not.toContain('open');
  });

  it('applies ±25% jitter without exceeding the 30 s ceiling', () => {
    const low = make({ random: () => 0 });
    low.socket.start();
    FakeWebSocket.last().serverClose();
    expect(low.socket.getState().nextRetryAt! - Date.now()).toBe(750);
    low.socket.close();

    FakeWebSocket.reset();
    const high = make({ random: () => 0.999999 });
    high.socket.start();
    FakeWebSocket.last().serverClose();
    expect(high.socket.getState().nextRetryAt! - Date.now()).toBe(1_250);
    // Drive to the cap: the jittered delay must never exceed maxMs.
    for (let i = 0; i < 8; i++) {
      const delay = high.socket.getState().nextRetryAt! - Date.now();
      expect(delay).toBeLessThanOrEqual(30_000);
      vi.advanceTimersByTime(delay);
      FakeWebSocket.last().serverClose();
    }
    expect(high.socket.getState().nextRetryAt! - Date.now()).toBe(30_000);
  });

  it('keeps growing when connections open but drop before becoming stable', () => {
    const { socket } = make();
    socket.start();
    FakeWebSocket.last().serverOpen();
    FakeWebSocket.last().serverClose();
    expect(socket.getState().nextRetryAt! - Date.now()).toBe(1_000);
    expectReconnectAfter(1_000).serverOpen();
    vi.advanceTimersByTime(5_000); // open, but not yet stable (10 s)
    FakeWebSocket.last().serverClose();
    expect(socket.getState().nextRetryAt! - Date.now()).toBe(2_000);
  });

  it('resets after the connection has been stable for stableAfterMs', () => {
    const { socket } = make();
    socket.start();
    FakeWebSocket.last().serverClose();
    expectReconnectAfter(1_000).serverClose();
    expectReconnectAfter(2_000).serverOpen();
    expect(socket.getState().attempt).toBe(2);
    vi.advanceTimersByTime(10_000);
    expect(socket.getState().attempt).toBe(0);
    FakeWebSocket.last().serverClose();
    expect(socket.getState().nextRetryAt! - Date.now()).toBe(1_000);
  });

  it('abandons an attempt that never opens (connect timeout) and retries', () => {
    const { socket } = make({ connectTimeoutMs: 5_000 });
    socket.start();
    const first = FakeWebSocket.last();
    vi.advanceTimersByTime(5_000);
    expect(first.closeCalls).toHaveLength(1);
    expect(first.onmessage).toBeNull();
    expect(socket.getState().lastError).toBe('Test: connect timeout');
    expectReconnectAfter(1_000);
  });
});

describe('idle watchdog', () => {
  it('reconnects when no frame arrives for idleTimeoutMs, but not while traffic flows', () => {
    const { socket, messages } = make({ idleTimeoutMs: 5_000 });
    socket.start();
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(3_000);
      ws.serverMessage(`m${i}`);
    }
    expect(socket.getStatus()).toBe('open');
    vi.advanceTimersByTime(5_000);
    expect(socket.getStatus()).toBe('reconnecting');
    expect(ws.closeCalls).toHaveLength(1);
    expect(socket.getState().lastError).toBe('Test: no data for 5 s');
    // Late frames from the abandoned socket are ignored.
    ws.serverMessage('late');
    expect(messages).toEqual(['m0', 'm1', 'm2', 'm3']);
    const next = expectReconnectAfter(1_000);
    next.serverOpen();
    expect(socket.getStatus()).toBe('open');
  });

  it('can be changed at runtime and disabled with 0', () => {
    const { socket } = make({ idleTimeoutMs: 5_000 });
    socket.start();
    FakeWebSocket.last().serverOpen();
    socket.setIdleTimeout(0);
    vi.advanceTimersByTime(60_000);
    expect(socket.getStatus()).toBe('open');
    socket.setIdleTimeout(2_000);
    vi.advanceTimersByTime(2_000);
    expect(socket.getStatus()).toBe('reconnecting');
  });
});

describe('keepalive', () => {
  it('sends the keepalive frame on its interval only while open', () => {
    let n = 0;
    const { socket } = make({ keepalive: { intervalMs: 25_000, message: () => `ping${++n}` } });
    socket.start();
    vi.advanceTimersByTime(10_000); // connecting: nothing sent
    const ws = FakeWebSocket.last();
    expect(FakeWebSocket.instances).toHaveLength(1);
    ws.serverOpen();
    vi.advanceTimersByTime(50_000);
    expect(ws.sent).toEqual(['ping1', 'ping2']);
    socket.close();
    vi.advanceTimersByTime(100_000);
    expect(ws.sent).toEqual(['ping1', 'ping2']);
  });
});

describe('send queue', () => {
  it('queues while connecting and flushes after onOpen', () => {
    const order: string[] = [];
    const { socket } = make({
      onOpen: () => {
        order.push('onOpen');
        socket.sendNow('resubscribe');
      },
    });
    socket.start();
    expect(socket.send('a')).toBe(false);
    expect(socket.send('b')).toBe(false);
    expect(socket.sendNow('c')).toBe(false);
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    order.push('opened');
    expect(order).toEqual(['onOpen', 'opened']);
    expect(ws.sent).toEqual(['resubscribe', 'a', 'b']);
    expect(socket.send('d')).toBe(true);
    expect(ws.sent.at(-1)).toBe('d');
  });

  it('keeps only the newest maxQueue frames and drops sends when stopped', () => {
    const { socket } = make({ maxQueue: 2 });
    expect(socket.send('ignored-not-running')).toBe(false);
    socket.start();
    socket.send('1');
    socket.send('2');
    socket.send('3');
    FakeWebSocket.last().serverOpen();
    expect(FakeWebSocket.last().sent).toEqual(['2', '3']);
  });
});

describe('close and ref-counting', () => {
  it('close() stops reconnecting for good', () => {
    const { socket, statuses } = make();
    socket.start();
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    socket.close();
    expect(ws.closeCalls).toEqual([{ code: 1000, reason: 'client closed' }]);
    expect(socket.getStatus()).toBe('closed');
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(statuses.at(-1)).toBe('closed');
  });

  it('close() during a pending retry cancels it', () => {
    const { socket } = make();
    socket.start();
    FakeWebSocket.last().serverClose();
    socket.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.getState().nextRetryAt).toBeUndefined();
  });

  it('survives a StrictMode mount → unmount → mount with one connection', () => {
    const { socket } = make({ lingerMs: 3_000 });
    const release1 = socket.acquire();
    release1();
    const release2 = socket.acquire();
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.last().serverOpen();
    vi.advanceTimersByTime(10_000);
    expect(socket.getStatus()).toBe('open');
    expect(socket.getState().consumers).toBe(1);
    release2();
    release2(); // idempotent
    expect(socket.getState().consumers).toBe(0);
    vi.advanceTimersByTime(2_999);
    expect(socket.getStatus()).toBe('open');
    vi.advanceTimersByTime(1);
    expect(socket.getStatus()).toBe('closed');
    expect(FakeWebSocket.last().closeCalls).toHaveLength(1);
  });

  it('keeps the connection while any consumer remains', () => {
    const { socket } = make({ lingerMs: 0 });
    const a = socket.acquire();
    const b = socket.acquire();
    FakeWebSocket.last().serverOpen();
    a();
    expect(socket.getStatus()).toBe('open');
    b();
    expect(socket.getStatus()).toBe('closed');
    socket.acquire();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(socket.getStatus()).toBe('connecting');
  });
});

describe('robustness', () => {
  it('stays closed with a note when no WebSocket implementation exists', () => {
    vi.stubGlobal('WebSocket', undefined);
    try {
      const socket = new ReconnectingSocket({ url: 'wss://x.test', label: 'NoWS' });
      socket.start();
      expect(socket.getStatus()).toBe('closed');
      expect(socket.isRunning()).toBe(false);
      expect(socket.getState().lastError).toBe('NoWS: WebSocket unavailable');
      vi.advanceTimersByTime(60_000);
      expect(socket.getStatus()).toBe('closed');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retries when the constructor throws', () => {
    let calls = 0;
    class Throwing extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        if (++calls === 1) throw new Error('SyntaxError');
      }
    }
    const socket = new ReconnectingSocket({ url: 'wss://x.test', WebSocketImpl: Throwing, random: () => 0.5 });
    socket.start();
    expect(socket.getStatus()).toBe('reconnecting');
    vi.advanceTimersByTime(1_000);
    FakeWebSocket.last().serverOpen();
    expect(socket.getStatus()).toBe('open');
  });

  it('isolates a throwing onMessage consumer', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    const socket = new ReconnectingSocket({
      url: 'wss://x.test',
      WebSocketImpl: FakeWebSocket,
      onMessage: (data) => {
        seen.push(data);
        if (data === 'boom') throw new Error('consumer bug');
      },
    });
    socket.start();
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    ws.serverMessage('boom');
    ws.serverMessage('ok');
    expect(seen).toEqual(['boom', 'ok']);
    expect(socket.getStatus()).toBe('open');
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('throttles activity-only state emissions and keeps snapshots stable', () => {
    const { socket } = make({ activityThrottleMs: 1_000 });
    const states: number[] = [];
    socket.onState((s) => states.push(s.lastMessageAt ?? 0));
    socket.start();
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    const emittedAfterOpen = states.length;
    const snap = socket.getState();
    expect(socket.getState()).toBe(snap);
    for (let i = 0; i < 50; i++) {
      ws.serverMessage('x');
      vi.advanceTimersByTime(20);
    }
    // 50 frames over 1 s → at most two activity emissions.
    expect(states.length - emittedAfterOpen).toBeLessThanOrEqual(2);
    expect(socket.getState().lastMessageAt).toBeDefined();
  });

  it('reconnectNow() replaces the connection immediately', () => {
    const { socket, onOpen } = make();
    socket.start();
    const first = FakeWebSocket.last();
    first.serverOpen();
    socket.reconnectNow('network changed');
    expect(first.closeCalls).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(socket.getStatus()).toBe('reconnecting');
    FakeWebSocket.last().serverOpen();
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
