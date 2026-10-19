// Texto de la pestaña «Mis trades». Solo números de la página: el registro
// pasado del usuario, sin probabilidades ni recomendaciones.

import type { HistoryMetrics } from './metrics';
import type { ClosedPosition } from './parse-history';
import type { PagePosition } from './parse-positions';
import type { PositionSide } from '../account/types';

/** Mínimo de operaciones para hablar de evidencia (igual que el motor). */
export const EVIDENCE_MIN_N = 30;

export type HistorySideFilter = 'all' | PositionSide;

export interface HistoryFilters {
  symbol: string;
  side: HistorySideFilter;
}

const num = (value: number, digits = 2): string => {
  if (!Number.isFinite(value)) return '—';
  const fixed = value.toFixed(digits);
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
};

/** `+9.25 %`, `-62.05 %`, `0 %`, `—`. */
export function formatPct(value: number | null | undefined, digits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${num(value, digits)} %`;
}

/** `+1.01 USDC`, `-10.57 USDC`; sin activo, solo el número. */
export function formatAmount(value: number | null | undefined, asset: string | null = null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${num(value, 2)}${asset ? ` ${asset}` : ''}`;
}

/** `10 h 35 min`, `45 min`, `2 d 3 h`; `—` sin dato. */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const totalMinutes = Math.round(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  if (totalMinutes > 0) return `${totalMinutes} min`;
  return 'menos de 1 min';
}

/** Lado en palabras del registro propio; sin lenguaje de compra/venta. */
export function sideLabel(side: PositionSide | null | undefined): string {
  if (side === 'long') return 'largo';
  if (side === 'short') return 'corto';
  return 'sin lado';
}

export function filterHistory(
  rows: readonly ClosedPosition[] | null | undefined,
  filters: HistoryFilters,
): ClosedPosition[] {
  const symbol = typeof filters.symbol === 'string' ? filters.symbol : '';
  const side = filters.side;
  return (rows ?? []).filter(
    (row) => (symbol === '' || row.symbol === symbol) && (side === 'all' || row.side === side),
  );
}

/** Símbolos presentes en el historial, ordenados. */
export function historySymbols(rows: readonly ClosedPosition[] | null | undefined): string[] {
  const seen = new Set<string>();
  for (const row of rows ?? []) if (row.symbol) seen.add(row.symbol);
  return [...seen].sort();
}

/**
 * Líneas de la tarjeta de métricas. Etiquetas cortas, sin jerga y sin promesas:
 * cuando hay pocas operaciones el win rate se marca «sin evidencia».
 */
export function metricsLines(metrics: HistoryMetrics): string[] {
  const lines: string[] = [];
  if (metrics.n === 0) return ['Todavía no hay operaciones leídas.'];
  lines.push(`${metrics.n} cerradas · ${metrics.wins} ganadas · ${metrics.losses} perdidas`);
  lines.push(`Resultado neto ${formatAmount(metrics.netPnl, metrics.best?.pnlAsset ?? null)}`);
  lines.push(`ROI medio ${formatPct(metrics.avgRoiPct)}`);
  if (metrics.best && metrics.worst) {
    lines.push(
      `Mejor ${formatPct(metrics.best.roiPct)} (${metrics.best.symbol}) · peor ${formatPct(
        metrics.worst.roiPct,
      )} (${metrics.worst.symbol})`,
    );
  }
  const bySymbol = metrics.bySymbol
    .slice(0, 4)
    .map((row) => `${row.symbol} ${row.n}`)
    .join(' · ');
  if (bySymbol) lines.push(`Por símbolo: ${bySymbol}`);
  lines.push(
    `Por lado: largo ${metrics.bySide.long.n} · corto ${metrics.bySide.short.n}`,
  );
  lines.push(`Duración media ${formatDuration(metrics.avgDurationMs)}`);
  if (metrics.leverage.median !== null || metrics.leverage.max !== null) {
    lines.push(
      `Apalancamiento mediano ${metrics.leverage.median === null ? '—' : `${num(metrics.leverage.median, 1)}x`} · máximo ${
        metrics.leverage.max === null ? '—' : `${num(metrics.leverage.max, 1)}x`
      }`,
    );
  }
  const [low, high] = metrics.winRateCi;
  const interval =
    low === null || high === null
      ? ''
      : ` · IC 95 % ${num(low * 100, 1)}–${num(high * 100, 1)} %`;
  const evidence = metrics.n < EVIDENCE_MIN_N ? ' · sin evidencia' : '';
  const winRate = metrics.n > 0 ? (metrics.wins / metrics.n) * 100 : null;
  const winText = winRate === null ? '—' : `${num(winRate, 1)} %`;
  lines.push(`Aciertos ${winText}${interval}${evidence}`);
  return lines;
}

/** Una línea por posición abierta leída de la página. */
export function openPositionLines(rows: readonly PagePosition[]): string[] {
  return rows.map((row) => {
    const size =
      row.sizeBase !== null
        ? `${num(row.sizeBase, 6)} ${row.symbol.replace(/(USDT|USDC|BUSD)$/, '')}`
        : row.sizeQuote !== null
          ? `${num(row.sizeQuote.value, 2)} ${row.sizeQuote.asset}`
          : 'tamaño sin dato';
    const pnl = `${formatAmount(row.uPnl)}${row.roiPct === null ? '' : ` (${formatPct(row.roiPct)})`}`;
    const parts = [
      `${row.symbol} · ${sideLabel(row.side)} · ${size}`,
      `uPnL ${pnl}`,
      `entrada ${row.entry === null ? '—' : num(row.entry, 6)}`,
      `marca ${row.mark === null ? '—' : num(row.mark, 6)}`,
      `liq. ${row.liq === null ? 'sin dato' : num(row.liq, 6)}`,
    ];
    return parts.join(' · ');
  });
}
