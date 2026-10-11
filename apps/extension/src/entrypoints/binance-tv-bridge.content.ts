/**
 * Puente MAIN-world para el gráfico de TradingView de Binance.
 *
 * Vive en el mundo de la página porque es el único que alcanza el iframe del
 * mismo origen que la pestaña "Trading View" monta. Este script:
 *
 * - busca `tradingViewApi` en el iframe (o en su propia ventana, si él es el
 *   iframe del chart);
 * - espera a que el chart tenga rango visible antes de dibujar nada;
 * - acepta órdenes SOLO por `window.postMessage` desde el content script
 *   aislado de esta extensión, validadas con el nonce de la página;
 * - dibuja con un tono neutro y opacidad baja, y bloquea las entidades;
 * - borra únicamente las entidades que él creó;
 * - redibuja cuando cambia el símbolo o la temporalidad.
 *
 * No lee la cuenta, no toca formularios de orden, no pulsa nada. No tiene
 * acceso a la API de la extensión: en el mundo MAIN no existe.
 */

import {
  SWAL_READY,
  buildReadyMessage,
  parseBridgeMessage,
  type BridgeMessage,
} from '../lib/tv-bridge/schema';
import { readNonce } from '../lib/tv-bridge/nonce';
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
        const nonce = readNonce(document);
        if (!nonce) return;
        try {
          window.postMessage(buildReadyMessage(nonce, report.status, report.chart), location.origin);
        } catch {
          // Sin destino mismo origen no hay nada que decir.
        }
      },
    });

    const onMessage = (event: MessageEvent) => {
      // Solo lo que llegue a esta ventana desde ella misma.
      if (event.source !== window) return;
      const message = parseBridgeMessage(event.data, readNonce(document));
      if (!message || message.type === SWAL_READY) return;
      session.apply(message as BridgeMessage);
    };

    window.addEventListener('message', onMessage);
    window.addEventListener('pagehide', () => {
      window.removeEventListener('message', onMessage);
      session.stop();
    });

    session.start();
  },
});
