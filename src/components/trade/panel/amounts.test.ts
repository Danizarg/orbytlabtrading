import { describe, expect, it } from 'vitest';
import {
  checkBalance,
  decimalToRaw,
  DEFAULT_BUY_PRESETS,
  FEE_RESERVE_LAMPORTS,
  formatPreset,
  invalidPresetDraft,
  maxBuyAmount,
  maxBuyLamports,
  minReceived,
  normalizeBuyPresets,
  parsePresetInput,
  percentOfRaw,
  rawToDecimal,
  sellAmountForPercent,
  solToLamports,
  uiBalanceToRaw,
} from './amounts';

describe('raw ↔ decimal', () => {
  it('formats raw amounts exactly', () => {
    expect(rawToDecimal(1_234_500n, 6)).toBe('1.2345');
    expect(rawToDecimal(1_000_000_000n, 9)).toBe('1');
    expect(rawToDecimal(5n, 9)).toBe('0.000000005');
    expect(rawToDecimal(42n, 0)).toBe('42');
  });

  it('parses typed amounts into base units, truncating extra digits', () => {
    expect(decimalToRaw('0.5', 9)).toBe(500_000_000n);
    expect(decimalToRaw('1.23456789', 6)).toBe(1_234_567n);
    expect(decimalToRaw('0', 9)).toBeUndefined();
    expect(decimalToRaw('', 9)).toBeUndefined();
    expect(decimalToRaw('abc', 9)).toBeUndefined();
  });
});

describe('uiBalanceToRaw', () => {
  it('recovers the exact raw balance for pump.fun-sized balances', () => {
    // 6 decimals, the largest possible pump.fun balance and a typical one.
    expect(uiBalanceToRaw(999_999_999.999999, 6)).toBe(999_999_999_999_999n);
    expect(uiBalanceToRaw(35_123_456.789012, 6)).toBe(35_123_456_789_012n);
    expect(uiBalanceToRaw(0.000001, 6)).toBe(1n);
  });

  it('recovers 9-decimal balances below 2^50 raw exactly', () => {
    expect(uiBalanceToRaw(1_125_899.906842623, 9)).toBe(1_125_899_906_842_623n);
    expect(uiBalanceToRaw(12.345678901, 9)).toBe(12_345_678_901n);
  });

  it('never exceeds the real balance when a double cannot hold it', () => {
    const raw = 123_456_789_123_456_789n; // 123 456 789.123456789 (9 decimals, 18 significant digits)
    const ui = Number(rawToDecimal(raw, 9));
    const recovered = uiBalanceToRaw(ui, 9)!;
    expect(recovered).toBeLessThanOrEqual(raw);
    // Dust left behind is negligible (< 1e-12 of the balance).
    expect(Number(raw - recovered) / Number(raw)).toBeLessThan(1e-12);
  });

  it('is undefined for unknown or empty balances', () => {
    expect(uiBalanceToRaw(undefined, 6)).toBeUndefined();
    expect(uiBalanceToRaw(0, 6)).toBeUndefined();
    expect(uiBalanceToRaw(-1, 6)).toBeUndefined();
    expect(uiBalanceToRaw(Number.NaN, 6)).toBeUndefined();
    expect(uiBalanceToRaw(1, undefined)).toBeUndefined();
    expect(uiBalanceToRaw(1, 1.5)).toBeUndefined();
  });
});

describe('sell percentages', () => {
  it('takes a percentage of the raw balance, rounded down', () => {
    expect(percentOfRaw(1_000_001n, 25)).toBe(250_000n);
    expect(percentOfRaw(1_000_001n, 50)).toBe(500_000n);
    expect(percentOfRaw(1_000_001n, 75)).toBe(750_000n);
    expect(percentOfRaw(1_000_001n, 100)).toBe(1_000_001n);
    expect(percentOfRaw(3n, 33.33)).toBe(0n);
    expect(percentOfRaw(1_000n, 150)).toBe(1_000n);
    expect(percentOfRaw(0n, 50)).toBe(0n);
  });

  it('turns a percentage into the sell field text', () => {
    const balance = uiBalanceToRaw(1_234.567891, 6);
    expect(sellAmountForPercent(balance, 6, 100)).toBe('1234.567891');
    expect(sellAmountForPercent(balance, 6, 50)).toBe('617.283945');
    expect(sellAmountForPercent(balance, 6, 25)).toBe('308.641972');
    expect(sellAmountForPercent(1n, 6, 25)).toBeUndefined();
    expect(sellAmountForPercent(undefined, 6, 25)).toBeUndefined();
  });

  it('100 % round-trips to the exact balance the field sends to Jupiter', () => {
    const text = sellAmountForPercent(uiBalanceToRaw(35_123_456.789012, 6), 6, 100)!;
    expect(decimalToRaw(text, 6)).toBe(35_123_456_789_012n);
  });
});

describe('Max on buys', () => {
  it('keeps 0.01 SOL for fees', () => {
    expect(FEE_RESERVE_LAMPORTS).toBe(10_000_000n);
    expect(maxBuyLamports(1_500_000_000n)).toBe(1_490_000_000n);
    expect(maxBuyAmount(1_500_000_000n)).toBe('1.49');
    expect(maxBuyAmount(123_456_789n)).toBe('0.113456789');
  });

  it('offers nothing when the balance is at or below the reserve', () => {
    expect(maxBuyLamports(10_000_000n)).toBe(0n);
    expect(maxBuyLamports(5n)).toBe(0n);
    expect(maxBuyAmount(10_000_000n)).toBeUndefined();
    expect(maxBuyAmount(undefined)).toBeUndefined();
  });

  it('converts a server SOL balance to lamports', () => {
    expect(solToLamports(1.5)).toBe(1_500_000_000n);
    expect(solToLamports(0.000000001)).toBe(1n);
    expect(solToLamports(undefined)).toBeUndefined();
    expect(solToLamports(-1)).toBeUndefined();
  });
});

describe('minimum received', () => {
  it('applies slippage like Jupiter otherAmountThreshold', () => {
    expect(minReceived(1_000, 100)).toBe(990);
    expect(minReceived(1_000, 1_000)).toBe(900);
    expect(minReceived(1_000, 0)).toBe(1_000);
    // Live order 2026-09-29: outAmount 329630040000 raw, slippage 1000 → otherAmountThreshold 296667036000.
    expect(minReceived(329_630_040_000, 1_000)).toBe(296_667_036_000);
  });

  it('is undefined for unknown inputs', () => {
    expect(minReceived(undefined, 100)).toBeUndefined();
    expect(minReceived(0, 100)).toBeUndefined();
    expect(minReceived(1_000, undefined)).toBeUndefined();
    expect(minReceived(1_000, 10_001)).toBeUndefined();
    expect(minReceived(1_000, 1.5)).toBeUndefined();
  });
});

describe('checkBalance', () => {
  it('flags amounts above the balance and buys that eat the fee reserve', () => {
    expect(checkBalance({ side: 'buy', amountRaw: 2_000_000_000n, balanceRaw: 1_000_000_000n })).toBe('insufficient');
    expect(checkBalance({ side: 'buy', amountRaw: 995_000_000n, balanceRaw: 1_000_000_000n })).toBe('low_reserve');
    expect(checkBalance({ side: 'buy', amountRaw: 990_000_000n, balanceRaw: 1_000_000_000n })).toBe('ok');
    expect(checkBalance({ side: 'sell', amountRaw: 1_000n, balanceRaw: 1_000n })).toBe('ok');
    expect(checkBalance({ side: 'sell', amountRaw: 1_001n, balanceRaw: 1_000n })).toBe('insufficient');
    expect(checkBalance({ side: 'sell', amountRaw: 1n, balanceRaw: 0n })).toBe('insufficient');
    expect(checkBalance({ side: 'sell', amountRaw: 1n, balanceRaw: undefined })).toBe('unknown');
    expect(checkBalance({ side: 'buy', amountRaw: undefined, balanceRaw: 1n })).toBe('unknown');
  });
});

describe('buy presets', () => {
  it('parses preset text as SOL amounts', () => {
    expect(parsePresetInput('0.25')).toBe(0.25);
    expect(parsePresetInput('2')).toBe(2);
    expect(parsePresetInput('0')).toBeUndefined();
    expect(parsePresetInput('')).toBeUndefined();
    expect(parsePresetInput('100001')).toBeUndefined();
    expect(parsePresetInput('1.0000000001')).toBe(1);
  });

  it('keeps exactly four valid presets from storage', () => {
    expect(normalizeBuyPresets([0.2, 1, 2, 10])).toEqual([0.2, 1, 2, 10]);
    expect(normalizeBuyPresets(undefined)).toEqual([...DEFAULT_BUY_PRESETS]);
    expect(normalizeBuyPresets([0.2, -1, 'x', 1e9, 7])).toEqual([0.2, 0.5, 1, 5]);
    expect(normalizeBuyPresets([3])).toEqual([3, 0.5, 1, 5]);
  });

  it('an edit is saved all or nothing: the first invalid draft is reported before anything is saved', () => {
    expect(invalidPresetDraft(['0.2', '1', '2', '10'])).toBeUndefined();
    expect(invalidPresetDraft(['0.2', '1', '', '10'])).toBe(2);
    expect(invalidPresetDraft(['0.2', '0', '.', '10'])).toBe(1);
    expect(invalidPresetDraft(['100001', '1', '2', '3'])).toBe(0);
  });

  it('formats presets without exponent notation', () => {
    expect(formatPreset(0.1)).toBe('0.1');
    expect(formatPreset(1e-7)).toBe('0.0000001');
    expect(formatPreset(25000)).toBe('25000');
  });
});
