import { describe, expect, it } from 'vitest';
import { buildHistoryPayload, serializeForLlm } from '../ai/payload';
import type { Finding } from '../types';
import {
  aiErrorText, atrOf, consentText, exportFilename, findingsForPayload, gradeLine, historyErrorText,
  historyInputFromMetrics, metricRows, riskPerTradeUsd, topBuckets, trendToken,
} from './analysis-view';
import { computeMetrics } from './metrics';
import type { ClosedTrade } from './types';

const trip = (i: number, pnl: number, symbol = 'BTCUSDT', side: 'long' | 'short' = 'long'): ClosedTrade => ({
  symbol, side, openedMs: Date.UTC(2026, 0, 1 + i, 10), closedMs: Date.UTC(2026, 0, 1 + i, 11),
  entry: 100, exit: 100, size: 1, pnl, fees: 0.1,
});
const OPTS = { riskPerTradeUsd: 10, leverageRule: 10, tzOffsetHours: 0, revengeMinutes: 15 };

describe('riskPerTradeUsd', () => {
  it('uses maxRiskPct of equity when known, otherwise the manual number', () => {
    expect(riskPerTradeUsd({ maxRiskPct: 1 }, 2000, 5)).toBe(20);
    expect(riskPerTradeUsd({ maxRiskPct: 1 }, null, 5)).toBe(5);
    expect(riskPerTradeUsd({ maxRiskPct: 1 }, null, null)).toBeNull();
    expect(riskPerTradeUsd({ maxRiskPct: 1 }, 0, -3)).toBeNull();
  });
});

describe('metric lines and grade', () => {
  it('n<30 says sin evidencia', () => {
    const m = computeMetrics([trip(0, 5), trip(1, -3)], OPTS);
    expect(gradeLine(m)).toContain('sin evidencia');
    const rows = metricRows(m);
    expect(rows[0]).toEqual({ label: 'Operaciones (n)', value: '2' });
    expect(rows.map((r) => r.label)).toContain('Factor de beneficio');
    expect(rows.find((r) => r.label === 'Ganadoras')!.value).toMatch(/^50 % \(IC 95 %/);
  });
  it('empty history does not crash and shows no profit factor', () => {
    const m = computeMetrics([], OPTS);
    expect(metricRows(m).find((r) => r.label === 'Factor de beneficio')!.value).toBe('sin perdidas');
    expect(gradeLine(m)).toContain('sin evidencia');
  });
  it('top buckets sort by count', () => {
    const m = computeMetrics([trip(0, 1, 'ETHUSDT'), trip(1, 1), trip(2, 1), trip(3, 1, 'SOLUSDT'), trip(4, 1, 'XRPUSDT'), trip(5, 1, 'DOGEUSDT')], OPTS);
    const top = topBuckets(m, 'symbol');
    expect(top).toHaveLength(3);
    expect(top[0]!.key).toBe('BTCUSDT');
  });
});

describe('history payload from metrics', () => {
  it('has no USD amounts and keeps the counters', () => {
    const trips = Array.from({ length: 12 }, (_, i) => trip(i, i % 3 === 0 ? -7.123 : 9.876));
    const m = computeMetrics(trips, OPTS);
    const s = serializeForLlm(buildHistoryPayload(historyInputFromMetrics(m), 'relative'));
    const p = JSON.parse(s);
    expect(p.n).toBe(12);
    expect(p.buckets.length).toBeLessThanOrEqual(3);
    expect(p.grade).toBeNull();
    expect(s).not.toMatch(/9\.876|7\.123|BTCUSDT.*usd/i);
    expect(s).not.toMatch(/netUsd|expectancy|equity/i);
  });
});

describe('ai context helpers', () => {
  const f = (over: Partial<Finding>): Finding => ({
    id: 'a', kind: 'double_bottom', label: 'Doble suelo', explanation: '', from: 0, to: 1,
    levels: [{ role: 'neck', price: 100, invalidate: 98 }], direction: 'up', strength: 70, evidence: null, ...over,
  });
  it('maps findings to relative form and skips neutral ones', () => {
    const out = findingsForPayload([f({}), f({ direction: 'neutral' }), f({ kind: 'x', strength: 0.5, levels: [] })], 100);
    expect(out).toEqual([
      { kind: 'double_bottom', dir: 'up', fuerza: 0.7, invalida_pct: 2 },
      { kind: 'x', dir: 'up', fuerza: 0.5, invalida_pct: 0 },
    ]);
  });
  it('trend token and atr', () => {
    expect(trendToken('Tendencia alcista')).toBe('tendencia_alcista');
    expect(trendToken(null)).toBeUndefined();
    const candles = Array.from({ length: 20 }, (_, i) => ({ high: 102 + i, low: 98 + i, close: 100 + i }));
    expect(atrOf(candles)).toBeGreaterThan(0);
    expect(atrOf(candles.slice(0, 5))).toBeNull();
  });
});

describe('texts', () => {
  it('maps every AI failure reason to Spanish text', () => {
    for (const r of ['no_key', 'auth', 'rate_limit', 'timeout', 'no_consent', 'bad_payload', 'net']) {
      expect(aiErrorText(r)).not.toBe('No se pudo completar el análisis.');
    }
    expect(aiErrorText('http_500')).toContain('HTTP 500');
    expect(aiErrorText(undefined)).toBe('No se pudo completar el análisis.');
  });
  it('maps history error codes', () => {
    for (const c of ['ip_or_perm', 'clock', 'net', 'no_key']) expect(historyErrorText(c).length).toBeGreaterThan(10);
    expect(historyErrorText('http_418')).toContain('HTTP 418');
  });
  it('consent names the provider and the fields; absolute adds prices', () => {
    const rel = consentText('openrouter', 'relative', 'position');
    expect(rel).toContain('OpenRouter');
    expect(rel).toContain('riesgo en % del capital');
    expect(rel).toContain('Sin importes en USD');
    expect(consentText('openrouter', 'absolute', 'position')).toContain('precios de entrada');
    expect(consentText('opencode', 'relative', 'history')).toContain('OpenCode');
  });
  it('export filename', () => {
    expect(exportFilename('csv', Date.UTC(2026, 9, 18))).toBe('swal-historial-2026-10-18.csv');
  });
});
