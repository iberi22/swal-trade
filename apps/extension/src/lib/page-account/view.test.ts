import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_MIN_N,
  filterHistory,
  formatAmount,
  formatDuration,
  formatPct,
  historySymbols,
  metricsLines,
  openPositionLines,
  sideLabel,
} from './view';
import { historyMetrics } from './metrics';
import type { ClosedPosition } from './parse-history';
import type { PagePosition } from './parse-positions';

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
  closeVolume: null,
  closeVolumeAsset: null,
  entry: 82_644.1,
  avgClose: 82_900,
  maxOpenInterest: null,
  key: 'BTCUSDC|1700000000000|1700003600000',
  ...over,
});

describe('formatPct / formatAmount / formatDuration / sideLabel', () => {
  it('porcentajes con signo y sin ceros de más', () => {
    expect(formatPct(9.25)).toBe('+9.25 %');
    expect(formatPct(-62.05)).toBe('-62.05 %');
    expect(formatPct(0)).toBe('0 %');
    expect(formatPct(null)).toBe('—');
    expect(formatPct(Number.NaN)).toBe('—');
  });

  it('importes con su activo', () => {
    expect(formatAmount(1.01, 'USDC')).toBe('+1.01 USDC');
    expect(formatAmount(-10.57, 'USDC')).toBe('-10.57 USDC');
    expect(formatAmount(0)).toBe('0');
    expect(formatAmount(undefined, 'USDC')).toBe('—');
  });

  it('duraciones legibles', () => {
    expect(formatDuration(10 * 3_600_000 + 35 * 60_000)).toBe('10 h 35 min');
    expect(formatDuration(45 * 60_000)).toBe('45 min');
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe('2 d 3 h');
    expect(formatDuration(0)).toBe('menos de 1 min');
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });

  it('lados en palabras, sin jerga de compra/venta', () => {
    expect(sideLabel('long')).toBe('largo');
    expect(sideLabel('short')).toBe('corto');
    expect(sideLabel(null)).toBe('sin lado');
  });
});

describe('filterHistory', () => {
  const rows = [
    row(),
    row({ key: 'ETHUSDC|1|2', symbol: 'ETHUSDC', side: 'short' }),
    row({ key: 'BTCUSDC|3|4', closedAtMs: 1_700_009_999_999 }),
  ];

  it('filtra por símbolo y por lado', () => {
    expect(filterHistory(rows, { symbol: 'BTCUSDC', side: 'all' })).toHaveLength(2);
    expect(filterHistory(rows, { symbol: 'ETHUSDC', side: 'all' })).toHaveLength(1);
    expect(filterHistory(rows, { symbol: '', side: 'short' })).toHaveLength(1);
    expect(filterHistory(rows, { symbol: 'HBARUSDC', side: 'all' })).toHaveLength(0);
    expect(filterHistory(null, { symbol: '', side: 'all' })).toHaveLength(0);
  });

  it('lista los símbolos sin duplicados', () => {
    expect(historySymbols(rows)).toEqual(['BTCUSDC', 'ETHUSDC']);
    expect(historySymbols([])).toEqual([]);
  });
});

describe('metricsLines', () => {
  it('resume el registro propio con la etiqueta sin evidencia', () => {
    const lines = metricsLines(historyMetrics([row(), row({ key: 'b', realizedPnl: -2, roiPct: -20 })]));
    const text = lines.join('\n');
    expect(text).toContain('2 cerradas · 1 ganadas · 1 perdidas');
    expect(text).toContain('Resultado neto');
    expect(text).toContain('ROI medio');
    expect(text).toContain('Mejor');
    expect(text).toContain('Por símbolo');
    expect(text).toContain('Por lado: largo 2 · corto 0');
    expect(text).toContain('Duración media 1 h');
    expect(text).toContain('Apalancamiento mediano 20x · máximo 20x');
    expect(text).toContain('Aciertos 50 %');
    expect(text).toContain('IC 95 %');
    expect(text).toContain('sin evidencia');
  });

  it('con treinta o más operaciones ya no dice sin evidencia', () => {
    const rows = Array.from({ length: EVIDENCE_MIN_N }, (_v, i) =>
      row({ key: `k${i}`, openedAtMs: i, closedAtMs: i + 1, roiPct: i % 2 ? 5 : -5 }),
    );
    const text = metricsLines(historyMetrics(rows)).join('\n');
    expect(text).not.toContain('sin evidencia');
  });

  it('sin operaciones lo dice sin más', () => {
    expect(metricsLines(historyMetrics([]))).toEqual(['Todavía no hay operaciones leídas.']);
  });
});

describe('openPositionLines', () => {
  const position = (over: Partial<PagePosition> = {}): PagePosition => ({
    symbol: 'BTCUSDC',
    contract: 'perp',
    leverage: 30,
    marginMode: 'cross',
    side: 'short',
    sizeQuote: null,
    sizeBase: -0.004,
    uPnl: 2.1,
    roiPct: 19,
    entry: 82_644.1,
    breakEven: 82_300,
    mark: 82_100,
    liq: 95_000,
    ...over,
  });

  it('una línea por posición, con uPnL y ROI', () => {
    const [line] = openPositionLines([position()]);
    expect(line).toContain('BTCUSDC · corto');
    expect(line).toContain('uPnL +2.1 (+19 %)');
    expect(line).toContain('entrada 82644.1');
    expect(line).toContain('marca 82100');
    expect(line).toContain('liq. 95000');
  });

  it('con tamaño solo en la moneda de cotización lo dice', () => {
    const [line] = openPositionLines([position({ sizeBase: null, sizeQuote: { value: 254.56, asset: 'USDC' } })]);
    expect(line).toContain('254.56 USDC');
  });

  it('sin datos no inventa cifras', () => {
    const [line] = openPositionLines([
      position({ sizeBase: null, sizeQuote: null, entry: null, mark: null, liq: null, uPnl: null, roiPct: null }),
    ]);
    expect(line).toContain('tamaño sin dato');
    expect(line).toContain('uPnL —');
    expect(line).toContain('liq. sin dato');
  });
});
