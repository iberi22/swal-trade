import { describe, expect, it } from 'vitest';
import type { Candle } from '../types';
import {
  RANGE_LABEL,
  atrWilder,
  bollinger,
  buildLevels,
  computeAtrs,
  ema,
  expectedRange,
  roundNumbers,
  roundStep,
} from './levels';

const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;
const candle = (time: number, open: number, high: number, low: number, close: number): Candle => ({
  time,
  open,
  high,
  low,
  close,
  volume: 1,
});
/** n velas planas: cierre 100, máx 101, mín 99 -> TR = 2 en todas. */
const flat = (n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => candle(1_700_000_000 + i * 3600, 100, 101, 99, 100));

describe('indicadores', () => {
  it('EMA con semilla SMA', () => {
    // semilla (1+2+3)/3 = 2; k = 0,5 -> 3 -> 4
    expect(ema([1, 2, 3, 4, 5], 3)).toBe(4);
    expect(ema([1, 2], 3)).toBeNull();
  });

  it('Bollinger con desviación poblacional', () => {
    // media 5, varianza 4, sd 2
    const bb = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
    expect(bb).toEqual({ mid: 5, upper: 9, lower: 1 });
    expect(bollinger([1, 2, 3], 20)).toBeNull();
  });

  it('ATR de Wilder: 14 TR de 2 y uno de 16 dan (2*13+16)/14 = 3', () => {
    const candles = flat(15);
    expect(atrWilder(candles)).toBe(2);
    candles.push(candle(1_800_000_000, 100, 108, 92, 100)); // TR = 16
    expect(atrWilder(candles)).toBe(3);
    expect(atrWilder(flat(14))).toBeNull();
  });

  it('computeAtrs ignora la vela en curso', () => {
    const h1 = flat(15);
    h1.push(candle(1_800_000_000, 100, 200, 0, 100)); // en curso, enorme
    expect(computeAtrs({ h1 }).atr1h).toBe(2);
    expect(computeAtrs({ h1: flat(15) }).atr1h).toBeNull(); // solo 14 cerradas
    expect(computeAtrs({})).toEqual({ atr1h: null, atr4h: null, atrD: null });
  });
});

describe('números redondos', () => {
  it('paso según la magnitud', () => {
    expect(roundStep(82_977)).toBe(1000);
    expect(roundStep(3_050)).toBe(100);
    expect(roundStep(150)).toBe(10);
    expect(roundStep(12.3)).toBe(1);
    expect(roundStep(0.0041558)).toBeCloseTo(0.0001, 10);
  });

  it('el redondo de abajo y el de arriba', () => {
    expect(roundNumbers(82_977)).toEqual({ below: 82_000, above: 83_000 });
    expect(roundNumbers(82_000)).toEqual({ below: 81_000, above: 83_000 });
    expect(roundNumbers(3_050)).toEqual({ below: 3_000, above: 3_100 });
    expect(roundNumbers(0.0041558)).toEqual({ below: 0.0041, above: 0.0042 });
    expect(roundNumbers(Number.NaN)).toBeNull();
  });
});

describe('buildLevels', () => {
  // ayer: H 120, L 90, C 102 -> P = 312/3 = 104, R1 = 208-90 = 118, S1 = 208-120 = 88
  const d1 = [
    candle(day(2026, 10, 13) - 86_400, 95, 99, 94, 98),
    candle(day(2026, 10, 13), 98, 120, 90, 102),
    candle(day(2026, 10, 14), 100, 106, 99, 101),
  ];
  const base = { price: 101, d1, h1: flat(16) };

  it('escalera ordenada de mayor a menor con distancias', () => {
    const rows = buildLevels(base);
    expect(rows.map((r) => [r.price, r.label])).toEqual([
      [120, 'PDH'],
      [118, 'R1'],
      [110, 'Redondo'],
      [104, 'Pivote'],
      [100, 'Apertura día + Redondo'],
      [90, 'PDL'],
      [88, 'S1'],
    ]);
    const pivot = rows.find((r) => r.label === 'Pivote')!;
    expect(pivot.distancePct).toBeCloseTo((3 / 101) * 100, 10);
    expect(pivot.distanceAtr).toBe(1.5); // ATR 1h = 2
    const open = rows.find((r) => r.kind === 'dayOpen')!;
    expect(open.kinds).toEqual(['dayOpen', 'round']);
    expect(open.distancePct).toBeLessThan(0);
    expect(open.distanceAtr).toBe(-0.5);
  });

  it('funde niveles a menos de 0,1 % con etiquetas unidas', () => {
    const rows = buildLevels({
      ...base,
      findingsLevels: [{ label: 'Doble techo', confirm: 120.05, invalidate: null }],
    });
    const merged = rows.find((r) => r.kinds.includes('prevDayHigh'))!;
    expect(merged.label).toBe('PDH + Confirma · Doble techo');
    expect(merged.kind).toBe('prevDayHigh');
    expect(merged.price).toBeCloseTo(120.025, 10);
    expect(rows.filter((r) => r.price > 119)).toHaveLength(1);
  });

  it('no funde lo que está a más de 0,1 %', () => {
    const rows = buildLevels({
      price: 100,
      findingsLevels: [{ label: 'X', confirm: 105, invalidate: 105.2 }],
    });
    expect(rows.filter((r) => r.price > 104 && r.price < 110)).toHaveLength(2);
  });

  it('máximo 7 por lado, los más cercanos', () => {
    const findingsLevels = Array.from({ length: 10 }, (_, i) => ({
      label: `P${i}`,
      confirm: 130 + i * 10,
      invalidate: null,
    }));
    const rows = buildLevels({ ...base, findingsLevels });
    const above = rows.filter((r) => r.price >= 101);
    expect(above).toHaveLength(7);
    expect(Math.max(...above.map((r) => r.price))).toBeLessThan(200);
    expect(rows.filter((r) => r.price < 101)).toHaveLength(3);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.price).toBeLessThan(rows[i - 1]!.price);
  });

  it('EMA y Bollinger con 60 velas planas se funden en 100', () => {
    const rows = buildLevels({ price: 105, h1: flat(60), h4: flat(60) });
    const at100 = rows.find((r) => Math.abs(r.price - 100) < 0.01)!;
    for (const kind of ['ema20_1h', 'ema50_1h', 'bbUpper', 'bbLower', 'round'] as const) {
      expect(at100.kinds).toContain(kind);
    }
    expect(at100.label).toContain('EMA20 1h');
    expect(at100.label).toContain('BB sup 1h');
  });

  it('apertura del mes desde las velas diarias', () => {
    const rows = buildLevels({
      price: 100,
      d1: [
        candle(day(2026, 10, 1), 95, 99, 94, 98),
        candle(day(2026, 10, 2), 98, 99, 90, 92),
        candle(day(2026, 10, 3), 92, 93, 91, 92),
      ],
    });
    expect(rows.find((r) => r.kinds.includes('monthOpen'))?.price).toBe(95);
  });

  it('semana: apertura y máx/mín de la anterior', () => {
    const rows = buildLevels({
      price: 100,
      w1: [candle(day(2026, 10, 5), 90, 130, 80, 100), candle(day(2026, 10, 12), 101, 108, 97, 104)],
    });
    expect(rows.find((r) => r.kinds.includes('prevWeekHigh'))?.price).toBe(130);
    expect(rows.find((r) => r.kinds.includes('prevWeekLow'))?.price).toBe(80);
    expect(rows.find((r) => r.kinds.includes('weekOpen'))?.price).toBe(101);
  });

  it('sin historia devuelve lo que puede y nunca lanza', () => {
    const rows = buildLevels({ price: 100 });
    expect(rows.map((r) => r.price)).toEqual([110, 90]);
    expect(rows.every((r) => r.distanceAtr === null)).toBe(true);
    expect(buildLevels({ price: Number.NaN })).toEqual([]);
    expect(buildLevels({ price: -5 })).toEqual([]);
    expect(buildLevels({ price: 100, d1: [candle(1, Number.NaN, Number.NaN, Number.NaN, Number.NaN)] }).length).toBe(2);
    expect(() => buildLevels({ price: 100, d1: [], w1: [], h1: [], h4: [] })).not.toThrow();
  });
});

describe('expectedRange', () => {
  it('±1 ATR por horizonte, en precio y en %', () => {
    const rows = expectedRange({ price: 100, atr1h: 2, atr4h: 4, atrD: 10 });
    expect(rows.map((r) => [r.id, r.low, r.high, r.pct])).toEqual([
      ['1h', 98, 102, 2],
      ['4h', 96, 104, 4],
      ['24h', 90, 110, 10],
    ]);
    expect(rows.every((r) => r.label === RANGE_LABEL)).toBe(true);
  });

  it('omite los horizontes sin ATR', () => {
    expect(expectedRange({ price: 100, atr1h: null, atr4h: 4 }).map((r) => r.id)).toEqual(['4h']);
    expect(expectedRange({ price: 0, atr1h: 2 })).toEqual([]);
  });
});
