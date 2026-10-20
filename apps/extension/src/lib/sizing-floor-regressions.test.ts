import { describe, expect, it } from 'vitest';
import { calculatePositionSize, floorLossUsdForDisplay, floorToDecimals } from './sizing';
import { buildTicket } from './trade-cards/ticket';
import { DEFAULT_PRESETS } from './trade-cards/presets';
import { DEFAULT_SETTINGS } from './settings';

describe('regresiones del juez (ronda 5): nunca hacia arriba y nunca colgado', () => {
  it('floorToDecimals termina con valores enormes y no supera la entrada', () => {
    expect(floorToDecimals(1e301)).toBe(1e301);
    expect(floorToDecimals(Number.MAX_SAFE_INTEGER * 10)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER * 10);
    for (const v of [0.0091, 0.009099999999999, 1e-12, 123456.123456789, 0.1 + 0.2]) {
      expect(floorToDecimals(v)).toBeLessThanOrEqual(v);
    }
    expect(floorToDecimals(0.0091)).toBe(0.0091);
  });

  it('calculatePositionSize no se cuelga con precios minúsculos y respeta el presupuesto', () => {
    const r = calculatePositionSize({ capital: 1000, riskPct: 1, direction: 'long', entry: 0.000001, stop: 9.868581870819907e-7 });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.quantity * (0.000001 - 9.868581870819907e-7)).toBeLessThanOrEqual(10);
  });

  it('la pérdida mostrada no sube: 0,019999999995 -> 0,01', () => {
    expect(floorLossUsdForDisplay(0.019999999995)).toBe(0.01);
    expect(floorLossUsdForDisplay(0.015)).toBe(0.01);
  });

  it('el porcentaje de pérdida de una tarjeta se recorta, no se redondea al alza', () => {
    const preset = DEFAULT_PRESETS.find((p) => p.size.basis === 'risk' && p.entry.kind === 'market') ?? DEFAULT_PRESETS[0]!;
    const r = buildTicket({
      preset: { ...preset, size: { basis: 'risk', pct: 0.996 }, stop: { kind: 'pct', pct: 1 } },
      symbol: 'BTCUSDT',
      price: 100,
      levels: [],
      atrs: { atr1h: 1 },
      capital: 1000,
      rules: DEFAULT_SETTINGS.rules,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const exact = (r.ticket.lossAtStopUsd / 1000) * 100;
      expect(r.ticket.lossAtStopPctOfCapital).toBeLessThanOrEqual(exact);
      expect(r.ticket.lossAtStopPctOfCapital).toBeLessThan(1);
    }
  });
  it('la tolerancia de ruido no sube un céntimo con importes enormes', () => {
    expect(floorLossUsdForDisplay(9999999999999.99)).toBeLessThanOrEqual(9999999999999.99);
    expect(floorLossUsdForDisplay(0.009 * 1100)).toBe(9.9);
  });

  it('el aviso de regla usa la pérdida exacta: 1,0005 % con regla del 1 % avisa', () => {
    const preset = DEFAULT_PRESETS.find((p) => p.size.basis === 'risk' && p.entry.kind === 'market') ?? DEFAULT_PRESETS[0]!;
    const r = buildTicket({
      preset: { ...preset, size: { basis: 'risk', pct: 1.0005 }, stop: { kind: 'pct', pct: 1 } },
      symbol: 'BTCUSDT', price: 100, levels: [], atrs: { atr1h: 1 }, capital: 1000,
      rules: { ...DEFAULT_SETTINGS.rules, maxRiskPct: 1 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ticket.warnings.some((w) => w.code === 'risk_above_rule')).toBe(true);
  });
});
