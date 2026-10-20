import { describe, expect, it } from 'vitest';
import type { LevelRow } from '../context/levels';
import { DEFAULT_SETTINGS } from '../settings';
import { planScaleIn } from '../sizing';
import { DEFAULT_PRESETS, defaultPresets } from './presets';
import { buildTicket, buildTicketSides, formatTicketText, HONEST_R_LINE, CARDS_FOOTER } from './ticket';
import type { TradeCardPreset, TradeTicket } from './types';

const rules = { ...DEFAULT_SETTINGS.rules, maxRiskPct: 1, maxLeverage: 10, dailyLossUsd: 1000 };
const row = (price: number, kind: LevelRow['kind'], label = kind as string): LevelRow => ({
  price, kind, kinds: [kind], label, distancePct: 0, distanceAtr: null,
});
const marketPreset = (over: Partial<TradeCardPreset> = {}): TradeCardPreset => ({
  id: 't', name: 'Prueba', side: 'long', entry: { kind: 'market' },
  stop: { kind: 'pct', pct: 1 }, tp: { rMultiples: [1, 2], useNextLevel: false },
  size: { basis: 'risk', pct: 1 }, leverage: 'min', ...over,
});
const atrs = { atr1h: 2 };
const base = { symbol: 'BTCUSDT', price: 100, levels: [] as LevelRow[], atrs, capital: 1000, rules };

function ok(r: ReturnType<typeof buildTicket>): TradeTicket {
  if (!r.ok) throw new Error(r.reason);
  return r.ticket;
}

describe('buildTicket sizing', () => {
  it('risk basis includes round-trip fees: 1 % of 1000, entry 100 stop 99 -> qty 9,095043 (floor a 6), loss 9,99 floored with fees', () => {
    const t = ok(buildTicket({ ...base, preset: marketPreset() }));
    expect(t.orderType).toBe('MARKET');
    expect(t.stop).toBe(99);
    // La cantidad no se redondea hacia arriba: se pisa al sexto decimal (antes 9,095).
    expect(t.entries).toEqual([{ price: 100, qty: 9.095043, weightPct: 100 }]);
    // La pérdida mostrada se recorta: la real es 9,999999…, no 10,00.
    expect(t.lossAtStopUsd).toBe(9.99);
    expect(t.lossAtStopUsd).toBeLessThanOrEqual(10);
    expect(t.lossIncludesFees).toBe(true);
    expect(t.lossAtStopPctOfCapital).toBe(1);
    expect(t.notionalUsd).toBe(909.5);
    expect(t.leverage).toBe(1);
    expect(t.marginUsd).toBe(909.5);
    expect(t.feeUsd).toBe(0.9); // 9,095 * (100 + 99) * 0,05 %
    expect(t.tps.map((x) => x.price)).toEqual([101, 102]);
    expect(t.tps.map((x) => x.rMultiple)).toEqual([1, 2]);
    expect(t.rrToFirstTp).toBe(1);
    expect(t.warnings.some((w) => w.code === 'risk_above_rule')).toBe(false);
  });

  it('resting limit entry uses maker fee and keeps the 1 % budget (1000 / 100 / 99)', () => {
    const t = ok(buildTicket({
      ...base, price: 101, levels: [row(100, 'round')],
      preset: marketPreset({ entry: { kind: 'limit_level', pick: 'nearest_support' } }),
    }));
    expect(t.entries[0]?.price).toBe(100);
    expect(t.fees.entryRate).toBe(0.0002);
    expect(t.entries[0]?.qty).toBe(9.350163); // 10 / (1 + 0,02 + 0,0495), pisado a 6 decimales
    expect(t.lossAtStopUsd).toBeLessThanOrEqual(10);
    expect(t.lossIncludesFees).toBe(true);
  });

  it('never exceeds the 1 % budget once fees are counted (judge scenario 1000 / 100 / 99)', () => {
    const filters = { tickSize: 0.01, stepSize: 0.001, minNotional: 5, minQty: 0.001 };
    const t = ok(buildTicket({ ...base, filters, preset: marketPreset() }));
    expect(t.entries[0]?.qty).toBe(9.095);
    expect(t.lossIncludesFees).toBe(true);
    expect(t.lossAtStopUsd).toBeLessThanOrEqual(10);
    expect(t.lossAtStopUsd).toBeGreaterThan(9.9);
    expect(t.feeUsd).toBeGreaterThan(0);
  });

  it('margin basis: 5 % of 1000 at 10x -> notional 500, loss 5,49 floored with fees (not 5,50)', () => {
    const t = ok(buildTicket({ ...base, preset: marketPreset({ size: { basis: 'margin', pct: 5 }, leverage: 10 }) }));
    expect(t.marginUsd).toBe(50);
    expect(t.notionalUsd).toBe(500);
    expect(t.entries[0]?.qty).toBe(5);
    // La pérdida real con comisiones es 5,4975: el redondeo la subía a 5,50.
    expect(t.lossAtStopUsd).toBe(5.49);
    expect(t.lossAtStopUsd).toBeLessThanOrEqual(5.4975);
    expect(t.lossIncludesFees).toBe(true);
    expect(t.leverage).toBe(10);
  });

  it('margin basis with leverage min uses the largest leverage whose fee-inclusive loss fits the rule (9x, not 10x)', () => {
    // margen 100, stop 1 %: sin comisiones 10x cabría justo; con comisiones la pérdida sería 10,995 -> 9x.
    const t = ok(buildTicket({ ...base, preset: marketPreset({ size: { basis: 'margin', pct: 10 }, leverage: 'min' }) }));
    expect(t.leverage).toBe(9);
    // 9 × 1,0995 = 9,8955 de pérdida real: se recorta a 9,89 (antes se subía a 9,90).
    expect(t.lossAtStopUsd).toBe(9.89);
    expect(t.lossAtStopUsd).toBeLessThanOrEqual(10);
    expect(t.warnings.some((w) => w.code === 'risk_above_rule')).toBe(false);
  });

  it('averaging in 3 tranches keeps the total loss at the risk budget incl. fees', () => {
    const preset = DEFAULT_PRESETS.find((p) => p.id === 'promediar-3') as TradeCardPreset;
    const filters = { tickSize: 0.01, stepSize: 0.001, minNotional: 5, minQty: 0.001 };
    const levels = [row(95, 's1', 'S1')];
    const stopPreset = { ...preset, stop: { kind: 'pct' as const, pct: 2 } };
    const t = ok(buildTicket({ ...base, levels, filters, preset: stopPreset, sideOverride: 'long' }));
    expect(t.entries).toHaveLength(3);
    expect(t.entries[0]?.price).toBe(95);
    const plan = planScaleIn({
      capital: 1000, riskPct: 1, direction: 'long', entry1: 95, entry2: t.entries[1]?.price as number,
      entry3: t.entries[2]?.price as number, stop: t.stop, feeRate: 0.0007, ...filters,
    });
    expect(plan.valid).toBe(true);
    if (!plan.valid) return;
    expect(t.entries.map((e) => e.qty)).toEqual(plan.tranches.map((x) => x.qty));
    expect(t.lossIncludesFees).toBe(true);
    expect(t.lossAtStopUsd).toBeLessThanOrEqual(10.005);
    expect(t.lossAtStopUsd).toBeGreaterThan(9.9);
    expect(t.orderType).toBe('LIMIT');
    expect(t.scaleInNote).toBeTruthy();
  });

  it('supports 2 and 4 tranches', () => {
    for (const n of [2, 4] as const) {
      const t = ok(buildTicket({ ...base, levels: [row(95, 's1')], preset: { ...marketPreset({ entry: { kind: 'limit_level', pick: 'nearest_support' } }), scaleIn: { tranches: n } } }));
      expect(t.entries).toHaveLength(n);
      expect(t.lossAtStopUsd).toBeLessThanOrEqual(10.01);
    }
  });
});

describe('buildTicket sides, rounding and warnings', () => {
  const levels = [row(105, 'r1', 'R1'), row(95, 's1', 'S1')];
  const auto: TradeCardPreset = { ...(DEFAULT_PRESETS[0] as TradeCardPreset) };

  it('side auto computes both sides at the nearest level on each side', () => {
    const sides = buildTicketSides({ ...base, levels, preset: auto });
    expect(sides.map((s) => s.side)).toEqual(['long', 'short']);
    const long = ok(sides[0]?.result as never) as TradeTicket;
    const short = ok(sides[1]?.result as never) as TradeTicket;
    expect(long.entries[0]?.price).toBe(95);
    expect(long.stop).toBe(92); // 95 - 1,5 * ATR 2
    expect(short.entries[0]?.price).toBe(105);
    expect(short.stop).toBe(108);
    expect(short.tps[0]?.price).toBeLessThan(105);
  });

  it('uses the invalidate level as stop when present', () => {
    const t = ok(buildTicket({ ...base, levels: [...levels, row(93, 'invalidate', 'Invalida')], preset: auto, sideOverride: 'long' }));
    expect(t.stop).toBe(93);
    expect(t.stopSource).toBe('invalidation');
  });

  it('rounds prices to tick and floors quantity to step (fees included)', () => {
    const filters = { tickSize: 0.5, stepSize: 0.1, minNotional: 5, minQty: 0.1 };
    const t = ok(buildTicket({
      ...base, capital: 1234, filters, levels: [row(97.3, 's1')],
      preset: marketPreset({ stop: { kind: 'pct', pct: 2 }, entry: { kind: 'limit_level', pick: 'nearest_support' } }),
    }));
    expect(t.entries[0]?.price).toBe(97.5);
    expect(t.stop).toBe(95.5);
    expect(t.entries[0]?.qty).toBe(5.9); // 12,34 / (2 + fees) = 5,9689 -> 5,9
    expect(t.warnings.some((w) => w.code === 'no_filters')).toBe(false);
  });

  it('charges taker when a rounded limit entry would rest on the wrong side (stop entry)', () => {
    const filters = { tickSize: 1, stepSize: 0.001, minNotional: 0, minQty: 0 };
    const t = ok(buildTicket({
      ...base, price: 100.9, filters, levels: [row(100.8, 's1')],
      preset: marketPreset({ entry: { kind: 'limit_level', pick: 'nearest_support' }, stop: { kind: 'pct', pct: 2 } }),
    }));
    expect(t.entries[0]?.price).toBe(101); // el tick lo redondea por ENCIMA del precio
    expect(t.warnings.some((w) => w.code === 'entry_stop')).toBe(true);
    // entrada taker 0,05 % + salida taker 0,05 % = 0,10 % del nocional
    expect(t.feeUsd).toBeCloseTo(t.notionalUsd * 0.001, 1);
  });

  it('warns about rounding when filters are unknown', () => {
    const t = ok(buildTicket({ ...base, preset: marketPreset() }));
    expect(t.warnings.find((w) => w.code === 'no_filters')?.text).toBe('redondea a los pasos del par');
  });

  it('warns below the pair minimum', () => {
    const filters = { tickSize: 0.01, stepSize: 0.1, minNotional: 100, minQty: 0.1 };
    const t = ok(buildTicket({ ...base, capital: 100, filters, preset: marketPreset({ stop: { kind: 'pct', pct: 2 } }) }));
    expect(t.entries[0]?.qty).toBe(0.4);
    expect(t.warnings.some((w) => w.text === 'por debajo del mínimo del par')).toBe(true);
  });

  it('flags risk above the rule, in inverted style above 2 %', () => {
    const t = ok(buildTicket({ ...base, preset: marketPreset({ size: { basis: 'risk', pct: 3 } }) }));
    expect(t.warnings.find((w) => w.code === 'risk_above_rule')?.text).toBe('supera tu regla de riesgo (1 %)');
    expect(t.highRisk).toBe(true);
    const mild = ok(buildTicket({ ...base, preset: marketPreset({ size: { basis: 'risk', pct: 1.5 } }) }));
    expect(mild.highRisk).toBe(false);
    expect(mild.warnings.some((w) => w.code === 'risk_above_rule')).toBe(true);
  });

  it('flags leverage above the rule', () => {
    const t = ok(buildTicket({ ...base, preset: marketPreset({ size: { basis: 'margin', pct: 5 }, leverage: 20 }) }));
    expect(t.warnings.some((w) => w.code === 'leverage_above_rule')).toBe(true);
  });

  it('flags a stop closer than 0,15 %', () => {
    const t = ok(buildTicket({ ...base, preset: marketPreset({ stop: { kind: 'pct', pct: 0.1 } }) }));
    expect(t.warnings.find((w) => w.code === 'stop_too_close')?.text).toContain('el coste ya se come el stop');
  });

  it('flags an entry farther than 3 ATR', () => {
    const t = ok(buildTicket({ ...base, levels: [row(90, 's1')], preset: auto, sideOverride: 'long' }));
    expect(t.warnings.some((w) => w.code === 'entry_far')).toBe(true);
  });

  it('flags when the loss exceeds the daily-loss remainder', () => {
    const t = ok(buildTicket({ ...base, preset: marketPreset(), dailyLossRemainingUsd: 4 }));
    expect(t.warnings.some((w) => w.code === 'daily_loss')).toBe(true);
  });

  it('shows the daily-loss budget floored, never above the one chosen', () => {
    // 0,005 USD de límite diario: el redondeo al céntimo lo enseñaba como 0,01.
    const t = ok(buildTicket({ ...base, preset: marketPreset(), dailyLossRemainingUsd: 0.005 }));
    const text = t.warnings.find((w) => w.code === 'daily_loss')?.text;
    expect(text).toContain('0,005 USD');
    expect(text).not.toContain('0,01 USD');
  });

  it('fails when the stop ends on the wrong side after rounding', () => {
    const filters = { tickSize: 5, stepSize: 0.1, minNotional: 0, minQty: 0 };
    const r = buildTicket({ ...base, filters, preset: marketPreset({ stop: { kind: 'pct', pct: 0.1 } }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('lado equivocado');
  });

  it('empty ladder: limit cards fail, market cards keep working', () => {
    const r = buildTicket({ ...base, levels: [], preset: auto });
    expect(r).toEqual({ ok: false, reason: 'Sin niveles todavía' });
    expect(buildTicket({ ...base, levels: [], preset: DEFAULT_PRESETS.at(-1) as TradeCardPreset }).ok).toBe(true);
  });

  it('adds the next ladder level as a target with its own R multiple', () => {
    const t = ok(buildTicket({
      ...base, levels: [row(100.5, 'round'), row(103.5, 'r1', 'R1')],
      preset: marketPreset({ tp: { rMultiples: [1], useNextLevel: true } }),
    }));
    const lvl = t.tps.find((x) => x.source === 'level');
    expect(lvl?.price).toBe(103.5);
    expect(lvl?.rMultiple).toBe(3.5);
  });
});

describe('ticket text', () => {
  it('copies the floored loss and quantity, not a rounded-up one', () => {
    const t = ok(buildTicket({ ...base, preset: marketPreset() }));
    const text = formatTicketText(t);
    // La real con comisiones es 9,999999…; el texto no la infla a 10.
    expect(text).toContain('Pérdida en el stop: 9.99 USD');
    expect(text).toContain('cantidad 9.095043');
  });

  it('has the honest line and no forbidden words, for every default card and side', () => {
    const levels = [row(105, 'r1', 'R1'), row(95, 's1', 'S1')];
    for (const preset of defaultPresets()) {
      for (const { result } of buildTicketSides({ ...base, levels, preset })) {
        if (!result.ok) continue;
        const text = formatTicketText(result.ticket);
        expect(text).toContain(HONEST_R_LINE);
        expect(text).toContain(CARDS_FOOTER);
        expect(text).toContain('BTCUSDT');
        expect(text).toContain('Stop:');
        expect(text).toContain('Apalancamiento:');
        const lower = text.toLowerCase();
        for (const word of ['comprar', 'vender', 'garantiz', 'probabilidad de']) expect(lower).not.toContain(word);
        for (const w of result.ticket.warnings) expect(w.text.length).toBeLessThanOrEqual(90);
      }
    }
  });
});
