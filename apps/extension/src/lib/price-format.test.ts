import { describe, expect, it } from 'vitest';
import { chartPriceFormat, formatPanelPrice, typicalLevelUsd } from './price-format';

describe('formatPanelPrice (panel de pulso, es-ES)', () => {
  it('precio bajo tipo PEPE conserva sus cifras significativas', () => {
    expect(formatPanelPrice(0.0041558)).toBe('0,0041558');
    expect(formatPanelPrice(0.00001234)).toBe('0,00001234');
  });

  it('precio alto usa dos decimales y separador de miles', () => {
    expect(formatPanelPrice(82313.85)).toBe('82.313,85');
    expect(formatPanelPrice(82313.851)).toBe('82.313,85');
    expect(formatPanelPrice(1.5)).toBe('1,50');
  });

  it('valores no finitos no inventan cifras', () => {
    expect(formatPanelPrice(Number.NaN)).toBe('—');
    expect(formatPanelPrice(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('typicalLevelUsd (nivel típico en USDT)', () => {
  it('convierte la cantidad mediana a USD con el precio medio', () => {
    // 2.000.000 PEPE a 0,0041558 = 8.311,6 USDT
    expect(typicalLevelUsd(2_000_000, 0.0041558)).toBeCloseTo(8311.6, 6);
    expect(typicalLevelUsd(1.5, 82313.85)).toBeCloseTo(123470.775, 6);
  });

  it('sin precio medio no hay conversión', () => {
    expect(typicalLevelUsd(10, null)).toBeNull();
    expect(typicalLevelUsd(Number.NaN, 100)).toBeNull();
  });
});

describe('chartPriceFormat (escala de precios de lightweight-charts)', () => {
  it('precio bajo: decimales para 6 cifras significativas', () => {
    expect(chartPriceFormat(0.0041558)).toEqual({ type: 'price', precision: 8, minMove: 1e-8 });
  });

  it('precio alto: mínimo de 2 decimales', () => {
    expect(chartPriceFormat(82313.85)).toEqual({ type: 'price', precision: 2, minMove: 0.01 });
  });

  it('valores no válidos caen a 2 decimales', () => {
    expect(chartPriceFormat(0)).toEqual({ type: 'price', precision: 2, minMove: 0.01 });
    expect(chartPriceFormat(Number.NaN)).toEqual({ type: 'price', precision: 2, minMove: 0.01 });
  });

  it('el paso mínimo es 10^-precision', () => {
    const f = chartPriceFormat(0.00000123);
    expect(f.precision).toBe(10);
    expect(f.minMove).toBeCloseTo(1e-10, 15);
  });
});
