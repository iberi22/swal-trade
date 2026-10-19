/**
 * Contrato COMPARTIDO del puente al dimensionador.
 *
 * Las dos fuentes (tarjeta de operación y dibujo del gráfico) publican el mismo
 * `SizingLoad` y pasan por la misma puerta (`parseSizingLoad`) antes de que
 * `SizingCard` enseñe nada. Estas pruebas recorren los DOS productores: si uno
 * deja de emitir un campo, esto falla aunque su propia prueba siga verde.
 */
import { describe, expect, it } from 'vitest';
import type { LevelRow } from '../context/levels';
import { DEFAULT_SETTINGS } from '../settings';
import { analyzeDrawing } from '../drawing/analyze';
import { sizingLoadFromDrawing } from '../drawing/card-model';
import type { PositionDrawing } from '../drawing/types';
import {
  FROM_CARD_NOTE,
  FROM_DRAWING_NOTE,
  exactSizingFromLoad,
  parseSizingLoad,
  sizingLoadFromTicket,
  type SizingLoad,
} from './sizing-bridge';
import { buildTicket } from './ticket';
import type { TradeCardPreset } from './types';

const rules = { ...DEFAULT_SETTINGS.rules, maxRiskPct: 1, maxLeverage: 10, dailyLossUsd: 1000 };
const row = (price: number, kind: LevelRow['kind'], label = kind as string): LevelRow => ({
  price,
  kind,
  kinds: [kind],
  label,
  distancePct: 0,
  distanceAtr: null,
});
const marketPreset = (over: Partial<TradeCardPreset> = {}): TradeCardPreset => ({
  id: 't', name: 'Prueba', side: 'long', entry: { kind: 'market' },
  stop: { kind: 'pct', pct: 1 }, tp: { rMultiples: [1, 2], useNextLevel: false },
  size: { basis: 'risk', pct: 1 }, leverage: 'min', ...over,
});

/** Productor 1: una tarjeta de operación ya calculada. */
function cardProducer(preset: TradeCardPreset = marketPreset()): SizingLoad {
  const result = buildTicket({
    symbol: 'BTCUSDT', price: 100, levels: [], atrs: { atr1h: 2 }, capital: 1000, rules, preset,
  });
  if (!result.ok) throw new Error(result.reason);
  return sizingLoadFromTicket(result.ticket);
}

/** Productor 2: un dibujo del gráfico. */
function drawingProducer(over: Partial<PositionDrawing> = {}): SizingLoad {
  const drawing: PositionDrawing = { id: 'tv-1', side: 'long', entry: 100, stop: 98, target: 106, symbol: 'BTCUSDT', ...over };
  const result = analyzeDrawing({
    drawing,
    price: 100,
    levels: [],
    atrs: { atr1h: 2, atr4h: 4, atrD: 8 },
    capital: 1000,
    rules,
    filters: { tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 100 },
    fundingRatePct8h: 0.01,
  });
  if (!result.ok) throw new Error(result.reason);
  return sizingLoadFromDrawing(result.analysis);
}

const unchanged = (load: SizingLoad) => ({
  entryStr: String(load.entry),
  stopStr: String(load.stop),
  direction: load.direction,
  capital: load.capital,
});

describe('contrato compartido del dimensionador', () => {
  it('los dos productores pasan la misma puerta y conservan su carga exacta', () => {
    for (const [label, load] of [
      ['tarjeta', cardProducer()],
      ['dibujo', drawingProducer()],
    ] as const) {
      const parsed = parseSizingLoad(load);
      expect(parsed, label).not.toBeNull();
      expect(parsed).toEqual(load);
      // La cifra que enseña el panel es la EXACTA del productor, no una recomputada.
      expect(exactSizingFromLoad(parsed as SizingLoad, unchanged(parsed as SizingLoad)), label).toEqual({
        quantity: load.quantity,
        lossUsd: load.riskUsd,
      });
    }
  });

  it('cada productor firma su procedencia con su propia nota', () => {
    expect(parseSizingLoad(cardProducer())?.note).toBe(FROM_CARD_NOTE);
    expect(parseSizingLoad(drawingProducer())?.note).toBe(FROM_DRAWING_NOTE);
  });

  it('el dibujo corto y la tarjeta corta comparten la forma del payload', () => {
    const short = drawingProducer({ id: 's', side: 'short', stop: 102, target: 94 });
    expect(short.direction).toBe('short');
    // El stop corto tiene que quedar por encima de la entrada, o la puerta lo tira.
    expect(parseSizingLoad(short)).not.toBeNull();
    // Corto con stop por DEBAJO de la entrada: la puerta lo tira sin que el análisis lo produzca.
    expect(parseSizingLoad({ ...short, stop: 96 })).toBeNull();
  });

  it('tira un payload sin nota, sin tarifas, con el stop del lado equivocado o incoherente', () => {
    const good = cardProducer();
    expect(parseSizingLoad(undefined)).toBeNull();
    expect(parseSizingLoad(null)).toBeNull();
    expect(parseSizingLoad('texto')).toBeNull();
    expect(parseSizingLoad([])).toBeNull();
    expect(parseSizingLoad({ ...good, direction: 'arriba' })).toBeNull();
    expect(parseSizingLoad({ ...good, note: '' })).toBeNull();
    expect(parseSizingLoad({ ...good, note: '   ' })).toBeNull();
    expect(parseSizingLoad({ ...good, capital: 0 })).toBeNull();
    expect(parseSizingLoad({ ...good, entry: Number.NaN })).toBeNull();
    expect(parseSizingLoad({ ...good, riskPct: -1 })).toBeNull();
    expect(parseSizingLoad({ ...good, entryFeeRate: -0.001 })).toBeNull();
    expect(parseSizingLoad({ ...good, entryFeeRate: 'x' })).toBeNull();
    // Long con stop por encima de la entrada.
    expect(parseSizingLoad({ ...good, stop: 101 })).toBeNull();
    // Tranquillas inválidas: más de cuatro o precios no positivos.
    expect(parseSizingLoad({ ...good, tranches: [1, 2, 3, 4, 5] })).toBeNull();
    expect(parseSizingLoad({ ...good, tranches: [0] })).toBeNull();
    // Hasta cuatro tramos válidos sí pasan.
    expect(parseSizingLoad({ ...good, tranches: [99, 98, 97, 96] })?.tranches).toEqual([99, 98, 97, 96]);
  });

  it('deja de enseñar la cifra exacta en cuanto cambia un campo del panel', () => {
    const load = parseSizingLoad(cardProducer()) as SizingLoad;
    expect(exactSizingFromLoad(load, unchanged(load))).not.toBeNull();
    expect(exactSizingFromLoad(load, { ...unchanged(load), entryStr: '100.5' })).toBeNull();
    expect(exactSizingFromLoad(load, { ...unchanged(load), stopStr: '98.5' })).toBeNull();
    expect(exactSizingFromLoad(load, { ...unchanged(load), direction: 'short' })).toBeNull();
    expect(exactSizingFromLoad(load, { ...unchanged(load), capital: 2000 })).toBeNull();
  });
});
