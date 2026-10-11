import { describe, expect, it } from 'vitest';
import type { Finding } from '../types';
import { formatPrice, shapesForFinding, shapesForFindings } from './shapes';
import { SWAL_MAX_SHAPES } from './schema';

/** Hallazgo con la forma que emite el núcleo de análisis. */
function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'head_and_shoulders:1700000000',
    kind: 'head_and_shoulders',
    label: 'Hombro-cabeza-hombro',
    explanation: 'Tres máximos y un cuello roto.',
    from: 1_700_000_000,
    to: 1_700_100_000,
    levels: [
      { role: 'neckline', price: 100, confirm: 105, invalidate: 95 },
      { role: 'head', price: 110, time: 1_700_050_000 },
    ],
    direction: 'down',
    strength: 0.8,
    status: 'confirmed',
    evidence: null,
    ...overrides,
  };
}

describe('formatPrice', () => {
  it('usa el formato español con cifras significativas', () => {
    expect(formatPrice(82977.7)).toBe('82.977,7');
    expect(formatPrice(83010)).toBe('83.010');
    expect(formatPrice(0.5)).toBe('0,5');
    // Seis cifras significativas: la cola se redondea, no se recorta a dos decimales.
    expect(formatPrice(1234567.891)).toBe('1.234.570');
  });

  it('conserva los precios pequeños sin colapsarlos a cero (F9)', () => {
    // Un toFixed(2) daría 0,01 y 0,00. Las cifras significativas no.
    expect(formatPrice(0.006)).toBe('0,006');
    expect(formatPrice(0.00001234)).toBe('0,00001234');
    expect(formatPrice(0.00001)).toBe('0,00001');
  });

  it('un no número se devuelve tal cual', () => {
    expect(formatPrice(Number.NaN)).toBe('NaN');
    expect(formatPrice(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });
});

describe('shapesForFinding', () => {
  it('el cuello se pinta como línea de tendencia y los precios de decisión como niveles', () => {
    const shapes = shapesForFinding(finding());
    const ids = shapes.map((shape) => shape.id);
    expect(ids).toContain('head_and_shoulders:1700000000|neckline:100|trend');
    expect(ids).toContain('head_and_shoulders:1700000000|head:110');
    expect(ids).toContain('head_and_shoulders:1700000000|confirm:105');
    expect(ids).toContain('head_and_shoulders:1700000000|invalidate:95');
  });

  it('la confirmación es sólida y la invalidación punteada', () => {
    const shapes = shapesForFinding(finding());
    expect(shapes.find((item) => item.id.endsWith('confirm:105'))?.style).toBe('solid');
    expect(shapes.find((item) => item.id.endsWith('invalidate:95'))?.style).toBe('dashed');
  });

  it('los textos van en español y cortos', () => {
    const shapes = shapesForFinding(finding());
    expect(shapes.find((item) => item.id.endsWith('confirm:105'))?.text).toBe('confirma 105');
    expect(shapes.find((item) => item.id.endsWith('invalidate:95'))?.text).toBe('invalida 95');
    expect(shapes.find((item) => item.id.endsWith('neckline:100|trend'))?.text).toBe('cuello 100');
    expect(shapes.every((item) => item.text.length <= 48)).toBe(true);
  });

  it('la línea de tendencia usa los dos instantes del nivel cuando el núcleo los trae', () => {
    const shapes = shapesForFinding(
      finding({
        kind: 'symmetric_triangle',
        levels: [
          {
            role: 'triangle_upper',
            price: 120,
            line: { from: { time: 1_700_000_000, price: 118 }, to: { time: 1_700_100_000, price: 120 } },
          },
          { role: 'triangle_lower', price: 100, confirm: 120, invalidate: 100 },
        ],
      }),
    );
    const upper = shapes.find((item) => item.id.includes('triangle_upper'))!;
    expect(upper.kind).toBe('trend');
    expect(upper.points).toEqual([
      { time: 1_700_000_000, price: 118 },
      { time: 1_700_100_000, price: 120 },
    ]);
  });

  it('un cuello sin línea explícita se pinta horizontal de from a to', () => {
    const shapes = shapesForFinding(finding());
    const neck = shapes.find((item) => item.id.endsWith('neckline:100|trend'))!;
    expect(neck.points).toEqual([
      { time: 1_700_000_000, price: 100 },
      { time: 1_700_100_000, price: 100 },
    ]);
  });

  it('una zona sale de dos niveles con banda, nunca de un precio inventado', () => {
    const shapes = shapesForFinding(
      finding({
        kind: 'order_block_bullish',
        levels: [
          { role: 'ob_high', price: 130 },
          { role: 'ob_low', price: 120 },
        ],
      }),
    );
    const zone = shapes.find((item) => item.kind === 'zone')!;
    expect(zone.points).toEqual([
      { time: 1_700_000_000, price: 120 },
      { time: 1_700_100_000, price: 130 },
    ]);
    expect(zone.text).toContain('120');
    expect(zone.text).toContain('130');
    // Los dos niveles que forman la banda no se repiten como líneas.
    expect(shapes.some((item) => item.kind === 'level')).toBe(false);
  });

  it('un nivel con high/low ya es una zona y no se pinta dos veces', () => {
    const shapes = shapesForFinding(
      finding({
        kind: 'sr_zone',
        levels: [
          { role: 'support', price: 70144, low: 70080, high: 70208, confirm: 70208, invalidate: 70080 },
        ],
      }),
    );
    const zones = shapes.filter((item) => item.kind === 'zone');
    expect(zones).toHaveLength(1);
    expect(zones[0]!.points).toEqual([
      { time: 1_700_000_000, price: 70080 },
      { time: 1_700_100_000, price: 70208 },
    ]);
    expect(shapes.some((item) => item.kind === 'level' && item.points[0]!.price === 70144)).toBe(false);
  });

  it('sin banda no hay zona', () => {
    const shapes = shapesForFinding(
      finding({ kind: 'pivot', levels: [{ role: 'pivot_high', price: 110 }] }),
    );
    expect(shapes.some((item) => item.kind === 'zone')).toBe(false);
  });

  it('la vela de choque se pinta como flecha con el precio de la vela', () => {
    const candles = [
      { time: 1_699_999_000, close: 99 },
      { time: 1_700_000_000, close: 104 },
    ];
    const shapes = shapesForFinding(
      finding({ kind: 'shock', label: '', direction: 'up', levels: [{ role: 'shock', price: 105, confirm: 105, invalidate: 99 }] }),
      { candleTimes: candles.map((candle) => candle.time), priceAt: (time) => candles.find((c) => c.time === time)?.close ?? null },
    );
    const arrow = shapes.find((item) => item.kind === 'arrow')!;
    expect(arrow.direction).toBe('up');
    // Texto neutro: describe la vela y su dirección, nunca "compra" ni "venta".
    expect(arrow.text).toBe('vela de choque al alza');
    expect(arrow.text).not.toMatch(/compra|venta|agresiv/i);
    expect(arrow.points).toEqual([{ time: 1_700_000_000, price: 104 }]);
  });

  it('el texto de la flecha nunca es una orden de compra o venta', () => {
    const at = { candleTimes: [1_700_000_000], priceAt: (t: number) => (t === 1_700_000_000 ? 104 : null) };
    for (const direction of ['up', 'down'] as const) {
      const shapes = shapesForFinding(
        finding({ kind: 'liquidity_sweep_high', label: '', direction, levels: [{ role: 'sweep', price: 105 }] }),
        at,
      );
      const text = shapes.find((item) => item.kind === 'arrow')?.text ?? '';
      expect(text).not.toMatch(/compra|venta|agresiv/i);
    }
  });

  it('un choque a la baja apunta abajo con texto neutro', () => {
    const shapes = shapesForFinding(
      finding({ kind: 'shock', label: '', direction: 'down', levels: [{ role: 'shock', price: 99, confirm: 105, invalidate: 99 }] }),
      { candleTimes: [1_700_000_000], priceAt: (t) => (t === 1_700_000_000 ? 104 : null) },
    );
    const arrow = shapes.find((item) => item.kind === 'arrow')!;
    expect(arrow.direction).toBe('down');
    expect(arrow.text).toBe('vela de choque a la baja');
  });

  it('sin precio de vela cerca no hay flecha (F10: sin anclaje inventado)', () => {
    // Antes anclaba en levels[0].price; ahora solo pinta si hay precio de vela.
    const shapes = shapesForFinding(
      finding({ kind: 'shock', label: '', direction: 'up', levels: [{ role: 'shock', price: 105, confirm: 105, invalidate: 99 }] }),
    );
    expect(shapes.some((item) => item.kind === 'arrow')).toBe(false);
  });

  it('niveles sin precio utilizable se descartan', () => {
    const shapes = shapesForFinding(
      finding({ levels: [{ role: 'pivot_high', price: Number.NaN }, { role: 'pivot_low', price: 80 }] }),
    );
    expect(shapes.map((item) => item.id)).not.toContain(
      'head_and_shoulders:1700000000|pivot_high:NaN',
    );
    expect(shapes.some((item) => item.id.endsWith('pivot_low:80'))).toBe(true);
  });

  it('un nivel que ya está en la lista no se repite como confirmación', () => {
    const shapes = shapesForFinding(
      finding({ levels: [{ role: 'pivot_high', price: 120, confirm: 120, invalidate: 100 }] }),
    );
    // confirm coincide con el nivel: se pinta una sola línea.
    expect(shapes.filter((item) => item.kind === 'level' && item.points[0]!.price === 120)).toHaveLength(1);
    expect(shapes.some((item) => item.id.endsWith('invalidate:100'))).toBe(true);
  });
});

describe('shapesForFindings', () => {
  it('respeta el límite de hallazgos y no repite formas', () => {
    const levels = [{ role: 'neckline', price: 100, confirm: 105, invalidate: 95 }];
    const findings = Array.from({ length: 12 }, (_, index) =>
      finding({ id: `f${index}`, levels, strength: 0.1 * index + 0.1 }),
    );
    const shapes = shapesForFindings(findings, { limit: 4 });
    expect(shapes).toHaveLength(4 * 3);
    expect(new Set(shapes.map((item) => item.id)).size).toBe(shapes.length);
  });

  it('nunca pasa del tope de formas del mensaje', () => {
    const findings = Array.from({ length: 200 }, (_, index) =>
      finding({
        id: `f${index}`,
        levels: [
          { role: 'fvg_top', price: 130 },
          { role: 'fvg_bottom', price: 120 },
          { role: 'pivot_high', price: 140 },
        ],
      }),
    );
    const shapes = shapesForFindings(findings, { limit: SWAL_MAX_SHAPES });
    expect(shapes.length).toBeLessThanOrEqual(SWAL_MAX_SHAPES);
  });

  it('sin hallazgos no hay formas', () => {
    expect(shapesForFindings([])).toEqual([]);
  });
});
