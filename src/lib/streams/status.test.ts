import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPumpPortalClient } from './pumpportal';
import { createSolanaWsClient } from './solana-ws';
import { createStreamStatusStore, SERVER_STREAM_STATUS, streamBadge, streamStatusStore, toStreamStatusEntry } from './status';
import { FakeWebSocket } from './testing/fake-websocket';

describe('streamBadge', () => {
  it('maps socket states to header badges', () => {
    expect(streamBadge({ status: 'open', attempt: 0, consumers: 1 })).toBe('live');
    expect(streamBadge({ status: 'connecting', attempt: 0, consumers: 1 })).toBe('connecting');
    expect(streamBadge({ status: 'reconnecting', attempt: 1, consumers: 1 })).toBe('reconnecting');
    expect(streamBadge({ status: 'reconnecting', attempt: 3, consumers: 1 })).toBe('offline');
    expect(streamBadge({ status: 'closed', attempt: 0, consumers: 1 })).toBe('offline');
    expect(streamBadge({ status: 'closed', attempt: 0, consumers: 0 })).toBe('idle');
  });

  it('omits unknown optional fields', () => {
    expect(toStreamStatusEntry({ status: 'closed', attempt: 0, consumers: 0 })).toEqual({ badge: 'idle', status: 'closed', attempt: 0, consumers: 0 });
  });

  it('has an idle server snapshot', () => {
    expect(SERVER_STREAM_STATUS.pumpPortal.badge).toBe('idle');
    expect(SERVER_STREAM_STATUS.solanaWs.badge).toBe('idle');
  });
});

describe('stream status store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
    FakeWebSocket.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aggregates both streams with stable snapshots and change notifications', () => {
    const pump = createPumpPortalClient({ url: 'wss://pp.test', WebSocketImpl: FakeWebSocket, random: () => 0.5 });
    const solana = createSolanaWsClient({ url: 'wss://rpc.test', WebSocketImpl: FakeWebSocket, random: () => 0.5 });
    const store = createStreamStatusStore({ pumpPortal: pump, solanaWs: solana });
    const onChange = vi.fn();
    const unsubscribe = store.subscribe(onChange);

    const first = store.getSnapshot();
    expect(first.pumpPortal.badge).toBe('idle');
    expect(first.solanaWs.badge).toBe('idle');
    expect(store.getSnapshot()).toBe(first);

    pump.onNewToken(() => {});
    const pumpWs = FakeWebSocket.last();
    expect(store.getSnapshot().pumpPortal.badge).toBe('connecting');
    pumpWs.serverOpen();
    pumpWs.serverMessage({ message: 'Successfully subscribed to token creation events.' });
    const live = store.getSnapshot();
    expect(live.pumpPortal).toMatchObject({ badge: 'live', lastMessageAt: Date.now() });
    expect(live.solanaWs.badge).toBe('idle');
    expect(onChange).toHaveBeenCalled();

    // Frames within the throttle window do not produce new snapshots.
    vi.advanceTimersByTime(100);
    pumpWs.serverMessage('{}');
    expect(store.getSnapshot()).toBe(live);

    pumpWs.serverClose(1006);
    const dropped = store.getSnapshot();
    expect(dropped.pumpPortal.badge).toBe('reconnecting');
    expect(dropped.pumpPortal.nextRetryAt).toBe(Date.now() + 1_000);
    expect(dropped.pumpPortal.lastError).toBe('PumpPortal: closed (1006)');

    const calls = onChange.mock.calls.length;
    unsubscribe();
    solana.logsSubscribe('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', () => {});
    expect(onChange.mock.calls.length).toBe(calls);
    expect(store.getSnapshot().solanaWs.badge).toBe('connecting');
    pump.dispose();
    solana.dispose();
  });

  it('exposes a singleton store that reads without opening sockets', () => {
    const snap = streamStatusStore.getSnapshot();
    expect(snap).toBe(streamStatusStore.getSnapshot());
    expect(snap.pumpPortal.badge).toBe('idle');
    expect(snap.solanaWs.badge).toBe('idle');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
