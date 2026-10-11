// Helpers puros del panel de flujo de volumen (CVD) del panel lateral.
// Sin DOM ni red: los consume chart.ts para dibujar y los tests de vitest.
// El cálculo (delta, CVD, buyShare) es del núcleo compartido; aquí solo se
// traduce a puntos de lightweight-charts y a los marcadores de agresión.
// Un solo tono: el signo se lee por la altura, nunca por el color.
import type { Candle, Finding, VolumeFlow } from './types';
import type { ChartMarker } from './findings-view';

/** Definición corta del panel, en castellano y sin jerga. */
export const CVD_LEGEND_TEXT = 'CVD = compra agresiva acumulada − venta agresiva acumulada (volumen taker)';

/** Nota cuando la ventana no trae volumen taker (velas antiguas, núcleo stub). */
export const CVD_NO_DATA_TEXT = 'Esta ventana no trae volumen taker: sin delta ni CVD.';

/** Pasos del único tono (--foreground). Sin rojo ni verde. */
export const CVD_TONE = {
  line: 'hsl(30 12% 12%)',
  deltaUp: 'hsl(30 12% 12% / 0.35)',
  deltaDown: 'hsl(30 12% 12% / 0.85)',
};

export interface FlowPoint {
  time: number;
  value: number;
}

export interface FlowBar extends FlowPoint {
  color: string;
}

function seconds(time: unknown): number | null {
  const n = typeof time === 'number' ? time : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const value = n > 10_000_000_000 ? Math.floor(n / 1000) : Math.floor(n);
  return value > 0 ? value : null;
}

/**
 * Línea del CVD: un punto por vela. Vacía si no hay flujo (el núcleo devolvió
 * `null`) o si las longitudes no casan con las velas.
 */
export function cvdLineData(candles: readonly Candle[], flow: VolumeFlow | null | undefined): FlowPoint[] {
  if (!flow || !Array.isArray(flow.cvd)) return [];
  const out: FlowPoint[] = [];
  for (let i = 0; i < candles.length && i < flow.cvd.length; i += 1) {
    const candle = candles[i];
    const time = seconds(candle?.time);
    const value = flow.cvd[i];
    if (time === null || typeof value !== 'number' || !Number.isFinite(value)) continue;
    out.push({ time, value });
  }
  return out;
}

/**
 * Histograma del delta por vela. El tono sube con el signo negativo para que la
 * presión vendedora pese más que la compradora, sin usar color.
 */
export function cvdHistogramData(
  candles: readonly Candle[],
  flow: VolumeFlow | null | undefined,
  tone: Partial<typeof CVD_TONE> = {},
): FlowBar[] {
  if (!flow || !Array.isArray(flow.delta)) return [];
  const positiveColor = tone.deltaUp ?? CVD_TONE.deltaUp;
  const negativeColor = tone.deltaDown ?? CVD_TONE.deltaDown;
  const out: FlowBar[] = [];
  for (let i = 0; i < candles.length && i < flow.delta.length; i += 1) {
    const candle = candles[i];
    const time = seconds(candle?.time);
    const value = flow.delta[i];
    if (time === null || typeof value !== 'number' || !Number.isFinite(value)) continue;
    out.push({ time, value, color: value < 0 ? negativeColor : positiveColor });
  }
  return out;
}

/** Ancla un tiempo a la vela más cercana; sin velas, lo deja como está. */
export function nearestCandleTime(times: readonly number[], target: number): number | null {
  const time = seconds(target);
  if (time === null || times.length === 0) return time;
  let best = times[0]!;
  let bestDist = Math.abs(best - time);
  for (const value of times) {
    const dist = Math.abs(value - time);
    if (dist < bestDist) {
      best = value;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Marcadores ▲/▼ de los choques de volumen con agresión (`volume_shock_buy` /
 * `volume_shock_sell`): compra agresiva debajo de la vela, venta agresiva
 * encima. El resto de hallazgos se pintan con sus propias anotaciones.
 */
export function volumeShockMarkers(
  findings: readonly Finding[],
  candleTimes: readonly number[] = [],
): ChartMarker[] {
  const out: ChartMarker[] = [];
  for (const finding of findings) {
    const kind = String(finding.kind ?? '');
    const buy = kind === 'volume_shock_buy';
    const sell = kind === 'volume_shock_sell';
    if (!buy && !sell) continue;
    const time = nearestCandleTime(candleTimes, finding.from);
    if (time === null) continue;
    out.push({
      time,
      position: buy ? 'belowBar' : 'aboveBar',
      shape: buy ? 'arrowUp' : 'arrowDown',
      text: buy ? '▲' : '▼',
      findingId: String(finding.id),
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Texto de la leyenda del panel, con el aviso cuando no hay datos que pintar. */
export function flowLegendText(candles: readonly Candle[], flow: VolumeFlow | null | undefined): string {
  return cvdLineData(candles, flow).length ? CVD_LEGEND_TEXT : `${CVD_LEGEND_TEXT} ${CVD_NO_DATA_TEXT}`;
}
