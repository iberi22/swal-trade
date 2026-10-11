/**
 * Adaptador fino sobre la API de TradingView que expone Binance.
 *
 * Todo lo de aquí está verificado en `e2e/scripts/investigation/` (commits
 * da88477 y siguientes), no supuesto:
 *
 * - el iframe de la pestaña "Trading View" es del mismo origen y publica
 *   `window.tradingViewApi.activeChart()`;
 * - `createShape(punto, opciones)` y `createMultipointShape(puntos, opciones)`
 *   devuelven una Promesa que resuelve a un id de texto;
 * - `removeEntity(id)` es sincrónico;
 * - crear antes de que el chart tenga rango visible lanza "Cannot create …";
 * - las formas que acepta el punto único son `horizontal_line`, `horizontal_ray`,
 *   `vertical_line`, `text`, `arrow_up`, `arrow_down`, `balloon`, `comment`;
 *   las de dos puntos, `trend_line`, `ray`, `rectangle`, `arrow`;
 * - `getAllShapes()` devuelve `{ id, name }` por entidad.
 *
 * Un solo tono neutro y opacidad baja: esto es una anotación, no una señal.
 */

import type { BridgeShape } from './schema';

/**
 * Tinta única para todo lo que pintamos. Gris medio sin ningún matiz: se ve
 * igual sobre el gráfico oscuro de Binance que sobre uno claro, y no compite
 * con el rojo y el verde de las velas. La opacidad la da el propio trazo.
 */
export const SWAL_INK = '#8a8a8a';

/** Opacidad de las zonas: 0 es opaco, 95 es casi invisible. */
const ZONE_TRANSPARENCY = 82;

export interface TvVisibleRange {
  from: number;
  to: number;
}

export interface TvShapeHandle {
  id: unknown;
  name?: string;
}

/** Lo que usamos del chart. Nada de account ni de order forms. */
export interface TvChartLike {
  getVisibleRange(): TvVisibleRange | null;
  symbol(): string;
  resolution?(): string | null;
  createShape(point: { time: number; price: number }, options: unknown): unknown;
  createMultipointShape(points: Array<{ time: number; price: number }>, options: unknown): unknown;
  removeEntity(id: string): void;
  getAllShapes?(): TvShapeHandle[];
  onSymbolChanged?(callback: () => void): void;
  onIntervalChanged?(callback: () => void): void;
}

export interface TvApiWindow {
  tradingViewApi?: { activeChart(): TvChartLike | null };
}

type ChartWindow = TvApiWindow & Window;

/** Ventana que expone la API del gráfico, si es esta. */
export function chartFromWindow(win: unknown): TvChartLike | null {
  const candidate = win as TvApiWindow | null;
  if (!candidate) return null;
  let api: TvApiWindow['tradingViewApi'];
  try {
    // Tocar una propiedad de una ventana de otro origen lanza SecurityError:
    // el iframe de accounts.binance.com está en la misma página.
    api = candidate.tradingViewApi;
  } catch {
    return null;
  }
  if (!api || typeof api.activeChart !== 'function') return null;
  try {
    const chart = api.activeChart();
    return chart && typeof chart.createShape === 'function' ? chart : null;
  } catch {
    return null;
  }
}

/**
 * Busca la ventana del gráfico: `selfWindow` si es el iframe del chart, o el
 * primer iframe del mismo origen que publique la API. Los iframes de otros
 * orígenes (accounts.binance.com) se saltan sin tocar nada.
 */
export function findChartWindow(doc: Document, selfWindow?: unknown): ChartWindow | null {
  if (selfWindow != null) {
    const self = chartFromWindow(selfWindow);
    if (self) return selfWindow as ChartWindow;
  }
  let frames: HTMLIFrameElement[] = [];
  try {
    frames = [...doc.querySelectorAll('iframe')];
  } catch {
    return null;
  }
  for (const frame of frames) {
    let win: Window | null = null;
    try {
      win = frame.contentWindow;
    } catch {
      continue; // cross-origin
    }
    if (!win) continue;
    if (chartFromWindow(win)) return win as ChartWindow;
  }
  return null;
}

/** El chart miente hasta que tiene datos: un rango a cero es "arrancando". */
export function visibleRange(chart: TvChartLike): TvVisibleRange | null {
  try {
    const range = chart.getVisibleRange();
    const from = Number(range?.from);
    const to = Number(range?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
    return { from, to };
  } catch {
    return null;
  }
}

/** Símbolo y temporalidad del chart, para detectar el cambio sin adivinar. */
export function chartKey(chart: TvChartLike): string {
  let symbol = '';
  let resolution = '';
  try {
    symbol = String(chart.symbol() ?? '');
  } catch {
    symbol = '';
  }
  try {
    resolution = chart.resolution ? String(chart.resolution() ?? '') : '';
  } catch {
    resolution = '';
  }
  return `${symbol}@${resolution}`;
}

/**
 * Meter un punto dentro del margen visible. Un punto muy lejos no se ve y la
 * API puede rechazarlo; holgura de un span a cada lado.
 */
export function clampTime(time: number, range: TvVisibleRange): number {
  const span = range.to - range.from;
  const low = range.from - span;
  const high = range.to + span;
  if (!Number.isFinite(time)) return range.from;
  if (time < low) return Math.floor(low);
  if (time > high) return Math.floor(high);
  return Math.floor(time);
}

function lineOverrides(shape: BridgeShape): Record<string, unknown> {
  return {
    linecolor: SWAL_INK,
    linewidth: 1,
    linestyle: shape.style === 'dashed' ? 2 : 0,
    textcolor: SWAL_INK,
    color: SWAL_INK,
    fontsize: 11,
    showLabel: true,
    horzLabelsAlign: 'right',
    // Bloqueo: el usuario no debe mover nuestras anotaciones sin querer.
    locked: true,
    disableSelection: true,
  };
}

function zoneOverrides(): Record<string, unknown> {
  return {
    linecolor: SWAL_INK,
    linewidth: 1,
    backgroundColor: SWAL_INK,
    backgroundFilled: true,
    transparency: ZONE_TRANSPARENCY,
    showLabel: false,
    locked: true,
    disableSelection: true,
  };
}

function markerOverrides(): Record<string, unknown> {
  return {
    color: SWAL_INK,
    textcolor: SWAL_INK,
    fontsize: 11,
    showLabel: true,
    locked: true,
    disableSelection: true,
  };
}

/**
 * Crea la entidad en el gráfico. Devuelve lo que devuelva la API (Promesa o id)
 * para que el registro se ocupe del resto.
 */
export function createEntity(
  chart: TvChartLike,
  shape: BridgeShape,
  range: TvVisibleRange,
): unknown {
  const points = shape.points.map((point) => ({
    time: clampTime(point.time, range),
    price: point.price,
  }));
  switch (shape.kind) {
    case 'trend':
      return chart.createMultipointShape(points, {
        shape: 'trend_line',
        text: shape.text,
        overrides: lineOverrides(shape),
      });
    case 'zone':
      return chart.createMultipointShape(points, {
        shape: 'rectangle',
        text: shape.text,
        overrides: zoneOverrides(),
      });
    case 'arrow': {
      const point = points[0];
      if (!point) return null;
      return chart.createShape(point, {
        shape: shape.direction === 'down' ? 'arrow_down' : 'arrow_up',
        text: shape.text,
        overrides: markerOverrides(),
      });
    }
    case 'label': {
      const point = points[0];
      if (!point) return null;
      return chart.createShape(point, {
        shape: 'text',
        text: shape.text,
        overrides: markerOverrides(),
      });
    }
    default: {
      const point = points[0];
      if (!point) return null;
      return chart.createShape(point, {
        shape: 'horizontal_line',
        text: shape.text,
        overrides: lineOverrides(shape),
      });
    }
  }
}
