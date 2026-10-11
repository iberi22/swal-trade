// volume-flow-view.js — helpers puros del panel de flujo de volumen (CVD).
// Sin DOM, sin red y sin reloj: los usa analisis.js en el navegador y los tests
// de workers/public-site/test. El cálculo (delta, CVD, buyShare) vive en
// analysis-core.js (`volumeFlow`); aquí solo se traduce a lo que dibuja
// lightweight-charts: una línea de CVD, un histograma de delta y los marcadores
// de choque con agresión. Un solo tono: el signo se lee por la altura, nunca
// por el color.
import { volumeFlow } from './analysis-core.js';

/** Definición corta del panel, en castellano y sin jerga. */
export const CVD_LEGEND = 'CVD = compra agresiva acumulada − venta agresiva acumulada (volumen taker)';

/** Nota cuando la fuente no publica volumen taker (velas antiguas, otro exchange). */
export const CVD_NO_DATA = 'Esta ventana no trae volumen taker: sin delta ni CVD.';

/** Pasos del único tono (--foreground). Sin rojo ni verde. */
export const TONE = {
  line: 'rgba(34, 31, 27, 0.95)',
  deltaUp: 'rgba(34, 31, 27, 0.35)',
  deltaDown: 'rgba(34, 31, 27, 0.85)',
};

/** Segundo a epoch: acepta segundos o milisegundos. */
function asSeconds(value) {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const seconds = n > 10_000_000_000 ? Math.floor(n / 1000) : Math.floor(n);
  return seconds > 0 ? seconds : null;
}

/** Ancla un tiempo a la vela más cercana; si no hay velas, lo deja como está. */
export function nearestTime(times, target) {
  const t = asSeconds(target);
  if (t === null || !Array.isArray(times) || times.length === 0) return t;
  let best = times[0];
  let bestDist = Math.abs(best - t);
  for (const time of times) {
    const dist = Math.abs(time - t);
    if (dist < bestDist) { best = time; bestDist = dist; }
  }
  return best;
}

/**
 * Línea del CVD: `[{ time, value }]` por vela. Vacía cuando el núcleo no tiene
 * flujo (ninguna vela con takerBuyVolume): entonces no se pinta nada.
 */
export function cvdLineData(candles) {
  const flow = volumeFlow(candles);
  if (!flow) return [];
  const out = [];
  for (let i = 0; i < candles.length && i < flow.cvd.length; i += 1) {
    const value = flow.cvd[i];
    const time = asSeconds(candles[i].time);
    if (time === null || !Number.isFinite(value)) continue;
    out.push({ time, value });
  }
  return out;
}

/**
 * Histograma del delta por vela: `[{ time, value, color }]`. El tono sube con el
 * signo negativo para que la presión vendedora pese más que la compradora.
 */
export function cvdHistogramData(candles, { positiveColor = TONE.deltaUp, negativeColor = TONE.deltaDown } = {}) {
  const flow = volumeFlow(candles);
  if (!flow) return [];
  const out = [];
  for (let i = 0; i < candles.length && i < flow.delta.length; i += 1) {
    const value = flow.delta[i];
    const time = asSeconds(candles[i].time);
    if (time === null || !Number.isFinite(value)) continue;
    out.push({ time, value, color: value < 0 ? negativeColor : positiveColor });
  }
  return out;
}

/**
 * Marcadores ▲/▼ de los choques de volumen con sesgo (`volume_shock_buy` /
 * `volume_shock_sell`): compra agresiva debajo de la vela, venta agresiva
 * encima. Ignora el resto de hallazgos y ordena por tiempo.
 */
export function volumeShockMarkers(findings, { color = TONE.line, candleTimes = [] } = {}) {
  const out = [];
  for (const f of Array.isArray(findings) ? findings : []) {
    const kind = f && typeof f.kind === 'string' ? f.kind : '';
    const buy = kind === 'volume_shock_buy';
    const sell = kind === 'volume_shock_sell';
    if (!buy && !sell) continue;
    const time = nearestTime(candleTimes, f.from);
    if (time === null) continue;
    out.push({
      time,
      position: buy ? 'belowBar' : 'aboveBar',
      shape: buy ? 'arrowUp' : 'arrowDown',
      color,
      text: buy ? '▲' : '▼',
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Texto del eje del panel: una línea con lo que se ve, sin adornos. */
export function flowLegend(candles) {
  return cvdLineData(candles).length ? CVD_LEGEND : `${CVD_LEGEND} ${CVD_NO_DATA}`;
}
