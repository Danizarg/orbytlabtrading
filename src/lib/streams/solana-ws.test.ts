import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSolanaWsClient,
  getSolanaWs,
  parseAccountNotification,
  parseLogsNotification,
  type AccountUpdate,
  type LogsNotification,
  type SolanaWsClientOptions,
} from './solana-ws';
import { FakeWebSocket } from './testing/fake-websocket';

type Raw = Record<string, unknown>;
interface Notification {
  jsonrpc: string;
  method: string;
  params: { subscription: number; result: Raw };
}

function fixture<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures', dir, name), 'utf8')) as T;
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture index ${index} missing`);
  return item;
}

const logsFixture = fixture<{
  subscribeResponse: { result: number };
  notificationSuccess: Notification[];
  notificationFailed: Notification[];
  notificationCreate: Notification[];
}>('solana-rpc', 'publicnode_ws_logsSubscribe_pumpfun.json');
const accountFixture = fixture<{ subscribeResponse: { result: number }; notifications: Notification[] }>(
  'solana-rpc',
  'publicnode_ws_accountSubscribe_jsonParsed.json',
);
const officialAccountFixture = fixture<{ notifications: Notification[] }>('solana-rpc', 'solana_public_ws_accountSubscribe_jsonParsed.json');
/** getAccountInfo result has the same {context, value} shape as an accountNotification result. */
const bondingCurveInfo = fixture<{ result: Raw }>('pump', 'rpc-getAccountInfo-pump-bonding-curve.json');

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const FEE_ACCOUNT = 'Bvtgim23rfocUzxVX9j9QFxTbBnH8JZxnaGLCEkXvjKS';
const CURVE_PDA = '2JUXSuq1A1EdBzZj757cXFYuALPxv6vee4X981ajpzo8';
const WALLET = 'Di9s2Gg8eAwE26ruJ114bQWWQzF5Edajgj6eS5Q8TJzj';
const RECEIVED_AT = 1_790_000_000_000;

/** Re-address a real notification to a subscription id. */
function withSub(n: Notification, subscription: number): Notification {
  return { ...n, params: { ...n.params, subscription } };
}

describe('parseLogsNotification (real publicnode frames)', () => {
  it('normalizes a successful transaction', () => {
    const raw = at(logsFixture.notificationSuccess, 0);
    const n = parseLogsNotification(raw.params.result, RECEIVED_AT);
    expect(n).not.toBeNull();
    expect(n?.signature).toBe('4acJcbKmpeXva9hSSndfGScZbDF4V2HAyQ38Y7uNMnNzaQvwoJ8USLkXyecNF326XJ6C8oWxZgPRxofpRpVub5H1');
    expect(n?.err).toBeNull();
    expect(n?.slot).toBe(451433707);
    expect(n?.logs).toHaveLength(35);
    expect(n?.logs[2]).toBe('Program log: Instruction: Buy');
    expect(n?.receivedAt).toBe(RECEIVED_AT);
    expect(n?.source).toBe('solana-ws');
    expect(Object.keys(n ?? {})).not.toContain('_logsTotal');
  });

  it('keeps the error of a failed transaction', () => {
    const n = parseLogsNotification(at(logsFixture.notificationFailed, 0).params.result, RECEIVED_AT);
    expect(n?.err).toEqual({ InstructionError: [4, { Custom: 7 }] });
    expect(n?.logs.length).toBeGreaterThan(0);
  });

  it('rejects malformed results instead of inventing data', () => {
    expect(parseLogsNotification(null, RECEIVED_AT)).toBeNull();
    expect(parseLogsNotification({ value: { signature: 'x', logs: [] } }, RECEIVED_AT)).toBeNull();
    const raw = at(logsFixture.notificationSuccess, 0).params.result;
    const value = raw.value as Raw;
    expect(parseLogsNotification({ ...raw, value: { ...value, logs: null } }, RECEIVED_AT)).toBeNull();
    const noContext = parseLogsNotification({ value }, RECEIVED_AT);
    expect(noContext?.slot).toBeUndefined();
  });
});

describe('parseAccountNotification', () => {
  it('normalizes a real jsonParsed token-account notification', () => {
    const u = parseAccountNotification(at(accountFixture.notifications, 0).params.result, FEE_ACCOUNT, RECEIVED_AT);
    expect(u).toMatchObject({
      address: FEE_ACCOUNT,
      exists: true,
      slot: 451433741,
      lamports: 367293435877,
      sol: 367.293435877,
      owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      space: 165,
      source: 'solana-ws',
    });
    expect(u?.data).toMatchObject({ encoding: 'jsonParsed', program: 'spl-token', space: 165 });
    const parsed = u?.data?.encoding === 'jsonParsed' ? (u.data.parsed as { info: { tokenAmount: { uiAmountString: string } } }) : null;
    expect(parsed?.info.tokenAmount.uiAmountString).toBe('367.291947437');
    expect(Object.keys(u ?? {})).not.toContain('rentEpoch');
  });

  it('normalizes base64 account data (pump bonding curve)', () => {
    const u = parseAccountNotification(bondingCurveInfo.result, CURVE_PDA, RECEIVED_AT);
    expect(u?.data?.encoding).toBe('base64');
    expect(u?.data?.encoding === 'base64' ? u.data.base64.startsWith('F7f4N2DYrGA') : false).toBe(true);
    expect(u?.owner).toBe(PUMP_PROGRAM);
    expect(u?.lamports).toBe(1934880);
    expect(u?.slot).toBe(451434238);
    expect(u?.space).toBe(150);
  });

  it('reports a missing account as exists=false without fields', () => {
    expect(parseAccountNotification({ context: { slot: 5 }, value: null }, WALLET, RECEIVED_AT)).toEqual({
      address: WALLET,
      exists: false,
      slot: 5,
      receivedAt: RECEIVED_AT,
      source: 'solana-ws',
    });
    expect(parseAccountNotification({ context: { slot: 5 } }, WALLET, RECEIVED_AT)).toBeNull();
    expect(parseAccountNotification('x', WALLET, RECEIVED_AT)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Client behaviour
// ---------------------------------------------------------------------------

function client(overrides: SolanaWsClientOptions = {}) {
  return createSolanaWsClient({ url: 'wss://rpc.test', WebSocketImpl: FakeWebSocket, random: () => 0.5, lingerMs: 1_000, ...overrides });
}

interface SentRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params?: unknown[];
}

function sent(ws: FakeWebSocket): SentRequest[] {
  return ws.sentJson() as SentRequest[];
}

function lastRequest(ws: FakeWebSocket, method: string): SentRequest {
  const req = sent(ws)
    .filter((r) => r.method === method)
    .at(-1);
  if (!req) throw new Error(`no ${method} sent`);
  return req;
}

describe('Solana WS client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('subscribes to logs after open and routes notifications by subscription id', () => {
    const c = client();
    const seen: LogsNotification[] = [];
    c.logsSubscribe(PUMP_PROGRAM, (n) => seen.push(n));
    const ws = FakeWebSocket.last();
    expect(ws.sent).toEqual([]);
    ws.serverOpen();
    const req = lastRequest(ws, 'logsSubscribe');
    expect(req).toEqual({ jsonrpc: '2.0', id: req.id, method: 'logsSubscribe', params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'confirmed' }] });
    const subId = logsFixture.subscribeResponse.result;
    ws.serverMessage({ jsonrpc: '2.0', result: subId, id: req.id });
    expect(c.getStatus().confirmed).toBe(1);
    ws.serverMessage(at(logsFixture.notificationSuccess, 0));
    ws.serverMessage(at(logsFixture.notificationFailed, 0));
    ws.serverMessage(withSub(at(logsFixture.notificationCreate, 0), 999)); // unknown subscription
    expect(seen.map((n) => n.err === null)).toEqual([true, false]);
    expect(at(seen, 0).signature).toBe('4acJcbKmpeXva9hSSndfGScZbDF4V2HAyQ38Y7uNMnNzaQvwoJ8USLkXyecNF326XJ6C8oWxZgPRxofpRpVub5H1');
  });

  it('subscribes to account updates with the requested encoding and commitment', () => {
    const c = client();
    const updates: AccountUpdate[] = [];
    c.accountSubscribe(FEE_ACCOUNT, (u) => updates.push(u), { encoding: 'jsonParsed', commitment: 'processed' });
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    const req = lastRequest(ws, 'accountSubscribe');
    expect(req.params).toEqual([FEE_ACCOUNT, { encoding: 'jsonParsed', commitment: 'processed' }]);
    ws.serverMessage({ jsonrpc: '2.0', result: accountFixture.subscribeResponse.result, id: req.id });
    ws.serverMessage(at(accountFixture.notifications, 0));
    expect(updates).toHaveLength(1);
    expect(at(updates, 0).address).toBe(FEE_ACCOUNT);
    expect(at(updates, 0).lamports).toBe(367293435877);
    // A logs notification for an account subscription id is not mis-routed.
    ws.serverMessage(withSub(at(logsFixture.notificationSuccess, 0), accountFixture.subscribeResponse.result));
    expect(updates).toHaveLength(1);
  });

  it('ref-counts identical subscriptions and unsubscribes on the last listener', () => {
    const c = client();
    const a: string[] = [];
    const b: string[] = [];
    const offA = c.logsSubscribe(WALLET, (n) => a.push(n.signature));
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    const offB = c.logsSubscribe(WALLET, (n) => b.push(n.signature));
    expect(sent(ws).filter((r) => r.method === 'logsSubscribe')).toHaveLength(1);
    const req = lastRequest(ws, 'logsSubscribe');
    ws.serverMessage({ jsonrpc: '2.0', result: 77, id: req.id });
    ws.serverMessage(withSub(at(logsFixture.notificationSuccess, 1), 77));
    expect(a).toHaveLength(1);
    expect(b).toEqual(a);
    offA();
    offA();
    expect(sent(ws).some((r) => r.method === 'logsUnsubscribe')).toBe(false);
    offB();
    expect(lastRequest(ws, 'logsUnsubscribe').params).toEqual([77]);
    expect(c.getStatus().subscriptions).toBe(0);
    ws.serverMessage(withSub(at(logsFixture.notificationSuccess, 1), 77));
    expect(a).toHaveLength(1);
  });

  it('keeps different commitments and encodings as separate subscriptions', () => {
    const c = client();
    c.logsSubscribe(WALLET, () => {});
    c.logsSubscribe(WALLET, () => {}, { commitment: 'processed' });
    c.accountSubscribe(WALLET, () => {}, { encoding: 'base64' });
    c.accountSubscribe(WALLET, () => {}, { encoding: 'jsonParsed' });
    FakeWebSocket.last().serverOpen();
    expect(FakeWebSocket.last().sentMethods()).toEqual(['logsSubscribe', 'logsSubscribe', 'accountSubscribe', 'accountSubscribe']);
    expect(c.getStatus().subscriptions).toBe(4);
  });

  it('unsubscribes an orphaned subscription whose ack arrives after the last listener left', () => {
    const c = client();
    const keep = c.accountSubscribe(FEE_ACCOUNT, () => {});
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    const off = c.logsSubscribe(WALLET, () => {});
    const req = lastRequest(ws, 'logsSubscribe');
    off();
    expect(sent(ws).some((r) => r.method === 'logsUnsubscribe')).toBe(false);
    ws.serverMessage({ jsonrpc: '2.0', result: 4242, id: req.id });
    expect(lastRequest(ws, 'logsUnsubscribe').params).toEqual([4242]);
    expect(c.getStatus().confirmed).toBe(0);
    keep();
  });

  it('re-subscribes everything after a reconnect with fresh ids', () => {
    const c = client();
    const logs: string[] = [];
    const accounts: number[] = [];
    c.logsSubscribe(PUMP_PROGRAM, (n) => logs.push(n.signature));
    c.accountSubscribe(FEE_ACCOUNT, (u) => accounts.push(u.lamports ?? -1), { encoding: 'jsonParsed' });
    const ws1 = FakeWebSocket.last();
    ws1.serverOpen();
    const [logsReq1, accReq1] = sent(ws1);
    ws1.serverMessage({ jsonrpc: '2.0', result: 1, id: logsReq1?.id });
    ws1.serverMessage({ jsonrpc: '2.0', result: 2, id: accReq1?.id });
    expect(c.getStatus().confirmed).toBe(2);
    ws1.serverClose(1013, 'Connection timeout exceeded');
    expect(c.getStatus().confirmed).toBe(0);
    expect(c.getStatus().subscriptions).toBe(2);
    vi.advanceTimersByTime(1_000);
    const ws2 = FakeWebSocket.last();
    expect(ws2).not.toBe(ws1);
    ws2.serverOpen();
    const [logsReq2, accReq2] = sent(ws2);
    expect(logsReq2?.method).toBe('logsSubscribe');
    expect(accReq2?.method).toBe('accountSubscribe');
    expect(logsReq2?.id).not.toBe(logsReq1?.id);
    ws2.serverMessage({ jsonrpc: '2.0', result: 900, id: logsReq2?.id });
    ws2.serverMessage({ jsonrpc: '2.0', result: 901, id: accReq2?.id });
    // Old ids are dead on the new connection.
    ws2.serverMessage(withSub(at(logsFixture.notificationSuccess, 0), 1));
    ws2.serverMessage(withSub(at(logsFixture.notificationSuccess, 0), 900));
    ws2.serverMessage(withSub(at(officialAccountFixture.notifications, 1), 901));
    expect(logs).toHaveLength(1);
    expect(accounts).toEqual([366092189777]);
  });

  it('records subscription errors and server notices without crashing', () => {
    const c = client();
    c.logsSubscribe(WALLET, () => {});
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    const req = lastRequest(ws, 'logsSubscribe');
    ws.serverMessage({ jsonrpc: '2.0', error: { code: -32602, message: 'Invalid params' }, id: req.id });
    expect(c.getStatus().lastServerError).toBe('logsSubscribe: Invalid params');
    expect(c.getStatus().confirmed).toBe(0);
    ws.serverMessage({ jsonrpc: '2.0', error: { code: -32701, message: 'connection timeout exceeded' } });
    expect(c.getStatus().lastServerError).toBe('connection timeout exceeded');
    ws.serverMessage('not json');
    ws.serverMessage('[]');
    ws.serverMessage({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: 'x' } });
    expect(c.getStatus().status).toBe('open');
  });

  it('sends getHealth keepalives and reconnects when even those get no reply', () => {
    const c = client();
    c.logsSubscribe(WALLET, () => {});
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    vi.advanceTimersByTime(25_000);
    const ping = lastRequest(ws, 'getHealth');
    expect(ping).toEqual({ jsonrpc: '2.0', id: ping.id, method: 'getHealth' });
    ws.serverMessage({ jsonrpc: '2.0', result: 'ok', id: ping.id }); // publicnode's real reply
    vi.advanceTimersByTime(60_000);
    expect(c.getStatus().status).toBe('open');
    expect(sent(ws).filter((r) => r.method === 'getHealth')).toHaveLength(3);
    // No replies at all → idle watchdog (65 s since the last frame) reconnects.
    vi.advanceTimersByTime(5_000);
    expect(c.getStatus().status).toBe('reconnecting');
    expect(c.getStatus().lastError).toBe('Solana WS: no data for 65 s');
  });

  it('rejects invalid addresses', () => {
    const c = client();
    expect(() => c.logsSubscribe('not-an-address', () => {})).toThrow(TypeError);
    expect(() => c.accountSubscribe('', () => {})).toThrow(TypeError);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('closes after the last subscription (with linger) and survives a StrictMode double mount', () => {
    const c = client();
    const off1 = c.accountSubscribe(CURVE_PDA, () => {});
    off1();
    const off2 = c.accountSubscribe(CURVE_PDA, () => {});
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    expect(ws.sentMethods()).toEqual(['accountSubscribe']);
    off2();
    vi.advanceTimersByTime(1_000);
    expect(c.getStatus().status).toBe('closed');
    expect(c.getStatus().consumers).toBe(0);
  });

  it('isolates throwing listeners', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = client();
    const ok: string[] = [];
    c.logsSubscribe(PUMP_PROGRAM, () => {
      throw new Error('ui bug');
    });
    c.logsSubscribe(PUMP_PROGRAM, (n) => ok.push(n.signature));
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    ws.serverMessage({ jsonrpc: '2.0', result: 5, id: lastRequest(ws, 'logsSubscribe').id });
    ws.serverMessage(withSub(at(logsFixture.notificationSuccess, 0), 5));
    expect(ok).toHaveLength(1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('solanaWs singleton', () => {
  it('returns one shared client per tab and opens no socket on access', () => {
    expect(getSolanaWs()).toBe(getSolanaWs());
    expect(getSolanaWs().getStatus()).toMatchObject({ status: 'closed', subscriptions: 0, confirmed: 0 });
  });
});
