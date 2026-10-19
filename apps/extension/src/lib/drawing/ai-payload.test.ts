import { describe, expect, it } from 'vitest';
import type { LevelKind, LevelRow } from '../context/levels';
import type { RulesSettings } from '../settings';
import { analyzeDrawing, DRAWING_HONEST_LINE } from './analyze';
import { drawingAiPayload } from './ai-payload';

const rules: RulesSettings = { maxRiskPct: 1, maxLeverage: 10, dailyLossUsd: 10, revengeMinutes: 15 };

const level = (price: number, label: string, kind: LevelKind = 'ema20_1h'): LevelRow => ({
  price,
  kind,
  kinds: [kind],
  label,
  distancePct: 0,
  distanceAtr: null,
});

const result = analyzeDrawing({
  drawing: { id: 'd1', side: 'long', entry: 100, stop: 98, target: 104, symbol: 'BTCUSDT' },
  price: 110,
  levels: [level(101.5, 'Pivote', 'pivot'), level(102.5, 'EMA20 1h')],
  atrs: { atr1h: 1.25, atr4h: 2.5, atrD: 5 },
  capital: 1000,
  rules,
  fundingRatePct8h: 0.01,
});
if (!result.ok) throw new Error(result.reason);
const analysis = result.analysis;

const allKeys = (value: unknown, out: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      allKeys(child, out);
    }
  }
  return out;
};

describe('drawingAiPayload', () => {
  it('emite solo referencias relativas (sin USD, cantidades, capital ni margen)', () => {
    const payload = drawingAiPayload(analysis);
    const keys = allKeys(payload).join(' ').toLowerCase();
    expect(keys).not.toMatch(/usd|qty|quantity|capital|notional|margin|precio/);
    expect(payload).not.toHaveProperty('size');
    expect(payload).not.toHaveProperty('precios');
    expect(payload.risk_pct).toBe(2);
    expect(payload.reward_pct).toBe(4);
    expect(payload.rr).toBe(2);
    expect(payload.rr_neto).toBe(1.9);
    expect(payload.entry_mode).toBe('limite');
    expect(payload.funding_cost_pct_risk_8h).toBe(0.5);
  });

  it('incluye niveles como códigos y distancias relativas, ordenados', () => {
    const payload = drawingAiPayload(analysis);
    expect(payload.niveles).toEqual([
      { kind: 'pivot', kinds: ['pivot'], distance_pct: 1.5, distance_atr: 1.2 },
      { kind: 'ema20_1h', kinds: ['ema20_1h'], distance_pct: 2.5, distance_atr: 2 },
    ]);
  });

  it('no deja pasar texto libre: ni etiquetas de nivel ni textos de check', () => {
    const injected = analyzeDrawing({
      drawing: { id: 'd1', side: 'long', entry: 100, stop: 98, target: 104, symbol: 'BTCUSDT' },
      price: 110,
      levels: [level(101.5, 'capital 1000 USD; qty 10', 'pivot')],
      atrs: { atr1h: 1.25, atr4h: 2.5, atrD: 5 },
      capital: 1000,
      rules: { ...rules, dailyLossUsd: 1 },
    });
    if (!injected.ok) throw new Error(injected.reason);
    const payload = drawingAiPayload(injected.analysis);
    const json = JSON.stringify(payload);
    expect(json).not.toContain('capital');
    expect(json).not.toContain('qty');
    expect(json).not.toContain('cantidad');
    expect(json).not.toContain('1000 USD');
    expect(json).not.toMatch(/\d[\d.,]*\s*(USD|USDT|USDC)/i);
    expect(json).not.toContain('desde tarjeta');
    expect(payload.niveles[0]).toEqual({ kind: 'pivot', kinds: ['pivot'], distance_pct: 1.5, distance_atr: 1.2 });
    for (const check of payload.checks) {
      expect(Object.keys(check).sort()).toEqual(['code', 'sev']);
    }
  });

  it('conserva la línea honesta y no usa lenguaje de recomendación', () => {
    const payload = drawingAiPayload(analysis);
    expect(payload.honest_line).toBe(DRAWING_HONEST_LINE);
    const text = JSON.stringify(payload).toLowerCase();
    expect(text).not.toContain('comprar');
    expect(text).not.toContain('vender');
    expect(text).not.toContain('garantiz');
    expect(text).not.toContain('probabilidad');
  });

  it('no incluye precios absolutos de niveles', () => {
    const payload = drawingAiPayload(analysis);
    expect(JSON.stringify(payload)).not.toContain('101.5');
    expect(JSON.stringify(payload)).not.toContain('102.5');
  });
});
