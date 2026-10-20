import { describe, expect, it } from 'vitest';
import type { LevelKind, LevelRow } from '../context/levels';
import type { RulesSettings } from '../settings';
import { analyzeDrawing, DRAWING_HONEST_LINE, MAX_CHECKS, TINY_STOP_PCT } from './analyze';
import type { AnalyzeDrawingInput, DrawingSide } from './types';

const rules: RulesSettings = {
  maxRiskPct: 1,
  maxLeverage: 10,
  dailyLossUsd: 10,
  revengeMinutes: 15,
};

const level = (price: number, label = 'Nivel', kind: LevelKind = 'ema20_1h'): LevelRow => ({
  price,
  kind,
  kinds: [kind],
  label,
  distancePct: 0,
  distanceAtr: null,
});

function run(over: Partial<AnalyzeDrawingInput> = {}, side: DrawingSide = 'long') {
  const drawing =
    over.drawing ??
    ({
      id: 'd1',
      side,
      entry: 100,
      stop: side === 'long' ? 98 : 102,
      target: side === 'long' ? 104 : 96,
      symbol: 'BTCUSDT',
    } as const);
  const result = analyzeDrawing({
    drawing,
    price: 100,
    levels: [],
    atrs: { atr1h: 1.25, atr4h: 2.5, atrD: 5 },
    capital: 1000,
    rules,
    ...over,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.analysis;
}

describe('analyzeDrawing · geometría', () => {
  it('calcula riesgo, recompensa y R:R de un largo (100 / 98 / 104)', () => {
    const a = run();
    expect(a.geometry.riskPct).toBe(2);
    expect(a.geometry.rewardPct).toBe(4);
    expect(a.geometry.rr).toBe(2);
    expect(a.geometry.stopAtr1h).toBe(1.6); // 2 / 1,25
    expect(a.geometry.targetAtr1h).toBe(3.2); // 4 / 1,25
    expect(a.geometry.entryDistancePct).toBe(0);
    expect(a.geometry.entryMode).toBe('mercado');
    expect(a.side).toBe('long');
    expect(a.symbol).toBe('BTCUSDT');
  });

  it('calcula el mismo R:R en un corto (100 / 102 / 96)', () => {
    const a = run({}, 'short');
    expect(a.geometry.riskPct).toBe(2);
    expect(a.geometry.rewardPct).toBe(4);
    expect(a.geometry.rr).toBe(2);
    expect(a.geometry.stopAtr1h).toBe(1.6);
    expect(a.side).toBe('short');
  });

  it('marca entrada límite cuando el precio está a más del 0,05 % y la entrada reposa del lado correcto', () => {
    const a = run({ price: 110 });
    expect(a.geometry.entryDistancePct).toBeCloseTo(-9.0909, 4);
    expect(a.geometry.entryMode).toBe('límite');
  });

  it('trata como stop (taker) una entrada por encima del precio en un largo', () => {
    // Largo con entrada 110 y precio 100: al enviarla cruzaría, sería una orden stop.
    const a = run({
      price: 100,
      drawing: { id: 'd', side: 'long', entry: 110, stop: 108, target: 114, symbol: 'BTCUSDT' },
    });
    expect(a.geometry.entryDistancePct).toBe(10);
    expect(a.geometry.entryMode).toBe('stop');
    expect(a.costs.entryFeePct).toBe(0.05); // taker, no maker
    const check = a.checks.find((c) => c.code === 'entry_stop');
    expect(check?.severity).toBe('info');
    expect(check?.text).toBe('entrada por encima del precio: sería una orden stop, comisión taker');
  });

  it('trata como stop (taker) una entrada por debajo del precio en un corto', () => {
    const a = run(
      {
        price: 100,
        drawing: { id: 'd', side: 'short', entry: 90, stop: 92, target: 86, symbol: 'BTCUSDT' },
      },
      'short',
    );
    expect(a.geometry.entryDistancePct).toBe(-10);
    expect(a.geometry.entryMode).toBe('stop');
    expect(a.costs.entryFeePct).toBe(0.05);
    expect(a.checks.find((c) => c.code === 'entry_stop')?.text).toContain('por debajo del precio');
  });

  it('mantiene entrada de mercado justo en el límite del 0,05 %', () => {
    const a = run({ price: 100.05 });
    expect(a.geometry.entryDistancePct).toBe(-0.05);
    expect(a.geometry.entryMode).toBe('mercado');
  });
});

describe('analyzeDrawing · costes', () => {
  it('cobra maker 0,02 % en límite + taker 0,05 % de salida y calcula el R:R neto', () => {
    const a = run({ price: 110 }); // límite -> 0,02 + 0,05 = 0,07 %
    expect(a.costs.entryFeePct).toBe(0.02);
    expect(a.costs.exitFeePct).toBe(0.05);
    expect(a.costs.totalFeePct).toBe(0.07);
    expect(a.costs.feeShareOfRisk).toBe(3.5); // 0,07 / 2 %
    expect(a.costs.netRr).toBe(1.9); // (4 - 0,07) / (2 + 0,07)
    expect(a.summary).toContain('R:R 2,0 (1,9 neto)');
  });

  it('cobra taker 0,05 % en entrada de mercado + 0,05 % de salida', () => {
    const a = run(); // mercado -> 0,05 + 0,05 = 0,10 %
    expect(a.costs.entryFeePct).toBe(0.05);
    expect(a.costs.totalFeePct).toBe(0.1);
    expect(a.costs.feeShareOfRisk).toBe(5); // 0,10 / 2 %
    expect(a.costs.netRr).toBe(1.86); // (4 - 0,10) / (2 + 0,10)
  });

  it('avisa cuando las comisiones pasan del 10 % del riesgo', () => {
    const a = run({
      drawing: { id: 'd', side: 'long', entry: 100, stop: 99.5, target: 104, symbol: 'BTCUSDT' },
    });
    const check = a.checks.find((c) => c.code === 'fees_eat_risk');
    expect(check?.severity).toBe('warn');
    expect(check?.text).toContain('las comisiones se comen');
    expect(check?.text).toContain('% del riesgo');
  });

  it('avisa de un stop menor al 0,3 % con el texto de costes medido', () => {
    const a = run({
      drawing: { id: 'd', side: 'long', entry: 100, stop: 99.8, target: 104, symbol: 'BTCUSDT' },
    });
    expect(a.geometry.riskPct).toBe(0.2);
    expect(a.geometry.riskPct).toBeLessThan(TINY_STOP_PCT);
    const check = a.checks.find((c) => c.code === 'tiny_stop');
    expect(check?.severity).toBe('warn');
    expect(check?.text).toBe('stop menor a 0,3 %: en nuestra medición, los costes se comen esos stops');
  });
});

describe('analyzeDrawing · tamaño al riesgo de la regla', () => {
  it('usa maxRiskPct del capital con comisiones y deja la cantidad a toda precisión (sin redondear)', () => {
    const a = run();
    expect(a.size.riskUsd).toBe(10); // 1 % de 1.000
    // 10 / (2 + 0,05 + 0,049) con taker/taker, SIN redondear hacia arriba.
    expect(a.size.qty).toBe(4.76417341);
    expect(a.size.notionalUsd).toBe(476.42);
    expect(a.size.minLeverage).toBe(1);
    expect(a.size.marginUsd).toBe(476.42);
    // La pérdida con comisiones no supera el presupuesto y se RECORTA hacia
    // abajo: la real es 9,999999… (no se sube a 10,00).
    expect(a.size.lossUsd).toBe(9.99);
    expect(a.size.lossUsd).toBeLessThanOrEqual(10);
    expect(a.size.lossPct).toBe(0.999);
    expect(a.size.lossIncludesFees).toBe(true);
  });

  it('no supera el presupuesto de riesgo al incluir comisiones (1000 / 100 / 99, 1 %)', () => {
    // Escenario del juez: qty sin comisiones sería 10 y la pérdida real ~10,5.
    const a = run({
      drawing: { id: 'd', side: 'long', entry: 100, stop: 99, target: 104, symbol: 'BTCUSDT' },
      filters: { stepSize: 0.001 },
    });
    expect(a.size.qty).toBe(9.095); // 10 / (1 + 0,05 + 0,0495)
    expect(a.size.lossUsd).toBeLessThanOrEqual(10);
    expect(a.size.lossUsd).toBeGreaterThan(9.9);
    expect(a.size.lossIncludesFees).toBe(true);
  });

  it('respeta el stepSize sin inflar el riesgo', () => {
    const a = run({ filters: { stepSize: 0.1 } });
    expect(a.size.qty).toBe(4.7);
    const b = run({ filters: { stepSize: 3 } });
    expect(b.size.qty).toBe(3); // floor(4,7619 / 3) * 3
    expect(b.size.lossUsd).toBe(6.29); // 3 * (2 + 0,05 + 0,049) = 6,297, recortado
  });

  it('devuelve tamaño 0 si el mínimo del contrato obligaría a arriesgar más', () => {
    const a = run({ filters: { stepSize: 10 } });
    expect(a.size.qty).toBe(0);
    expect(a.size.lossUsd).toBe(0);
  });

  it('avisa si el tamaño rompe el apalancamiento máximo o la pérdida diaria', () => {
    const lev = run({ rules: { ...rules, maxRiskPct: 5, maxLeverage: 2 } });
    expect(lev.size.minLeverage).toBe(3); // 2.500 / 1.000
    expect(lev.rules.maxLeverageBreached).toBe(true);
    expect(lev.checks.find((c) => c.code === 'leverage_breach')?.severity).toBe('warn');

    const daily = run({ rules: { ...rules, dailyLossUsd: 5 } });
    expect(daily.rules.dailyLossBreached).toBe(true);
    expect(daily.checks.find((c) => c.code === 'daily_loss_breach')?.severity).toBe('warn');
  });
});

describe('analyzeDrawing · geometría inválida', () => {
  it('rechaza un largo con el stop por encima de la entrada: sin R:R ni tamaño', () => {
    const result = analyzeDrawing({
      drawing: { id: 'bad', side: 'long', entry: 100, stop: 101, target: 102, symbol: 'BTCUSDT' },
      price: 100,
      levels: [],
      atrs: { atr1h: 1.25 },
      capital: 1000,
      rules,
    });
    expect(result).toEqual({ ok: false, reason: 'wrong_order' });
    expect(result).not.toHaveProperty('analysis');
  });

  it('rechaza números no positivos sin lanzar', () => {
    const result = analyzeDrawing({
      drawing: { id: 'bad', side: 'long', entry: 0, stop: -1, target: 102, symbol: 'BTCUSDT' },
      price: 100,
      levels: [],
      atrs: { atr1h: 1.25 },
      capital: 1000,
      rules,
    });
    expect(result).toEqual({ ok: false, reason: 'non_positive_numbers' });
  });
});

describe('analyzeDrawing · niveles', () => {
  const levels = [
    level(103.5, 'EMA20 1h'),
    level(101.5, 'Pivote', 'pivot'),
    level(102, 'Apertura día', 'dayOpen'),
    level(98.3, 'PDL', 'prevDayLow'),
    level(97, 'PWL', 'prevWeekLow'),
    level(104.1, 'PDH', 'prevDayHigh'),
  ];

  it('lista los niveles entre entrada y objetivo ordenados por distancia', () => {
    const a = run({ levels });
    expect(a.levels.betweenEntryAndTarget.map((l) => l.label)).toEqual([
      'Pivote',
      'Apertura día',
      'EMA20 1h',
    ]);
    expect(a.levels.betweenEntryAndTarget.map((l) => l.price)).toEqual([101.5, 102, 103.5]);
    expect(a.levels.betweenEntryAndTarget[0]?.distancePctFromEntry).toBe(1.5);
    expect(a.levels.betweenEntryAndTarget[0]?.distanceAtrFromEntry).toBe(1.2); // 1,5 / 1,25
    expect(a.summary).toContain('cruza 3 niveles');
  });

  it('detecta niveles pegados al stop (≤ 0,3 ATR) y el más cercano al otro lado', () => {
    const a = run({ levels });
    expect(a.levels.nearStop.map((l) => l.label)).toEqual(['PDL']); // 98,3 está a 0,3 del stop 98
    expect(a.checks.find((c) => c.code === 'stop_near_level')?.text).toBe(
      'stop pegado a un nivel visible: muchos traders ponen stops ahí',
    );
    expect(a.levels.beyondStop?.label).toBe('PWL');
    expect(a.levels.beyondStop?.price).toBe(97);
  });

  it('marca el objetivo justo antes o después de un nivel según el lado', () => {
    const long = run({ levels: [level(104.1, 'PDH', 'prevDayHigh')] });
    expect(long.levels.targetNearLevel?.label).toBe('PDH');
    expect(long.levels.targetNearLevelSide).toBe('before'); // el nivel queda por encima

    const longAfter = run({ levels: [level(103.9, 'PDH', 'prevDayHigh')] });
    expect(longAfter.levels.targetNearLevelSide).toBe('after'); // el nivel queda por debajo

    const short = run({ levels: [level(95.9, 'PDL', 'prevDayLow')] }, 'short');
    expect(short.levels.targetNearLevel?.label).toBe('PDL');
    expect(short.levels.targetNearLevelSide).toBe('before'); // en corto, 96 se alcanza antes que 95,9

    const shortAfter = run({ levels: [level(96.1, 'PDL', 'prevDayLow')] }, 'short');
    expect(shortAfter.levels.targetNearLevelSide).toBe('after');
  });
});

describe('analyzeDrawing · alcance y funding', () => {
  it('compara el objetivo con el rango típico y elige el horizonte más pequeño', () => {
    const a = run();
    expect(a.reach.targetAtr4h).toBe(1.6); // 4 / 2,5
    expect(a.reach.targetAtrD).toBe(0.8); // 4 / 5
    expect(a.reach.smallestHorizon).toBe('24h'); // 4 > 2,5 y <= 5
    expect(a.checks.find((c) => c.code === 'target_vs_4h')?.text).toBe(
      'el objetivo pide 1,6 veces el rango típico de 4 h',
    );

    const intraday = run({
      drawing: { id: 'd', side: 'long', entry: 100, stop: 98, target: 102, symbol: 'BTCUSDT' },
    });
    expect(intraday.reach.smallestHorizon).toBe('4h'); // 2 <= 2,5
  });

  it('cobra funding al largo cuando el tipo es positivo y al corto cuando es negativo', () => {
    const long = run({ fundingRatePct8h: 0.01 });
    expect(long.funding.ratePct8h).toBe(0.01);
    expect(long.funding.sidePays).toBe(true);
    expect(long.funding.pctOfRiskPer8h).toBe(0.5); // 0,01 / 2 % * 100

    const shortPositive = run({ fundingRatePct8h: 0.01 }, 'short');
    expect(shortPositive.funding.sidePays).toBe(false);
    expect(shortPositive.funding.pctOfRiskPer8h).toBe(-0.5);

    const shortNegative = run({ fundingRatePct8h: -0.01 }, 'short');
    expect(shortNegative.funding.sidePays).toBe(true);
    expect(shortNegative.funding.pctOfRiskPer8h).toBe(0.5);
  });
});

describe('analyzeDrawing · contrato de texto', () => {
  it('limita los checks a 8, con textos de 90 caracteres como máximo', () => {
    const a = run({
      drawing: { id: 'd', side: 'long', entry: 100, stop: 99.8, target: 104, symbol: 'BTCUSDT' },
      atrs: { atr1h: 1.25, atr4h: 0.1, atrD: 0.1 },
      levels: [level(99.9), level(104.05)],
      rules: { ...rules, maxRiskPct: 5, maxLeverage: 1, dailyLossUsd: 1 },
    });
    expect(a.checks.length).toBeLessThanOrEqual(MAX_CHECKS);
    expect(a.checks.length).toBe(8);
    for (const check of a.checks) {
      expect(check.text.length).toBeLessThanOrEqual(90);
      expect(check.severity === 'info' || check.severity === 'warn').toBe(true);
    }
    expect(a.summary.length).toBeLessThanOrEqual(110);
  });

  it('no usa lenguaje de recomendación ni probabilidades', () => {
    const text = JSON.stringify(run({ levels: [level(101), level(98.2), level(97)] })).toLowerCase();
    expect(text).not.toContain('comprar');
    expect(text).not.toContain('vender');
    expect(text).not.toContain('garantiz');
    expect(text).not.toContain('probabilidad');
  });

  it('exporta la línea honesta exacta', () => {
    expect(DRAWING_HONEST_LINE).toBe(
      'Lectura de geometría y costes, no una predicción: ningún nivel ni R:R tiene ventaja medida.',
    );
  });
});
