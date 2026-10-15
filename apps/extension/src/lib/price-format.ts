/**
 * Formato de precios para el panel y para la escala del gráfico.
 *
 * Un precio de 0,0041558 (1000PEPE) no cabe en dos decimales: se mostraría como `0`.
 * Por eso el formato depende de la magnitud del precio, no de una cifra fija.
 */

const PANEL_LOCALE = 'es-ES';
const WIDE = new Intl.NumberFormat(PANEL_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SMALL = new Intl.NumberFormat(PANEL_LOCALE, { maximumSignificantDigits: 8 });

/** Precio para el panel: |p| >= 1 con 2 decimales; |p| < 1 con hasta 8 cifras significativas. */
export function formatPanelPrice(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Math.abs(value) >= 1 ? WIDE.format(value) : SMALL.format(value);
}

/**
 * Nivel típico en USDT: cantidad mediana del libro (en el activo base) por el precio medio.
 * Devuelve null si falta el precio medio o la cantidad.
 */
export function typicalLevelUsd(medianSize: number, mid: number | null): number | null {
  if (mid === null || !Number.isFinite(mid) || mid <= 0) return null;
  if (!Number.isFinite(medianSize) || medianSize < 0) return null;
  return medianSize * mid;
}

export interface ChartPriceFormat {
  type: 'price';
  precision: number;
  minMove: number;
}

/**
 * Formato de la escala de precios para lightweight-charts: decimales necesarios para
 * 6 cifras significativas del precio actual, con un mínimo de 2 y un máximo de 10.
 */
export function chartPriceFormat(price: number): ChartPriceFormat {
  if (!Number.isFinite(price) || price <= 0) return { type: 'price', precision: 2, minMove: 0.01 };
  const sixSignificant = 5 - Math.floor(Math.log10(price));
  const precision = Math.min(10, Math.max(2, sixSignificant));
  return { type: 'price', precision, minMove: 10 ** -precision };
}
