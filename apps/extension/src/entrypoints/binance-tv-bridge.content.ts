/**
 * Puente MAIN-world para el gráfico de TradingView de Binance.
 *
 * Vive en el mundo de la página porque es el único que alcanza el iframe del
 * mismo origen que la pestaña "Trading View" monta. Este script:
 *
 * - hace un saludo one-shot en `document_start` con el content script aislado y
 *   recibe por el canal desvinculado UN puerto privado; a partir de ahí solo acepta
 *   órdenes por ese canal (nunca por `window`);
 * - no arranca a mirar el gráfico hasta que el interruptor de pintar esté
 *   encendido (el `hello` lo dice; draw ⇒ encendido, clear ⇒ apagado) (F8);
 * - busca `tradingViewApi` en el iframe del mismo origen, espera a que el chart
 *   tenga rango visible y dibuja;
 * - limita los dibujos a 4/s y rechacha cargas de más de 4 × SWAL_MAX_SHAPES (F1);
 * - dibuja con un tono neutro y opacidad baja, y bloquea las entidades;
 * - borra únicamente las entidades que él creó;
 * - si el usuario enciende «Leer mis dibujos de posición», SONDEO el gráfico cada
 *   1,5 s y publico (solo lectura) las herramientas Long/Short Position que él
 *   traza: entrada, stop y objetivo. Nunca creo, muevo ni borro un dibujo suyo:
 *   leer es `getAllShapes`/`getShapeById` y nada más.
 *
 * No lee la cuenta, no toca formularios de orden, no pulsa nada. No tiene acceso
 * a la API de la extensión: en el mundo MAIN no existe.
 */

import {
  SWAL_DRAW,
  buildReadyMessage,
  parseBridgeMessage,
  type BridgeMessage,
} from '../lib/tv-bridge/schema';
import { parseHello, withinShapeBudget, DrawRateLimit, establishLink, type BridgeChannel } from '../lib/tv-bridge/handshake';
import { ChartSession, type BridgeReport } from '../lib/tv-bridge/tv-session';
import { chartFromWindow, findChartWindow } from '../lib/tv-bridge/tv-chart';
import { createBridgeMessageHandler } from '../lib/tv-bridge/message-handler';
import {
  PositionToolsPoller,
  readPositionTools,
  type TvPositionChartLike,
} from '../lib/tv-bridge/position-tools';



/** Marca de "hay un puente en la página que se encarga del gráfico". */
const HOST_FLAG = '__swalTvBridgeHost';

type HostWindow = Window & { [HOST_FLAG]?: boolean };

/** true si esta ventana es la que publica la API del gráfico. */
function isChartWindow(): boolean {
  return chartFromWindow(window) !== null;
}

function isTopWindow(): boolean {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

/**
 * El puente de dentro del iframe solo actúa si la página no tiene el suyo: así
 * nunca dibujan dos instancias sobre el mismo gráfico.
 */
function shouldRunHere(): boolean {
  if (isTopWindow()) {
    (window as HostWindow)[HOST_FLAG] = true;
    return true;
  }
  if (!isChartWindow()) return false;
  try {
    return (window.top as HostWindow | null)?.[HOST_FLAG] !== true;
  } catch {
    return false;
  }
}

export default defineContentScript({
  matches: [
    'https://www.binance.com/*/futures/*',
    'https://www.binance.com/static/chart/tradingview/*',
  ],
  allFrames: true,
  runAt: 'document_start',
  // El iframe de TradingView es del mismo origen, pero la API solo se ve desde
  // el mundo de la página.
  world: 'MAIN',
  main() {
    if (!shouldRunHere()) return;

    const session = new ChartSession({
      document,
      selfWindow: window,
      onStatus: (report: BridgeReport) => {
        // El estado viaja solo por el puerto privado, nunca por window.
        if (!channel) return;
        try {
          channel.send(
            buildReadyMessage(
              report.status,
              report.status === 'mismatch' ? report.chart : undefined,
            ),
          );
        } catch {
          // El puerto pudo cerrarse (pestaña recargada). No hay nada que hacer.
        }
      },
    });

    // El canal síncrono desvinculado (DOM)
    let channel: BridgeChannel | null = null;
    // Lectura (solo lectura) de las herramientas Long/Short Position del usuario.
    const positionTools = new PositionToolsPoller({
      read: () => {
        const win = findChartWindow(document, window);
        const chart = win ? chartFromWindow(win) : null;
        return readPositionTools(chart as unknown as TvPositionChartLike | null);
      },
      send: (message) => {
        if (!channel) return;
        try {
          channel.send(message);
        } catch {
          // El puerto pudo cerrarse (pestaña recargada).
        }
      },
    });
    // F8: el bucle de vigilancia no arranca hasta el primer draw (encendido).
    const handler = createBridgeMessageHandler(
      {
        start: () => session.start(),
        stop: () => session.stop(),
        apply: (msg) => session.apply(msg),
        setResolution: (res) => session.setResolution(res),
        setRead: (enabled) => positionTools.setEnabled(enabled),
      },
      new DrawRateLimit(4),
      (ack) => {
        if (!channel) return;
        try {
          channel.send(ack);
        } catch {
          // El puerto pudo cerrarse
        }
      },
    );

    // Espera pasiva: no tocamos el DOM hasta que el aislado llama a la puerta.
    // Así el hueco hasta `document_idle` (medido de 9 s a 54 s en Binance con
    // red móvil lenta) no expone ningún nodo que un script de la página pueda
    // capturar. El canal se enlaza en cuanto el aislado arranca.
    establishLink('bridge')
      .then((ch) => {
        channel = ch;
        channel.onMessage((data: unknown) => handler(data));
      })
      .catch(() => {
        // Falló el enlace, no hacemos nada (el otro lado lo marcará como unavailable)
      });

    window.addEventListener('pagehide', () => {
      if (channel) {
        channel.disconnect();
        channel = null;
      }
      positionTools.stop();
      session.stop();
    });
  },
});
