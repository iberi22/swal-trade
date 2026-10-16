import { browser } from 'wxt/browser';
import { detectMarketContext } from '../lib/market-context';
import {
  CONTROL_SELECTOR,
  probeDomInterval,
  probeStorageInterval,
  type PageSource,
} from '../lib/page-probe';
import { buildClearMessage, buildDrawMessage, buildSetResolutionMessage, coerceShapes, isBridgeResolution, parseBridgeMessage } from '../lib/tv-bridge/schema';
import { TV_SET_RESOLUTION, TV_SWITCH_TAB } from '../lib/tv-paint-send';
import { buildHello, createSession, establishLink, type BridgeChannel } from '../lib/tv-bridge/handshake';
import { probeTvChart } from '../lib/tv-chart-state';
import { TV_PAINT, TV_STATE, type PaintCommand, type TvChartState } from '../lib/tv-paint';
import { getActiveChartTab, switchChartTab } from '../lib/binance-chart-tabs';

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
 * Filtra mutaciones ajenas: si ningún nodo añadido o cambiado tiene que ver con
 * intervalos, nos ahorramos reescanear el DOM.
 */
function shouldRescan(records: MutationRecord[]): boolean {
  for (const record of records) {
    if (record.type === 'characterData') {
      if (record.target.parentElement && isIntervalNode(record.target.parentElement)) return true;
      continue;
    }
    if (record.type === 'attributes') {
      const name = record.attributeName;
      if (name && SPECIFIC_ATTRS.has(name)) return true;
      if (isIntervalNode(record.target)) return true;
      continue;
    }
    if (record.type === 'childList') {
      for (let i = 0; i < record.addedNodes.length; i++) {
        if (isIntervalNode(record.addedNodes[i]!)) return true;
      }
      for (let i = 0; i < record.removedNodes.length; i++) {
        if (isIntervalNode(record.removedNodes[i]!)) return true;
      }
    }
  }
  return false;
}

const TV_PROBE_MS = 2000;

export default defineContentScript({
  matches: [
    'https://www.binance.com/*/futures/*',
    'https://www.tradingview.com/chart/*',
  ],
  runAt: 'document_idle',
  main() {
    let lastKey = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    const readStoredInterval = (key: string): string | null => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    };

    const publish = () => {
      try {
        const source: PageSource = location.hostname.includes('binance.com')
          ? 'binance'
          : 'tradingview';
        const context = detectMarketContext({
          url: location.href,
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

    const attachTitleObserver = () => {
      const title = document.querySelector('title');
      if (title) {
        new MutationObserver(schedule).observe(title, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
    };

    if (document.querySelector('title')) {
      attachTitleObserver();
    } else {
      window.addEventListener('DOMContentLoaded', attachTitleObserver, { once: true });
    }

    const navigation = (
      window as Window & { navigation?: { addEventListener(type: string, cb: () => void): void } }
    ).navigation;
    navigation?.addEventListener('navigatesuccess', schedule);

    document.addEventListener('click', schedule, true);

    // --- Pintar en el gráfico de Trading View de Binance ------------------
    // Canal privado: el puente MAIN-world y este script establecen un canal
    // síncrono desvinculado del DOM en document_start.
    // Desde ahí draw/clear/ready viajan SOLO por el canal privado.
    // Ver tv-bridge/handshake. Si el saludo falla, no se
    // pinta y el panel dice que no está disponible.
    const publishTvState = (state: TvChartState, chart?: { symbol: string; tf: string }) => {
      try {
        void browser.runtime.sendMessage({ type: TV_STATE, state, chart }).catch(() => {});
      } catch {
        // La extensión se recargó: este content script quedó viejo.
      }
    };

    let lastTvState: TvChartState | null = null;
    let lastTvChart: { symbol: string; tf: string } | null = null;
    let lastTabSwitchTime = 0;

    /** Estado que refleja la sonda del DOM (sin puente que lo refinen). */
    const probedState = (): TvChartState => {
      if (probeTvChart(document).present) return 'tradingview';
      const active = getActiveChartTab(document);
      if (active === 'tradingView') return 'tradingview';
      return 'original';
    };

    const applyReady = (
      ready: boolean,
      reason: string | undefined,
      chart?: { symbol: string; tf: string },
    ) => {
      if (ready) {
        lastTvState = 'ready';
        lastTvChart = null;
        publishTvState('ready');
        return;
      }
      if (reason === 'mismatch' && chart) {
        lastTvState = 'mismatch';
        lastTvChart = chart;
        publishTvState('mismatch', chart);
        return;
      }
      const probed = probedState();
      lastTvState = probed;
      lastTvChart = null;
      publishTvState(probed);
    };

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

    let session = createSession();
    let linkPromise: Promise<BridgeChannel | null> | null = null;
    let channel: BridgeChannel | null = null;
    const ackListeners = new Set<(data: unknown) => void>();

    if (PAINTABLE_URL.test(location.href)) {
      linkPromise = establishLink('content', 3000)
        .then((ch) => {
          channel = ch;
          channel.onMessage((data: unknown) => {
            for (const listener of ackListeners) {
              listener(data);
            }
            const message = parseBridgeMessage(data);
            if (!message || message.type !== 'swal:ready') return;
            applyReady(message.ready, message.reason, message.chart);
          });
          // Send hello
          channel.send(buildHello(session, false));
          return ch;
        })
        .catch(() => {
          if (!channel) {
            lastTvState = 'unavailable';
            publishTvState('unavailable');
          }
          return null;
        });
    }

    const waitForReady = (timeoutMs = 8000): Promise<boolean> => {
      if (lastTvState === 'ready') return Promise.resolve(true);
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const onAck = (data: unknown) => {
          const message = parseBridgeMessage(data);
          if (message?.type === 'swal:ready' && message.ready) {
            ackListeners.delete(onAck);
            clearTimeout(timer);
            resolve(true);
          }
        };
        ackListeners.add(onAck);
        timer = setTimeout(() => {
          ackListeners.delete(onAck);
          resolve(lastTvState === 'ready');
        }, timeoutMs);
      });
    };

    const paint = (command: PaintCommand, enabled: boolean) => {
      if (!channel) return; // sin canal privado no se pinta
      try {
        if (!enabled) {
          channel.send(buildClearMessage());
          return;
        }
        const shapes = coerceShapes(command.shapes);
        if (shapes.length === 0) return;
        channel.send(buildDrawMessage(shapes, command.key));
      } catch {
        // El canal se cerró: no se pinta. No pasa nada.
      }
    };

    const onRuntimeMessage = (
      message: unknown,
      _sender: unknown,
      sendResponse: (res: unknown) => void,
    ) => {
      if (!message || typeof message !== 'object') return;
      const record = message as {
        type?: unknown;
        shapes?: unknown;
        key?: unknown;
        enabled?: unknown;
        resolution?: unknown;
        tab?: unknown;
      };

      if (record.type === TV_SWITCH_TAB) {
        const targetTab = record.tab === 'tradingView' ? 'tradingView' : 'original';
        const res = switchChartTab(document, targetTab);
        if (res.switched) {
          probeChart();
        }
        sendResponse(res);
        return true;
      }

      if (record.type === TV_PAINT) {
        const enabled = record.enabled === true;
        const shapes = coerceShapes(record.shapes);
        const key = typeof record.key === 'string' ? record.key : '';
        const command: PaintCommand = { key, shapes };

        // Nunca hacer clic si pintar es una orden de limpiar o vacía
        if (!enabled || shapes.length === 0) {
          paint(command, enabled);
          sendResponse({ ok: true, switched: false });
          return;
        }

        // Si el puente ya está en 'ready', pintar directamente sin tocar pestañas
        if (channel && lastTvState === 'ready') {
          paint(command, true);
          sendResponse({ ok: true, switched: false });
          return;
        }

        const executeSwitchAndPaint = async () => {
          if (!channel && linkPromise) {
            await linkPromise;
          }

          const activeTab = getActiveChartTab(document);
          const isOriginal = activeTab === 'original' || (activeTab === null && probedState() === 'original');

          if (!isOriginal) {
            if (channel) {
              channel.send(buildHello(session, true));
            }
            const ready = await waitForReady(8000);
            if (ready) {
              paint(command, true);
              sendResponse({ ok: true, switched: false });
            } else {
              sendResponse({ ok: false, switched: false, error: 'bridge-timeout' });
            }
            return;
          }

          // Está en Original: no pulsar más de 1 vez cada 10 s para evitar bucles
          const now = Date.now();
          if (now - lastTabSwitchTime < 10_000) {
            sendResponse({ ok: false, switched: false, error: 'rate-limited' });
            return;
          }

          const tabSwitch = switchChartTab(document, 'tradingView');
          if (!tabSwitch.ok) {
            sendResponse({ ok: false, switched: false, error: tabSwitch.error });
            return;
          }

          if (tabSwitch.switched) {
            lastTabSwitchTime = Date.now();
          }

          if (channel) {
            channel.send(buildHello(session, true));
          }

          const ready = await waitForReady(8000);
          if (ready) {
            paint(command, true);
            sendResponse({ ok: true, switched: tabSwitch.switched });
          } else {
            sendResponse({ ok: false, switched: tabSwitch.switched, error: 'bridge-timeout' });
          }
        };

        void executeSwitchAndPaint();
        return true;
      }

      if (record.type === TV_SET_RESOLUTION) {
        const res = record.resolution;
        if (!isBridgeResolution(res)) { sendResponse({ ok: false, error: 'invalid-resolution' }); return; }
        if (!channel) { sendResponse({ ok: false, resolution: res, error: 'no-bridge-channel' }); return; }
        const onAck = (m: unknown) => {
          const parsed = parseBridgeMessage(m);
          if (parsed?.type === 'swal:resolution-ack') { ackListeners.delete(onAck); sendResponse(parsed); }
        };
        ackListeners.add(onAck);
        setTimeout(() => { if (ackListeners.delete(onAck)) sendResponse({ ok: false, resolution: res, error: 'bridge-timeout' }); }, 3000);
        try { channel.send(buildSetResolutionMessage(res)); } catch (err) { ackListeners.delete(onAck); sendResponse({ ok: false, resolution: res, error: String(err) }); }
        return true;
      }
    };
    browser.runtime.onMessage.addListener(onRuntimeMessage);

    const tvProbe = setInterval(probeChart, TV_PROBE_MS);
    probeChart();

    window.addEventListener('pagehide', () => {
      observer.disconnect();
      clearInterval(poll);
      clearInterval(tvProbe);
      if (timer !== null) clearTimeout(timer);
      browser.runtime.onMessage.removeListener(onRuntimeMessage);
      if (channel) {
        channel.disconnect();
        channel = null;
      }
    });

    schedule();
  },
});
