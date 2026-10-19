/**
 * Tendencia actual para la línea de contexto de los tooltips. La escribe
 * MarketPulse (régimen 15m/1h/4h) y la lee cada término al abrirse: no hace
 * falta que sea reactiva, basta con el valor más reciente.
 */
import { trendFromRegimen, type Trend } from '../../lib/glossary/context-line';
import type { TimeframeTrend } from '../../lib/types';

let current: Trend | null = null;

/** Guarda la tendencia vigente; null la borra (par nuevo, sin régimen). */
export function setTermTrend(trend: Trend | null): void {
  current = trend;
}

/** Fija la tendencia a partir del régimen del pulso. */
export function setTermTrendFromRegimen(regimen: readonly TimeframeTrend[] | null | undefined): void {
  current = trendFromRegimen(regimen ?? null);
}

/** Tendencia vigente para el próximo tooltip. */
export function getTermTrend(): Trend | null {
  return current;
}
