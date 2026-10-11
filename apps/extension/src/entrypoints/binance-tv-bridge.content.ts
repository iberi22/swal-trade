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
 * - borra únicamente las entidades que él creó.
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
import { chartFromWindow } from '../lib/tv-bridge/tv-chart';

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
    // F8: el bucle de vigilancia no arranca hasta el primer draw (encendido).
    let running = false;
    const rate = new DrawRateLimit(4);

    const ensureRunning = () => {
      if (running) return;
      running = true;
      session.start();
    };

    const stop = () => {
      running = false;
      session.stop();
    };

    let seenHello = false;

    // Establecer la comunicación síncrona
    establishLink(3000)
      .then((ch) => {
        channel = ch;
        channel.onMessage((data: unknown) => {
          if (!seenHello) {
            const hello = parseHello(data);
            if (!hello) return;
            seenHello = true;
            // El saludo dice si el interruptor ya está encendido; si lo está, arrancamos.
            if (hello.enabled) ensureRunning();
            return;
          }

          const raw = data as { type?: unknown; shapes?: unknown } | undefined;
          // Rechazo temprano: una carga descomunal se tira sin validarla.
          if (raw && raw.type === SWAL_DRAW && Array.isArray(raw.shapes) && !withinShapeBudget(raw.shapes.length)) {
            return;
          }
          // Límite blando de 4 dibujos por segundo.
          if (raw && raw.type === SWAL_DRAW && !rate.allow(Date.now())) return;
          const message = parseBridgeMessage(data);
          if (!message) return;
          if (message.type === SWAL_DRAW) {
            ensureRunning();
          } else {
            // clear: se apaga la vigilancia y se limpia.
            stop();
          }
          session.apply(message as BridgeMessage);
        });
      })
      .catch(() => {
        // Falló el enlace, no hacemos nada (el otro lado lo marcará como unavailable)
      });

    window.addEventListener('pagehide', () => {
      if (channel) {
        channel.disconnect();
        channel = null;
      }
      session.stop();
    });
  },
});
