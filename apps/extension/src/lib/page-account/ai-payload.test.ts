import { describe, expect, it } from 'vitest';
import { pageHistoryAiPayload, pageHistoryAiText, PAGE_AI_MIN_EVIDENCE } from './ai-payload';
import { historyMetrics } from './metrics';
import type { ClosedPosition } from './parse-history';
import { serializeForLlm } from '../ai/payload';

const row = (over: Partial<ClosedPosition> = {}): ClosedPosition => ({
  symbol: 'BTCUSDC',
  leverage: 20,
  marginMode: 'cross',
  side: 'long',
  status: 'closed',
  openedAtMs: 1_700_000_000_000,
  closedAtMs: 1_700_003_600_000,
  durationMs: 3_600_000,
  realizedPnl: 1.5,
  pnlAsset: 'USDC',
  roiPct: 12.5,
  closeVolume: 0.01,
  closeVolumeAsset: 'BTC',
  entry: 82_644.1,
  avgClose: 82_900,
  maxOpenInterest: 0.01,
  key: 'BTCUSDC|1700000000000|1700003600000',
  ...over,
});

const rows = (): ClosedPosition[] => [
  row(),
  row({ key: 'ETHUSDC|1|2', symbol: 'ETHUSDC', side: 'short', realizedPnl: -3, roiPct: -20, leverage: 40 }),
  row({ key: 'HBARUSDC|1|2', symbol: 'HBARUSDC', side: 'long', realizedPnl: 4, roiPct: 33, leverage: 25 }),
];

describe('pageHistoryAiPayload', () => {
  it('manda la forma swal.history.v1 con porcentajes, cuentas y ratios', () => {
    const payload = pageHistoryAiPayload(historyMetrics(rows()));
    expect(payload.schema).toBe('swal.history.v1');
    expect(payload.n).toBe(3);
    expect(payload.win_rate).toBeCloseTo(0.667, 2);
    expect(payload.avg_roi_pct).toBeCloseTo((12.5 - 20 + 33) / 3, 2);
    expect(payload.best_roi_pct).toBe(33);
    expect(payload.worst_roi_pct).toBe(-20);
    expect(payload.avg_duration_min).toBe(60);
    expect(payload.leverage_median).toBe(25);
    expect(payload.leverage_max).toBe(40);
    expect(payload.evidence).toBe(false);
    expect(payload.redaction).toBe('relative');
  });

  it('los buckets son cuentas por símbolo y por lado, nunca importes', () => {
    const payload = pageHistoryAiPayload(historyMetrics(rows()));
    expect(payload.buckets.every((b) => typeof b.n === 'number')).toBe(true);
    const sides = payload.buckets.filter((b) => b.by === 'side');
    expect(sides.map((b) => b.key).sort()).toEqual(['long', 'short']);
  });

  it('sin filas no inventa números', () => {
    const payload = pageHistoryAiPayload(historyMetrics([]));
    expect(payload.n).toBe(0);
    expect(payload.win_rate).toBeNull();
    expect(payload.wilson_lo).toBeNull();
    expect(payload.avg_roi_pct).toBeNull();
    expect(payload.best_roi_pct).toBeNull();
    expect(payload.worst_roi_pct).toBeNull();
    expect(payload.avg_duration_min).toBeNull();
    expect(payload.evidence).toBe(false);
  });

  it('con 30 operaciones ya habla de evidencia', () => {
    const many = Array.from({ length: PAGE_AI_MIN_EVIDENCE }, (_v, i) =>
      row({ key: `BTCUSDC|${i}|${i + 1}`, openedAtMs: i, closedAtMs: i + 1 }),
    );
    expect(pageHistoryAiPayload(historyMetrics(many)).evidence).toBe(true);
  });
});

describe('la carga útil no lleva importes, tamaños ni precios', () => {
  const forbiddenKeys =
    /"(usd|usdt|usdc|price|precio|precios|entry|entrada|mark|marca|liq|liquidacion|size|tamano|qty|quantity|cantidad|notional|nocional|equity|capital|margin|margen|pnl_usd|net_usd|realized_pnl|close_volume|volume)"\s*:/i;

  it('ni el JSON serializado ni sus claves', () => {
    const text = pageHistoryAiText(historyMetrics(rows()));
    expect(text).not.toMatch(forbiddenKeys);
    // Tampoco los valores absolutos de la página.
    expect(text).not.toContain('82644');
    expect(text).not.toContain('82900');
    expect(text).not.toContain('0.01');
    // Y sigue siendo JSON válido y corto.
    expect(text.length).toBeLessThanOrEqual(2800);
    expect(JSON.parse(text).schema).toBe('swal.history.v1');
  });

  it('también con muchas filas y muchos símbolos', () => {
    const many = Array.from({ length: 700 }, (_v, i) =>
      row({
        key: `SYM${i}USDC|${i}|${i + 1}`,
        symbol: `SYM${i}USDC`,
        openedAtMs: i,
        closedAtMs: i + 1,
        roiPct: (i % 40) - 20,
      }),
    );
    const text = pageHistoryAiText(historyMetrics(many));
    expect(text).not.toMatch(forbiddenKeys);
    expect(text.length).toBeLessThanOrEqual(2800);
  });

  it('serializeForLlm sigue aceptándolo sin tocar el esquema', () => {
    const payload = pageHistoryAiPayload(historyMetrics(rows()));
    const parsed = JSON.parse(serializeForLlm(payload));
    expect(parsed.schema).toBe('swal.history.v1');
    expect(parsed).not.toHaveProperty('precios');
  });
});
