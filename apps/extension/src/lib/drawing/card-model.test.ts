import { describe, expect, it } from 'vitest';
import type { LevelRow } from '../context/levels';
import type { RulesSettings } from '../settings';
import { DRAWING_HONEST_LINE, analyzeDrawing } from './analyze';
import { FROM_DRAWING_NOTE, feeInclusiveRiskUsd } from '../trade-cards/sizing-bridge';
import {
  DRAWING_EMPTY_HINT,
  DRAWING_MAX_SHOWN,
  DRAWING_OFF_TEXT,
  buildDrawingCardModel,
  drawingTicketText,
  fundingText,
  invalidDrawingText,
  levelLines,
  numberLines,
  reachText,
  toolFromAnalysis,
  type DrawingCardEntry,
} from './card-model';
import type { DrawingAnalysis, DrawingAnalysisResult, PositionDrawing } from './types';

const rules: RulesSettings = { maxRiskPct: 1, maxLeverage: 10, dailyLossUsd: 10, revengeMinutes: 15 };

const level = (price: number, label: string): LevelRow => ({
  price,
  kind: 'ema20_1h',
  kinds: ['ema20_1h'],
  label,
  distancePct: 0,
  distanceAtr: null,
});

function drawing(over: Partial<PositionDrawing> = {}): PositionDrawing {
  return {
    id: 'tv-1',
    side: 'long',
    entry: 100,
    stop: 98,
    target: 106,
    symbol: 'BTCUSDT',
    ...over,
  };
}

/** Mismos datos de mercado para todos los casos, para que las cifras sean comparables. */
function run(d: PositionDrawing = drawing(), price = 100): DrawingAnalysisResult {
  return analyzeDrawing({
    drawing: d,
    price,
    levels: [level(102, 'PDH'), level(104, 'EMA 20')],
    atrs: { atr1h: 2, atr4h: 4, atrD: 8 },
    capital: 1000,
    rules,
    filters: { tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 100 },
    fundingRatePct8h: 0.01,
  });
}

function unwrap(result: DrawingAnalysisResult): DrawingAnalysis {
  if (!result.ok) throw new Error(result.reason);
  return result.analysis;
}

function analysis(over: Partial<PositionDrawing> = {}, price = 100): DrawingAnalysis {
  return unwrap(run(drawing(over), price));
}

function entry(over: Partial<PositionDrawing> = {}, price = 100): DrawingCardEntry {
  const d = drawing(over);
  return { symbol: d.symbol, id: d.id, result: run(d, price) };
}

const analysisItems = (model: ReturnType<typeof buildDrawingCardModel>) =>
  model.state === 'ready' ? model.items.filter((item) => item.kind === 'analysis') : [];

describe('buildDrawingCardModel', () => {
  it('con el ajuste apagado devuelve la línea de lectura y nada más', () => {
    const model = buildDrawingCardModel({ enabled: false, symbol: 'BTCUSDT', entries: [entry()] });
    expect(model).toEqual({ state: 'off', text: DRAWING_OFF_TEXT });
  });

  it('encendido y sin dibujos para el símbolo devuelve la pista de la pestaña', () => {
    expect(buildDrawingCardModel({ enabled: true, symbol: 'BTCUSDT', entries: [] })).toEqual({
      state: 'empty',
      hint: DRAWING_EMPTY_HINT,
    });
    const other = buildDrawingCardModel({
      enabled: true,
      symbol: 'ETHUSDT',
      entries: [entry()],
    });
    expect(other.state).toBe('empty');
  });

  it('enseña como mucho dos y empieza por la última dibujada', () => {
    const entries = [
      entry({ id: 'a' }),
      entry({ id: 'b' }),
      entry({ id: 'c', entry: 200, stop: 196, target: 212 }),
    ];
    const model = buildDrawingCardModel({ enabled: true, symbol: 'btcusdt', entries });
    expect(model.state).toBe('ready');
    if (model.state !== 'ready') return;
    expect(model.items).toHaveLength(DRAWING_MAX_SHOWN);
    expect(analysisItems(model).map((item) => (item.kind === 'analysis' ? item.id : ''))).toEqual([
      'c',
      'b',
    ]);
  });

  it('la pista depende del símbolo, no del resto del almacén', () => {
    const model = buildDrawingCardModel({
      enabled: true,
      symbol: 'ETHUSDT',
      entries: [entry(), entry({ id: 'eth', symbol: 'ETHUSDT' })],
    });
    expect(model.state).toBe('ready');
    if (model.state !== 'ready') return;
    expect(analysisItems(model).map((item) => (item.kind === 'analysis' ? item.id : ''))).toEqual(['eth']);
  });

  it('un dibujo inválido ocupa su sitio con el motivo y sin cifras', () => {
    const model = buildDrawingCardModel({
      enabled: true,
      symbol: 'BTCUSDT',
      entries: [entry({ id: 'bad', stop: 102 })],
    });
    expect(model.state).toBe('ready');
    if (model.state !== 'ready') return;
    expect(model.items).toEqual([
      {
        kind: 'invalid',
        id: 'bad',
        text: 'Dibujo no válido: el stop está del lado equivocado (o el objetivo no queda en el sentido de la posición).',
      },
    ]);
    expect(analysisItems(model)).toHaveLength(0);
  });

  it('un dibujo inválido de otro símbolo no se cuela en la tarjeta', () => {
    const model = buildDrawingCardModel({
      enabled: true,
      symbol: 'BTCUSDT',
      entries: [entry({ id: 'eth-bad', symbol: 'ETHUSDT', stop: 102 })],
    });
    expect(model).toEqual({ state: 'empty', hint: DRAWING_EMPTY_HINT });
  });

  it('mezcla el motivo inválido y el análisis válido en orden de llegada', () => {
    const model = buildDrawingCardModel({
      enabled: true,
      symbol: 'BTCUSDT',
      entries: [entry({ id: 'ok' }), entry({ id: 'bad', stop: 102 })],
    });
    expect(model.state).toBe('ready');
    if (model.state !== 'ready') return;
    expect(model.items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'invalid:bad',
      'analysis:ok',
    ]);
  });
});

describe('invalidDrawingText', () => {
  it('traduce los códigos de validación a castellano llano', () => {
    expect(invalidDrawingText('wrong_order')).toContain('Dibujo no válido: el stop está del lado equivocado');
    expect(invalidDrawingText('non_positive_numbers')).toBe(
      'Dibujo no válido: los precios tienen que ser números positivos.',
    );
    expect(invalidDrawingText('invalid_side')).toBe(
      'Dibujo no válido: la herramienta no dice si la posición es larga o corta.',
    );
    expect(invalidDrawingText('stop_too_far')).toBe(
      'Dibujo no válido: el stop queda a más de la mitad del precio de entrada.',
    );
  });

  it('nunca deja pasar un código desconocido', () => {
    expect(invalidDrawingText('rm -rf /')).toBe('Dibujo no válido: no se pudo leer la herramienta.');
  });
});

describe('numberLines', () => {
  it('da entrada, stop, objetivo, R:R bruto/neto y distancia del stop', () => {
    const rows = numberLines(analysis());
    const byLabel = new Map(rows.map((row) => [row.label, row.value]));
    expect(byLabel.get('Entrada')).toBe('100,00 · mercado');
    expect(byLabel.get('Stop')).toBe('98,00');
    expect(byLabel.get('Objetivo')).toBe('106,00');
    expect(byLabel.get('R:R bruto / neto')).toBe('3,00 / 2,81');
    expect(byLabel.get('Distancia del stop')).toBe('2,00 % = 1,00 ATR(1h)');
  });

  it('la pérdida es la del stop con comisiones, recortada hacia abajo: 9,99 USD y 4,764 de cantidad, no 5 (la comisión baja la cantidad)', () => {
    const rows = numberLines(analysis());
    const byLabel = new Map(rows.map((row) => [row.label, row.value]));
    // 4,764 × (2 + 0,05 + 0,049) = 9,999636: el redondeo lo enseñaba como 10,00.
    expect(byLabel.get('Pérdida en el stop, con comisiones')).toBe('9,99 USD');
    expect(byLabel.get('Cantidad')).toBe('4.764');
    expect(byLabel.has('Pérdida a tu regla')).toBe(false);
  });

  it('marca la entrada como límite cuando está lejos del precio', () => {
    const rows = numberLines(analysis({}, 120));
    expect(rows.find((row) => row.label === 'Entrada')?.value).toContain('límite');
  });

  it('marca la entrada como stop (taker) cuando cruza el precio', () => {
    const rows = numberLines(analysis({}, 95));
    expect(rows.find((row) => row.label === 'Entrada')?.value).toBe('100,00 · stop (taker)');
  });

  it('avisa cuando el mínimo del contrato no cabe en la regla', () => {
    const tiny = unwrap(
      analyzeDrawing({
        drawing: { id: 'x', side: 'long', entry: 100, stop: 99.9, target: 101, symbol: 'BTCUSDT' },
        price: 100,
        levels: [],
        atrs: { atr1h: null },
        capital: 10,
        rules,
        filters: { tickSize: 0.01, stepSize: 0.001, minQty: 1, minNotional: 1000 },
      }),
    );
    const rows = numberLines(tiny);
    expect(rows.find((row) => row.label === 'Pérdida en el stop')?.value).toBe(
      'el mínimo del contrato no cabe en tu regla',
    );
    expect(rows.find((row) => row.label === 'Cantidad')?.value).toBe('—');
  });
});

describe('niveles, alcance y funding', () => {
  it('lista los niveles entre la entrada y el objetivo con su distancia', () => {
    const lines = levelLines(analysis());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('PDH a 2,00 % (1,0 ATR)');
    expect(lines[1]).toBe('EMA 20 a 4,00 % (2,0 ATR)');
  });

  it('dice en qué horizonte cabe el objetivo', () => {
    // Objetivo a 6 sobre ATR 1h 2 / 4h 4 / 24h 8: cabe en "24h".
    expect(reachText(analysis())).toBe('el objetivo cabe en el rango típico de 24 horas');
    const far = analysis({ target: 140 });
    expect(reachText(far)).toBe('el objetivo queda fuera de los rangos típicos de 1 h, 4 h y 24 h');
    const noAtr = unwrap(
      analyzeDrawing({
        drawing: { id: 'n', side: 'long', entry: 100, stop: 98, target: 104, symbol: 'BTCUSDT' },
        price: 100,
        levels: [],
        atrs: { atr1h: null },
        capital: 1000,
        rules,
      }),
    );
    expect(reachText(noAtr)).toBe('sin datos de ATR para comparar el alcance del objetivo');
  });

  it('el funding dice quién paga y su peso en el riesgo', () => {
    expect(fundingText(analysis())).toContain('lo paga tu lado');
    const short = analysis({ id: 's', side: 'short', stop: 102, target: 94 });
    expect(fundingText(short)).toContain('lo cobra tu lado');
    const noRate = unwrap(
      analyzeDrawing({
        drawing: { id: 'n', side: 'long', entry: 100, stop: 98, target: 104, symbol: 'BTCUSDT' },
        price: 100,
        levels: [],
        atrs: { atr1h: 1 },
        capital: 1000,
        rules,
      }),
    );
    expect(fundingText(noRate)).toBe('sin dato de funding');
  });

  it('no afirma «cada 8 h»: el intervalo de funding depende del contrato', () => {
    const text = fundingText(analysis());
    expect(text).not.toContain('cada 8 h');
    expect(text).toContain('por intervalo de funding');
    expect(text).toContain('% del riesgo por intervalo de funding');
  });
});

describe('ticket y carga al dimensionador', () => {
  it('el ticket copiado lleva lo que pide el contrato y la línea honesta', () => {
    const text = drawingTicketText(analysis());
    expect(text).toContain('DIBUJO · BTCUSDT · Largo');
    expect(text).toContain('Entrada: 100');
    expect(text).toContain('Stop: 98');
    expect(text).toContain('Objetivo: 106');
    expect(text).toContain('R:R: 3');
    expect(text).toContain('Cantidad a tu regla:');
    expect(text).toContain('Pérdida en el stop, con comisiones:');
    expect(text).toContain(DRAWING_HONEST_LINE);
  });

  it('el ticket dice cuándo la entrada sería una orden stop (taker)', () => {
    const text = drawingTicketText(analysis({}, 95));
    expect(text).toContain('Entrada: 100 · stop (taker)');
  });

  it('carga el contrato completo del dimensionador: dirección, precios, riesgo exacto y cantidad', () => {
    const a = analysis({ id: 's', side: 'short', stop: 102, target: 94 });
    const tool = toolFromAnalysis(a);
    // Antes el dibujo cargaba solo { direction, entry, stop }; el panel lo trataba
    // como «La comisión no es válida». Ahora lleva el mismo contrato que la tarjeta.
    expect(tool.load).toMatchObject({
      direction: 'short',
      entry: 100,
      stop: 102,
      quantity: a.size.qty,
      capital: 1000,
      note: FROM_DRAWING_NOTE,
    });
    expect(tool.load.entryFeeRate).toBeGreaterThan(0);
    expect(tool.load.exitFeeRate).toBeGreaterThan(0);
    expect(tool.load.riskUsd).toBe(
      feeInclusiveRiskUsd({
        quantity: a.size.qty,
        entry: 100,
        stop: 102,
        entryFeeRate: tool.load.entryFeeRate,
        exitFeeRate: tool.load.exitFeeRate,
      }),
    );
    expect(tool.load.riskPct).toBe(a.size.lossPct);
    expect(tool.sideLabel).toBe('Corto');
  });

  it('mantiene las severidades de los avisos del análisis', () => {
    const tool = toolFromAnalysis(analysis({ stop: 99.9, target: 100.05 }));
    expect(tool.checks.length).toBeGreaterThan(0);
    expect(tool.checks.some((check) => check.severity === 'warn')).toBe(true);
    expect(tool.checks.every((check) => check.text.length <= 90)).toBe(true);
  });

  it('nunca usa lenguaje de compra o venta ni habla de probabilidad', () => {
    const tool = toolFromAnalysis(analysis());
    const all = [
      tool.summary,
      tool.ticket,
      tool.reach,
      tool.funding,
      tool.honestLine,
      ...tool.levels,
      ...tool.checks.map((c) => c.text),
      ...tool.numbers.map((n) => `${n.label} ${n.value}`),
    ]
      .join(' ')
      .toLowerCase();
    expect(all).not.toContain('comprar');
    expect(all).not.toContain('vender');
    expect(all).not.toMatch(/probabilidad|\d\s?%\s+de\s+acierto/);
  });
});
