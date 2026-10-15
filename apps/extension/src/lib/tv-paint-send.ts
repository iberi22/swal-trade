/**
 * Envío de las formas al gráfico de Binance.
 *
 * El panel no habla con el gráfico: manda un mensaje de runtime al content
 * script aislado de cada pestaña pintable y este lo reenvía por postMessage al
 * puente MAIN-world. Si la pestaña no está, no pasa nada.
 *
 * Solo se mandan formas con precios y tiempos que ha calculado el núcleo de
 * análisis sobre velas públicas. No hay nada de cuenta en el mensaje.
 */

import { browser } from 'wxt/browser';
import { coerceShapes } from './tv-bridge/schema';
import type { TvChartDetail } from './messages';
import { PAINTABLE_URL, TV_GET_STATE, TV_PAINT, TV_STATE, type PaintCommand, type TvChartState } from './tv-paint';

interface PaintMessage {
  type: typeof TV_PAINT;
  enabled: boolean;
  key: string;
  shapes: unknown;
}

/** Manda la orden de pintar (o de limpiar) a todas las pestañas pintables. */
export async function sendPaintCommand(command: PaintCommand | null): Promise<number> {
  const tabs = await browser.tabs.query({}).catch(() => []);
  let sent = 0;
  for (const tab of tabs) {
    if (tab.id == null) continue;
    if (!PAINTABLE_URL.test(tab.url ?? '')) continue;
    const message: PaintMessage = {
      type: TV_PAINT,
      enabled: command !== null,
      key: command?.key ?? '',
      shapes: command ? coerceShapes(command.shapes) : [],
    };
    try {
      await browser.tabs.sendMessage(tab.id, message);
      sent += 1;
    } catch {
      // La pestaña no tiene content script (o se recargó): se ignora.
    }
  }
  return sent;
}

/** Estado del gráfico tal como lo devuelve el background. */
export interface TvStateSnapshot {
  state: TvChartState | null;
  chart: TvChartDetail | null;
}

function parseChartDetail(value: unknown): TvChartDetail | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { symbol?: unknown; tf?: unknown };
  if (typeof record.symbol !== 'string' || typeof record.tf !== 'string') return null;
  return { symbol: record.symbol, tf: record.tf };
}

/** Pregunta al background en qué pestaña está el gráfico. */
export async function requestTvState(): Promise<TvStateSnapshot | null> {
  try {
    const response = await browser.runtime.sendMessage({ type: TV_GET_STATE });
    if (!response || typeof response !== 'object') return null;
    const record = response as { state?: unknown; chart?: unknown };
    const state = typeof record.state === 'string' ? (record.state as TvChartState) : null;
    return { state, chart: parseChartDetail(record.chart) };
  } catch {
    return null;
  }
}

/** Escucha los cambios de estado que empuja el content script. */
export function onTvState(
  listener: (state: TvChartState, chart?: TvChartDetail | null) => void,
): () => void {
  const handler = (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const record = message as { type?: unknown; state?: unknown; chart?: unknown };
    if (record.type !== TV_STATE) return;
    if (typeof record.state === 'string') {
      listener(record.state as TvChartState, parseChartDetail(record.chart));
    }
  };
  browser.runtime.onMessage.addListener(handler);
  return () => browser.runtime.onMessage.removeListener(handler);
}

import type { BridgeResolution, BridgeResolutionAckMessage } from './tv-bridge/schema';
import type { Timeframe } from './types';

export const TIMEFRAME_TO_RESOLUTION: Record<Timeframe, BridgeResolution> = {
  '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': '1D',
};
export const TV_SET_RESOLUTION = 'tv:set-resolution';

export async function requestResolution(
  tabId: number,
  timeframe: Timeframe | string,
): Promise<{ ok: boolean; resolution?: BridgeResolution; error?: string }> {
  const resolution = TIMEFRAME_TO_RESOLUTION[timeframe as Timeframe];
  if (!resolution) return { ok: false, error: `invalid-timeframe: ${timeframe}` };
  try {
    const res = await browser.tabs.sendMessage(tabId, { type: TV_SET_RESOLUTION, resolution, timeframe });
    if (!res || typeof res !== 'object') return { ok: false, resolution, error: 'no-response' };
    const r = res as BridgeResolutionAckMessage;
    return { ok: r.ok === true, resolution: r.resolution ?? resolution, error: r.error };
  } catch (err) {
    return { ok: false, resolution, error: String(err) };
  }
}
