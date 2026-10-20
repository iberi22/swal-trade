import { describe, expect, it } from 'vitest';
import { droppedHistoryKeys, mergePageHistory, pageHistoryTime, pageSyncLabel } from './page-history';
import { createMemoryPageHistory } from './idb-page-history';
import { PAGE_HISTORY_KEEP } from './messages';
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

describe('persistencia', () => {
  it('guarda hasta 5000 filas', () => {
    expect(PAGE_HISTORY_KEEP).toBe(5000);
    const many = Array.from({ length: 6000 }, (_v, i) => row(`k${i}`, 1000 + i));
    expect(mergePageHistory(many, []).length).toBe(5000);
  });

  it('la memoria del historial fusiona entre lecturas y deduplica por clave', async () => {
    const storage = createMemoryPageHistory();
    const first = await storage.merge([row('BTCUSDC|1|2', 2), row('ETHUSDC|3|4', 4)]);
    expect(first.map((r) => r.key)).toEqual(['ETHUSDC|3|4', 'BTCUSDC|1|2']);
    // La segunda lectura trae la misma tarjeta de BTC (con un campo más) y una nueva.
    const second = await storage.merge([row('BTCUSDC|1|2', 2, { roiPct: 9 }), row('SOLUSDC|5|6', 6)]);
    expect(second.map((r) => r.key)).toEqual(['SOLUSDC|5|6', 'ETHUSDC|3|4', 'BTCUSDC|1|2']);
    expect(second.find((r) => r.key === 'BTCUSDC|1|2')?.roiPct).toBe(9);
    // Lo guardado sobrevive a la siguiente consulta: no se pierde al leer.
    expect((await storage.load()).map((r) => r.key)).toEqual(second.map((r) => r.key));
    await storage.clear();
    expect(await storage.load()).toEqual([]);
  });

  it('la clave es símbolo|apertura|cierre y no se repite', () => {
    const merged = mergePageHistory([], [row('X|10|20', 20), row('X|10|20', 20)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.key.split('|')).toHaveLength(3);
  });
});

describe('pageSyncLabel', () => {
  it('dice cuánto hace de la última sincronización', () => {
    expect(pageSyncLabel(1_000, 13_000)).toBe('última sincronización hace 12 s');
    expect(pageSyncLabel(0, 180_000)).toBe('última sincronización hace 3 min');
    expect(pageSyncLabel(0, 2 * 3_600_000)).toBe('última sincronización hace 2 h');
    expect(pageSyncLabel(0, 86_400_000)).toBe('última sincronización hace 1 día');
    expect(pageSyncLabel(0, 3 * 86_400_000)).toBe('última sincronización hace 3 días');
  });

  it('sin dato o con el reloj al revés no inventa nada', () => {
    expect(pageSyncLabel(null, 1)).toBeNull();
    expect(pageSyncLabel(undefined, 1)).toBeNull();
    expect(pageSyncLabel(Number.NaN, 1)).toBeNull();
    expect(pageSyncLabel(10_000, 1_000)).toBe('última sincronización hace 0 s');
  });
});
