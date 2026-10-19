import { describe, expect, it } from 'vitest';
import {
  calculatePositionSize,
  calculatePositionSizeWithFees,
  defaultScaleEntries,
  floorToStep,
  planScaleIn,
  invalidationPriceFromFinding,
  normalizeSizingPreferences,
  TAKER_FEE_RATE,
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
    expect(result.feeUsd).toBe(0.2);
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
    expect(result.feeUsd).toBe(0.2);
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

  it('calculates fees as 0.05% taker on entry plus 0.05% on exit', () => {
    expect(TAKER_ROUND_TRIP_FEE_RATE).toBe(0.001);
    const input: SizingInput = { capital: 10000, riskPct: 1, direction: 'long', entry: 50000, stop: 49000 };
    const result = calculatePositionSize(input);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.notionalUsd).toBe(5000);
    expect(result.feeUsd).toBe(5);
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

describe('planScaleIn (escalonar en 3 tramos)', () => {
  function prng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const isMultiple = (v: number, step: number) => Math.abs(v / step - Math.round(v / step)) < 1e-6;

  it('keeps loss within R_max (with fees) and close to it over random geometries', () => {
    const rnd = prng(12345);
    for (let i = 0; i < 500; i++) {
      const direction = rnd() < 0.5 ? 'long' : 'short';
      const entry1 = 50 + rnd() * 90000;
      const dist = entry1 * (0.005 + rnd() * 0.05);
      const sign = direction === 'long' ? -1 : 1;
      const stop = entry1 + sign * dist;
      const e = defaultScaleEntries({ direction, entry: entry1, stop, tickSize: 0.01 })!;
      const capital = 1000 + rnd() * 99000;
      const riskPct = 0.5 + rnd() * 2;
      const tickSize = 0.01;
      const stepSize = 0.0001;
      const r = planScaleIn({ capital, riskPct, direction, entry1: roundToTickTest(entry1), entry2: e.entry2, entry3: e.entry3, stop, tickSize, stepSize });
      expect(r.valid).toBe(true);
      if (!r.valid) continue;
      const rMax = capital * riskPct / 100;
      expect(r.lossIfAllFillAndStop).toBeLessThanOrEqual(rMax + 1e-9);
      expect(r.lossIfAllFillAndStop).toBeGreaterThanOrEqual(0.97 * rMax);
      expect(r.lossIfOnlyFirstFillsAndStop).toBeLessThan(r.lossIfAllFillAndStop);
      expect(r.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      for (const t of r.tranches) {
        expect(isMultiple(t.qty, stepSize)).toBe(true);
        expect(isMultiple(t.price, tickSize)).toBe(true);
      }
      expect(r.honestNote).toContain('no mejora la esperanza');
      expect(r.avgByFill).toHaveLength(r.tranches.length);
    }
    function roundToTickTest(p: number) { return Math.round(p / 0.01) * 0.01; }
  });

  it('rejects wrong ordering for long and short with a Spanish reason', () => {
    const base = { capital: 1000, riskPct: 1 };
    const l = planScaleIn({ ...base, direction: 'long', entry1: 100, entry2: 101, entry3: 98, stop: 95 });
    expect(l.valid).toBe(false);
    if (!l.valid) { expect(l.reason).toBe('wrong_order'); expect(l.error).toContain('entrada 1 > entrada 2'); }
    expect(planScaleIn({ ...base, direction: 'long', entry1: 100, entry2: 98, entry3: 96, stop: 97 }).valid).toBe(false);
    const s = planScaleIn({ ...base, direction: 'short', entry1: 100, entry2: 99, entry3: 102, stop: 105 });
    expect(s.valid).toBe(false);
    expect(planScaleIn({ ...base, direction: 'short', entry1: 100, entry2: 102, entry3: 104, stop: 105 }).valid).toBe(true);
    expect(planScaleIn({ ...base, direction: 'long', entry1: 100, entry2: 98, entry3: 96, stop: 95 }).valid).toBe(true);
  });

  it('rejects invalid input and weights', () => {
    const r = planScaleIn({ capital: 0, riskPct: 1, direction: 'long', entry1: 100, entry2: 98, entry3: 96, stop: 95 });
    expect(r.valid).toBe(false);
    const w = planScaleIn({ capital: 1000, riskPct: 1, direction: 'long', entry1: 100, entry2: 98, entry3: 96, stop: 95, weights: [0.5, 0.5, 0.5] });
    expect(w.valid).toBe(false);
  });

  it('degrades to two tranches when a tranche is below the minimum, and says so', () => {
    const r = planScaleIn({ capital: 1000, riskPct: 1, direction: 'long', entry1: 100, entry2: 98, entry3: 96, stop: 95, stepSize: 0.1, minQty: 1 });
    expect(r.valid).toBe(true);
    if (!r.valid) return;
    expect(r.degraded).toBe(true);
    expect(r.tranches).toHaveLength(2);
    expect(r.weights).toEqual([0.35, 0.65]);
    expect(r.tranches.map((t) => t.price)).toEqual([100, 96]);
    expect(r.notes.join(' ')).toContain('dos tramos');
    expect(r.lossIfAllFillAndStop).toBeLessThanOrEqual(10 + 1e-9);
  });

  it('is invalid when even two tranches do not reach the minimum', () => {
    const r = planScaleIn({ capital: 1000, riskPct: 1, direction: 'long', entry1: 100, entry2: 98, entry3: 96, stop: 95, minNotional: 100000 });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('too_small');
  });

  it('computes a known example', () => {
    const r = planScaleIn({ capital: 1000, riskPct: 1, direction: 'long', entry1: 100, entry2: 98, entry3: 96, stop: 94, feeRate: 0 });
    expect(r.valid).toBe(true);
    if (!r.valid) return;
    // media 0,25*100 + 0,35*98 + 0,4*96 = 97,7; distancia 3,7; Q = 10/3,7
    expect(r.avgByFill[2]).toBeCloseTo(97.7, 2);
    expect(r.avgByFill[0]).toBeCloseTo(100, 8);
    expect(r.totalQty).toBeCloseTo(10 / 3.7, 3);
    expect(r.breakEvenByFill[0]).toBeCloseTo(100, 8);
  });

  it('defaultScaleEntries uses 40 % and 80 % of the distance', () => {
    expect(defaultScaleEntries({ direction: 'long', entry: 100, stop: 90 })).toEqual({ entry2: 96, entry3: 92 });
    expect(defaultScaleEntries({ direction: 'short', entry: 100, stop: 110 })).toEqual({ entry2: 104, entry3: 108 });
    expect(defaultScaleEntries({ direction: 'long', entry: 100, stop: 105 })).toBeNull();
  });
});

describe('calculatePositionSizeWithFees (riesgo con comisiones)', () => {
  const base = {
    capital: 1000,
    riskPct: 1,
    direction: 'long' as const,
    entry: 100000,
    stop: 99000,
    entryFeeRate: TAKER_FEE_RATE,
    exitFeeRate: TAKER_FEE_RATE,
  };

  it('keeps the loss at the stop within the risk budget once fees are included', () => {
    const r = calculatePositionSizeWithFees(base);
    expect(r.valid).toBe(true);
    if (!r.valid) return;
    // Presupuesto 10 USD: qty = 10 / (1000 + 100000·0,0005 + 99000·0,0005) = 10 / 1099,5
    expect(r.lossBudgetUsd).toBe(10);
    expect(r.quantity).toBeCloseTo(10 / 1099.5, 12);
    expect(r.lossUsd).toBeLessThanOrEqual(10 + 1e-9);
    expect(r.lossUsd).toBe(10);
    expect(r.notionalUsd).toBeCloseTo(909.5, 6);
    expect(r.minLeverage).toBe(1);
    // Comisión de ida (50·qty) + vuelta (49,5·qty) ≈ 0,90 USD
    expect(r.feeUsd).toBe(0.9);
  });

  it('floors the quantity to the contract step so it never spends more than the budget', () => {
    const r = calculatePositionSizeWithFees({ ...base, stepSize: 0.0001 });
    expect(r.valid).toBe(true);
    if (!r.valid) return;
    expect(r.quantity).toBe(0.009);
    expect(r.quantity).toBe(floorToStep(10 / 1099.5, 0.0001));
    expect(r.lossUsd).toBeLessThanOrEqual(10 + 1e-9);
  });

  it('returns full precision when no stepSize is given instead of flooring to 6 decimals', () => {
    const r = calculatePositionSizeWithFees(base);
    expect(r.valid).toBe(true);
    if (!r.valid) return;
    const raw = 10 / 1099.5;
    // Sin paso de contrato la cantidad conserva toda la precisión: no se recorta al
    // suelo de 6 decimales que aplica floorToStep sin argumento.
    expect(r.quantity).not.toBe(floorToStep(raw, undefined));
    expect(r.quantity).toBeCloseTo(raw, 12);
  });

  it('honours an exact lossBudgetUsd instead of deriving it from a rounded riskPct', () => {
    const r = calculatePositionSizeWithFees({ ...base, lossBudgetUsd: 25 });
    expect(r.valid).toBe(true);
    if (!r.valid) return;
    expect(r.lossBudgetUsd).toBe(25);
    expect(r.quantity).toBeCloseTo(25 / 1099.5, 12);
    expect(r.lossUsd).toBeLessThanOrEqual(25 + 1e-9);
  });

  it('rejects a negative fee and propagates base validation errors', () => {
    const badFee = calculatePositionSizeWithFees({ ...base, entryFeeRate: -0.001 });
    expect(badFee.valid).toBe(false);
    if (!badFee.valid) expect(badFee.reason).toBe('invalid_input');

    const wrongSide = calculatePositionSizeWithFees({ ...base, direction: 'long', stop: 100500 });
    expect(wrongSide.valid).toBe(false);
    if (!wrongSide.valid) expect(wrongSide.reason).toBe('wrong_side');
  });
});
