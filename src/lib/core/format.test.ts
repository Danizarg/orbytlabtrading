import { describe, expect, it } from 'vitest';
import {
  changeClass,
  DASH,
  formatAge,
  formatAmount,
  formatCompact,
  formatDateTime,
  formatDuration,
  formatPct,
  formatPrice,
  formatSol,
  formatTime,
  formatUpdated,
  formatUsd,
} from './format';

const MISSING = [undefined, null, Number.NaN, Infinity, -Infinity];

describe('formatPrice', () => {
  it.each([
    [0.00000123, '$0.0₅123'],
    [1e-9, '$0.0₈1'],
    [1.2e-9, '$0.0₈12'],
    [1e-12, '$0.0₁₁1'],
    [5e-7, '$0.0₆5'],
    [0.0000012344, '$0.0₅1234'],
    [0.0000012346, '$0.0₅1235'],
    [0.0000012, '$0.0₅12'],
    [0.00099, '$0.0₃99'],
    [0.001, '$0.001'],
    [0.0012345, '$0.001234'],
    [0.1, '$0.1'],
    [1.2345, '$1.2345'],
    [123.456789, '$123.4568'],
    [12345.678, '$12,345.68'],
    [1000, '$1,000'],
    [0, '$0'],
  ])('%s → %s', (n, expected) => {
    expect(formatPrice(n)).toBe(expected);
  });

  it('formats real meme-coin prices from GeckoTerminal / DEX Screener', () => {
    expect(formatPrice(Number('0.00000002954'))).toBe('$0.0₇2954');
    expect(formatPrice(Number('0.000916892312481002815581917050585391677766421884911919392848741178'))).toBe('$0.0₃9169');
    expect(formatPrice(Number('118.738242161225618886967433278566259850591157466'))).toBe('$118.7382');
  });

  it('keeps the sign in front of the currency', () => {
    expect(formatPrice(-0.00000123)).toBe('-$0.0₅123');
    expect(formatPrice(-1.5)).toBe('-$1.50');
    expect(formatPrice(-12345.678)).toBe('-$12,345.68');
  });

  it('can omit the currency symbol', () => {
    expect(formatPrice(0.00000123, { currency: false })).toBe('0.0₅123');
    expect(formatPrice(1.2345, { currency: false })).toBe('1.2345');
  });

  it('renders missing / non-finite values as an em dash, never 0', () => {
    for (const n of MISSING) expect(formatPrice(n)).toBe(DASH);
    expect(DASH).toBe('—');
  });

  // Bug: when rounding to 4 significant digits carries into a new power of ten
  // (9999.9… → 10000), the digits are truncated to "1000" but the zero count is
  // not decremented, so the price is shown 10× too small.
  it.fails('does not lose a power of ten when rounding carries (0.00000999999 → $0.0₄1)', () => {
    expect(formatPrice(0.00000999999)).toBe('$0.0₄1');
  });

  it.fails('does not lose a power of ten just below 0.001 (0.0009999999 → $0.001)', () => {
    expect(formatPrice(0.0009999999)).toBe('$0.001');
  });
});

describe('formatUsd', () => {
  it.each([
    [0, '$0.00'],
    [5, '$5.00'],
    [12.5, '$13'],
    [999.4, '$999'],
    [1000, '$1K'],
    [1234, '$1.2K'],
    [99_999, '$100K'],
    [100_000, '$100K'],
    [1_234_567, '$1.23M'],
    [1_500_000_000, '$1.5B'],
    [2.5e12, '$2.5T'],
    [-5, '-$5.00'],
    [-1234, '-$1.2K'],
  ])('compact %s → %s', (n, expected) => {
    expect(formatUsd(n)).toBe(expected);
  });

  it('supports full precision and explicit decimals', () => {
    expect(formatUsd(1_234_567.891, { compact: false })).toBe('$1,234,567.89');
    expect(formatUsd(12.5, { compact: false, decimals: 0 })).toBe('$13');
    expect(formatUsd(1_234_567, { decimals: 1 })).toBe('$1.2M');
  });

  it('renders missing values as an em dash', () => {
    for (const n of MISSING) expect(formatUsd(n)).toBe(DASH);
  });
});

describe('formatPct', () => {
  it.each([
    [1.234, '+1.23%'],
    [-1.234, '-1.23%'],
    [12.34, '+12.3%'],
    [123.4, '+123%'],
    [1000, '+1000%'],
    [12_345, '+12.3K%'],
    [-78.19, '-78.2%'],
    [0, '0.00%'],
  ])('%s → %s', (n, expected) => {
    expect(formatPct(n)).toBe(expected);
  });

  it('can drop the positive sign but always keeps the negative one', () => {
    expect(formatPct(5, { signed: false })).toBe('5.00%');
    expect(formatPct(-5, { signed: false })).toBe('-5.00%');
  });

  it('honours explicit decimals', () => {
    expect(formatPct(12.3456, { decimals: 3 })).toBe('+12.346%');
  });

  it('renders missing values as an em dash', () => {
    for (const n of MISSING) expect(formatPct(n)).toBe(DASH);
  });
});

describe('formatAge', () => {
  const now = 1_790_628_304_000;
  const ago = (s: number) => formatAge(now - s * 1000, now);

  it.each([
    [0, '0s'],
    [59, '59s'],
    [60, '1m'],
    [3_599, '59m'],
    [3_600, '1h'],
    [86_399, '23h'],
    [86_400, '1d'],
    [30 * 86_400 - 1, '29d'],
    [30 * 86_400, '1mo'],
    [365 * 86_400 - 1, '12mo'],
    [365 * 86_400, '1y'],
    [3 * 365 * 86_400, '3y'],
  ])('%ss ago → %s', (s, expected) => {
    expect(ago(s)).toBe(expected);
  });

  it('floors partial units and clamps future timestamps to 0s', () => {
    expect(formatAge(now - 59_999, now)).toBe('59s');
    expect(formatAge(now + 5_000, now)).toBe('0s');
  });

  it('renders missing values as an em dash', () => {
    for (const n of MISSING) expect(formatAge(n, now)).toBe(DASH);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [44.6, '45s'],
    [60, '1m'],
    [150, '3m'],
    [3_600, '1.0h'],
    [5_400, '1.5h'],
    [86_400, '1.0d'],
    [180_000, '2.1d'],
    [-3, '0s'],
  ])('%s → %s', (s, expected) => {
    expect(formatDuration(s)).toBe(expected);
  });

  it('renders missing values as an em dash', () => {
    expect(formatDuration(undefined)).toBe(DASH);
  });
});

describe('formatCompact / formatAmount / formatSol', () => {
  it('formats compact numbers', () => {
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(999)).toBe('999');
    expect(formatCompact(5.678)).toBe('5.68');
    expect(formatCompact(12.345)).toBe('12.3');
    expect(formatCompact(1_234)).toBe('1.2K');
    expect(formatCompact(1_500_000)).toBe('1.5M');
    expect(formatCompact(-2_500)).toBe('-2.5K');
    expect(formatCompact(undefined)).toBe(DASH);
  });

  it('formats token amounts with magnitude-dependent precision', () => {
    expect(formatAmount(0.001234567)).toBe('0.001235');
    expect(formatAmount(0.5)).toBe('0.5');
    expect(formatAmount(12.3456)).toBe('12.35');
    expect(formatAmount(1_234.56)).toBe('1,235');
    expect(formatAmount(2_500_000)).toBe('2.5M');
    expect(formatAmount(635_981.867943)).toBe('635,982');
    expect(formatAmount(null)).toBe(DASH);
  });

  it('formats SOL amounts', () => {
    expect(formatSol(4.911028452)).toBe('4.91 SOL');
    expect(formatSol(0.001234)).toBe('0.001 SOL');
    expect(formatSol(410.8801681200643)).toBe('410.9 SOL');
    expect(formatSol(undefined)).toBe(DASH);
  });
});

describe('time and freshness labels', () => {
  const now = 1_790_628_304_000;

  it('formatUpdated', () => {
    expect(formatUpdated(now - 1_000, now)).toBe('Updated just now');
    expect(formatUpdated(now - 5_000, now)).toBe('Updated 5s ago');
    expect(formatUpdated(now - 120_000, now)).toBe('Updated 2m ago');
    expect(formatUpdated(undefined, now)).toBe('Waiting for data');
  });

  it('formatTime / formatDateTime render missing values as an em dash', () => {
    expect(formatTime(undefined)).toBe(DASH);
    expect(formatDateTime(null)).toBe(DASH);
    expect(formatTime(now)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(formatTime(now, { seconds: false })).toMatch(/^\d{2}:\d{2}$/);
  });

  it('changeClass', () => {
    expect(changeClass(1)).toBe('text-up');
    expect(changeClass(-0.01)).toBe('text-down');
    expect(changeClass(0)).toBe('text-muted');
    expect(changeClass(undefined)).toBe('text-muted');
  });
});
