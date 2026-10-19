/**
 * Línea de contexto por tendencia del tooltip. Puro: sin DOM, sin red.
 * El texto de cada tendencia sale de `glossary.<id>.up|down|range`; el prefijo
 * «Tendencia actual: …» solo aparece cuando el panel sabe la tendencia.
 */
import type { GlossaryEntry } from './entries';
import type { TimeframeTrend } from '../types';
import { entryText, uiText } from './text';

export type Trend = 'up' | 'down' | 'range';

/** Etiqueta corta de la tendencia (`alcista`, `bajista`, `lateral`). */
export function trendLabel(trend: Trend): string {
  return uiText(`trend_${trend}`);
}

/**
 * Texto de referencia de la entrada para la tendencia dada, con el prefijo
 * «Tendencia actual: alcista». Sin tendencia devuelve null: no se inventa
 * contexto que el panel no conozca.
 */
export function trendContext(entry: GlossaryEntry | null | undefined, trend: Trend | null): string | null {
  if (!entry || !trend) return null;
  const body = entryText(entry.id, trend);
  if (!body) return null;
  return `${uiText('current_trend', { trend: trendLabel(trend) })} — ${body}`;
}

/** Dirección del régimen (15m/1h/4h) como tendencia del glosario. */
export function trendFromDirection(direction: unknown): Trend | null {
  if (direction === 'up') return 'up';
  if (direction === 'down') return 'down';
  if (direction === 'neutral') return 'range';
  return null;
}

/**
 * Tendencia del panel a partir del régimen de MarketPulse. Se prefiere 1h (el
 * marco con el que se leen los niveles del mapa) y se cae a la primera
 * temporalidad disponible. Sin régimen devuelve null.
 */
export function trendFromRegimen(regimen: readonly TimeframeTrend[] | null | undefined): Trend | null {
  if (!regimen || regimen.length === 0) return null;
  const row = regimen.find((item) => item.timeframe === '1h') ?? regimen[0];
  return trendFromDirection(row?.direction);
}
