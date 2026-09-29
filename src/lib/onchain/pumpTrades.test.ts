import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodePumpTradeEventLogLine,
  decodePumpTradeEvents,
  decodePumpTradeEventsFromLogs,
  logsTruncated,
  type PumpTradeEvent,
} from '@/lib/analytics/swaps';
import type { RpcParsedTransaction } from '@/lib/analytics/tx-types';
import { PROGRAMS } from '@/lib/core/solana';
import { priceWithSol, pumpTradeFromEvents, rawToNumber, reservePriceSol, tradeFromPumpEvents } from './pumpTrades';

/**
 * Log-line TradeEvent decoding (the path the on-chain feed uses for
 * logsSubscribe notifications) against the three live pump.fun captures in
 * tests/fixtures/solana-rpc: every field must equal the fixture's
 * independently decoded `_decodedPumpTradeEvents`, and the event self-CPI
 * decoder of the full transaction.
 */

interface Fixture {
  response: { result: RpcParsedTransaction & { meta: { logMessages: string[] } } };
  _decodedPumpTradeEvents: Array<Record<string, string | boolean>>;
}

const FIXTURES = [
  'rpc_getTransaction_pumpfun_bondingcurve_buyExactSolIn_legacy.json',
  'rpc_getTransaction_pumpfun_bondingcurve_buyV2_v0.json',
  'rpc_getTransaction_pumpfun_bondingcurve_sell_v1.json',
] as const;

function load(name: string): Fixture {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/solana-rpc', name), 'utf8')) as Fixture;
}

function wsNotifications(): Array<{ signature: string; err: unknown; logs: string[] }> {
  const file = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/solana-rpc/publicnode_ws_logsSubscribe_pumpfun.json'), 'utf8')) as {
    notificationSuccess: Array<{ params: { result: { value: { signature: string; err: unknown; logs: string[] } } } }>;
  };
  return file.notificationSuccess.map((n) => n.params.result.value);
}

function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`expected ${what}`);
  return value;
}

describe('decodePumpTradeEventsFromLogs (logsSubscribe path)', () => {
  for (const name of FIXTURES) {
    it(`decodes the TradeEvent of ${name} exactly like the fixture decode`, () => {
      const fixture = load(name);
      const logs = fixture.response.result.meta.logMessages;
      const events = decodePumpTradeEventsFromLogs(logs);
      expect(events).toHaveLength(1);
      const event = must(events[0]);
      const expected = must(fixture._decodedPumpTradeEvents[0]);
      expect(event.mint).toBe(expected.mint);
      expect(event.solAmount).toBe(BigInt(expected.sol_amount as string));
      expect(event.tokenAmount).toBe(BigInt(expected.token_amount as string));
      expect(event.isBuy).toBe(expected.is_buy);
      expect(event.user).toBe(expected.user);
      expect(event.timestamp).toBe(Number(expected.timestamp));
      expect(event.virtualSolReserves).toBe(BigInt(expected.virtual_sol_reserves as string));
      expect(event.virtualTokenReserves).toBe(BigInt(expected.virtual_token_reserves as string));
      expect(event.realSolReserves).toBe(BigInt(expected.real_sol_reserves as string));
      expect(event.realTokenReserves).toBe(BigInt(expected.real_token_reserves as string));
      expect(event.fee).toBe(BigInt(expected.fee as string));
      expect(event.creatorFee).toBe(BigInt(expected.creator_fee as string));
      expect(event.ixName).toBe(expected.ix_name);
    });

    it(`matches the event self-CPI decode of the full transaction (${name})`, () => {
      const tx = load(name).response.result;
      expect(decodePumpTradeEventsFromLogs(tx.meta.logMessages)).toEqual(decodePumpTradeEvents(tx));
    });
  }

  it('decodes real publicnode logsNotification payloads (buy and sell)', () => {
    const [buy, sell] = wsNotifications();
    const buyEvents = decodePumpTradeEventsFromLogs(must(buy).logs);
    const sellEvents = decodePumpTradeEventsFromLogs(must(sell).logs);
    expect(buyEvents).toHaveLength(1);
    expect(sellEvents).toHaveLength(1);
    expect(buyEvents[0]).toMatchObject({ isBuy: true, ixName: 'buy' });
    expect(sellEvents[0]).toMatchObject({ isBuy: false, ixName: 'sell' });
    // Routed through a trading-bot program (FLASHX…): the event is still emitted while pump executes.
    expect(must(buyEvents[0]).tokenAmount).toBeGreaterThan(0n);
  });

  it('ignores a TradeEvent-shaped line emitted while another program executes', () => {
    const logs = load(FIXTURES[1]).response.result.meta.logMessages;
    const dataLine = must(logs.find((l) => l.startsWith('Program data: ')));
    const spoof = ['Program FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9 invoke [1]', dataLine, 'Program FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9 success'];
    expect(decodePumpTradeEventsFromLogs(spoof)).toEqual([]);
    const genuine = [`Program ${PROGRAMS.PUMP} invoke [1]`, dataLine, `Program ${PROGRAMS.PUMP} success`];
    expect(decodePumpTradeEventsFromLogs(genuine)).toHaveLength(1);
  });

  it('stops at "Log truncated" and reports truncation', () => {
    const logs = load(FIXTURES[1]).response.result.meta.logMessages;
    const index = logs.findIndex((l) => l.startsWith('Program data: '));
    const truncated = [...logs.slice(0, index), 'Log truncated', ...logs.slice(index)];
    expect(decodePumpTradeEventsFromLogs(truncated)).toEqual([]);
    expect(logsTruncated(truncated)).toBe(true);
    expect(logsTruncated(logs)).toBe(false);
  });

  it('decodes one line on its own and rejects other data', () => {
    const logs = load(FIXTURES[2]).response.result.meta.logMessages;
    const line = must(logs.find((l) => l.startsWith('Program data: ')));
    expect(decodePumpTradeEventLogLine(line)?.isBuy).toBe(false);
    expect(decodePumpTradeEventLogLine('Program log: Instruction: Buy')).toBeUndefined();
    expect(decodePumpTradeEventLogLine('Program data: AAAA')).toBeUndefined();
    expect(decodePumpTradeEventLogLine('Program data: !!not base64!!')).toBeUndefined();
    expect(decodePumpTradeEventsFromLogs('not an array')).toEqual([]);
  });
});

describe('tradeFromPumpEvents', () => {
  const fixture = load('rpc_getTransaction_pumpfun_bondingcurve_buyV2_v0.json');
  const event = must(decodePumpTradeEventsFromLogs(fixture.response.result.meta.logMessages)[0]);
  const MINT = '7ehsmTN3JRgZ54A4T6WN2PSKgM2FhxJ4bbgGV8Y1pump';
  const CURVE = '9ZZuz4cVoYhbAFomLMHJjpPijY7EXryqHRjY79f9VC7A';
  const SIG = '4udm6NA1et1irGeY4UNyd8hHYEdAr1ZZ6B4NkqeVFPwDp97qx87KjL2FYSSKb4YVmM4jAKh5Uv2yi4TUznXztd5C';
  const ctx = { signature: SIG, mint: MINT, pool: CURVE, source: 'solana-ws' as const };

  it('uses exact amounts, the trader, the event clock and the post-trade reserve price', () => {
    const built = must(tradeFromPumpEvents([event], ctx));
    // sol_amount 987,650,071 lamports; token_amount 20,682,995,874,269 raw (6 decimals)
    expect(built.trade).toEqual({
      signature: SIG,
      timestamp: 1_790_628_401_000,
      side: 'buy',
      wallet: 'DHpRzLRuACd8i1BVGZh8rGQWaQsP7b4spBZFWbzW5WSb',
      tokenAmount: 20_682_995.874269,
      solAmount: 0.987650071,
      quoteAmount: 0.987650071,
      quoteSymbol: 'SOL',
      pool: CURVE,
      dex: 'pumpfun',
      source: 'solana-ws',
    });
    // Post-trade virtual reserves: 39.703185855 SOL / 810,766,172.125991 tokens
    expect(built.priceSol).toBeCloseTo(39.703185855 / 810_766_172.125991, 18);
    expect(reservePriceSol(event)).toBe(built.priceSol);
  });

  it('prefers the block time when known', () => {
    expect(must(tradeFromPumpEvents([event], { ...ctx, timestampMs: 1_790_628_402_000 })).trade.timestamp).toBe(1_790_628_402_000);
  });

  it('sums split events of one trader and prices by the last reserves', () => {
    const second: PumpTradeEvent = { ...event, solAmount: 1_000_000n, tokenAmount: 2_000_000n, virtualSolReserves: 40_000_000_000n, virtualTokenReserves: 800_000_000_000_000n };
    const built = must(tradeFromPumpEvents([event, second], ctx));
    expect(built.trade.solAmount).toBe(rawToNumber(987_650_071n + 1_000_000n, 9));
    expect(built.trade.tokenAmount).toBe(rawToNumber(20_682_995_874_269n + 2_000_000n, 6));
    expect(built.priceSol).toBeCloseTo(40 / 800_000_000, 18);
  });

  it('refuses a bundle (two traders or two directions) and a non-SOL quote', () => {
    expect(tradeFromPumpEvents([event, { ...event, user: 'B8jTLPWYJMAZAW5vvw7c7fftNreGRrVt6MWjv6z8WLrw' }], ctx)).toBeUndefined();
    expect(tradeFromPumpEvents([event, { ...event, isBuy: false }], ctx)).toBeUndefined();
    expect(tradeFromPumpEvents([{ ...event, quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }], ctx)).toBeUndefined();
  });

  it('ignores events of other mints and needs a clock', () => {
    expect(tradeFromPumpEvents([{ ...event, mint: CURVE }], ctx)).toBeUndefined();
    const { timestamp: _t, ...untimed } = event;
    expect(tradeFromPumpEvents([untimed], ctx)).toBeUndefined();
  });

  it('falls back to the trade ratio when the layout has no reserves', () => {
    const { virtualSolReserves: _a, virtualTokenReserves: _b, ...bare } = event;
    const built = must(tradeFromPumpEvents([bare], ctx));
    expect(built.priceSol).toBeCloseTo(0.987650071 / 20_682_995.874269, 18);
  });

  describe('pumpTradeFromEvents (bundles)', () => {
    const OTHER = 'B8jTLPWYJMAZAW5vvw7c7fftNreGRrVt6MWjv6z8WLrw';

    it('matches tradeFromPumpEvents for one trader', () => {
      expect(pumpTradeFromEvents([event], ctx)).toEqual(tradeFromPumpEvents([event], ctx));
    });

    it('takes the (user, direction) group that moved the most tokens, priced by its own events', () => {
      const big: PumpTradeEvent = { ...event, user: OTHER, tokenAmount: event.tokenAmount * 3n, solAmount: 3_000_000_000n, virtualSolReserves: 42_000_000_000n, virtualTokenReserves: 760_000_000_000_000n };
      const built = must(pumpTradeFromEvents([event, big], ctx));
      expect(built.trade).toMatchObject({ wallet: OTHER, side: 'buy', solAmount: 3, tokenAmount: rawToNumber(event.tokenAmount * 3n, 6) });
      expect(built.priceSol).toBeCloseTo(42 / 760_000_000, 18);
      // A sell and a buy in one transaction: the larger leg.
      const sell: PumpTradeEvent = { ...event, isBuy: false, tokenAmount: event.tokenAmount / 2n };
      expect(must(pumpTradeFromEvents([sell, event], ctx)).trade.side).toBe('buy');
    });

    it('still refuses a non-SOL quote and foreign mints', () => {
      const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      expect(pumpTradeFromEvents([{ ...event, quoteMint: usdc }, { ...event, user: OTHER, quoteMint: usdc }], ctx)).toBeUndefined();
      expect(pumpTradeFromEvents([{ ...event, mint: CURVE }, { ...event, mint: CURVE, user: OTHER }], ctx)).toBeUndefined();
    });
  });
});

describe('priceWithSol', () => {
  const native = { trade: { signature: 's', timestamp: 1, side: 'buy' as const, tokenAmount: 1_000, solAmount: 0.5, source: 'solana-rpc' as const }, priceSol: 0.0004 };

  it('adds USD price, value and market cap only from real inputs', () => {
    expect(priceWithSol(native, 200, 1_000_000_000)).toMatchObject({ priceUsd: 0.08, usdValue: 100, marketCapUsd: 80_000_000 });
    const noSol = priceWithSol(native, undefined, 1_000_000_000);
    expect(noSol.priceUsd).toBeUndefined();
    expect(noSol.usdValue).toBeUndefined();
    expect(noSol.marketCapUsd).toBeUndefined();
    expect(priceWithSol(native, 200, undefined).marketCapUsd).toBeUndefined();
  });

  it('keeps a stablecoin-quoted trade’s own USD figures', () => {
    const usdc = { trade: { ...native.trade, solAmount: undefined, priceUsd: 0.07, usdValue: 70 } };
    expect(priceWithSol(usdc, 200, undefined)).toMatchObject({ priceUsd: 0.07, usdValue: 70 });
  });
});
