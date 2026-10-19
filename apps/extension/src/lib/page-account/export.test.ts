import { describe, expect, it } from 'vitest';
import { pageHistoryFilename, pageHistoryToCsv } from './export';
import type { ClosedPosition } from './parse-history';

const row = (over: Partial<ClosedPosition> = {}): ClosedPosition => ({
  symbol: 'BTCUSDC',
  leverage: 30,
  marginMode: 'cross',
  side: 'short',
  status: 'closed',
  openedAtMs: 1_700_000_000_000,
  closedAtMs: 1_700_010_000_000,
  durationMs: 10_000_000,
  realizedPnl: 1.01,
  pnlAsset: 'USDC',
  roiPct: 9.25,
  closeVolume: 0.004,
  closeVolumeAsset: 'BTC',
  entry: 82_644.1,
  avgClose: 82_330,
  maxOpenInterest: 0.004,
  key: 'BTCUSDC|1700000000000|1700010000000',
  ...over,
});

describe('pageHistoryToCsv', () => {
  it('una cabecera y una fila por operación', () => {
    const csv = pageHistoryToCsv([row(), row({ key: 'b' })]);
    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('simbolo');
    expect(lines[0]).toContain('roi_pct');
    expect(lines[1]).toContain('BTCUSDC');
    expect(lines[1]).toContain('9.25');
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('neutraliza fórmulas de hoja de cálculo', () => {
    const csv = pageHistoryToCsv([row({ symbol: 'BTCUSDC', pnlAsset: '=cmd|calc' })]);
    expect(csv).toContain("'=cmd|calc");
  });

  it('sin filas solo queda la cabecera', () => {
    expect(pageHistoryToCsv([]).trimEnd().split('\n')).toHaveLength(1);
    expect(pageHistoryToCsv(null).trimEnd().split('\n')).toHaveLength(1);
  });

  it('los huecos quedan vacíos, no como "null"', () => {
    const csv = pageHistoryToCsv([row({ realizedPnl: null, roiPct: null, closeVolume: null })]);
    expect(csv).not.toContain('null');
    expect(csv).not.toContain('undefined');
  });
});

describe('pageHistoryFilename', () => {
  it('lleva la fecha en UTC', () => {
    expect(pageHistoryFilename(Date.UTC(2026, 9, 19, 23, 0, 0))).toBe('swal-mis-trades-2026-10-19.csv');
    expect(pageHistoryFilename(Number.NaN)).toMatch(/^swal-mis-trades-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
