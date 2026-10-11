/**
 * Puente MAIN-world para el gráfico de TradingView de Binance.
 *
 * Vive en el mundo de la página porque es el único que alcanza el iframe del
 * mismo origen que la pestaña "Trading View" monta. Este script:
 *
 * - hace un saludo one-shot en `document_start` con el content script aislado y
 *   recibe por `MessageChannel` UN puerto privado; a partir de ahí solo acepta
 *   órdenes por ese puerto (nunca por `window`);
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
import { buildPort, isPortFor, parseHello, withinShapeBudget, DrawRateLimit } from '../lib/tv-bridge/handshake';
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
        if (!port) return;
        try {
          port.postMessage(
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

    // El puerto privado que entrega el saludo. Sin él no se acepta nada.
    let port: MessagePort | null = null;
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

    const onHello = (event: MessageEvent) => {
      // Solo lo que llegue a esta ventana desde ella misma.
      if (event.source !== window) return;
      const hello = parseHello(event.data);
      if (!hello || port) return;
      let channel: MessageChannel;
      try {
        channel = new MessageChannel();
      } catch {
        return;
      }
      port = channel.port1;
      port.onmessage = (ev: MessageEvent) => {
        const raw = ev.data as { type?: unknown; shapes?: unknown } | undefined;
        // Rechazo temprano: una carga descomunal se tira sin validarla.
        if (raw && raw.type === SWAL_DRAW && Array.isArray(raw.shapes) && !withinShapeBudget(raw.shapes.length)) {
          return;
        }
        // Límite blando de 4 dibujos por segundo.
        if (raw && raw.type === SWAL_DRAW && !rate.allow(Date.now())) return;
        const message = parseBridgeMessage(ev.data);
        if (!message) return;
        if (message.type === SWAL_DRAW) {
          ensureRunning();
        } else {
          // clear: se apaga la vigilancia y se limpia.
          stop();
        }
        session.apply(message as BridgeMessage);
      };
      // Entrega el otro puerto al aislado, atado a ESTE session.
      try {
        window.postMessage(buildPort(hello.session), location.origin, [channel.port2]);
      } catch {
        // Sin destino mismo origen no hay canal: no se pinta.
        port = null;
        return;
      }
      // El saludo dice si el interruptor ya está encendido; si lo está, arrancamos.
      if (hello.enabled) ensureRunning();
    };

    window.addEventListener('message', onHello);
    window.addEventListener('pagehide', () => {
      window.removeEventListener('message', onHello);
      port = null;
      session.stop();
    });
  },
});
