import { browser } from 'wxt/browser';
import { detectMarketContext } from '../lib/market-context';
import {
  CONTROL_SELECTOR,
  probeDomInterval,
  probeStorageInterval,
  type PageSource,
} from '../lib/page-probe';
import { buildClearMessage, buildDrawMessage, coerceShapes, parseBridgeMessage } from '../lib/tv-bridge/schema';
import { createNonce, publishNonce, readNonce } from '../lib/tv-bridge/nonce';
import { probeTvChart } from '../lib/tv-chart-state';
import { TV_PAINT, TV_STATE, type PaintCommand, type TvChartState } from '../lib/tv-paint';

/** Atributos que cambian cuando el usuario pulsa otro intervalo. */
const OBSERVED_ATTRS = [
  'class',
  'aria-pressed',
  'aria-checked',
  'aria-selected',
  'aria-current',
  'data-value',
  'data-interval',
  'data-resolution',
  'data-name',
  'data-active',
  'data-state',
  'title',
];

/** Estos, si cambian, solo los lleva un control: disparan el relectura seguro. */
const SPECIFIC_ATTRS = new Set([
  'aria-pressed',
  'aria-checked',
  'data-value',
  'data-interval',
  'data-resolution',
  'data-name',
  'data-active',
  'data-state',
]);

const INTERVAL_NAME = /interval|kline|timeframe|resolution/i;

function isIntervalNode(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element || typeof element.matches !== 'function') return false;
  const identity = `${element.id ?? ''} ${
    typeof element.className === 'string' ? element.className : ''
  } ${element.getAttribute('data-testid') ?? ''}`;
  if (INTERVAL_NAME.test(identity)) return true;
  if (element.matches(CONTROL_SELECTOR)) return true;
  try {
    return element.querySelector(CONTROL_SELECTOR) !== null;
  } catch {
    return false;
  }
}

/**
 * Filtro de ruido: el gráfico en vivo muta cientos de nodos por segundo y
 * releer la barra cada vez saldría caro. Solo pasan las mutaciones de un nodo
 * que sea, contenga o se llame como un control de intervalo.
 */
function shouldRescan(records: MutationRecord[]): boolean {
  for (const record of records) {
    if (record.type === 'attributes') {
      const name = (record.attributeName ?? '').toLowerCase();
      if (SPECIFIC_ATTRS.has(name)) return true;
      if (isIntervalNode(record.target)) return true;
      continue;
    }
    if (isIntervalNode(record.target)) return true;
  }
  return false;
}

/** Cada cuánto se mira si la pestaña del gráfico ha cambiado. */
const TV_PROBE_MS = 2_500;

/**
 * Lee el símbolo y la temporalidad de la URL, del DOM (barra de intervalos) y,
 * si la página no la pinta, de la clave de storage que la guarda. No lee
 * balances, órdenes, formularios, cookies ni el resto del almacenamiento.
 */
export default defineContentScript({
  matches: ['https://www.binance.com/*/futures/*', 'https://www.tradingview.com/chart/*'],
  runAt: 'document_idle',
  allFrames: false,
  world: 'ISOLATED',
  main() {
    let lastKey = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    const source: PageSource = location.hostname.endsWith('tradingview.com')
      ? 'tradingview'
      : 'binance';

    const readStoredInterval = (key: string): string | null => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    };

    const publish = () => {
      try {
        const context = detectMarketContext({
          href: location.href,
          title: document.title,
          domInterval: probeDomInterval(document, source),
          storageInterval: probeStorageInterval(readStoredInterval, source),
        });
        if (!context) return;
        const key = `${context.source}|${context.symbol}|${context.timeframe}|${context.timeframeInferred}`;
        if (key === lastKey) return;
        lastKey = key;
        void browser.runtime.sendMessage({ type: 'market-context', context }).catch(() => {});
      } catch {
        // La extensión se recargó y este content script quedó viejo.
      }
    };

    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(publish, 150);
    };

    const observer = new MutationObserver((records) => {
      if (shouldRescan(records)) schedule();
    });
    // La SPA de Binance y TradingView reemplaza la barra entera al cambiar de
    // intervalo: hacen falta childList + subtree, no solo atributos.
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRS,
      characterData: true,
    });

    // Red de seguridad: si el DOM ya no cambia y el intervalo solo está en
    // storage, el sondeo lo recoge. Una relectura cada 5 s es desdeñable.
    const poll = setInterval(schedule, 5000);

    const pushState = history.pushState.bind(history);
    const replaceState = history.replaceState.bind(history);
    history.pushState = (...args: Parameters<History['pushState']>) => {
      const result = pushState(...args);
      schedule();
      return result;
    };
    history.replaceState = (...args: Parameters<History['replaceState']>) => {
      const result = replaceState(...args);
      schedule();
      return result;
    };
    window.addEventListener('popstate', schedule);
    window.addEventListener('hashchange', schedule);

    const title = document.querySelector('title');
    if (title) {
      new MutationObserver(schedule).observe(title, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    const navigation = (
      window as Window & { navigation?: { addEventListener(type: string, cb: () => void): void } }
    ).navigation;
    navigation?.addEventListener('navigatesuccess', schedule);

    document.addEventListener('click', schedule, true);

    // --- Pintar en el gráfico de Trading View de Binance ------------------
    // El nonce vive en el DOM: el puente MAIN-world no comparte objetos de
    // JavaScript con este mundo aislado, pero sí el documento.
    const nonce = createNonce();
    publishNonce(document, nonce);

    const post = (message: unknown) => {
      try {
        window.postMessage(message, location.origin);
      } catch {
        // Sin destino mismo origen no se pinta. No pasa nada.
      }
    };

    const publishTvState = (state: TvChartState, chart?: { symbol: string; tf: string }) => {
      try {
        void browser.runtime.sendMessage({ type: TV_STATE, state, chart }).catch(() => {});
      } catch {
        // La extensión se recargó: este content script quedó viejo.
      }
    };

    let lastTvState: TvChartState | null = null;
    let lastTvChart: { symbol: string; tf: string } | null = null;
    /** Estado que refleja la sonda del DOM (sin puente que lo refinen). */
    const probedState = (): TvChartState =>
      probeTvChart(document).present ? 'tradingview' : 'original';
    const probeChart = () => {
      // El puente manda sobre la sonda cuando sabe si el chart está listo o no
      // casa: no lo pisamos mientras estemos en ready o mismatch.
      if (lastTvState === 'ready' || lastTvState === 'mismatch') return;
      const state = probedState();
      if (state === lastTvState) return;
      lastTvState = state;
      lastTvChart = null;
      publishTvState(state);
    };

    const onWindowMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const message = parseBridgeMessage(event.data, readNonce(document));
      // Se acepta el saludo del puente y nada más: lo que él dibuja no vuelve.
      if (!message || message.type !== 'swal:ready') return;
      if (message.ready) {
        lastTvState = 'ready';
        lastTvChart = null;
        publishTvState('ready');
        return;
      }
      if (message.reason === 'mismatch' && message.chart) {
        lastTvState = 'mismatch';
        lastTvChart = message.chart;
        publishTvState('mismatch', message.chart);
        return;
      }
      // absent/booting: el puente no tiene chart listo. Refleja la sonda.
      const probed = probedState();
      lastTvState = probed;
      lastTvChart = null;
      publishTvState(probed);
    };
    window.addEventListener('message', onWindowMessage);

    const paint = (command: PaintCommand, enabled: boolean) => {
      if (!enabled) {
        post(buildClearMessage(nonce));
        return;
      }
      const shapes = coerceShapes(command.shapes);
      if (shapes.length === 0) return;
      post(buildDrawMessage(shapes, nonce, command.key));
    };

    const onRuntimeMessage = (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const record = message as { type?: unknown; shapes?: unknown; key?: unknown; enabled?: unknown };
      if (record.type !== TV_PAINT) return;
      paint(
        { key: typeof record.key === 'string' ? record.key : '', shapes: coerceShapes(record.shapes) },
        record.enabled === true,
      );
    };
    browser.runtime.onMessage.addListener(onRuntimeMessage);

    const tvProbe = setInterval(probeChart, TV_PROBE_MS);
    probeChart();

    window.addEventListener('pagehide', () => {
      observer.disconnect();
      clearInterval(poll);
      clearInterval(tvProbe);
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener('message', onWindowMessage);
      browser.runtime.onMessage.removeListener(onRuntimeMessage);
    });

    schedule();
  },
});
