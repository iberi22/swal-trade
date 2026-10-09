import { describe, expect, it } from 'vitest';
import { analyze } from './analysis';
import { analyze as stubAnalyze } from './analysis-core-stub';
import { renderAnalysis } from './findings-view';
import type { AnalysisResult, Finding } from './types';

function finding(partial: Partial<Finding> & Pick<Finding, 'id' | 'strength'>): Finding {
  return {
    kind: 'test',
    label: partial.id,
    explanation: 'explicación',
    from: 1_000,
    to: 2_000,
    levels: [],
    direction: 'neutral',
    evidence: null,
    ...partial,
  };
}

describe('stub de análisis', () => {
  const input = { symbol: 'BTCUSDT', timeframe: '5m', candles: [] };

  it('el stub devuelve hallazgos vacíos y el helper no pinta nada', () => {
    const rendered = renderAnalysis(stubAnalyze(input));
    expect(rendered).toEqual([]);
    expect(JSON.stringify(rendered)).not.toMatch(/probabil/i);
  });

  it('analyze() cumple el contrato aunque el núcleo real todavía no esté', () => {
    const result = analyze(input);
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.trend === null || typeof result.trend === 'string').toBe(true);
    expect(Array.isArray(result.levels)).toBe(true);
    expect(typeof result.generatedAt).toBe('string');
  });
});

describe('renderAnalysis', () => {
  const result: AnalysisResult = {
    trend: null,
    levels: [],
    generatedAt: '1970-01-01T00:00:00.000Z',
    findings: [
      finding({ id: 'a', strength: 0.2, label: 'débil' }),
      finding({ id: 'b', strength: 0.9, label: 'fuerte', direction: 'up', levels: [100, 90, 100] }),
      finding({ id: 'c', strength: 40, label: 'media' }),
      finding({ id: 'd', strength: 0.9, label: 'empate' }),
      finding({ id: 'e', strength: 0.1 }),
      finding({ id: 'f', strength: 0.05, label: 'fuera' }),
      finding({ id: 'g', strength: 0.5, direction: 'down', from: 1490, to: 1795, levels: [42] }),
    ],
  };

  it('se queda con los cinco de más fuerza y llama a la barra fuerza', () => {
    const rendered = renderAnalysis(result, { candleTimes: [1000, 1500, 1800, 2000] });
    expect(rendered.map((item) => item.id)).toEqual(['b', 'd', 'g', 'c', 'a']);
    expect(rendered.map((item) => item.fuerzaPct)).toEqual([90, 90, 50, 40, 20]);
    expect(rendered[0]).toHaveProperty('fuerza');
    expect(rendered[0]).not.toHaveProperty('probability');
    expect(JSON.stringify(rendered)).not.toMatch(/probabil/i);
    expect(rendered.map((item) => item.id)).not.toContain('f');
  });

  it('marca el hallazgo elegido y dibuja sus niveles, sin rojo ni verde', () => {
    const [top] = renderAnalysis(result, { candleTimes: [1000, 1500, 1800, 2000] });
    expect(top?.annotations.markers).toEqual([
      { time: 1000, position: 'belowBar', shape: 'arrowUp', text: '' },
      { time: 2000, position: 'belowBar', shape: 'arrowUp', text: 'fuerte' },
    ]);
    expect(top?.annotations.priceLines).toEqual([
      { price: 100, title: 'fuerte' },
      { price: 90, title: 'fuerte' },
    ]);

    const down = renderAnalysis(result, { candleTimes: [1000, 1500, 1800, 2000] }).find(
      (item) => item.id === 'g',
    );
    expect(down?.annotations.markers.map((marker) => marker.time)).toEqual([1500, 1800]);
    expect(down?.annotations.markers[1]).toMatchObject({
      position: 'aboveBar',
      shape: 'arrowDown',
    });
    expect(down?.annotations.priceLines).toEqual([{ price: 42, title: 'g' }]);
  });

  it('acepta from/to en milisegundos', () => {
    const [item] = renderAnalysis(
      {
        findings: [
          finding({
            id: 'ms',
            strength: 1,
            label: 'ms',
            from: 1_500_000_000_000,
            to: 1_800_000_000_000,
          }),
        ],
        trend: null,
        levels: [],
        generatedAt: '',
      },
      { candleTimes: [1_500_000_000, 1_800_000_000] },
    );
    expect(item?.annotations.markers.map((marker) => marker.time)).toEqual([
      1_500_000_000,
      1_800_000_000,
    ]);
  });
});
