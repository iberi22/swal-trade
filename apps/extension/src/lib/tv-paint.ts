/**
 * Lo que comparten el panel, el content script aislado y el puente MAIN-world
 * sobre pintar en el gráfico de Binance.
 *
 * No hay acceso a la cuenta en ningún punto: lo que viaja es una lista de
 * formas con precios y tiempos que salen del análisis de velas públicas.
 */

import type { BridgeShape } from './tv-bridge/schema';

/** Mensaje de runtime: del panel al content script aislado. */
export const TV_PAINT = 'tv-paint';
/** Mensaje de runtime: del content script al panel y al background. */
export const TV_STATE = 'tv-state';
/** Mensaje de runtime: del panel al background. */
export const TV_GET_STATE = 'get-tv-state';

/**
 * Estado del gráfico de la pestaña abierta:
 * - `ready`: el puente tiene el chart de Trading View con rango visible;
 * - `tradingview`: el iframe está, pero el puente todavía no lo ha cogido;
 * - `original`: la pestaña Original, el lienzo propio de Binance (sin API);
 * - `none`: no hay gráfico de este tipo en la página;
 * - `mismatch`: hay chart, pero muestra otro símbolo u otra temporalidad;
 * - `unavailable`: el puente MAIN-world no está (no se puede pintar).
 */
export type TvChartState =
  | 'ready'
  | 'tradingview'
  | 'original'
  | 'none'
  | 'mismatch'
  | 'unavailable';

/** Aviso que se le enseña al usuario según el estado. */
export function tvStateHint(state: TvChartState | null | undefined): string | null {
  if (state === 'original') {
    return 'La pestaña Original es el gráfico propio de Binance y no se puede pintar: cambia a la pestaña Trading View.';
  }
  if (state === 'none') {
    return 'Abre un futuro en Binance para pintar sobre su gráfico.';
  }
  if (state === 'tradingview') {
    return 'El gráfico de Trading View está cargando. En cuanto tenga datos se pinta.';
  }
  if (state === 'unavailable') {
    return 'El puente con el gráfico no está disponible: no se puede pintar en esta página.';
  }
  // `ready`: no estorba. `mismatch`: lo compone el panel con los dos símbolos.
  return null;
}

export interface PaintCommand {
  /** Símbolo y temporalidad del análisis: `BTCUSDT@1h`. */
  key: string;
  shapes: BridgeShape[];
}

/** Páginas donde el panel puede pintar. Públicas, sin cuenta. */
export const PAINTABLE_URL = /^https:\/\/www\.binance\.com\/([a-z-]{2}\/)?futures\//;
