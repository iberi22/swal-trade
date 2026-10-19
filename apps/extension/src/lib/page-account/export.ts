// CSV del historial leído de la página. Mismo criterio que `account/export.ts`:
// las celdas que empiezan por =+-@ se neutralizan para que una hoja de cálculo
// no las ejecute.

import { formatDuration } from './view';
import type { ClosedPosition } from './parse-history';

const HEADER = [
  'simbolo',
  'lado',
  'estado',
  'apertura_iso',
  'cierre_iso',
  'duracion',
  'apalancamiento',
  'margen',
  'pnl_realizado',
  'activo_pnl',
  'roi_pct',
  'vol_cierre',
  'activo_vol_cierre',
  'entrada',
  'cierre_prom',
  'interes_abierto_max',
];

function textCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function numCell(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function iso(ms: number | null): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

/** CSV con una fila por operación cerrada, de la más nueva a la más vieja. */
export function pageHistoryToCsv(rows: readonly ClosedPosition[] | null | undefined): string {
  const lines = [HEADER.join(',')];
  for (const row of rows ?? []) {
    lines.push(
      [
        textCell(String(row.symbol ?? '')),
        textCell(String(row.side ?? '')),
        textCell(String(row.status ?? '')),
        textCell(iso(row.closedAtMs)),
        textCell(iso(row.openedAtMs)),
        textCell(formatDuration(row.durationMs)),
        numCell(row.leverage),
        textCell(String(row.marginMode ?? '')),
        numCell(row.realizedPnl),
        textCell(String(row.pnlAsset ?? '')),
        numCell(row.roiPct),
        numCell(row.closeVolume),
        textCell(String(row.closeVolumeAsset ?? '')),
        numCell(row.entry),
        numCell(row.avgClose),
        numCell(row.maxOpenInterest),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/** Nombre del archivo: `swal-mis-trades-2026-10-19.csv`. */
export function pageHistoryFilename(nowMs: number): string {
  const date = Number.isFinite(nowMs) ? new Date(nowMs) : new Date();
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `swal-mis-trades-${y}-${m}-${d}.csv`;
}
