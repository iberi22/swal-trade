import { describe, expect, it } from 'vitest';
import type { LevelRow } from '../context/levels';
import type { RulesSettings } from '../settings';
import { DRAWING_HONEST_LINE, analyzeDrawing } from './analyze';
import {
  DRAWING_EMPTY_HINT,
  DRAWING_MAX_SHOWN,
  DRAWING_OFF_TEXT,
  buildDrawingCardModel,
  drawingTicketText,
  fundingText,
  levelLines,
  numberLines,
  reachText,
  toolFromAnalysis,
} from './card-model';
import type { DrawingAnalysis, PositionDrawing } from './types';

const rules: RulesSettings = { maxRiskPct: 1, maxLeverage: 10, dailyLossUsd: 10, revengeMinutes: 15 };

const level = (price: number, label: string): LevelRow => ({
  price,
  kind: 'ema20_1h',
  kinds: ['ema20_1h'],
  label,
  distancePct: 0,
  distanceAtr: null,
});

function analysis(over: Partial<PositionDrawing> = {}, price = 100): DrawingAnalysis {
  const drawing: PositionDrawing = {
    id: 'tv-1',
    side: 'long',
    entry: 100,
    stop: 98,
    target: 106,
    symbol: 'BTCUSDT',
    ...over,
  };
  return analyzeDrawing({
    drawing,
    price,
    levels: [level(102, 'PDH'), level(104, 'EMA 20')],
    atrs: { atr1h: 2, atr4h: 4, atrD: 8 },
    capital: 1000,
    rules,
    filters: { tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 100 },
    fundingRatePct8h: 0.01,
  });
}

describe('buildDrawingCardModel', () => {
  it('con el ajuste apagado devuelve la línea de lectura y nada más', () => {
    const model = buildDrawingCardModel({ enabled: false, symbol: 'BTCUSDT', analyses: [analysis()] });
    expect(model).toEqual({ state: 'off', text: DRAWING_OFF_TEXT });
  });

  it('encendido y sin dibujos para el símbolo devuelve la pista de la pestaña', () => {
    expect(buildDrawingCardModel({ enabled: true, symbol: 'BTCUSDT', analyses: [] })).toEqual({
      state: 'empty',
      hint: DRAWING_EMPTY_HINT,
    });
    const other = buildDrawingCardModel({
      enabled: true,
      symbol: 'ETHUSDT',
      analyses: [analysis()],
    });
    expect(other.state).toBe('empty');
  });

  it('enseña como mucho dos y empieza por la última dibujada', () => {
    const analyses = [
      analysis({ id: 'a' }),
      analysis({ id: 'b' }),
      analysis({ id: 'c', entry: 200, stop: 196, target: 212 }),
    ];
    const model = buildDrawingCardModel({ enabled: true, symbol: 'btcusdt', analyses });
    expect(model.state).toBe('ready');
    if (model.state !== 'ready') return;
    expect(model.tools).toHaveLength(DRAWING_MAX_SHOWN);
    expect(model.tools.map((t) => t.id)).toEqual(['c', 'b']);
  });

  it('la pista depende del símbolo, no del resto del almacén', () => {
    const model = buildDrawingCardModel({
      enabled: true,
      symbol: 'ETHUSDT',
      analyses: [analysis(), analysis({ id: 'eth', symbol: 'ETHUSDT' })],
    });
    expect(model.state).toBe('ready');
    if (model.state !== 'ready') return;
    expect(model.tools.map((t) => t.id)).toEqual(['eth']);
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

  it('marca la entrada como límite cuando está lejos del precio', () => {
    const rows = numberLines(analysis({}, 120));
    expect(rows.find((row) => row.label === 'Entrada')?.value).toContain('límite');
  });

  it('avisa cuando el mínimo del contrato no cabe en la regla', () => {
    const tiny = analyzeDrawing({
      drawing: { id: 'x', side: 'long', entry: 100, stop: 99.9, target: 101, symbol: 'BTCUSDT' },
      price: 100,
      levels: [],
      atrs: { atr1h: null },
      capital: 10,
      rules,
      filters: { tickSize: 0.01, stepSize: 0.001, minQty: 1, minNotional: 1000 },
    });
    const rows = numberLines(tiny);
    expect(rows.find((row) => row.label === 'Pérdida a tu regla')?.value).toBe(
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
    const noAtr = analyzeDrawing({
      drawing: { id: 'n', side: 'long', entry: 100, stop: 98, target: 104, symbol: 'BTCUSDT' },
      price: 100,
      levels: [],
      atrs: { atr1h: null },
      capital: 1000,
      rules,
    });
    expect(reachText(noAtr)).toBe('sin datos de ATR para comparar el alcance del objetivo');
  });

  it('el funding dice quién paga y su peso en el riesgo', () => {
    expect(fundingText(analysis())).toContain('lo paga tu lado');
    const short = analysis({ id: 's', side: 'short', stop: 102, target: 94 });
    expect(fundingText(short)).toContain('lo cobra tu lado');
    const noRate = analyzeDrawing({
      drawing: { id: 'n', side: 'long', entry: 100, stop: 98, target: 104, symbol: 'BTCUSDT' },
      price: 100,
      levels: [],
      atrs: { atr1h: 1 },
      capital: 1000,
      rules,
    });
    expect(fundingText(noRate)).toBe('sin dato de funding');
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
    expect(text).toContain('Pérdida en el stop:');
    expect(text).toContain(DRAWING_HONEST_LINE);
  });

  it('carga dirección, entrada y stop en el dimensionador', () => {
    const tool = toolFromAnalysis(analysis({ id: 's', side: 'short', stop: 102, target: 94 }));
    expect(tool.load).toEqual({ direction: 'short', entry: 100, stop: 102 });
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
