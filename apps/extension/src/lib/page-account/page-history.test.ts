import { describe, expect, it } from 'vitest';
import { droppedHistoryKeys, mergePageHistory, pageHistoryTime } from './page-history';
import type { ClosedPosition } from './parse-history';

const row = (key: string, closed: number | null, over: Partial<ClosedPosition> = {}): ClosedPosition => ({
  symbol: 'BTCUSDC',
  leverage: 30,
  marginMode: 'cross',
  side: 'short',
  status: closed === null ? 'open' : 'closed',
  openedAtMs: closed === null ? 1 : closed - 1000,
  closedAtMs: closed,
  durationMs: closed === null ? null : 1000,
  realizedPnl: 1,
  pnlAsset: 'USDC',
  roiPct: 1,
  closeVolume: null,
  closeVolumeAsset: null,
  entry: 100,
  avgClose: 101,
  maxOpenInterest: null,
  key,
  ...over,
});

describe('mergePageHistory', () => {
  it('ordena de la más nueva a la más vieja', () => {
    const merged = mergePageHistory([row('a', 100), row('c', 300)], [row('b', 200)]);
    expect(merged.map((r) => r.key)).toEqual(['c', 'b', 'a']);
  });

  it('deduplica por clave: gana la fila entrante y conserva lo que no vio', () => {
    const merged = mergePageHistory(
      [row('a', 100, { roiPct: 5, realizedPnl: 2 })],
      [row('a', 100, { roiPct: 7, realizedPnl: null as unknown as number })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.roiPct).toBe(7);
    // null = "no lo vi": no borra el valor anterior.
    expect(merged[0]?.realizedPnl).toBe(2);
  });

  it('corta en el límite y tira las más viejas', () => {
    const existing = Array.from({ length: 6 }, (_v, i) => row(`k${i}`, 1000 + i));
    const merged = mergePageHistory(existing, [], 3);
    expect(merged.map((r) => r.key)).toEqual(['k5', 'k4', 'k3']);
  });

  it('aguanta basura sin lanzar', () => {
    expect(mergePageHistory(null, undefined)).toEqual([]);
    expect(mergePageHistory([{ key: '' } as ClosedPosition], [null as unknown as ClosedPosition])).toEqual([]);
    expect(mergePageHistory([row('a', 1)], [], Number.NaN)).toHaveLength(1);
  });

  it('usa la apertura cuando falta el cierre y ordena estable', () => {
    expect(pageHistoryTime(row('a', null))).toBe(1);
    const merged = mergePageHistory([row('a', null)], [row('b', 50)]);
    expect(merged.map((r) => r.key)).toEqual(['b', 'a']);
  });

  it('sin fechas se ordena por símbolo y clave', () => {
    const merged = mergePageHistory(
      [row('z', null, { openedAtMs: null, closedAtMs: null }), row('b', null, { openedAtMs: null, closedAtMs: null, symbol: 'AAAUSDC' })],
      [],
    );
    expect(merged.map((r) => r.symbol)).toEqual(['AAAUSDC', 'BTCUSDC']);
  });
});

describe('droppedHistoryKeys', () => {
  it('dice qué claves sobran al recortar', () => {
    const before = [row('a', 1), row('b', 2), row('c', 3)];
    const after = [row('c', 3), row('b', 2)];
    expect(droppedHistoryKeys(before, after)).toEqual(['a']);
    expect(droppedHistoryKeys(before, before)).toEqual([]);
  });
});
