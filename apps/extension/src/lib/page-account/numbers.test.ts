import { describe, expect, it } from 'vitest';
import {
  parseDate,
  parseDuration,
  parseLeverage,
  parseNum,
  parsePercent,
  parsePrice,
  parseSignedAmount,
} from './numbers';

describe('parseNum', () => {
  it('reads comma thousands with dot decimals (UI espanola)', () => {
    expect(parseNum('82,644.1')).toBe(82_644.1);
    expect(parseNum('53,033')).toBe(53_033);
    expect(parseNum('5,184')).toBe(5_184);
    expect(parseNum('1,234,567')).toBe(1_234_567);
  });

  it('reads plain decimals and signs', () => {
    expect(parseNum('0.0041106')).toBe(0.0041106);
    expect(parseNum('+1.01')).toBe(1.01);
    expect(parseNum('-0.91')).toBe(-0.91);
    expect(parseNum('-10.57 USDC')).toBe(-10.57);
    expect(parseNum(42)).toBe(42);
  });

  it('accepts comma as decimal separator when it is not thousands', () => {
    expect(parseNum('0,004')).toBe(0.004);
    expect(parseNum('1.234,56')).toBe(1234.56);
  });

  it('returns null for empty markers and garbage', () => {
    expect(parseNum('--')).toBeNull();
    expect(parseNum('')).toBeNull();
    expect(parseNum('   ')).toBeNull();
    expect(parseNum('n/a')).toBeNull();
    expect(parseNum('Merc...')).toBeNull();
    expect(parseNum(Number.NaN)).toBeNull();
    expect(parseNum(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseNum(null)).toBeNull();
    expect(parseNum(undefined)).toBeNull();
    expect(parseNum({})).toBeNull();
  });
});

describe('parseSignedAmount', () => {
  it('keeps the sign and the asset', () => {
    expect(parseSignedAmount('+1.01 USDC')).toEqual({ value: 1.01, asset: 'USDC' });
    expect(parseSignedAmount('-10.57 USDC')).toEqual({ value: -10.57, asset: 'USDC' });
    expect(parseSignedAmount('254.56 USDC')).toEqual({ value: 254.56, asset: 'USDC' });
    expect(parseSignedAmount('-0.004 BTC')).toEqual({ value: -0.004, asset: 'BTC' });
  });

  it('works without an asset and rejects labels', () => {
    expect(parseSignedAmount('53,033')).toEqual({ value: 53_033, asset: null });
    expect(parseSignedAmount('PnL realizado (USDC)')).toBeNull();
    expect(parseSignedAmount('--')).toBeNull();
    expect(parseSignedAmount(null)).toBeNull();
  });
});

describe('parsePercent', () => {
  it('reads signed percentages', () => {
    expect(parsePercent('-14.40%')).toBe(-14.4);
    expect(parsePercent('+40.24%')).toBe(40.24);
    expect(parsePercent('62.05 %')).toBe(62.05);
  });

  it('returns null without a percent token', () => {
    expect(parsePercent('ROI')).toBeNull();
    expect(parsePercent('')).toBeNull();
    expect(parsePercent(undefined)).toBeNull();
  });
});

describe('parseLeverage', () => {
  it('reads Nx tokens', () => {
    expect(parseLeverage('40x')).toBe(40);
    expect(parseLeverage('Perp. 30x')).toBe(30);
    expect(parseLeverage('BTCUSDC Perp. 25x Cruzado')).toBe(25);
  });

  it('rejects impossible or absent leverage', () => {
    expect(parseLeverage('0x')).toBeNull();
    expect(parseLeverage('BTCUSDC')).toBeNull();
    expect(parseLeverage('')).toBeNull();
    expect(parseLeverage(null)).toBeNull();
  });
});

describe('parseDuration', () => {
  it('adds days, hours and minutes', () => {
    expect(parseDuration('10h 35m')).toBe(38_100_000);
    expect(parseDuration('2d 3h')).toBe(183_600_000);
    expect(parseDuration('45m')).toBe(2_700_000);
    expect(parseDuration('(Duración 10h 37m)')).toBe(38_220_000);
    expect(parseDuration('1d 2h 3m 4s')).toBe(93_784_000);
  });

  it('returns null when there is nothing to parse', () => {
    expect(parseDuration('Duración')).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration(null)).toBeNull();
  });
});

describe('parseDate', () => {
  it('applies the page timezone offset (UTC-5)', () => {
    const ms = parseDate('10/19/2026 00:13:18', -300);
    expect(ms).not.toBeNull();
    expect(new Date(ms as number).toISOString()).toBe('2026-10-19T05:13:18.000Z');
    expect(ms).toBe(Date.UTC(2026, 9, 19, 5, 13, 18));
  });

  it('treats the offset as UTC when omitted', () => {
    expect(parseDate('10/18/2026 23:45:54')).toBe(Date.UTC(2026, 9, 18, 23, 45, 54));
  });

  it('finds the date inside a longer label text', () => {
    expect(parseDate('10/19/2026 10:21:28 Cerrado', -300)).toBe(
      Date.UTC(2026, 9, 19, 15, 21, 28),
    );
  });

  it('rejects invalid dates and garbage', () => {
    expect(parseDate('13/45/2026 00:00:00', -300)).toBeNull();
    expect(parseDate('02/31/2026 00:00:00', -300)).toBeNull();
    expect(parseDate('wrong', -300)).toBeNull();
    expect(parseDate(null)).toBeNull();
  });
});

describe('parsePrice', () => {
  it('finds the first number in a noisy cell', () => {
    expect(parsePrice('0.0041106')).toBe(0.0041106);
    expect(parsePrice('82,644.1')).toBe(82_644.1);
    expect(parsePrice('Merc...')).toBeNull();
    expect(parsePrice('')).toBeNull();
  });
});
