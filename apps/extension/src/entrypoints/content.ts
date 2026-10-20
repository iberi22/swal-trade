import { browser } from 'wxt/browser';
import { detectMarketContext } from '../lib/market-context';
import {
  CONTROL_SELECTOR,
  probeDomInterval,
  probeStorageInterval,
  type PageSource,
} from '../lib/page-probe';
import { buildClearMessage, buildDrawMessage, buildSetReadMessage, buildSetResolutionMessage, coerceShapes, isBridgeResolution, parseBridgeMessage, SWAL_POSITION_TOOLS } from '../lib/tv-bridge/schema';
import { TV_SET_RESOLUTION, TV_SWITCH_TAB } from '../lib/tv-paint-send';
import { buildHello, createSession, establishLink, type BridgeChannel } from '../lib/tv-bridge/handshake';
import { probeTvChart } from '../lib/tv-chart-state';
import { PAINTABLE_URL, TV_PAINT, TV_POSITION_TOOLS, TV_STATE, type PaintCommand, type TvChartState } from '../lib/tv-paint';
import { SETTINGS_KEY, settingsFromStorage, type ExtensionSettings } from '../lib/settings';
import { hotkeyTimeframe, showTimeframeToast } from '../lib/hotkeys';
import { getActiveChartTab, switchChartTab } from '../lib/binance-chart-tabs';
import { readPageAccount } from '../lib/page-account/content-reader';
import { binanceAdapter } from '../lib/exchanges/binance';
import { supportedAdapterForUrl } from '../lib/exchanges/registry';
import {
  PAGE_ACCOUNT_DIAGNOSE_REQUEST,
  PAGE_ACCOUNT_DIAGNOSE_RESULT,
  PAGE_ACCOUNT_UPDATE,
} from '../lib/page-account/messages';
import { anonymizeTree, treeToCompactText } from '../lib/page-account/snapshot';
import type { TextNode } from '../lib/page-account/tree';

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
    // Binance deja montado (oculto) el iframe de Trading View al volver a Original:
    // por eso la pestaña activa del DOM manda sobre la presencia del iframe.
    const probedState = (): TvChartState => {
      const active = getActiveChartTab(document);
      if (active === 'original') return 'original';
      if (probeTvChart(document).present) return 'tradingview';
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

    // --- Atajos de teclado de la extensión (Alt+Mayús...) ------------------
    // Se escuchan en la página, no en un content script aparte. Las teclas de
    // función (F1..F12) quedaron fuera: son del navegador y del sistema. Los
    // atajos cambian la temporalidad del gráfico a través del background, que es
    // quien conoce el puente con Trading View.
    let hotkeySettings: ExtensionSettings | null = null;

    const onPageKeyDown = (event: KeyboardEvent) => {
      const current = hotkeySettings;
      if (!current) return;
      const timeframe = hotkeyTimeframe(event, current.hotkeyMap, current.hotkeysEnabled);
      if (!timeframe) return;
      event.preventDefault();
      event.stopPropagation();
      showTimeframeToast(document, timeframe);
      try {
        void browser.runtime.sendMessage({ type: 'swal:hotkey-set-timeframe', timeframe }).catch(() => {});
      } catch {
        // La extensión se recargó: este content script quedó viejo.
      }
    };

    // Solo en Binance: en TradingView los atajos son del gráfico anfitrión.
    if (location.hostname.includes('binance.com')) {
      window.addEventListener('keydown', onPageKeyDown, true);
    }

    // --- Lectura de la página (posiciones e historial) --------------------
    // Opt-in: solo con `readPageAccount` encendido. Lee el texto que el usuario
    // ya ve, no escribe en la página ni pulsa nada. Una lectura cada >= 2 s,
    // solo con la pestaña visible y solo se avisa si el contenido cambió.
    const PAGE_READ_MIN_MS = 2000;
    const PAGE_READ_DEBOUNCE_MS = 600;

    let pageReadWanted = false;
    let pageReadTimer: ReturnType<typeof setTimeout> | null = null;
    let pageReadObserver: MutationObserver | null = null;
    let lastPageParseMs = 0;
    let lastPageFingerprint = '';
    let lastPageTree: TextNode | null = null;

    const pageTzOffset = () => new Date().getTimezoneOffset();

    // El adaptador sale del registro: hoy solo Binance está soportado. Cualquier
    // otra página cae al adaptador de Binance, como antes (no hay lectores de
    // otros exchanges y no se inventan datos).
    const pageAdapter = () => supportedAdapterForUrl(location.href) ?? binanceAdapter;

    const readPageNow = () => {
      lastPageParseMs = Date.now();
      const result = readPageAccount(document, {
        tzOffsetMinutes: pageTzOffset(),
        adapter: pageAdapter(),
      });
      if (result.tree) lastPageTree = result.tree;
      return result;
    };

    const publishPageAccount = () => {
      if (!pageReadWanted) return;
      // Con la pestaña oculta no se lee: el usuario no está mirando nada.
      if (document.visibilityState !== 'visible') return;
      const result = readPageNow();
      if (result.fingerprint === lastPageFingerprint) return;
      lastPageFingerprint = result.fingerprint;
      try {
        void browser.runtime
          .sendMessage({
            type: PAGE_ACCOUNT_UPDATE,
            balance: result.balance,
            positions: result.positions,
            history: result.history,
            tzOffsetMinutes: pageTzOffset(),
            capturedAt: Date.now(),
          })
          .catch(() => {});
      } catch {
        // La extensión se recargó: este content script quedó viejo.
      }
    };

    const schedulePageRead = () => {
      if (!pageReadWanted || pageReadTimer !== null) return;
      const wait = Math.max(PAGE_READ_DEBOUNCE_MS, PAGE_READ_MIN_MS - (Date.now() - lastPageParseMs));
      pageReadTimer = setTimeout(() => {
        pageReadTimer = null;
        publishPageAccount();
      }, wait);
    };

    const startPageRead = () => {
      if (pageReadObserver) return;
      pageReadObserver = new MutationObserver(() => schedulePageRead());
      // Binance reemplaza tablas y tarjetas enteras: hace falta subtree.
      pageReadObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      schedulePageRead();
    };

    const stopPageRead = () => {
      pageReadObserver?.disconnect();
      pageReadObserver = null;
      if (pageReadTimer !== null) clearTimeout(pageReadTimer);
      pageReadTimer = null;
      lastPageFingerprint = '';
      lastPageTree = null;
    };

    const applyPageReadSetting = (enabled: boolean) => {
      if (enabled === pageReadWanted) return;
      pageReadWanted = enabled;
      if (enabled) startPageRead();
      else stopPageRead();
    };

    const onPageVisibility = () => {
      if (document.visibilityState === 'visible') schedulePageRead();
    };
    document.addEventListener('visibilitychange', onPageVisibility);

    // Lectura de los dibujos de posición del usuario (solo lectura). El ajuste
    // vive en storage.local y este content script lo lee por su cuenta: así
    // sobrevive a una recarga de la página sin depender de que el panel empuje
    // nada. El puente solo mira el gráfico cuando recibe el encendido.
    let readWanted = false;
    const pushReadState = () => {
      if (!channel) return;
      try {
        channel.send(buildSetReadMessage(readWanted));
      } catch {
        // El canal se cerró: se reenvía cuando se vuelva a enlazar.
      }
    };
    const applyReadSetting = (enabled: boolean) => {
      if (enabled === readWanted) return;
      readWanted = enabled;
      pushReadState();
    };
    const onSettingsChanged = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
      if (areaName !== 'local' || !changes[SETTINGS_KEY]) return;
      const next = settingsFromStorage({ settings: changes[SETTINGS_KEY]?.newValue });
      applyReadSetting(next.readDrawings);
      applyPageReadSetting(next.readPageAccount);
      hotkeySettings = next;
    };
    try {
      browser.storage?.onChanged?.addListener(onSettingsChanged as never);
    } catch {
      // Sin storage.onChanged: queda solo la lectura inicial.
    }
    try {
      void browser.storage?.local
        ?.get(SETTINGS_KEY)
        .then((stored) => {
          const next = settingsFromStorage(stored);
          applyReadSetting(next.readDrawings);
          applyPageReadSetting(next.readPageAccount);
          hotkeySettings = next;
        })
        .catch(() => {});
    } catch {
      // storage no disponible en este frame.
    }

    if (PAINTABLE_URL.test(location.href)) {
      linkPromise = establishLink('content', 3000)
        .then((ch) => {
          channel = ch;
          channel.onMessage((data: unknown) => {
            for (const listener of ackListeners) {
              listener(data);
            }
            const message = parseBridgeMessage(data);
            if (!message) return;
            // Dibujos de posición: el background los guarda por símbolo en
            // storage.session y el panel lee de ahí. Nunca se pintan.
            if (message.type === SWAL_POSITION_TOOLS) {
              try {
                void browser.runtime
                  .sendMessage({ type: TV_POSITION_TOOLS, tools: message })
                  .catch(() => {});
              } catch {
                // La extensión se recargó: este content script quedó viejo.
              }
              return;
            }
            if (message.type !== 'swal:ready') return;
            applyReady(message.ready, message.reason, message.chart);
          });
          // Send hello
          channel.send(buildHello(session, false));
          // Estado del interruptor de lectura en el momento de enlazar.
          channel.send(buildSetReadMessage(readWanted));
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

    // "Listo" para pintar: el puente ha reportado el gráfico. Con 'mismatch' el
    // gráfico está pero muestra otro par o temporalidad: el puente no dibuja hasta
    // casar (el panel adopta la temporalidad del gráfico y reenvía la orden).
    const waitForReady = (timeoutMs = 8000): Promise<boolean> => {
      if (lastTvState === 'ready' || lastTvState === 'mismatch') return Promise.resolve(true);
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const onAck = (data: unknown) => {
          const message = parseBridgeMessage(data);
          if (message?.type === 'swal:ready' && (message.ready || message.reason === 'mismatch')) {
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

      if (record.type === PAGE_ACCOUNT_DIAGNOSE_REQUEST) {
        // Solo el esquema anonimizado: el árbol crudo no sale de la página.
        let tree = lastPageTree;
        if (!tree && pageReadWanted) tree = readPageNow().tree;
        const outline = tree ? treeToCompactText(anonymizeTree(tree)) : '';
        sendResponse({ type: PAGE_ACCOUNT_DIAGNOSE_RESULT, outline });
        return;
      }

      if (record.type === TV_SWITCH_TAB) {
        const targetTab = record.tab === 'tradingView' ? 'tradingView' : 'original';
        const res = switchChartTab(document, targetTab);
        if (res.switched) {
          // Re-sondear: el estado 'ready' de antes ya no vale tras cambiar de pestaña.
          applyReady(false, undefined);
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

        // El DOM manda: si se ve Original no puede haber un 'ready' vigente (puede
        // quedar de antes, p. ej. tras apagar el interruptor o volver a Original).
        const activeNow = getActiveChartTab(document);
        const showsOriginal = activeNow === 'original' || (activeNow === null && probedState() === 'original');
        if (showsOriginal && (lastTvState === 'ready' || lastTvState === 'mismatch')) {
          applyReady(false, undefined);
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
      document.removeEventListener('visibilitychange', onPageVisibility);
      window.removeEventListener('keydown', onPageKeyDown, true);
      stopPageRead();
      try {
        browser.storage?.onChanged?.removeListener(onSettingsChanged as never);
      } catch {
        // nunca se llegó a registrar
      }
      if (channel) {
        channel.disconnect();
        channel = null;
      }
    });

    schedule();
  },
});
