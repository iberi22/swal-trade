import { describe, expect, it } from 'vitest';
import type { Candle } from '../types';
import { RANGE_LABEL, buildLevels } from '../context/levels';
import { findingOneLiner } from '../findings-view';
import { entryById, termsInText } from './entries';

const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;
const candle = (time: number, open: number, high: number, low: number, close: number): Candle => ({
  time,
  open,
  high,
  low,
  close,
  volume: 1,
});
const flat = (n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => candle(1_700_000_000 + i * 3600, 100, 101, 99, 100));

/** Lo que queda del texto al quitar los términos: solo separadores. */
function leftover(text: string, matches: ReadonlyArray<{ start: number; end: number }>): string {
  let out = '';
  let at = 0;
  for (const match of matches) {
    out += text.slice(at, match.start);
    at = match.end;
  }
  out += text.slice(at);
  return out;
}

function expectIds(text: string, ids: string[]): void {
  const matches = termsInText(text);
  expect(matches.map((match) => match.id), text).toEqual(ids);
  for (const match of matches) {
    expect(entryById(match.id), `${text}: ${match.id}`).toBeDefined();
    expect(text.slice(match.start, match.end)).toBe(match.text);
  }
  // Ninguna palabra del texto queda sin enlazar (solo números y separadores).
  expect(leftover(text, matches), text).not.toMatch(/\p{L}/u);
}

describe('etiquetas reales del mapa de niveles', () => {
  const d1 = [
    candle(day(2026, 10, 13) - 86_400, 95, 99, 94, 98),
    candle(day(2026, 10, 13), 98, 120, 90, 102),
    candle(day(2026, 10, 14), 100, 106, 99, 101),
  ];
  const rows = buildLevels({ price: 101, d1, h1: flat(16) });

  it('cada fila de la escalera se reconoce como término', () => {
    for (const row of rows) {
      const matches = termsInText(row.label);
      expect(matches.length, row.label).toBeGreaterThan(0);
      expect(leftover(row.label, matches), row.label).toMatch(/^[\s+·,–—/-]*$/);
    }
    expectIds('PDH', ['prevDayHigh']);
    expectIds('R1', ['r1']);
    expectIds('S1', ['s1']);
    expectIds('Pivote', ['pivot']);
    expectIds('Apertura día + Redondo', ['dayOpen', 'round']);
  });

  it('las etiquetas fundidas conservan sus dos términos', () => {
    const merged = buildLevels({
      price: 101,
      d1,
      h1: flat(16),
      findingsLevels: [{ label: 'Doble techo', confirm: 120.05, invalidate: null }],
    }).find((row) => row.kinds.includes('prevDayHigh'))!;
    expect(merged.label).toBe('PDH + Confirma · Doble techo');
    expectIds(merged.label, ['prevDayHigh', 'confirm', 'double_top']);
  });

  it('el rango típico es una entrada del glosario', () => {
    expectIds(RANGE_LABEL, ['expected_range']);
  });
});

describe('etiquetas de la banda de contexto', () => {
  it('sentimiento y cierres', () => {
    const labels: Array<[string, string[]]> = [
      ['Miedo/Codicia', ['fear_greed']],
      ['Miedo extremo', ['fear_greed']],
      ['Funding 8h', ['funding']],
      ['Funding', ['funding']],
      ['Basis', ['basis']],
      ['24h', ['change_24h']],
      ['Titulares', ['news']],
      ['Régimen', ['regime']],
      ['Vela 15m', ['close_15m']],
      ['Cierre 1h', ['close_1h']],
      ['Cierre 4h', ['close_4h']],
      ['Cierre diario', ['close_daily']],
      ['Cierre semanal', ['close_weekly']],
      ['Cierre mensual', ['close_monthly']],
      ['Apertura Asia', ['session_asia']],
      ['Apertura Europa', ['session_europe']],
      ['Apertura EE.UU.', ['session_us']],
    ];
    for (const [label, ids] of labels) expectIds(label, ids);
  });
});

describe('etiquetas de pulso y hallazgos', () => {
  it('tarjetas de MarketPulse', () => {
    expectIds('Muros del libro', ['order_book_walls']);
    expectIds('Liquidaciones recientes', ['liquidations']);
    expectIds('Miedo y codicia', ['fear_greed']);
    expectIds('Régimen', ['regime']);
    expectIds('Precio medio', ['spread']);
  });

  it('la línea corta de un hallazgo también se enlaza', () => {
    expectIds(findingOneLiner('Doble techo', 62), ['double_top', 'strength']);
    expectIds('Zona de resistencia', ['sr_zone']);
    expectIds('R1 + Invalida · Zona de resistencia', ['r1', 'invalidate', 'sr_zone']);
    expectIds('PDH + EMA50 4h', ['prevDayHigh', 'ema50_4h']);
  });
});
