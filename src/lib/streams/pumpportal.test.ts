import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPumpPortalClient,
  getPumpPortal,
  normalizeNewTokenEvent,
  parsePumpPortalFrame,
  pumpProgressFromVirtualTokens,
  type MigrationEvent,
  type NewTokenEvent,
  type PumpPortalClientOptions,
} from './pumpportal';
import { FakeWebSocket } from './testing/fake-websocket';

type Raw = Record<string, unknown>;

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/pump', name), 'utf8')) as T;
}

const pumpCreates = fixture<{ events: Raw[] }>('pumpportal_ws_subscribeNewToken_pump_create_events.json').events;
const bonkCreates = fixture<{ events: Raw[] }>('pumpportal_ws_subscribeNewToken_bonk_create_events.json').events;
const migrationFixture = fixture<{ events: Raw[]; createEventOfSecondMint: Raw }>('pumpportal_ws_subscribeMigration_events.json');
const control = fixture<{ received: Array<{ message: Raw }> }>('pumpportal_ws_control_messages_2026-09-28.json');
const sessionLog = readFileSync(path.join(process.cwd(), 'tests/fixtures/pump/pumpportal_ws_raw_session_log_2026-09-28.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { dir: string; data: unknown });

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture index ${index} missing`);
  return item;
}

const RECEIVED_AT = 1_790_000_000_000;

function parseCreate(raw: Raw): NewTokenEvent {
  const frame = parsePumpPortalFrame(JSON.stringify(raw), RECEIVED_AT);
  if (frame.kind !== 'newToken') throw new Error(`expected newToken, got ${frame.kind}`);
  return frame.event;
}

describe('pumpProgressFromVirtualTokens', () => {
  it('maps the curve from 0% (untouched) to 100% (fully sold) and clamps', () => {
    expect(pumpProgressFromVirtualTokens(1_073_000_000)).toBe(0);
    expect(pumpProgressFromVirtualTokens(279_900_000)).toBe(100);
    expect(pumpProgressFromVirtualTokens(1_200_000_000)).toBe(0);
    expect(pumpProgressFromVirtualTokens(100_000_000)).toBe(100);
    expect(pumpProgressFromVirtualTokens(676_450_000)).toBeCloseTo(50, 10);
    expect(pumpProgressFromVirtualTokens(Number.NaN)).toBeUndefined();
    expect(pumpProgressFromVirtualTokens(0)).toBeUndefined();
  });
});

describe('parsePumpPortalFrame — real create events (pool pump)', () => {
  it('normalizes a standard create with dev buy', () => {
    const e = parseCreate(at(pumpCreates, 0));
    expect(e).toMatchObject({
      mint: '24DUUJB1gT27TdbqvuLBUZqKJR1xbpFwTfNVoroWxq1P',
      name: 'PALMO',
      symbol: 'PALMO',
      uri: 'https://pump.mypinata.cloud/ipfs/bafkreih3rzlvard4wax7fzy22iaxyd7aivvrzaviuwhipae2ltx3k5p24e',
      creator: 'Di9s2Gg8eAwE26ruJ114bQWWQzF5Edajgj6eS5Q8TJzj',
      devBuySol: 1.85,
      initialBuyTokens: 62324960.753532,
      marketCapSol: 31.513591177384267,
      isMayhemMode: false,
      launchpad: 'pump.fun',
      pool: 'pump',
      signature: '58GxbVCPKzjvMaFuiY9PNVeAeL1ftNENZwqX4cSdpNKADXtxnYBmV2CQji9SvpXnFybdJs7K83KnN6WEcmmVXp9d',
      receivedAt: RECEIVED_AT,
      source: 'pumpportal',
    });
    // initialBuy / 793.1M sellable tokens
    expect(e.progressPct).toBeCloseTo((62324960.753532 / 793_100_000) * 100, 9);
    expect(e.unverified).toBeUndefined();
  });

  it('never exposes bondingCurveKey or raw upstream fields', () => {
    for (const raw of pumpCreates) {
      const e = parseCreate(raw);
      expect(Object.keys(e)).not.toContain('bondingCurveKey');
      expect(JSON.stringify(e)).not.toContain(String(raw.bondingCurveKey));
      expect(Object.keys(e)).not.toContain('vSolInBondingCurve');
    }
  });

  it('flags mayhem coins and omits their market cap and progress', () => {
    const e = parseCreate(at(pumpCreates, 1));
    expect(e.symbol).toBe('HALH');
    expect(e.isMayhemMode).toBe(true);
    expect(e.marketCapSol).toBeUndefined();
    expect(e.progressPct).toBeUndefined();
    expect(e.devBuySol).toBe(0.195542678);
    expect(e.initialBuyTokens).toBe(6948618.075286);
  });

  it('omits missing name/symbol/uri and keeps a real zero dev buy', () => {
    const e = parseCreate(at(pumpCreates, 2));
    expect(e.mint).toBe('cPW1Zrx1zqEVb21pcQrzfjNkhS4Dz6fyztKooh6xfEX');
    expect('name' in e).toBe(false);
    expect('symbol' in e).toBe(false);
    expect('uri' in e).toBe(false);
    expect(e.devBuySol).toBe(0);
    expect(e.initialBuyTokens).toBe(0);
    expect(e.progressPct).toBe(0);
    expect(e.marketCapSol).toBe(27.958993476234856);
  });

  it('computes 100% for the create that bought the whole curve (initialBuy 793,100,000)', () => {
    const e = parseCreate(migrationFixture.createEventOfSecondMint);
    expect(e.initialBuyTokens).toBe(793_100_000);
    expect(e.progressPct).toBe(100);
    expect(e.devBuySol).toBe(85.005359057);
    expect(e.marketCapSol).toBe(410.8801681200643);
    expect(e.name).toBe('Claude');
  });

  it('parses numeric strings and omits SOL figures when mayhem status is unknown', () => {
    const raw = { ...at(pumpCreates, 0), solAmount: '1.85', vSolInBondingCurve: '31.85', marketCapSol: '31.5', initialBuy: '62324960.753532' };
    delete (raw as Raw).is_mayhem_mode;
    const e = parseCreate(raw);
    expect(e.devBuySol).toBe(1.85);
    expect(e.initialBuyTokens).toBe(62324960.753532);
    expect(e.isMayhemMode).toBeUndefined();
    expect(e.marketCapSol).toBeUndefined();
    expect(e.progressPct).toBeUndefined();
  });

  it('omits SOL figures when they do not follow the SOL-curve shape', () => {
    // e.g. a curve reported with real non-SOL quote reserves (4,292 USDC initial virtual quote)
    const e = parseCreate({ ...at(pumpCreates, 0), vSolInBondingCurve: 4293.85 });
    expect(e.devBuySol).toBeUndefined();
    expect(e.marketCapSol).toBeUndefined();
    expect(e.initialBuyTokens).toBe(62324960.753532);
    expect(e.progressPct).toBeDefined();
  });

  it('drops creates without a valid mint or signature and rejects unsafe metadata URIs', () => {
    expect(parsePumpPortalFrame(JSON.stringify({ ...at(pumpCreates, 0), mint: 'not-a-mint' }), RECEIVED_AT).kind).toBe('ignored');
    expect(parsePumpPortalFrame(JSON.stringify({ ...at(pumpCreates, 0), signature: 42 }), RECEIVED_AT).kind).toBe('ignored');
    const e = parseCreate({ ...at(pumpCreates, 0), uri: 'javascript:alert(1)', traderPublicKey: 'nope' });
    expect(e.uri).toBeUndefined();
    expect(e.creator).toBeUndefined();
  });
});

describe('parsePumpPortalFrame — bonk, migrations and control frames', () => {
  it('drops the real bonk create (no name/symbol: a mislabelled pool creation)', () => {
    const frame = parsePumpPortalFrame(JSON.stringify(at(bonkCreates, 0)), RECEIVED_AT);
    expect(frame).toEqual({ kind: 'ignored', reason: 'incomplete create event' });
  });

  it('surfaces bonk creates with identity as unverified letsbonk events without amounts', () => {
    const e = parseCreate({ ...at(bonkCreates, 0), name: 'Bonk Test', symbol: 'BT' });
    expect(e).toEqual({
      mint: 'Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8',
      name: 'Bonk Test',
      symbol: 'BT',
      launchpad: 'letsbonk',
      pool: 'bonk',
      unverified: true,
      creator: 'AV7PjXHL5JXZ1YoYRoN9Dsstg1x2UciBupMCXcJP8gUz',
      signature: '5h7BsoZq91g8TXfVErMetWBa2x2VZDVEzgNvvi7b2p5qfpzKXT2iG3jgTRNHBfPiE8SieG3rXonybgtLsxL3q4BY',
      receivedAt: RECEIVED_AT,
      source: 'pumpportal',
    });
  });

  it('normalizes real migrate events', () => {
    const frames = migrationFixture.events.map((raw) => parsePumpPortalFrame(JSON.stringify(raw), RECEIVED_AT));
    expect(frames).toEqual([
      {
        kind: 'migration',
        event: {
          mint: 'GJJ6TADXU6TdvBR8siNxLqYzbcwc6ixgxFCg7Ystpump',
          signature: '3kNYYYzipdWUwX7ZrgvWEwzLwNpvcLGgBy1P6JNgZWqXUpaAQ8eRGkzzvbgukDeyFwwrMbQGeorUj8gFf3Hubp6x',
          pool: 'pump-amm',
          receivedAt: RECEIVED_AT,
          source: 'pumpportal',
        } satisfies MigrationEvent,
      },
      {
        kind: 'migration',
        event: {
          mint: '4ov9rwwS4iBHeTWGCrVaQYW1HzWK51MSfs8csGAApump',
          signature: '2nLGhzNKBCJH9U3ZUKS4kjdQWufDhYrw4BKrSWT4m5Lir4zSWxSzKDZ4KJdgcAQAihqwgycvqseVMbyGup8TzVZj',
          pool: 'pump-amm',
          receivedAt: RECEIVED_AT,
          source: 'pumpportal',
        },
      },
    ]);
  });

  it('classifies real acks as notices and the unsubscribeMigration rejection as an error', () => {
    const kinds = control.received.map((r) => parsePumpPortalFrame(JSON.stringify(r.message), RECEIVED_AT));
    expect(kinds.map((k) => k.kind)).toEqual(['notice', 'notice', 'notice', 'notice', 'notice', 'error']);
    expect(at(kinds, 0)).toEqual({ kind: 'notice', message: 'Successfully subscribed to token creation events.' });
    expect(at(kinds, 5)).toMatchObject({ kind: 'error' });
  });

  it('never throws on garbage frames', () => {
    expect(parsePumpPortalFrame('{not json', RECEIVED_AT)).toEqual({ kind: 'ignored', reason: 'invalid JSON' });
    expect(parsePumpPortalFrame('[1,2]', RECEIVED_AT).kind).toBe('ignored');
    expect(parsePumpPortalFrame('null', RECEIVED_AT).kind).toBe('ignored');
    expect(parsePumpPortalFrame('{}', RECEIVED_AT).kind).toBe('ignored');
    expect(parsePumpPortalFrame('{"errors":["a","b"]}', RECEIVED_AT)).toEqual({ kind: 'error', message: 'a; b' });
    expect(parsePumpPortalFrame(JSON.stringify({ ...at(pumpCreates, 0), txType: 'buy' }), RECEIVED_AT).kind).toBe('ignored');
    expect(parsePumpPortalFrame(JSON.stringify({ txType: 'migrate', mint: 'x', signature: 'y', pool: 'pump-amm' }), RECEIVED_AT).kind).toBe('ignored');
  });

  it('parses the full real session log', () => {
    const counts: Record<string, number> = {};
    for (const entry of sessionLog) {
      if (entry.dir !== 'in') continue;
      const kind = parsePumpPortalFrame(JSON.stringify(entry.data), RECEIVED_AT).kind;
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    // 39 pump creates, 1 bonk create without identity (ignored), 2 migrations, 5 notices, 1 error.
    expect(counts).toEqual({ newToken: 39, ignored: 1, migration: 2, notice: 5, error: 1 });
  });

  it('exposes normalizeNewTokenEvent for already-parsed payloads', () => {
    expect(normalizeNewTokenEvent({ ...at(pumpCreates, 0), pool: 'raydium' }, RECEIVED_AT)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Client behaviour
// ---------------------------------------------------------------------------

function client(overrides: PumpPortalClientOptions = {}) {
  return createPumpPortalClient({ url: 'wss://pumpportal.test/api/data', WebSocketImpl: FakeWebSocket, random: () => 0.5, lingerMs: 1_000, ...overrides });
}

describe('PumpPortal client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens nothing until the first listener, then shares one connection', () => {
    const pp = client();
    expect(FakeWebSocket.instances).toHaveLength(0);
    const a: NewTokenEvent[] = [];
    const b: NewTokenEvent[] = [];
    const m: MigrationEvent[] = [];
    pp.onNewToken((e) => a.push(e));
    pp.onNewToken((e) => b.push(e));
    pp.onMigration((e) => m.push(e));
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.last();
    expect(ws.sent).toEqual([]); // nothing is queued while connecting
    ws.serverOpen();
    expect(ws.sentJson()).toEqual([{ method: 'subscribeNewToken' }, { method: 'subscribeMigration' }]);
    expect(pp.getStatus().subscribed).toEqual({ newToken: true, migration: true });

    ws.serverMessage(at(pumpCreates, 0));
    ws.serverMessage(at(migrationFixture.events, 0));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.symbol).toBe('PALMO');
    expect(m.map((e) => e.mint)).toEqual(['GJJ6TADXU6TdvBR8siNxLqYzbcwc6ixgxFCg7Ystpump']);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('subscribes each stream once, including listeners added after open', () => {
    const pp = client();
    pp.onNewToken(() => {});
    FakeWebSocket.last().serverOpen();
    pp.onNewToken(() => {});
    pp.onMigration(() => {});
    pp.onMigration(() => {});
    expect(FakeWebSocket.last().sentMethods()).toEqual(['subscribeNewToken', 'subscribeMigration']);
  });

  it('re-sends the wanted subscriptions after every reconnect', () => {
    const pp = client();
    const seen: string[] = [];
    pp.onNewToken((e) => seen.push(e.mint));
    pp.onMigration((e) => seen.push(`migrate:${e.mint}`));
    FakeWebSocket.last().serverOpen();
    FakeWebSocket.last().serverClose(1006);
    expect(pp.getStatus().status).toBe('reconnecting');
    expect(pp.getStatus().subscribed).toEqual({ newToken: false, migration: false });
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const ws2 = FakeWebSocket.last();
    ws2.serverOpen();
    expect(ws2.sentMethods()).toEqual(['subscribeNewToken', 'subscribeMigration']);
    ws2.serverMessage(at(pumpCreates, 1));
    ws2.serverMessage(at(migrationFixture.events, 1));
    expect(seen).toEqual(['Cn573YtVhybK8t9GY6eaG1HKgzQrtK2KotgPHYFepump', 'migrate:4ov9rwwS4iBHeTWGCrVaQYW1HzWK51MSfs8csGAApump']);
  });

  it('unsubscribes new tokens on the last listener but never sends unsubscribeMigration', () => {
    const pp = client();
    const offNew1 = pp.onNewToken(() => {});
    const offNew2 = pp.onNewToken(() => {});
    const migrations: MigrationEvent[] = [];
    const offMig = pp.onMigration((e) => migrations.push(e));
    const keep = pp.onMigration(() => {});
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    offNew1();
    expect(ws.sentMethods()).toEqual(['subscribeNewToken', 'subscribeMigration']);
    offNew2();
    expect(ws.sentMethods()).toEqual(['subscribeNewToken', 'subscribeMigration', 'unsubscribeNewToken']);
    expect(pp.getStatus().subscribed.newToken).toBe(false);
    offMig();
    ws.serverMessage(at(migrationFixture.events, 0));
    expect(migrations).toHaveLength(0);
    keep();
    // Re-adding a migration listener on the same connection does not re-subscribe (still subscribed server-side).
    pp.onMigration(() => {});
    pp.onNewToken(() => {});
    expect(ws.sentMethods()).toEqual(['subscribeNewToken', 'subscribeMigration', 'unsubscribeNewToken', 'subscribeNewToken']);
    expect(FakeWebSocket.allSentJson()).not.toContainEqual({ method: 'unsubscribeMigration' });
  });

  it('closes after the last listener leaves (after the linger) and reopens on demand', () => {
    const pp = client();
    const off = pp.onMigration(() => {});
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    off();
    expect(pp.getStatus().status).toBe('open');
    vi.advanceTimersByTime(1_000);
    expect(pp.getStatus().status).toBe('closed');
    expect(ws.closeCalls).toHaveLength(1);
    expect(FakeWebSocket.allSentJson()).not.toContainEqual({ method: 'unsubscribeMigration' });
    pp.onMigration(() => {});
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.last().serverOpen();
    expect(FakeWebSocket.last().sentMethods()).toEqual(['subscribeMigration']);
  });

  it('is safe under a StrictMode double mount', () => {
    const pp = client();
    const events: NewTokenEvent[] = [];
    const listener = (e: NewTokenEvent) => events.push(e);
    const off1 = pp.onNewToken(listener);
    off1();
    off1(); // idempotent
    pp.onNewToken(listener);
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    vi.advanceTimersByTime(5_000);
    expect(ws.sentMethods()).toEqual(['subscribeNewToken']);
    ws.serverMessage(at(pumpCreates, 0));
    expect(events).toHaveLength(1);
  });

  it('survives JSON parse errors and isolates throwing listeners', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pp = client();
    const good: string[] = [];
    pp.onNewToken(() => {
      throw new Error('ui bug');
    });
    pp.onNewToken((e) => good.push(e.mint));
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    ws.serverMessage('{"signature":"trunc');
    ws.serverMessage('');
    ws.serverMessage(at(pumpCreates, 0));
    ws.serverMessage(at(pumpCreates, 2));
    expect(good).toEqual(['24DUUJB1gT27TdbqvuLBUZqKJR1xbpFwTfNVoroWxq1P', 'cPW1Zrx1zqEVb21pcQrzfjNkhS4Dz6fyztKooh6xfEX']);
    expect(pp.getStatus().status).toBe('open');
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('surfaces acks and server errors in the status', () => {
    const pp = client();
    const statuses: string[] = [];
    pp.onStatus((s) => statuses.push(s.status));
    pp.onMigration(() => {});
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    ws.serverMessage({ message: "Subscribed to 'migration' events." });
    expect(pp.getStatus().lastNotice).toBe("Subscribed to 'migration' events.");
    const errorFrame = at(control.received, 5).message;
    ws.serverMessage(errorFrame);
    expect(pp.getStatus().lastServerError).toBe(errorFrame.errors);
    expect(statuses).toContain('connecting');
    expect(statuses).toContain('open');
    const snap = pp.getStatus();
    expect(pp.getStatus()).toBe(snap);
  });

  it('uses a tight idle watchdog for new tokens and a loose one for migrations only', () => {
    const pp = client();
    const offNew = pp.onNewToken(() => {});
    pp.onMigration(() => {});
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    offNew();
    // Only migrations remain: 90 s of silence is fine.
    vi.advanceTimersByTime(120_000);
    expect(pp.getStatus().status).toBe('open');
    pp.onNewToken(() => {});
    vi.advanceTimersByTime(90_000);
    expect(pp.getStatus().status).toBe('reconnecting');
    expect(pp.getStatus().lastError).toBe('PumpPortal: no data for 90 s');
  });

  it('never implements the paid trade subscriptions', () => {
    const pp = client();
    pp.onNewToken(() => {});
    pp.onMigration(() => {});
    FakeWebSocket.last().serverOpen();
    const methods = FakeWebSocket.allSentJson().map((m) => (m as { method: string }).method);
    expect(methods.some((m) => /Trade/.test(m))).toBe(false);
  });

  it('dispose() closes the connection', () => {
    const pp = client();
    pp.onNewToken(() => {});
    FakeWebSocket.last().serverOpen();
    pp.dispose();
    expect(pp.getStatus().status).toBe('closed');
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('pumpPortal singleton', () => {
  it('returns one shared client per tab and opens no socket on access', () => {
    expect(getPumpPortal()).toBe(getPumpPortal());
    expect(getPumpPortal().getStatus().status).toBe('closed');
  });
});
