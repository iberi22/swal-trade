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
    const input: SizingInput = {
      capital: 1000,
      riskPct: 1,
      direction: 'long',
      entry: 100,
      stop: 95,
    };
    const result = calculatePositionSize(input);
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    // Distancia al stop: (100 - 95) / 100 = 5%
    expect(result.distancePct).toBe(5);
    // Pérdida si salta el stop: 1% de 1000 = 10 USD
    expect(result.lossUsd).toBe(10);
    // Cantidad: 10 / 5 = 2 contratos/monedas
    expect(result.quantity).toBe(2);
    // Nocional: 2 * 100 = 200 USD
    expect(result.notionalUsd).toBe(200);
    // Apalancamiento mínimo necesario: ceil(200 / 1000) = 1
    expect(result.minLeverage).toBe(1);
    // Comisiones aprox. taker 0.05% ida y vuelta: 200 * 0.0005 = 0.1 USD
    expect(result.feeUsd).toBe(0.1);
    // Frase resumen requerida
    expect(result.summary).toBe('Si el stop salta pierdes 10 USD (1 % de tu cuenta)');
  });

  it('calculates normal short position correctly', () => {
    const input: SizingInput = {
      capital: 1000,
      riskPct: 1,
      direction: 'short',
      entry: 100,
      stop: 105,
    };
    const result = calculatePositionSize(input);
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    // Distancia al stop: (105 - 100) / 100 = 5%
    expect(result.distancePct).toBe(5);
    // Pérdida: 10 USD
    expect(result.lossUsd).toBe(10);
    // Cantidad: 10 / 5 = 2
    expect(result.quantity).toBe(2);
    // Nocional: 200 USD
    expect(result.notionalUsd).toBe(200);
    expect(result.minLeverage).toBe(1);
    expect(result.feeUsd).toBe(0.1);
    expect(result.summary).toBe('Si el stop salta pierdes 10 USD (1 % de tu cuenta)');
  });

  it('calculates higher leverage requirement when stop is tight', () => {
    const input: SizingInput = {
      capital: 500,
      riskPct: 1,
      direction: 'long',
      entry: 100,
      stop: 99.5,
    };
    const result = calculatePositionSize(input);
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    // Distancia: 0.5%
    expect(result.distancePct).toBe(0.5);
    // Pérdida: 5 USD
    expect(result.lossUsd).toBe(5);
    // Cantidad: 5 / 0.5 = 10
    expect(result.quantity).toBe(10);
    // Nocional: 10 * 100 = 1000 USD
    expect(result.notionalUsd).toBe(1000);
    // Apalancamiento mínimo: ceil(1000 / 500) = 2
    expect(result.minLeverage).toBe(2);
  });

  it('detects stop on wrong side for long and short', () => {
    // Para largo, stop debe ser menor que entrada
    const longEqual = calculatePositionSize({
      capital: 1000,
      riskPct: 1,
      direction: 'long',
      entry: 100,
      stop: 100,
    });
    expect(longEqual.valid).toBe(false);
    if (!longEqual.valid) {
      expect(longEqual.reason).toBe('wrong_side');
      expect(longEqual.error).toMatch(/por debajo/i);
    }

    const longAbove = calculatePositionSize({
      capital: 1000,
      riskPct: 1,
      direction: 'long',
      entry: 100,
      stop: 105,
    });
    expect(longAbove.valid).toBe(false);
    if (!longAbove.valid) {
      expect(longAbove.reason).toBe('wrong_side');
      expect(longAbove.error).toMatch(/por debajo/i);
    }

    // Para corto, stop debe ser mayor que entrada
    const shortEqual = calculatePositionSize({
      capital: 1000,
      riskPct: 1,
      direction: 'short',
      entry: 100,
      stop: 100,
    });
    expect(shortEqual.valid).toBe(false);
    if (!shortEqual.valid) {
      expect(shortEqual.reason).toBe('wrong_side');
      expect(shortEqual.error).toMatch(/por encima/i);
    }

    const shortBelow = calculatePositionSize({
      capital: 1000,
      riskPct: 1,
      direction: 'short',
      entry: 100,
      stop: 95,
    });
    expect(shortBelow.valid).toBe(false);
    if (!shortBelow.valid) {
      expect(shortBelow.reason).toBe('wrong_side');
      expect(shortBelow.error).toMatch(/por encima/i);
    }
  });

  it('rejects zero or negative inputs', () => {
    const base: SizingInput = {
      capital: 1000,
      riskPct: 1,
      direction: 'long',
      entry: 100,
      stop: 95,
    };

    expect(calculatePositionSize({ ...base, capital: 0 }).valid).toBe(false);
    expect(calculatePositionSize({ ...base, capital: -100 }).valid).toBe(false);
    expect(calculatePositionSize({ ...base, riskPct: 0 }).valid).toBe(false);
    expect(calculatePositionSize({ ...base, riskPct: -1 }).valid).toBe(false);
    expect(calculatePositionSize({ ...base, entry: 0 }).valid).toBe(false);
    expect(calculatePositionSize({ ...base, entry: -50 }).valid).toBe(false);
    expect(calculatePositionSize({ ...base, stop: 0 }).valid).toBe(false);
    expect(calculatePositionSize({ ...base, stop: -50 }).valid).toBe(false);
    expect(calculatePositionSize({ ...base, capital: NaN }).valid).toBe(false);
    expect(calculatePositionSize({ ...base, entry: Infinity }).valid).toBe(false);
  });

  it('rounds quantity to 4 decimals', () => {
    // 10 USD de riesgo con distancia de 1198 (ej. BTC)
    // 10 / 1198 = 0.008347245... -> 0.0083
    const input: SizingInput = {
      capital: 1000,
      riskPct: 1,
      direction: 'long',
      entry: 64321,
      stop: 63123,
    };
    const result = calculatePositionSize(input);
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    expect(result.quantity).toBe(0.0083);
    const decimals = result.quantity.toString().split('.')[1] || '';
    expect(decimals.length).toBeLessThanOrEqual(4);
  });

  it('calculates fee line with 0.05% round-trip taker estimate', () => {
    expect(TAKER_ROUND_TRIP_FEE_RATE).toBe(0.0005);
    const input: SizingInput = {
      capital: 10000,
      riskPct: 1,
      direction: 'long',
      entry: 50000,
      stop: 49000,
    };
    // loss = 100 USD, dist = 1000, qty = 0.1, notional = 5000 USD
    // fee = 5000 * 0.0005 = 2.5 USD
    const result = calculatePositionSize(input);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.notionalUsd).toBe(5000);
    expect(result.feeUsd).toBe(2.5);
  });

  it('extracts invalidation level from finding when available', () => {
    const findingWithInvalidate: Finding = {
      id: 'f1',
      kind: 'double_bottom',
      label: 'Doble suelo',
      explanation: 'Soporte',
      from: 1000,
      to: 2000,
      levels: [
        { price: 100, role: 'neck', confirm: 105, invalidate: 94.5 },
      ],
      direction: 'bullish',
      strength: 0.8,
      evidence: {},
    };
    expect(invalidationPriceFromFinding(findingWithInvalidate)).toBe(94.5);

    const findingWithoutInvalidate: Finding = {
      id: 'f2',
      kind: 'pivot',
      label: 'Pivote',
      explanation: 'Pivote',
      from: 1000,
      to: 2000,
      levels: [100, 105],
      direction: 'neutral',
      strength: 0.5,
      evidence: {},
    };
    expect(invalidationPriceFromFinding(findingWithoutInvalidate)).toBe(null);
    expect(invalidationPriceFromFinding(null)).toBe(null);
  });

  it('normalizes sizing preferences properly', () => {
    expect(normalizeSizingPreferences(null)).toEqual({
      capital: 1000,
      riskPct: 1,
      direction: 'long',
    });

    expect(
      normalizeSizingPreferences({ capital: '5000', riskPct: '2.5', direction: 'short' }),
    ).toEqual({
      capital: 5000,
      riskPct: 2.5,
      direction: 'short',
    });

    // Clamps risk between 0.1 and 5
    expect(normalizeSizingPreferences({ riskPct: 10 })).toMatchObject({ riskPct: 5 });
    expect(normalizeSizingPreferences({ riskPct: 0.01 })).toMatchObject({ riskPct: 0.1 });
  });
});
