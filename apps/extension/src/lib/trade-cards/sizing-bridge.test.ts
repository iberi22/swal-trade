import { describe, expect, it } from 'vitest';
import type { LevelRow } from '../context/levels';
import { DEFAULT_SETTINGS } from '../settings';
import { calculatePositionSizeWithFees } from '../sizing';
import { DEFAULT_PRESETS } from './presets';
import {
  FROM_CARD_NOTE,
  displayRiskPct,
  exactSizingFromLoad,
  feeInclusiveRiskUsd,
  publishSizingLoad,
  sizingLoadFromTicket,
  subscribeSizingLoad,
} from './sizing-bridge';
import { buildTicket } from './ticket';
import type { TradeCardPreset, TradeTicket } from './types';

const rules = { ...DEFAULT_SETTINGS.rules, maxRiskPct: 1, maxLeverage: 10, dailyLossUsd: 1000 };
const row = (price: number, kind: LevelRow['kind'], label = kind as string): LevelRow => ({
  price,
  kind,
  kinds: [kind],
  label,
  distancePct: 0,
  distanceAtr: null,
});
const base = { symbol: 'BTCUSDT', price: 100, levels: [] as LevelRow[], atrs: { atr1h: 2 }, capital: 1000, rules };
const marketPreset = (over: Partial<TradeCardPreset> = {}): TradeCardPreset => ({
  id: 't', name: 'Prueba', side: 'long', entry: { kind: 'market' },
  stop: { kind: 'pct', pct: 1 }, tp: { rMultiples: [1, 2], useNextLevel: false },
  size: { basis: 'risk', pct: 1 }, leverage: 'min', ...over,
});

function ticket(preset: TradeCardPreset, over: Partial<typeof base> = {}): TradeTicket {
  const result = buildTicket({ ...base, ...over, preset });
  if (!result.ok) throw new Error(result.reason);
  return result.ticket;
}

/** Estado del panel cuando sus campos siguen siendo los del payload. */
const unchanged = (load: ReturnType<typeof sizingLoadFromTicket>) => ({
  entryStr: String(load.entry),
  stopStr: String(load.stop),
  direction: load.direction,
  capital: load.capital,
  riskPct: displayRiskPct(load),
});

describe('sizingLoadFromTicket', () => {
  it('margin card carries its EXACT fee-inclusive risk (0,32985 %), not the rounded 1 %', () => {
    const t = ticket(marketPreset({ size: { basis: 'margin', pct: 3 }, leverage: 10 }));
    expect(t.entries[0]?.qty).toBe(3);
    const load = sizingLoadFromTicket(t);
    // 3,2985 USD / 1.000 = 0,32985 %, sin pasar por `lossAtStopPctOfCapital` (0,33).
    expect(load.riskUsd).toBeCloseTo(3.2985, 10);
    expect(load.riskPct).toBe(0.32985);
    expect(load.quantity).toBe(3);
    expect(load.capital).toBe(1000);
    expect(load.note).toBe(FROM_CARD_NOTE);
    expect(load.note).toContain('tarjeta');
    expect(load.tranches).toBeUndefined();
    // El panel enseña la cantidad EXACTA del ticket cuando sus campos no cambian.
    expect(exactSizingFromLoad(load, unchanged(load))).toEqual({ quantity: 3, lossUsd: load.riskUsd });
  });

  it('the rounded percentage would give another size; the exact payload is what matches', () => {
    const t = ticket(marketPreset({ size: { basis: 'margin', pct: 3 }, leverage: 10 }));
    const load = sizingLoadFromTicket(t);
    const fromRounded = calculatePositionSizeWithFees({
      capital: 1000, riskPct: t.lossAtStopPctOfCapital, direction: load.direction,
      entry: load.entry, stop: load.stop,
      entryFeeRate: load.entryFeeRate, exitFeeRate: load.exitFeeRate,
    });
    expect(fromRounded.valid).toBe(true);
    if (!fromRounded.valid) return;
    // 3,0013… recomputado desde 0,33 % frente a los 3 exactos del ticket.
    expect(fromRounded.quantity).not.toBe(t.entries[0]?.qty);
    expect(load.quantity).toBe(t.entries[0]?.qty);
  });

  it('risk card carries the exact ticket risk and fees, and the panel shows its exact size', () => {
    const t = ticket(marketPreset());
    const load = sizingLoadFromTicket(t);
    const qty = t.entries[0]?.qty as number;
    const expectedRiskUsd = feeInclusiveRiskUsd({
      quantity: qty, entry: 100, stop: 99, entryFeeRate: t.fees.entryRate, exitFeeRate: t.fees.exitRate,
    });
    expect(load.entryFeeRate).toBe(t.fees.entryRate);
    expect(load.exitFeeRate).toBe(t.fees.exitRate);
    expect(load.riskUsd).toBe(expectedRiskUsd);
    // No es exactamente 1 %: la cantidad pisada a 6 decimales deja 0,99999998 %.
    expect(load.riskPct).toBe((expectedRiskUsd / 1_000) * 100);
    expect(load.riskPct).toBeLessThan(1);
    expect(load.riskPct).toBeCloseTo(1, 7);
    expect(exactSizingFromLoad(load, unchanged(load))).toEqual({ quantity: qty, lossUsd: expectedRiskUsd });
    // Con los campos cambiados deja de haber cifra exacta que enseñar.
    expect(exactSizingFromLoad(load, { ...unchanged(load), entryStr: '101' })).toBeNull();
    expect(exactSizingFromLoad(load, { ...unchanged(load), stopStr: '98' })).toBeNull();
    expect(exactSizingFromLoad(load, { ...unchanged(load), direction: 'short' })).toBeNull();
    expect(exactSizingFromLoad(load, { ...unchanged(load), capital: 500 })).toBeNull();
  });

  it('keeps the maker entry rate of a resting limit card and its exact size', () => {
    const t = ticket(
      marketPreset({ entry: { kind: 'limit_level', pick: 'nearest_support' }, stop: { kind: 'pct', pct: 2 } }),
      { levels: [row(95, 's1')] },
    );
    const load = sizingLoadFromTicket(t);
    expect(load.entry).toBe(95);
    expect(load.entryFeeRate).toBe(t.fees.makerRate);
    expect(load.quantity).toBe(t.entries[0]?.qty);
    // El dimensionador ya no recomputa (daba otra cantidad con el % redondeado).
    expect(exactSizingFromLoad(load, unchanged(load))?.quantity).toBe(t.entries[0]?.qty);
  });

  it('recomputing from the rounded percentage does not reproduce the resting-limit size', () => {
    const t = ticket(
      marketPreset({ entry: { kind: 'limit_level', pick: 'nearest_support' }, stop: { kind: 'pct', pct: 2 } }),
      { levels: [row(95, 's1')] },
    );
    const load = sizingLoadFromTicket(t);
    const fromRounded = calculatePositionSizeWithFees({
      capital: 1000, riskPct: t.lossAtStopPctOfCapital, direction: load.direction,
      entry: load.entry, stop: load.stop,
      entryFeeRate: load.entryFeeRate, exitFeeRate: load.exitFeeRate,
    });
    expect(fromRounded.valid).toBe(true);
    if (!fromRounded.valid) return;
    expect(fromRounded.quantity).not.toBe(t.entries[0]?.qty);
  });

  it('passes the tranche prices so the sizer can show or point to the ticket', () => {
    const preset = DEFAULT_PRESETS.find((p) => p.id === 'promediar-3') as TradeCardPreset;
    const t = ticket({ ...preset, stop: { kind: 'pct', pct: 2 } }, { levels: [row(95, 's1')] });
    expect(t.entries).toHaveLength(3);
    const load = sizingLoadFromTicket(t);
    expect(load.tranches).toEqual(t.entries.map((e) => e.price));
  });

  it('publishes the load to subscribers', () => {
    const t = ticket(marketPreset());
    const load = sizingLoadFromTicket(t);
    const seen: ReturnType<typeof sizingLoadFromTicket>[] = [];
    const off = subscribeSizingLoad((incoming) => seen.push(incoming));
    publishSizingLoad(load);
    off();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.riskPct).toBe(load.riskPct);
    expect(seen[0]?.riskUsd).toBe(load.riskUsd);
  });
});

describe('carga exacta y edición del riesgo', () => {
  /** Tarjeta de margen: 3 % de 1.000 a 10x son 3 unidades de 100 con stop en 99. */
  const marginLoad = () => sizingLoadFromTicket(ticket(marketPreset({ size: { basis: 'margin', pct: 3 }, leverage: 10 })));

  it('bajar el riesgo de 3 % a 0,1 % anula la cantidad exacta del ticket', () => {
    const load = marginLoad();
    expect(load.quantity).toBe(3);
    expect(load.riskUsd).toBeCloseTo(3.2985, 10);
    // Mientras no se toque nada, se enseña la cifra exacta del ticket.
    expect(exactSizingFromLoad(load, unchanged(load))).toEqual({ quantity: 3, lossUsd: load.riskUsd });
    // Volver a escribir el riesgo que enseña el campo tampoco la anula.
    expect(exactSizingFromLoad(load, { ...unchanged(load), riskPct: displayRiskPct(load) })).not.toBeNull();
    // Cualquier otro riesgo escribe una carga nueva: la cifra del ticket ya no vale.
    expect(exactSizingFromLoad(load, { ...unchanged(load), riskPct: 0.1 })).toBeNull();
    expect(exactSizingFromLoad(load, { ...unchanged(load), riskPct: 1 })).toBeNull();
    // El capital y los precios siguen anulándola.
    expect(exactSizingFromLoad(load, { ...unchanged(load), capital: 500 })).toBeNull();
  });

  it('con 0,1 % el panel recalcula con comisiones y el paso del contrato: 1 USD de presupuesto', () => {
    const load = marginLoad();
    const r = calculatePositionSizeWithFees({
      capital: load.capital,
      riskPct: 0.1,
      direction: load.direction,
      entry: load.entry,
      stop: load.stop,
      entryFeeRate: load.entryFeeRate,
      exitFeeRate: load.exitFeeRate,
      stepSize: 0.0001,
    });
    expect(r.valid).toBe(true);
    if (!r.valid) return;
    // Presupuesto 1 USD, no los 3,2985 del ticket: la cantidad cae de 3 a 0,9095.
    expect(r.lossBudgetUsd).toBe(1);
    expect(r.quantity).toBe(0.9095);
    expect(r.quantity).toBeLessThan(load.quantity);
    expect(r.lossUsd).toBeLessThanOrEqual(1 + 1e-9);
  });
});
