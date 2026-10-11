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

/** Pregunta al background en qué pestaña está el gráfico. */
export async function requestTvState(): Promise<TvChartState | null> {
  try {
    const response = await browser.runtime.sendMessage({ type: TV_GET_STATE });
    if (!response || typeof response !== 'object') return null;
    const state = (response as { state?: unknown }).state;
    return typeof state === 'string' ? (state as TvChartState) : null;
  } catch {
    return null;
  }
}

/** Escucha los cambios de estado que empuja el content script. */
export function onTvState(listener: (state: TvChartState) => void): () => void {
  const handler = (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const record = message as { type?: unknown; state?: unknown };
    if (record.type !== TV_STATE) return;
    if (typeof record.state === 'string') listener(record.state as TvChartState);
  };
  browser.runtime.onMessage.addListener(handler);
  return () => browser.runtime.onMessage.removeListener(handler);
}
