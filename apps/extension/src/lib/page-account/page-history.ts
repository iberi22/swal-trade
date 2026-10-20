// Orden y deduplicación del historial leído de la página. Puro: no toca
// IndexedDB ni el DOM, así que se puede probar sin navegador.
//
// Dos lecturas de la página devuelven casi las mismas tarjetas (y a veces una
// nueva): se juntan por `key` y se guardan como mucho `PAGE_HISTORY_KEEP` filas,
// de la más reciente a la más antigua.

import type { ClosedPosition } from './parse-history';
import { PAGE_HISTORY_KEEP } from './messages';

/** «última sincronización hace X» a partir del instante de la última fusión. */
export function pageSyncLabel(syncedAtMs: number | null | undefined, nowMs: number): string | null {
  if (typeof syncedAtMs !== 'number' || !Number.isFinite(syncedAtMs)) return null;
  if (!Number.isFinite(nowMs)) return null;
  const seconds = Math.max(0, Math.floor((nowMs - syncedAtMs) / 1000));
  if (seconds < 60) return `última sincronización hace ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `última sincronización hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `última sincronización hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `última sincronización hace ${days} ${days === 1 ? 'día' : 'días'}`;
}

/** Instante de la fila: el cierre manda; si falta, la apertura. */
export function pageHistoryTime(row: ClosedPosition): number {
  if (typeof row.closedAtMs === 'number' && Number.isFinite(row.closedAtMs)) return row.closedAtMs;
  if (typeof row.openedAtMs === 'number' && Number.isFinite(row.openedAtMs)) return row.openedAtMs;
  return 0;
}

function compare(a: ClosedPosition, b: ClosedPosition): number {
  const diff = pageHistoryTime(b) - pageHistoryTime(a);
  if (diff !== 0) return diff;
  // Empate (o fechas ausentes): el símbolo y la clave dan un orden estable.
  if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
  return a.key.localeCompare(b.key);
}

/**
 * Une lo guardado con lo recién leído: gana la fila entrante (puede traer más
 * campos), se deduplica por `key`, se ordena de más nueva a más vieja y se
 * corta en `limit`.
 */
export function mergePageHistory(
  existing: readonly ClosedPosition[] | null | undefined,
  incoming: readonly ClosedPosition[] | null | undefined,
  limit = PAGE_HISTORY_KEEP,
): ClosedPosition[] {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : PAGE_HISTORY_KEEP;
  const byKey = new Map<string, ClosedPosition>();
  for (const row of existing ?? []) {
    if (!row || typeof row !== 'object' || typeof row.key !== 'string' || !row.key) continue;
    byKey.set(row.key, row);
  }
  for (const row of incoming ?? []) {
    if (!row || typeof row !== 'object' || typeof row.key !== 'string' || !row.key) continue;
    const previous = byKey.get(row.key);
    // Se conserva lo viejo que la nueva lectura no pudo ver (campos ausentes).
    byKey.set(row.key, previous ? { ...previous, ...withoutNulls(row) } : row);
  }
  return [...byKey.values()].sort(compare).slice(0, cap);
}

/** Copia de la fila sin los campos nulos: null significa "no lo vi", no "vale null". */
function withoutNulls(row: ClosedPosition): Partial<ClosedPosition> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null) continue;
    out[key] = value;
  }
  return out as Partial<ClosedPosition>;
}

/** Claves que sobran al recortar (para borrarlas del almacén). */
export function droppedHistoryKeys(
  before: readonly ClosedPosition[],
  after: readonly ClosedPosition[],
): string[] {
  const keep = new Set(after.map((row) => row.key));
  const dropped: string[] = [];
  for (const row of before) {
    if (!keep.has(row.key)) dropped.push(row.key);
  }
  return dropped;
}
