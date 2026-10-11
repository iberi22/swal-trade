/**
 * Detección de la pestaña del gráfico de Binance.
 *
 * La pestaña "Original" es el lienzo propio de Binance: no hay iframe ni API.
 * La pestaña "Trading View" monta un iframe del MISMO origen que publica
 * `window.tradingViewApi`. Desde el content script aislado se puede mirar
 * dentro porque comparte origen; de los iframes de otros orígenes ni se entera.
 */

import { chartFromWindow, type TvChartLike } from './tv-bridge/tv-chart';

/** Lo mínimo del DOM que hace falta para la prueba. */
export interface ChartProbeDocument {
  querySelectorAll(selectors: string): ArrayLike<{ contentWindow: unknown }>;
}

/** Ventana del iframe de Trading View, o null. */
export function findTradingViewWindow(doc: ChartProbeDocument): unknown | null {
  let frames: ArrayLike<{ contentWindow: unknown }>;
  try {
    frames = doc.querySelectorAll('iframe');
  } catch {
    return null;
  }
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    let win: unknown = null;
    try {
      win = frame.contentWindow;
    } catch {
      continue; // otro origen
    }
    if (!win) continue;
    if (chartFromWindow(win)) return win;
  }
  return null;
}

export interface TvChartPresence {
  /** El iframe de Trading View está en la página. */
  present: boolean;
  /** El chart tiene rango visible: se puede dibujar ya. */
  drawable: boolean;
}

/** ¿Se puede pintar en esta página y ahora? */
export function probeTvChart(doc: ChartProbeDocument): TvChartPresence {
  const win = findTradingViewWindow(doc);
  if (!win) return { present: false, drawable: false };
  const chart: TvChartLike | null = chartFromWindow(win);
  if (!chart) return { present: false, drawable: false };
  let drawable = false;
  try {
    const range = chart.getVisibleRange();
    const from = Number(range?.from);
    const to = Number(range?.to);
    drawable = Number.isFinite(from) && Number.isFinite(to) && to > from;
  } catch {
    drawable = false;
  }
  return { present: true, drawable };
}
