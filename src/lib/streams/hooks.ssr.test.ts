import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { usePumpPortalMigrations, usePumpPortalNewTokens, usePumpPortalStatus } from '@/client/hooks/usePumpPortal';
import { useAccountSubscription, useLogsSubscription, useSolanaWsStatus } from '@/client/hooks/useSolanaSubscriptions';
import { useStreamStatus } from '@/client/hooks/useStreamStatus';
import { createPumpPortalClient } from './pumpportal';
import { createSolanaWsClient } from './solana-ws';
import { FakeWebSocket } from './testing/fake-websocket';

/**
 * The repo's Vitest runs in the node environment (no DOM renderer), so hook
 * effects are covered through the clients they wrap. This checks the server
 * render path: hooks render with server snapshots and never open a socket.
 */
describe('stream hooks during server rendering', () => {
  beforeEach(() => {
    FakeWebSocket.reset();
  });

  it('render idle status and open no connections', () => {
    const pump = createPumpPortalClient({ WebSocketImpl: FakeWebSocket });
    const solana = createSolanaWsClient({ WebSocketImpl: FakeWebSocket });
    const address = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

    function Probe() {
      usePumpPortalNewTokens(() => {}, { client: pump });
      usePumpPortalMigrations(() => {}, { client: pump });
      useLogsSubscription(address, () => {}, { client: solana });
      useAccountSubscription(address, 'base64', () => {}, { client: solana });
      const pumpStatus = usePumpPortalStatus(pump);
      const solanaStatus = useSolanaWsStatus(solana);
      const all = useStreamStatus();
      return createElement('span', null, [pumpStatus.status, solanaStatus.status, all.pumpPortal.badge, all.solanaWs.badge].join('|'));
    }

    const html = renderToString(createElement(Probe));
    expect(html).toContain('closed|closed|idle|idle');
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(pump.getStatus().consumers).toBe(0);
    expect(solana.getStatus().subscriptions).toBe(0);
  });
});
