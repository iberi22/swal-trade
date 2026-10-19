import { describe, expect, it } from 'vitest';
import { bandCloses, formatRemaining, isImminent, nextCloses, type CloseItem } from './closes';

type Id = 'c15m' | 'c1h' | 'c4h' | 'diario' | 'semanal' | 'mensual' | 'funding' | 'open-asia' | 'open-europa' | 'open-eeuu';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);
const byId = (now: number, offset = 0, opts = {}) =>
  Object.fromEntries(nextCloses(now, offset, opts).map((item) => [item.id, item])) as Record<Id, CloseItem>;

describe('nextCloses', () => {
  it('calcula las rejillas UTC a mitad de periodo', () => {
    // miércoles 2026-10-14 10:07:30 UTC
    const now = utc(2026, 10, 14, 10, 7, 30);
    const items = byId(now);
    expect(items.c15m.atMs).toBe(utc(2026, 10, 14, 10, 15));
    expect(items.c1h.atMs).toBe(utc(2026, 10, 14, 11));
    expect(items.c4h.atMs).toBe(utc(2026, 10, 14, 12));
    expect(items.diario.atMs).toBe(utc(2026, 10, 15));
    expect(items.semanal.atMs).toBe(utc(2026, 10, 19));
    expect(items.mensual.atMs).toBe(utc(2026, 11, 1));
    expect(items.c15m.remainingMs).toBe(7 * 60_000 + 30_000);
  });

  it('exactamente en un cierre, el próximo es el siguiente', () => {
    const now = utc(2026, 10, 14, 12);
    const items = byId(now);
    expect(items.c15m.atMs).toBe(utc(2026, 10, 14, 12, 15));
    expect(items.c1h.atMs).toBe(utc(2026, 10, 14, 13));
    expect(items.c4h.atMs).toBe(utc(2026, 10, 14, 16));
    expect(items.diario.atMs).toBe(utc(2026, 10, 15));
  });

  it('domingo pasa a lunes y el lunes 00:00 exacto salta una semana', () => {
    expect(byId(utc(2026, 10, 18, 23, 59)).semanal.atMs).toBe(utc(2026, 10, 19)); // domingo
    expect(byId(utc(2026, 10, 19, 0, 0)).semanal.atMs).toBe(utc(2026, 10, 26)); // lunes 00:00
    expect(byId(utc(2026, 10, 19, 0, 0, 1)).semanal.atMs).toBe(utc(2026, 10, 26));
    expect(byId(utc(2026, 10, 24, 12)).semanal.atMs).toBe(utc(2026, 10, 26)); // sábado
  });

  it('cambio de mes y de año', () => {
    expect(byId(utc(2026, 1, 31, 23, 59)).mensual.atMs).toBe(utc(2026, 2, 1));
    expect(byId(utc(2026, 2, 28, 12)).mensual.atMs).toBe(utc(2026, 3, 1));
    expect(byId(utc(2028, 2, 29, 12)).mensual.atMs).toBe(utc(2028, 3, 1)); // bisiesto
    const dec = byId(utc(2026, 12, 31, 23, 59, 59));
    expect(dec.mensual.atMs).toBe(utc(2027, 1, 1));
    expect(dec.diario.atMs).toBe(utc(2027, 1, 1));
    expect(dec.c4h.atMs).toBe(utc(2027, 1, 1));
  });

  it('funding cae en 00/08/16 UTC salvo que Binance diga otra cosa', () => {
    expect(byId(utc(2026, 10, 14, 7, 59)).funding.atMs).toBe(utc(2026, 10, 14, 8));
    expect(byId(utc(2026, 10, 14, 8)).funding.atMs).toBe(utc(2026, 10, 14, 16));
    expect(byId(utc(2026, 10, 14, 17)).funding.atMs).toBe(utc(2026, 10, 15, 0));
    const now = utc(2026, 10, 14, 10);
    expect(byId(now, 0, { nextFundingTimeMs: utc(2026, 10, 14, 16) }).funding.atMs).toBe(utc(2026, 10, 14, 16));
    // un valor pasado o absurdo se ignora
    expect(byId(now, 0, { nextFundingTimeMs: utc(2026, 10, 14, 9) }).funding.atMs).toBe(utc(2026, 10, 14, 16));
    expect(byId(now, 0, { nextFundingTimeMs: utc(2026, 10, 20) }).funding.atMs).toBe(utc(2026, 10, 14, 16));
    expect(byId(now, 0, { nextFundingTimeMs: Number.NaN }).funding.atMs).toBe(utc(2026, 10, 14, 16));
  });

  it('aperturas de sesión en UTC', () => {
    const items = byId(utc(2026, 10, 14, 8));
    expect(items['open-asia'].atMs).toBe(utc(2026, 10, 15, 0));
    expect(items['open-europa'].atMs).toBe(utc(2026, 10, 15, 7));
    expect(items['open-eeuu'].atMs).toBe(utc(2026, 10, 14, 13, 30));
    expect(items['open-eeuu'].kind).toBe('session');
    expect(items['open-eeuu'].label).toContain('Apertura');
  });

  it('viene ordenada por hora y marca los cierres mayores', () => {
    const items = nextCloses(utc(2026, 10, 14, 10, 7), 0);
    for (let i = 1; i < items.length; i++) expect(items[i]!.atMs).toBeGreaterThanOrEqual(items[i - 1]!.atMs);
    expect(items.filter((i) => i.major).map((i) => i.id).sort()).toEqual(['diario', 'mensual', 'semanal']);
    expect(items).toHaveLength(10);
  });

  it('el reloj local usa el offset dado (sin horario de verano: matemática UTC)', () => {
    const now = utc(2026, 10, 14, 10, 7);
    const madrid = byId(now, 120);
    expect(madrid.c1h.clock).toBe('13:00');
    expect(madrid.diario.clock).toBe('15/10 02:00');
    const ny = byId(now, -240);
    expect(ny.c1h.clock).toBe('07:00');
    expect(ny.diario.clock).toBe('20:00');
  });

  it('entrada no finita no lanza', () => {
    expect(nextCloses(Number.NaN, 0)).toEqual([]);
  });
});

describe('formatRemaining', () => {
  it('formatea minutos, horas y días', () => {
    expect(formatRemaining(30_000)).toBe('<1 min');
    expect(formatRemaining(12 * 60_000)).toBe('12 min');
    expect(formatRemaining(59 * 60_000 + 59_000)).toBe('59 min');
    expect(formatRemaining(60 * 60_000)).toBe('1 h 00 min');
    expect(formatRemaining(65 * 60_000)).toBe('1 h 05 min');
    expect(formatRemaining(23 * 3_600_000 + 59 * 60_000)).toBe('23 h 59 min');
    expect(formatRemaining(24 * 3_600_000)).toBe('1 d 0 h');
    expect(formatRemaining((3 * 24 + 4) * 3_600_000 + 20 * 60_000)).toBe('3 d 4 h');
    expect(formatRemaining(-1)).toBe('—');
    expect(formatRemaining(Number.NaN)).toBe('—');
  });
});

describe('isImminent', () => {
  it('solo cierres de 1h o más a 15 min o menos', () => {
    const items = byId(utc(2026, 10, 14, 10, 50), 0);
    expect(isImminent(items.c1h)).toBe(true); // 10 min
    expect(isImminent(items.c15m)).toBe(false); // vela de 15m nunca
    expect(isImminent(items.c4h)).toBe(false);
    const at15 = byId(utc(2026, 10, 14, 10, 45), 0);
    expect(isImminent(at15.c1h)).toBe(true); // justo 15 min
    const at16 = byId(utc(2026, 10, 14, 10, 44), 0);
    expect(isImminent(at16.c1h)).toBe(false);
    const fund = byId(utc(2026, 10, 14, 7, 55), 0);
    expect(isImminent(fund.funding)).toBe(false);
  });
});

describe('bandCloses', () => {
  it('deja fuera la vela de 15m y las aperturas', () => {
    const picked = bandCloses(nextCloses(utc(2026, 10, 14, 10, 7), 0));
    expect(picked.map((i) => i.id)).not.toContain('c15m');
    expect(picked.every((i) => i.kind !== 'session')).toBe(true);
    expect(picked[0]?.id).toBe('c1h');
    expect(picked.length).toBeLessThanOrEqual(5);
  });
});
