import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Trade } from '@/lib/core/types';
import { compareTradesNewestFirst, mergeTrades, newTradesSince, tradeStats, tradeUsdValue } from './trades';

interface GtTradeResource {
  attributes: {
    block_timestamp: string;
    tx_hash: string;
    tx_from_address: string;
    kind: 'buy' | 'sell';
    from_token_amount: string;
    to_token_amount: string;
    price_from_in_usd: string;
    price_to_in_usd: string;
    volume_in_usd: string;
  };
}

/** Minimal GeckoTerminal trade → Trade mapping for tests (the real parser lives in the provider). */
function gtTrades(name: string): Trade[] {
  const raw = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/geckoterminal', name), 'utf8')) as { data: GtTradeResource[] };
  return raw.data.map(({ attributes: a }) => {
    const buy = a.kind === 'buy';
    return {
      signature: a.tx_hash,
      timestamp: Date.parse(a.block_timestamp),
      side: a.kind,
      wallet: a.tx_from_address,
      tokenAmount: Number(buy ? a.to_token_amount : a.from_token_amount),
      solAmount: Number(buy ? a.from_token_amount : a.to_token_amount),
      usdValue: Number(a.volume_in_usd),
      priceUsd: Number(buy ? a.price_to_in_usd : a.price_from_in_usd),
      source: 'geckoterminal',
    };
  });
}

const T0 = Date.parse('2026-09-28T20:00:00Z');

function trade(signature: string, secondsAfterT0: number, overrides: Partial<Trade> = {}): Trade {
  return { signature, timestamp: T0 + secondsAfterT0 * 1000, side: 'buy', source: 'geckoterminal', ...overrides };
}

const sigs = (trades: Trade[]) => trades.map((t) => t.signature);

describe('tradeUsdValue', () => {
  it('prefers the provider usdValue, then priceUsd × tokenAmount', () => {
    expect(tradeUsdValue(trade('a', 0, { usdValue: 12.5, priceUsd: 1, tokenAmount: 1 }))).toBe(12.5);
    expect(tradeUsdValue(trade('a', 0, { priceUsd: 0.002, tokenAmount: 5000 }))).toBeCloseTo(10, 12);
  });

  it('is undefined when nothing reliable is known (never 0)', () => {
    expect(tradeUsdValue(trade('a', 0))).toBeUndefined();
    expect(tradeUsdValue(trade('a', 0, { priceUsd: 0.1 }))).toBeUndefined();
    expect(tradeUsdValue(trade('a', 0, { usdValue: Number.NaN, tokenAmount: 5 }))).toBeUndefined();
  });

  it('matches GeckoTerminal volume_in_usd ≈ price × amount on real trades', () => {
    for (const t of gtTrades('trades_pool.json')) {
      const derived = (t.priceUsd ?? NaN) * (t.tokenAmount ?? NaN);
      expect(Math.abs(derived - (t.usdValue ?? NaN)) / (t.usdValue ?? NaN)).toBeLessThan(1e-9);
    }
  });
});

describe('mergeTrades', () => {
  it('merges real GeckoTerminal pages newest first without duplicates', () => {
    const latest = gtTrades('trades_pool.json');
    const large = gtTrades('trades_pool_volume_gt_1000.json');
    const merged = mergeTrades(latest, [...large, ...latest]);
    expect(merged).toHaveLength(6);
    const times = merged.map((t) => t.timestamp);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(merged[0]?.timestamp).toBe(Date.parse('2026-09-28T20:50:48Z'));
    expect(merged.at(-1)?.timestamp).toBe(Date.parse('2026-09-28T20:34:01Z'));
  });

  it('dedupes by signature and lets the incoming row win', () => {
    const existing = [trade('s1', 1, { tokenAmount: 100 }), trade('s2', 2)];
    const incoming = [trade('s1', 1, { tokenAmount: 101, usdValue: 5 })];
    const merged = mergeTrades(existing, incoming);
    expect(sigs(merged)).toEqual(['s2', 's1']);
    expect(merged.find((t) => t.signature === 's1')).toMatchObject({ tokenAmount: 101, usdValue: 5 });
  });

  it('orders same-timestamp trades by signature, descending, deterministically', () => {
    const a = mergeTrades([], [trade('b', 5), trade('c', 5), trade('a', 5), trade('z', 4)]);
    const b = mergeTrades([trade('a', 5)], [trade('z', 4), trade('c', 5), trade('b', 5)]);
    expect(sigs(a)).toEqual(['c', 'b', 'a', 'z']);
    expect(sigs(b)).toEqual(sigs(a));
  });

  it('caps the list at max, keeping the newest', () => {
    const many = Array.from({ length: 250 }, (_, i) => trade(`s${String(i).padStart(3, '0')}`, i));
    const merged = mergeTrades([], many);
    expect(merged).toHaveLength(200);
    expect(merged[0]?.signature).toBe('s249');
    expect(merged.at(-1)?.signature).toBe('s050');
    expect(mergeTrades([], many, 3).map((t) => t.signature)).toEqual(['s249', 's248', 's247']);
    expect(mergeTrades([], many, 0)).toEqual([]);
    expect(mergeTrades([], many, -1)).toEqual([]);
    expect(mergeTrades([], many, 2.9)).toHaveLength(2);
  });

  it('drops rows that cannot be deduplicated or ordered', () => {
    const merged = mergeTrades([trade('', 1)], [trade('ok', 2), trade('nan', Number.NaN)]);
    expect(sigs(merged)).toEqual(['ok']);
  });

  it('does not mutate its inputs', () => {
    const existing = [trade('a', 1), trade('b', 2)];
    const incoming = [trade('c', 0)];
    const snapshot = JSON.stringify([existing, incoming]);
    mergeTrades(existing, incoming);
    expect(JSON.stringify([existing, incoming])).toBe(snapshot);
  });

  it('compareTradesNewestFirst is the exact reverse of chronological order', () => {
    expect(compareTradesNewestFirst(trade('a', 2), trade('b', 1))).toBeLessThan(0);
    expect(compareTradesNewestFirst(trade('a', 1), trade('b', 1))).toBeGreaterThan(0);
    expect(compareTradesNewestFirst(trade('a', 1), trade('a', 1))).toBe(0);
  });
});

describe('newTradesSince', () => {
  it('returns rows whose signature was not present before, in next order', () => {
    const prev = [trade('b', 2), trade('a', 1)];
    const next = mergeTrades(prev, [trade('d', 4), trade('c', 3)]);
    expect(sigs(newTradesSince(prev, next))).toEqual(['d', 'c']);
  });

  it('treats a corrected row (same signature) as not new', () => {
    const prev = [trade('a', 1, { tokenAmount: 1 })];
    expect(newTradesSince(prev, [trade('a', 1, { tokenAmount: 2 })])).toEqual([]);
  });

  it('reports every row on the initial load', () => {
    expect(newTradesSince([], [trade('a', 1)])).toHaveLength(1);
  });
});

describe('tradeStats', () => {
  const now = T0 + 300_000; // T0 + 5 min

  it('counts buys, sells, USD volume and unique wallets inside the window', () => {
    const trades = [
      trade('b1', 290, { wallet: 'W1', usdValue: 10 }),
      trade('b2', 200, { wallet: 'W2', priceUsd: 0.5, tokenAmount: 40 }),
      trade('s1', 100, { side: 'sell', wallet: 'W1', usdValue: 7 }),
      trade('old', -1, { wallet: 'W9', usdValue: 1_000 }), // before the 5-minute window
    ];
    expect(tradeStats(trades, 300_000, now)).toEqual({
      trades: 3,
      buys: 2,
      sells: 1,
      buyVolumeUsd: 30,
      sellVolumeUsd: 7,
      volumeComplete: true,
      uniqueWallets: 2,
    });
  });

  it('includes the window start and trades stamped after now (clock skew)', () => {
    const trades = [trade('edge', 0, { usdValue: 1 }), trade('future', 301, { usdValue: 2 })];
    expect(tradeStats(trades, 300_000, now)).toMatchObject({ buys: 2, buyVolumeUsd: 3 });
  });

  it('empty window → real zeros', () => {
    expect(tradeStats([], 60_000, now)).toEqual({
      trades: 0,
      buys: 0,
      sells: 0,
      buyVolumeUsd: 0,
      sellVolumeUsd: 0,
      volumeComplete: true,
      uniqueWallets: 0,
    });
  });

  it('omits volume / wallets when trades exist but none carries them', () => {
    const stats = tradeStats([trade('a', 250), trade('b', 260, { side: 'sell' })], 300_000, now);
    expect(stats).toEqual({ trades: 2, buys: 1, sells: 1, volumeComplete: false });
    expect(stats).not.toHaveProperty('buyVolumeUsd');
    expect(stats).not.toHaveProperty('uniqueWallets');
  });

  it('flags partial volume as incomplete', () => {
    const stats = tradeStats([trade('a', 250, { usdValue: 4 }), trade('b', 260)], 300_000, now);
    expect(stats.buyVolumeUsd).toBe(4);
    expect(stats.volumeComplete).toBe(false);
  });

  it('works on real GeckoTerminal trades', () => {
    const trades = mergeTrades(gtTrades('trades_pool.json'), gtTrades('trades_pool_volume_gt_1000.json'));
    const at = Date.parse('2026-09-28T20:51:00Z');
    const stats = tradeStats(trades, 10 * 60_000, at);
    // 20:45:04 → 2 buys + 1 sell; 20:49:46 and 20:50:48 → sells; 20:34:01 is outside the window.
    expect(stats.buys).toBe(2);
    expect(stats.sells).toBe(3);
    expect(stats.volumeComplete).toBe(true);
    expect(stats.sellVolumeUsd).toBeCloseTo(316.8958 + 1015.891208 + 1059.085046, 3);
    expect(stats.uniqueWallets).toBe(new Set(trades.filter((t) => t.timestamp >= at - 600_000).map((t) => t.wallet)).size);
  });
});
