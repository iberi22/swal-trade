// Carga útil RELATIVA del historial leído de la página para la IA.
//
// Solo porcentajes, cuentas y ratios: ni importes, ni tamaños, ni precios, ni
// el resultado neto en moneda. Reutiliza la forma `swal.history.v1` que ya
// acepta `src/lib/ai/payload.ts` y el enrutador.

import { buildHistoryPayload, serializeForLlm, type AiHistoryPayload } from '../ai/payload';
import type { HistoryMetrics } from './metrics';

export interface PageHistoryAiPayload extends AiHistoryPayload {
  /** ROI medio de las operaciones cerradas, en % sobre el margen. */
  avg_roi_pct: number | null;
  best_roi_pct: number | null;
  worst_roi_pct: number | null;
  avg_duration_min: number | null;
  leverage_median: number | null;
  leverage_max: number | null;
  /** false mientras el registro propio sea pequeño: sin evidencia. */
  evidence: boolean;
}

/** Mínimo de operaciones para hablar de evidencia (el mismo del motor). */
export const PAGE_AI_MIN_EVIDENCE = 30;

const num = (value: number | null | undefined, dp = 2): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const f = 10 ** dp;
  return Math.round(value * f) / f;
};

function minutes(ms: number | null | undefined): number | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  return num(ms / 60_000, 0);
}

/** Construye la carga útil desde las métricas del historial. */
export function pageHistoryAiPayload(metrics: HistoryMetrics): PageHistoryAiPayload {
  // Lado primero: con muchas filas los símbolos se comen el tope de tres
  // buckets y el reparto largo/corto es lo que más dice del registro.
  const buckets: NonNullable<Parameters<typeof buildHistoryPayload>[0]['buckets']> = [];
  for (const key of ['long', 'short'] as const) {
    const stats = metrics.bySide?.[key];
    if (!stats || stats.n <= 0) continue;
    buckets.push({ by: 'side', key, n: stats.n });
  }
  for (const row of metrics.bySymbol ?? []) {
    if (!row || row.n <= 0) continue;
    buckets.push({ by: 'symbol', key: row.symbol, n: row.n });
  }

  const base = buildHistoryPayload(
    {
      n: metrics.n,
      wins: metrics.wins,
      buckets,
    },
    'relative',
  );

  return {
    ...base,
    // El resultado neto en moneda NO viaja: solo la media de ROI en %.
    avg_roi_pct: num(metrics.avgRoiPct, 2),
    best_roi_pct: num(metrics.best?.roiPct ?? null, 2),
    worst_roi_pct: num(metrics.worst?.roiPct ?? null, 2),
    avg_duration_min: minutes(metrics.avgDurationMs),
    leverage_median: num(metrics.leverage?.median ?? null, 2),
    leverage_max: num(metrics.leverage?.max ?? null, 2),
    evidence: metrics.n >= PAGE_AI_MIN_EVIDENCE,
    grade: null,
  };
}

/** JSON con el mismo tope duro que el resto de cargas de IA. */
export function pageHistoryAiText(metrics: HistoryMetrics): string {
  return serializeForLlm(pageHistoryAiPayload(metrics));
}
