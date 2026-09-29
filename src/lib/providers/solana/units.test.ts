import { describe, expect, it } from 'vitest';
import { LruCache } from './lru';
import { clampInt, formatUnits, rawToUi, toBigInt } from './units';

describe('units', () => {
  it('converts raw u64 strings beyond 2^53 without precision loss in the split', () => {
    expect(formatUnits(8799437915923265810n, 5)).toBe('87994379159232.6581');
    expect(rawToUi('1000000000000000', 6)).toBe(1_000_000_000);
    expect(rawToUi('0', 9)).toBe(0);
    expect(formatUnits(-1500n, 3)).toBe('-1.5');
  });

  it('rejects non-integer input instead of guessing', () => {
    expect(toBigInt('1.5')).toBeUndefined();
    expect(toBigInt(2 ** 60)).toBeUndefined();
    expect(rawToUi('abc', 6)).toBeUndefined();
    expect(rawToUi('1', -1)).toBeUndefined();
    expect(rawToUi(undefined, 6)).toBeUndefined();
  });

  it('clamps options', () => {
    expect(clampInt(undefined, 1, 25, 15)).toBe(15);
    expect(clampInt(500, 1, 25, 15)).toBe(25);
    expect(clampInt(0, 1, 25, 15)).toBe(1);
    expect(clampInt(Number.NaN, 1, 25, 15)).toBe(15);
  });
});

describe('LruCache', () => {
  it('evicts the least recently used entry and keeps cached nulls', () => {
    const cache = new LruCache<string, number | null>(2);
    cache.set('a', 1).set('b', null);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
    cache.set('d', 4);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('a')).toBe(false);
    const nulls = new LruCache<string, null>(1).set('x', null);
    expect(nulls.has('x')).toBe(true);
    expect(nulls.get('x')).toBeNull();
    expect(() => new LruCache(0)).toThrow(RangeError);
  });
});
