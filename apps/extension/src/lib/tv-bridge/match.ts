/**
 * ¿Coincide el gráfico con el análisis que se quiere pintar?
 *
 * El panel manda su par y su temporalidad en la clave del mensaje
 * (`BTCUSDT@1h`). El gráfico de Binance expone `symbol()` (p. ej.
 * `BTCUSDT@PRICETYPE=LAST`) y `resolution()` (p. ej. `1D` o `60`). Pintar los
 * niveles de BTC en 1h sobre un gráfico de ETH, o sobre uno de 4h, sería
 * inventar contexto: aquí se compara símbolo y temporalidad ya normalizados y,
 * si no coinciden, el puente no dibuja y lo dice.
 *
 * Las funciones son puras: reciben el chart (o su clave) y la clave del mensaje,
 * sin tocar el DOM, así que se prueban sin navegador.
 */

import { normalizeSymbol, parseIntervalLabel } from '../market-context';
import type { Timeframe } from '../types';
import type { TvChartLike } from './tv-chart';

/** Símbolo y temporalidad ya normalizados de un análisis o de un gráfico. */
export interface Identity {
  symbol: string;
  tf: Timeframe | null;
}

/** Lo que se le enseña al usuario del gráfico cuando no coincide. */
export interface ChartDisplay {
  symbol: string;
  tf: string;
}

/**
 * Lee la clave del mensaje (`símbolo@tf`). Devuelve null si no encaja: sin clave
 * válida no se puede afirmar que el gráfico case con el análisis.
 */
export function analysisFromKey(key: string): Identity | null {
  if (typeof key !== 'string' || !key) return null;
  const idx = key.lastIndexOf('@');
  if (idx <= 0) return null;
  const symbol = normalizeSymbol(key.slice(0, idx));
  if (!symbol) return null;
  return { symbol, tf: parseIntervalLabel(key.slice(idx + 1), { bare: true }) };
}

/** Símbolo y temporalidad que reporta el chart, normalizados. */
export function chartIdentity(chart: TvChartLike): { identity: Identity; rawResolution: string } {
  let rawSymbol = '';
  let rawResolution = '';
  try {
    rawSymbol = String(chart.symbol?.() ?? '');
  } catch {
    rawSymbol = '';
  }
  try {
    rawResolution = chart.resolution ? String(chart.resolution?.() ?? '') : '';
  } catch {
    rawResolution = '';
  }
  const base = rawSymbol.split('@')[0] ?? '';
  const symbol = normalizeSymbol(base) ?? base.toUpperCase();
  return { identity: { symbol, tf: parseIntervalLabel(rawResolution, { bare: true }) }, rawResolution };
}

/** Texto del gráfico para el aviso: símbolo legible y tf (o la resolución cruda). */
export function describeChart(chart: TvChartLike): ChartDisplay {
  const { identity, rawResolution } = chartIdentity(chart);
  return { symbol: identity.symbol, tf: identity.tf ?? (rawResolution || '?') };
}

/**
 * true solo si coinciden símbolo Y temporalidad, ambos normalizados. Si algo no
 * se puede normalizar (clave rara, resolución fuera de nuestras seis), se
 * considera que NO coincide: más vale no pintar que pintar donde no toca.
 */
export function chartMatchesAnalysis(chart: TvChartLike, key: string): boolean {
  const analysis = analysisFromKey(key);
  if (!analysis || !analysis.tf) return false;
  const { identity } = chartIdentity(chart);
  if (!identity.tf) return false;
  return analysis.symbol === identity.symbol && analysis.tf === identity.tf;
}
