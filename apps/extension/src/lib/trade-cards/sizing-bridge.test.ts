import { describe, expect, it } from 'vitest';
import type { LevelRow } from '../context/levels';
import { DEFAULT_SETTINGS } from '../settings';
import { calculatePositionSizeWithFees } from '../sizing';
import { DEFAULT_PRESETS } from './presets';
import { FROM_CARD_NOTE, publishSizingLoad, sizingLoadFromTicket, subscribeSizingLoad } from './sizing-bridge';
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

describe('sizingLoadFromTicket', () => {
  it('margin card carries its fee-inclusive risk, so the sizer reproduces qty 3 (not the stored 1 %)', () => {
    const t = ticket(marketPreset({ size: { basis: 'margin', pct: 3 }, leverage: 10 }));
    expect(t.entries[0]?.qty).toBe(3);
    const load = sizingLoadFromTicket(t);
    expect(load.riskPct).toBe(t.lossAtStopPctOfCapital); // ~0,33 %, no el 1 % guardado
    expect(load.riskPct).toBeGreaterThan(0);
    expect(load.note).toBe(FROM_CARD_NOTE);
    expect(load.note).toContain('tarjeta');
    expect(load.tranches).toBeUndefined();
    const sized = calculatePositionSizeWithFees({
      capital: 1000, riskPct: load.riskPct, direction: load.direction,
      entry: load.entry, stop: load.stop,
      entryFeeRate: load.entryFeeRate, exitFeeRate: load.exitFeeRate,
    });
    expect(sized.valid).toBe(true);
    if (!sized.valid) return;
    expect(sized.quantity).toBeCloseTo(3, 1);
  });

  it('risk card carries the ticket risk and exact fees, reproducing the same size', () => {
    const t = ticket(marketPreset());
    const load = sizingLoadFromTicket(t);
    expect(load.riskPct).toBe(t.lossAtStopPctOfCapital);
    expect(load.riskPct).toBe(1);
    expect(load.entryFeeRate).toBe(t.fees.entryRate);
    expect(load.exitFeeRate).toBe(t.fees.exitRate);
    const sized = calculatePositionSizeWithFees({
      capital: 1000, riskPct: load.riskPct, direction: load.direction,
      entry: load.entry, stop: load.stop,
      entryFeeRate: load.entryFeeRate, exitFeeRate: load.exitFeeRate,
    });
    expect(sized.valid).toBe(true);
    if (!sized.valid) return;
    expect(sized.quantity).toBe(t.entries[0]?.qty);
  });

  it('keeps the maker entry rate of a resting limit card', () => {
    const t = ticket(
      marketPreset({ entry: { kind: 'limit_level', pick: 'nearest_support' }, stop: { kind: 'pct', pct: 2 } }),
      { levels: [row(95, 's1')] },
    );
    const load = sizingLoadFromTicket(t);
    expect(load.entry).toBe(95);
    expect(load.entryFeeRate).toBe(t.fees.makerRate);
    const sized = calculatePositionSizeWithFees({
      capital: 1000, riskPct: load.riskPct, direction: load.direction,
      entry: load.entry, stop: load.stop,
      entryFeeRate: load.entryFeeRate, exitFeeRate: load.exitFeeRate,
    });
    expect(sized.valid).toBe(true);
    if (!sized.valid) return;
    expect(sized.quantity).toBe(t.entries[0]?.qty);
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
    const seen: ReturnType<typeof sizingLoadFromTicket>[] = [];
    const off = subscribeSizingLoad((load) => seen.push(load));
    publishSizingLoad(sizingLoadFromTicket(t));
    off();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.riskPct).toBe(t.lossAtStopPctOfCapital);
  });
});
