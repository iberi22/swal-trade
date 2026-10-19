// Metricas del historial que la propia pagina muestra. Es el registro pasado
// del usuario, no una prediccion: aqui no hay probabilidades ni promesas.

import { gradeCell, wilsonBounds, type CellGradeResult } from '../account/grading';
import type { ClosedPosition } from './parse-history';
import type { PositionSide } from '../account/types';

export interface SideStats {
  n: number;
  wins: number;
  losses: number;
  netPnl: number;
  winRate: number;
  avgRoiPct: number | null;
}

export interface SymbolStats extends SideStats {
  symbol: string;
}

export interface LeverageStats {
  median: number | null;
  max: number | null;
}

export interface HistoryMetrics {
  n: number;
  wins: number;
  losses: number;
  netPnl: number;
  avgRoiPct: number | null;
  /** Mejor y peor operacion cerrada (la fila completa), null sin filas. */
  best: ClosedPosition | null;
  worst: ClosedPosition | null;
  bySymbol: SymbolStats[];
  bySide: Record<'long' | 'short', SideStats>;
  avgDurationMs: number | null;
  leverage: LeverageStats;
  /** Intervalo de Wilson al 95 % para el win rate observado. */
  winRateCi: [number | null, number | null];
  grade: CellGradeResult;
}

const EMPTY_SIDE = (): SideStats => ({
  n: 0,
  wins: 0,
  losses: 0,
  netPnl: 0,
  winRate: 0,
  avgRoiPct: null,
});

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length % 2) return sorted[middle] ?? null;
  const left = sorted[middle - 1] ?? 0;
  const right = sorted[middle] ?? 0;
  return (left + right) / 2;
}

function pnlOf(row: ClosedPosition): number {
  return typeof row.realizedPnl === 'number' && Number.isFinite(row.realizedPnl)
    ? row.realizedPnl
    : 0;
}

function roiOf(row: ClosedPosition): number | null {
  return typeof row.roiPct === 'number' && Number.isFinite(row.roiPct) ? row.roiPct : null;
}

function durationOf(row: ClosedPosition): number | null {
  if (typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) && row.durationMs >= 0) {
    return row.durationMs;
  }
  if (row.openedAtMs !== null && row.closedAtMs !== null && row.closedAtMs >= row.openedAtMs) {
    return row.closedAtMs - row.openedAtMs;
  }
  return null;
}

function accumulate(stats: SideStats, row: ClosedPosition): void {
  stats.n += 1;
  const pnl = pnlOf(row);
  stats.netPnl += pnl;
  if (pnl > 0) stats.wins += 1;
  if (pnl < 0) stats.losses += 1;
}

function finish(stats: SideStats, roiValues: number[]): SideStats {
  return {
    ...stats,
    winRate: stats.n > 0 ? stats.wins / stats.n : 0,
    avgRoiPct: mean(roiValues),
  };
}

/** Agrega el historial visible. No lanza con filas vacias o incompletas. */
export function historyMetrics(rows: ClosedPosition[] | null | undefined): HistoryMetrics {
  const list = Array.isArray(rows)
    ? rows.filter((row): row is ClosedPosition => Boolean(row) && typeof row === 'object')
    : [];

  const pnls = list.map(pnlOf);
  const rois = list.flatMap((row) => {
    const roi = roiOf(row);
    return roi === null ? [] : [roi];
  });
  const durations = list.flatMap((row) => {
    const duration = durationOf(row);
    return duration === null ? [] : [duration];
  });
  const leverages = list.flatMap((row) =>
    typeof row.leverage === 'number' && Number.isFinite(row.leverage) ? [row.leverage] : [],
  );

  const wins = pnls.filter((pnl) => pnl > 0).length;
  const losses = pnls.filter((pnl) => pnl < 0).length;
  const netPnl = pnls.reduce((sum, pnl) => sum + pnl, 0);

  let best: ClosedPosition | null = null;
  let worst: ClosedPosition | null = null;
  for (const row of list) {
    if (!best || pnlOf(row) > pnlOf(best)) best = row;
    if (!worst || pnlOf(row) < pnlOf(worst)) worst = row;
  }

  const symbolRows = new Map<string, { row: ClosedPosition; rois: number[] }[]>();
  for (const row of list) {
    const bucket = symbolRows.get(row.symbol) ?? [];
    const roi = roiOf(row);
    bucket.push({ row, rois: roi === null ? [] : [roi] });
    symbolRows.set(row.symbol, bucket);
  }
  const bySymbol: SymbolStats[] = [...symbolRows.entries()]
    .map(([symbol, bucket]) => {
      const stats = EMPTY_SIDE();
      const roiValues: number[] = [];
      for (const entry of bucket) {
        accumulate(stats, entry.row);
        roiValues.push(...entry.rois);
      }
      return { symbol, ...finish(stats, roiValues) };
    })
    .sort((a, b) => b.netPnl - a.netPnl || a.symbol.localeCompare(b.symbol));

  const bySide: Record<'long' | 'short', SideStats> = {
    long: EMPTY_SIDE(),
    short: EMPTY_SIDE(),
  };
  const sideRois: Record<'long' | 'short', number[]> = { long: [], short: [] };
  for (const row of list) {
    const side: PositionSide | null = row.side;
    if (side !== 'long' && side !== 'short') continue;
    accumulate(bySide[side], row);
    const roi = roiOf(row);
    if (roi !== null) sideRois[side].push(roi);
  }
  bySide.long = finish(bySide.long, sideRois.long);
  bySide.short = finish(bySide.short, sideRois.short);

  const winPnl = pnls.filter((pnl) => pnl > 0);
  const lossPnl = pnls.filter((pnl) => pnl < 0);
  const avgWin = mean(winPnl) ?? 0;
  const avgLossAbs = Math.abs(mean(lossPnl) ?? 0);
  const rr = avgWin > 0 && avgLossAbs > 0 ? avgWin / avgLossAbs : 1;
  const grade = gradeCell({ n: list.length, wins, netRs: pnls, rr, costR: 0 });
  if (list.length < 30) grade.grade = 'no_evidence';

  return {
    n: list.length,
    wins,
    losses,
    netPnl,
    avgRoiPct: mean(rois),
    best,
    worst,
    bySymbol,
    bySide,
    avgDurationMs: mean(durations),
    leverage: {
      median: median(leverages),
      max: leverages.length > 0 ? Math.max(...leverages) : null,
    },
    winRateCi: wilsonBounds(wins, list.length),
    grade,
  };
}
