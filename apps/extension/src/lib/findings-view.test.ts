import { describe, expect, it } from 'vitest';
import { analyze } from './analysis';
import { analyze as stubAnalyze } from './analysis-core-stub';
import {
  CHART_FINDING_LIMIT,
  COLLAPSED_MAX,
  collapsedLabel,
  cutAtWord,
  findingOneLiner,
  findingSummary,
  flowCollapsedLabel,
  newsCollapsedLabel,
  pulseCollapsedLabel,
  radarCollapsedLabel,
  shortPrice,
  annotationsForFinding,
  annotationsForFindings,
  findingsLegend,
  normalizeStrength,
  rankFindings,
  renderAnalysis,
  resolveLevels,
  roleLabel,
} from './findings-view';
import type { AnalysisResult, Finding, FindingLevel } from './types';

function level(
  partial: Partial<FindingLevel> & Pick<FindingLevel, 'price'>,
): FindingLevel {
  return { ...partial };
}

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

/** Hallazgo con la forma real que emite el núcleo. */
function coreLikeFinding(id: string, strength: number, shift = 0): Finding {
  return finding({
    id,
    kind: id,
    label: id,
    strength,
    direction: 'up',
    from: 1_000,
    to: 2_000,
    levels: [
      level({ role: 'neckline', price: 120.3 + shift, confirm: 120.3 + shift, invalidate: 109.5 + shift }),
      level({ role: 'trough', price: 109.7 + shift, confirm: 120.3 + shift, invalidate: 109.5 + shift }),
    ],
  });
}

const TIMES = [1000, 1500, 1800, 2000];

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
    expect(Array.isArray(result.top)).toBe(true);
    expect(result.trend === null || typeof result.trend === 'string').toBe(true);
    expect(Array.isArray(result.levels)).toBe(true);
    expect(typeof result.generatedAt).toBe('string');
  });
});

describe('normalizeStrength', () => {
  it('trata >1 como porcentaje y 1 como fuerza completa', () => {
    expect(normalizeStrength(0.2)).toBe(0.2);
    expect(normalizeStrength(40)).toBe(0.4);
    expect(normalizeStrength(1)).toBe(1);
    expect(normalizeStrength('x')).toBe(0);
  });
});

describe('resolveLevels', () => {
  it('acepta los niveles-objeto del núcleo', () => {
    expect(resolveLevels([level({ role: 'neckline', price: 100, confirm: 101, invalidate: 90 })])).toEqual([
      { price: 100, confirm: 101, invalidate: 90, role: 'neckline' },
    ]);
  });

  it('sigue aceptando los números pelados de los núcleos viejos', () => {
    expect(resolveLevels([100, 90])).toEqual([
      { price: 100, confirm: null, invalidate: null, role: '' },
      { price: 90, confirm: null, invalidate: null, role: '' },
    ]);
  });

  it('descarta lo que no es un precio', () => {
    expect(resolveLevels([null, 'x', { role: 'x' }, Number.NaN])).toEqual([]);
    expect(resolveLevels('nope')).toEqual([]);
  });
});

describe('annotationsForFinding', () => {
  it('dibuja los niveles, la confirmación y la invalidación de un hallazgo', () => {
    const annotation = annotationsForFinding(
      finding({
        id: 'b',
        strength: 0.9,
        label: 'Doble suelo',
        direction: 'up',
        from: 1_000,
        to: 2_000,
        levels: [
          level({ role: 'neckline', price: 120.3, confirm: 120.3, invalidate: 109.5 }),
          level({ role: 'trough', price: 109.7, confirm: 120.3, invalidate: 109.5 }),
        ],
      }),
      TIMES,
    );
    expect(annotation.markers).toEqual([
      { time: 1000, position: 'belowBar', shape: 'arrowUp', text: '', findingId: 'b' },
      { time: 2000, position: 'belowBar', shape: 'arrowUp', text: 'Doble suelo', findingId: 'b' },
    ]);
    expect(annotation.priceLines).toEqual([
      { price: 120.3, title: 'cuello', kind: 'level', findingId: 'b' },
      { price: 109.7, title: 'valle', kind: 'level', findingId: 'b' },
      { price: 109.5, title: 'invalida', kind: 'invalidate', findingId: 'b' },
    ]);
    // 120.3 es a la vez nivel y confirmación: se pinta una sola vez.
    expect(annotation.priceLines.filter((line) => line.price === 120.3)).toHaveLength(1);
  });

  it('marca invalidate para dibujarla punteada', () => {
    const annotation = annotationsForFinding(
      finding({ id: 'x', strength: 1, levels: [level({ price: 50, confirm: 55, invalidate: 45 })] }),
    );
    expect(annotation.priceLines.find((line) => line.kind === 'invalidate')?.price).toBe(45);
    expect(annotation.priceLines.find((line) => line.kind === 'confirm')?.price).toBe(55);
    expect(annotation.priceLines.find((line) => line.kind === 'level')?.price).toBe(50);
  });

  it('acepta from/to en milisegundos', () => {
    const annotation = annotationsForFinding(
      finding({ id: 'ms', strength: 1, from: 1_500_000_000_000, to: 1_800_000_000_000 }),
      [1_500_000_000, 1_800_000_000],
    );
    expect(annotation.markers.map((marker) => marker.time)).toEqual([1_500_000_000, 1_800_000_000]);
  });
});

describe('annotationsForFindings (todos los top, no solo el elegido)', () => {
  const findings = [
    coreLikeFinding('double_bottom', 0.84, 0),
    coreLikeFinding('rsi_divergence_bullish', 0.68, 10),
    coreLikeFinding('volume_profile', 0.41, 20),
  ];

  it('junta marcadores y líneas de los tres hallazgos', () => {
    const annotation = annotationsForFindings(findings, { candleTimes: TIMES });
    expect(new Set(annotation.markers.map((marker) => marker.findingId))).toEqual(
      new Set(['double_bottom', 'rsi_divergence_bullish', 'volume_profile']),
    );
    expect(new Set(annotation.priceLines.map((line) => line.findingId))).toEqual(
      new Set(['double_bottom', 'rsi_divergence_bullish', 'volume_profile']),
    );
    expect(annotation.markers).toHaveLength(6);
    // Cada hallazgo aporta 2 niveles + invalidate: 3 x 3.
    expect(annotation.priceLines).toHaveLength(9);
  });
  it('no repite una línea con el mismo precio y tipo', () => {
    const annotation = annotationsForFindings(findings);
    const keys = annotation.priceLines.map((line) => `${line.kind}@${line.price}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('respeta el límite de hallazgos dibujados', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      coreLikeFinding(`kind_${index}`, 1 - index / 100),
    );
    const annotation = annotationsForFindings(many);
    expect(new Set(annotation.markers.map((marker) => marker.findingId)).size).toBe(
      CHART_FINDING_LIMIT,
    );
  });
});

describe('rankFindings / renderAnalysis', () => {
  const result: AnalysisResult = {
    trend: null,
    levels: [],
    generatedAt: '1970-01-01T00:00:00.000Z',
    top: [
      finding({ id: 'a', strength: 0.2, label: 'débil' }),
      finding({ id: 'b', strength: 0.9, label: 'fuerte', direction: 'up', levels: [100, 90, 100] }),
      finding({ id: 'c', strength: 40, label: 'media' }),
      finding({ id: 'd', strength: 0.9, label: 'empate' }),
      finding({ id: 'e', strength: 0.1 }),
      finding({ id: 'f', strength: 0.05, label: 'fuera' }),
    ],
    findings: [],
  };

  it('se queda con los cinco de más fuerza y llama a la barra fuerza', () => {
    const rendered = renderAnalysis(result, { candleTimes: TIMES });
    expect(rendered.map((item) => item.id)).toEqual(['b', 'd', 'c', 'a', 'e']);
    expect(rendered.map((item) => item.fuerzaPct)).toEqual([90, 90, 40, 20, 10]);
    expect(rendered[0]).toHaveProperty('fuerza');
    expect(rendered[0]).not.toHaveProperty('probability');
    expect(JSON.stringify(rendered)).not.toMatch(/probabil/i);
    expect(rendered.map((item) => item.id)).not.toContain('f');
  });

  it('usa `findings` si el núcleo no trae `top`', () => {
    const only = { ...result, top: [], findings: result.top };
    expect(renderAnalysis(only).map((item) => item.id)).toEqual(['b', 'd', 'c', 'a', 'e']);
  });

  it('los niveles pelados siguen dibujándose como líneas', () => {
    const [top] = renderAnalysis(result, { candleTimes: TIMES });
    expect(top?.annotations.priceLines).toEqual([
      { price: 100, title: 'test', kind: 'level', findingId: 'b' },
      { price: 90, title: 'test', kind: 'level', findingId: 'b' },
    ]);
  });

  it('ordena por fuerza y recorta', () => {
    expect(rankFindings(result.top, 2).map((f) => f.id)).toEqual(['b', 'd']);
  });
});

describe('findingsLegend', () => {
  it('expone confirm e invalidate de cada hallazgo del top', () => {
    const rows = findingsLegend([
      coreLikeFinding('double_bottom', 0.84),
      coreLikeFinding('volume_profile', 0.41),
    ]);
    expect(rows.map((row) => row.findingId)).toEqual(['double_bottom', 'volume_profile']);
    const [first] = rows;
    expect(first?.confirm).toBe(120.3);
    expect(first?.invalidate).toBe(109.5);
    expect(first?.fuerzaPct).toBe(84);
    expect(first?.levels.map((entry) => entry.kind)).toEqual(['level', 'level', 'invalidate']);
    expect(first?.markerTimes).toEqual([1000, 2000]);
  });

  it('traduce el papel de los niveles a texto corto', () => {
    expect(roleLabel('neckline', 'double_bottom')).toBe('cuello');
    expect(roleLabel('support', 'sr_zone')).toBe('soporte');
    expect(roleLabel('poc', 'volume_profile')).toBe('POC');
    expect(roleLabel('', '')).toBe('nivel');
  });
});

describe('texto corto del panel', () => {
  it('findingSummary corta en una palabra y pone puntos suspensivos', () => {
    const long = 'palabra '.repeat(40);
    const out = findingSummary({ explanation: long }, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/palab…|\s…/);
    expect(findingSummary({ explanation: 'corto' })).toBe('corto');
    expect(findingSummary({ explanation: '', label: 'Doble suelo' })).toBe('Doble suelo');
    expect(findingSummary({ explanation: 'a\n\n b' })).toBe('a b');
  });

  it('cutAtWord parte una palabra larga sin espacios', () => {
    const out = cutAtWord('x'.repeat(200), 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('collapsedLabel nunca pasa de 70 caracteres', () => {
    expect(collapsedLabel('Pulso', 'muro venta 0.0841')).toBe('Pulso · muro venta 0.0841');
    const out = collapsedLabel('Titulares', 'una cadena muy larga '.repeat(10));
    expect(out.length).toBeLessThanOrEqual(COLLAPSED_MAX);
    expect(out.endsWith('…')).toBe(true);
    expect(collapsedLabel('Solo')).toBe('Solo');
  });

  it('findingOneLiner usa etiqueta y fuerza', () => {
    expect(findingOneLiner('Doble suelo', 62.4)).toBe('Doble suelo · fuerza 62');
  });

  it('shortPrice usa la precisión del tick sin ceros de más', () => {
    expect(shortPrice(0.0841)).toBe('0.0841');
    expect(shortPrice(65000.5)).toBe('65000.50');
    expect(shortPrice(120.3)).toBe('120.30');
    expect(shortPrice(0.004155)).toBe('0.004155');
    expect(shortPrice(Number.NaN)).toBe('—');
    expect(shortPrice(null)).toBe('—');
  });

  it('las etiquetas de los plegables dicen el dato clave', () => {
    expect(
      pulseCollapsedLabel({
        walls: { asks: [{ price: 0.0841, usd: 900 }], bids: [{ price: 0.08, usd: 100 }] },
        fearGreed: { value: 34 },
      }),
    ).toBe('Pulso · muro venta 0.0841 · miedo 34');
    expect(pulseCollapsedLabel({ walls: null, fearGreed: null })).toBe('Pulso · sin datos');
    expect(newsCollapsedLabel(4, 'hace 4 min')).toBe('Titulares · 4 · último hace 4 min');
    expect(newsCollapsedLabel(0)).toBe('Titulares · sin novedades');
    expect(radarCollapsedLabel(1)).toBe('Radar · 1 alerta');
    expect(radarCollapsedLabel(3)).toBe('Radar · 3 alertas');
    expect(flowCollapsedLabel(0)).toBe('Flujo CVD · sin volumen taker');
    expect(flowCollapsedLabel(71, 5)).toBe('Flujo CVD · última vela: compra agresiva');
    expect(flowCollapsedLabel(71, -5)).toBe('Flujo CVD · última vela: venta agresiva');
    for (const label of [
      pulseCollapsedLabel({ walls: null, fearGreed: { value: 80 } }),
      newsCollapsedLabel(99, 'hace 3 días y muchas horas más'),
      radarCollapsedLabel(12, 'BTCUSDT 15m largo muy largo muy largo muy largo muy largo muy largo'),
    ]) {
      expect(label.length).toBeLessThanOrEqual(COLLAPSED_MAX);
    }
  });
});
