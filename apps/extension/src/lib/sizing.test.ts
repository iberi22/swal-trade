import { describe, expect, it } from 'vitest';
import {
  calculatePositionSize,
  invalidationPriceFromFinding,
  normalizeSizingPreferences,
  TAKER_ROUND_TRIP_FEE_RATE,
  type SizingInput,
} from './sizing';
import type { Finding } from './types';

describe('position sizing math (pure)', () => {
  it('calculates normal long position correctly', () => {
    const input: SizingInput = { capital: 1000, riskPct: 1, direction: 'long', entry: 100, stop: 95 };
    const result = calculatePositionSize(input);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.distancePct).toBe(5);
    expect(result.lossUsd).toBe(10);
    expect(result.quantity).toBe(2);
    expect(result.notionalUsd).toBe(200);
    expect(result.minLeverage).toBe(1);
    expect(result.feeUsd).toBe(0.1);
    expect(result.summary).toBe('Si el stop salta pierdes 10 USD (1 % de tu cuenta)');
  });

  it('calculates normal short position correctly', () => {
    const input: SizingInput = { capital: 1000, riskPct: 1, direction: 'short', entry: 100, stop: 105 };
    const result = calculatePositionSize(input);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.distancePct).toBe(5);
    expect(result.lossUsd).toBe(10);
    expect(result.quantity).toBe(2);
    expect(result.notionalUsd).toBe(200);
    expect(result.minLeverage).toBe(1);
    expect(result.feeUsd).toBe(0.1);
    expect(result.summary).toBe('Si el stop salta pierdes 10 USD (1 % de tu cuenta)');
  });

  it('calculates minimum implied leverage rounded up', () => {
    const input: SizingInput = { capital: 500, riskPct: 1, direction: 'long', entry: 100, stop: 99.5 };
    const result = calculatePositionSize(input);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.distancePct).toBe(0.5);
    expect(result.lossUsd).toBe(5);
    expect(result.quantity).toBe(10);
    expect(result.notionalUsd).toBe(1000);
    expect(result.minLeverage).toBe(2);
  });

  it('detects stop on wrong side for long and short', () => {
    const longEq = calculatePositionSize({ capital: 1000, riskPct: 1, direction: 'long', entry: 100, stop: 100 });
    expect(longEq.valid).toBe(false);
    if (!longEq.valid) expect(longEq.reason).toBe('wrong_side');

    const longAbove = calculatePositionSize({ capital: 1000, riskPct: 1, direction: 'long', entry: 100, stop: 105 });
    expect(longAbove.valid).toBe(false);
    if (!longAbove.valid) expect(longAbove.error).toMatch(/por debajo/i);

    const shortEq = calculatePositionSize({ capital: 1000, riskPct: 1, direction: 'short', entry: 100, stop: 100 });
    expect(shortEq.valid).toBe(false);
    if (!shortEq.valid) expect(shortEq.reason).toBe('wrong_side');

    const shortBelow = calculatePositionSize({ capital: 1000, riskPct: 1, direction: 'short', entry: 100, stop: 95 });
    expect(shortBelow.valid).toBe(false);
    if (!shortBelow.valid) expect(shortBelow.error).toMatch(/por encima/i);
  });

  it('rejects zero or negative inputs', () => {
    const base: SizingInput = { capital: 1000, riskPct: 1, direction: 'long', entry: 100, stop: 95 };
    expect(calculatePositionSize({ ...base, capital: 0 }).valid).toBe(false);
    expect(calculatePositionSize({ ...base, capital: -100 }).valid).toBe(false);
    expect(calculatePositionSize({ ...base, riskPct: 0 }).valid).toBe(false);
    expect(calculatePositionSize({ ...base, riskPct: -1 }).valid).toBe(false);
    expect(calculatePositionSize({ ...base, entry: 0 }).valid).toBe(false);
    expect(calculatePositionSize({ ...base, entry: -50 }).valid).toBe(false);
    expect(calculatePositionSize({ ...base, stop: 0 }).valid).toBe(false);
    expect(calculatePositionSize({ ...base, stop: -50 }).valid).toBe(false);
    expect(calculatePositionSize({ ...base, capital: NaN }).valid).toBe(false);
  });

  it('rounds quantity to 4 decimals', () => {
    const input: SizingInput = { capital: 1000, riskPct: 1, direction: 'long', entry: 64321, stop: 63123 };
    const result = calculatePositionSize(input);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.quantity).toBe(0.0083);
    const decimals = result.quantity.toString().split('.')[1] || '';
    expect(decimals.length).toBeLessThanOrEqual(4);
  });

  it('calculates fee line with 0.05% round-trip taker estimate', () => {
    expect(TAKER_ROUND_TRIP_FEE_RATE).toBe(0.0005);
    const input: SizingInput = { capital: 10000, riskPct: 1, direction: 'long', entry: 50000, stop: 49000 };
    const result = calculatePositionSize(input);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.notionalUsd).toBe(5000);
    expect(result.feeUsd).toBe(2.5);
  });

  it('extracts invalidation level from finding when available', () => {
    const finding: Finding = {
      id: 'f1', kind: 'double_bottom', label: 'Doble suelo', explanation: 'Soporte', from: 1000, to: 2000,
      levels: [{ price: 100, role: 'neck', confirm: 105, invalidate: 94.5 }], direction: 'bullish', strength: 0.8, evidence: {},
    };
    expect(invalidationPriceFromFinding(finding)).toBe(94.5);
    expect(invalidationPriceFromFinding(null)).toBe(null);
  });

  it('normalizes sizing preferences properly', () => {
    expect(normalizeSizingPreferences(null)).toEqual({ capital: 1000, riskPct: 1, direction: 'long' });
    expect(normalizeSizingPreferences({ capital: '5000', riskPct: '2.5', direction: 'short' })).toEqual({
      capital: 5000, riskPct: 2.5, direction: 'short',
    });
    expect(normalizeSizingPreferences({ riskPct: 10 })).toMatchObject({ riskPct: 5 });
    expect(normalizeSizingPreferences({ riskPct: 0.01 })).toMatchObject({ riskPct: 0.1 });
  });
});
