import { browser } from 'wxt/browser';
import { isPrivilegedType, parseRuntimeMessage } from '../lib/messages';
import { requestResolution, TIMEFRAME_TO_RESOLUTION } from '../lib/tv-paint-send';
import type { Timeframe } from '../lib/types';
import type { TvChartState } from '../lib/tv-paint';
import { PAINTABLE_URL } from '../lib/tv-paint';
import type { MarketContext } from '../lib/types';
import { loadSettings, SETTINGS_KEY, settingsFromStorage } from '../lib/settings';
import { ClaudeBridgeClient, type BridgeChartState } from '../lib/claude-bridge';
import { sendPaintCommand } from '../lib/tv-paint-send';
import { createRouter, type KeyValueStore } from '../lib/background/router';
import { createSignedClient } from '../lib/account/binance-signed';
import { createIdbVault } from '../lib/account/idb-vault';
import { chat } from '../lib/ai/llm-client';
import { ALARM_NAME, createBackgroundScanner, desiredAlarm } from '../lib/scanner/background-runner';
import { loadScannerSettings, SCANNER_SETTINGS_KEY } from '../lib/scanner/settings';

function storageStore(area: 'local' | 'session'): KeyValueStore {
  const api = () => browser.storage[area];
  return {
    async get(key) {
      return (await api()?.get(key))?.[key];
    },
    async set(key, value) {
      await api()?.set({ [key]: value });
    },
    async remove(key) {
      await api()?.remove(key);
    },
  };
}

/** Idiomas del navegador: el panel resuelve 'auto' con la misma lista. */
function uiLanguages(): string[] {
  const out: string[] = [];
  try {
    const ui = browser.i18n?.getUILanguage?.();
    if (ui) out.push(ui);
  } catch {
    // sin API de i18n
  }
  if (typeof navigator !== 'undefined' && Array.isArray(navigator.languages)) out.push(...navigator.languages);
  return out;
}

const STORAGE_KEY = 'marketContext';

type SidePanelApi = {
  setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void> | void;
};

type SidebarActionApi = {
  toggle(): Promise<void> | void;
};

type ActionApi = {
  onClicked: { addListener(listener: () => void): void };
};

let latest: MarketContext | null = null;

/**
 * Estado del gráfico de Binance abierto por última vez. No es dato de cuenta:
 * solo dice si la pestaña del gráfico es la de Trading View y, si no casa, qué
 * símbolo y temporalidad muestra.
 */
let tvState: TvChartState | null = null;
let tvChart: { symbol: string; tf: string } | null = null;

let claudeBridge: ClaudeBridgeClient | null = null;

async function remember(context: MarketContext): Promise<void> {
  latest = context;
  try {
    await browser.storage.session?.set({ [STORAGE_KEY]: context });
  } catch {
    // storage.session puede faltar; el panel pregunta la copia en memoria.
  }
}

const ready = (async () => {
  try {
    const stored = await browser.storage.session?.get(STORAGE_KEY);
    const value = stored?.[STORAGE_KEY];
    const parsed = parseRuntimeMessage({ type: 'market-context', context: value });
    if (!latest && parsed?.type === 'market-context') latest = parsed.context;
  } catch {
    // sin sesión previa
  }
})();

type AlarmsApi = {
  create(name: string, info: { when?: number; periodInMinutes?: number }): Promise<void> | void;
  clear(name: string): Promise<boolean> | void;
  onAlarm: { addListener(listener: (alarm: { name: string }) => void): void };
};

/**
 * Vigilancia del escáner con el panel cerrado: una alarma cada 5 min solo si el
 * usuario la activó. Sin `alarms` (o sin fiabilidad) se queda en modo panel.
 */
function setupScannerAlarm(): void {
  const alarms = (browser as unknown as { alarms?: AlarmsApi }).alarms;
  if (!alarms || typeof alarms.create !== 'function' || !alarms.onAlarm) return;
  const storage = {
    async get(key: string) {
      return (await browser.storage.local.get(key))[key];
    },
    async set(key: string, value: unknown) {
      await browser.storage.local.set({ [key]: value });
    },
  };
  const scanner = createBackgroundScanner({
    fetch: (url, init) => fetch(url, init),
    storage,
    setBadge: (text) => {
      const action = (browser as unknown as { action?: { setBadgeText(d: { text: string }): unknown } }).action;
      void Promise.resolve(action?.setBadgeText({ text })).catch(() => {});
    },
    notificationsAllowed: async () =>
      (await (browser as unknown as { permissions?: { contains(p: { permissions: string[] }): Promise<boolean> } })
        .permissions?.contains({ permissions: ['notifications'] })) === true,
    notify: ({ title, message }) => {
      const n = (browser as unknown as {
        notifications?: { create(o: Record<string, unknown>): unknown };
      }).notifications;
      void Promise.resolve(
        n?.create({ type: 'basic', iconUrl: browser.runtime.getURL('/icon/128.png' as never), title, message }),
      ).catch(() => {});
    },
  });

  const sync = async (): Promise<void> => {
    try {
      const settings = await loadScannerSettings(storage);
      const want = desiredAlarm(settings, Date.now());
      if (!want) {
        await alarms.clear(ALARM_NAME);
        return;
      }
      await alarms.create(want.name, { when: want.when, periodInMinutes: want.periodInMinutes });
    } catch {
      // sin alarmas: el escáner sigue solo con el panel abierto
    }
  };

  alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void scanner.onAlarm();
  });
  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[SCANNER_SETTINGS_KEY]) void sync();
    });
    browser.runtime.onInstalled.addListener(() => void sync());
    browser.runtime.onStartup.addListener(() => void sync());
  } catch {
    // eventos no disponibles en este entorno
  }
}

export default defineBackground(() => {
  const runtime = browser as typeof browser & {
    sidePanel?: SidePanelApi;
    sidebarAction?: SidebarActionApi;
    browserAction?: ActionApi;
  };

  if (runtime.sidePanel) {
    void Promise.resolve(
      runtime.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }),
    ).catch(() => {});
  } else if (runtime.sidebarAction) {
    const action = runtime.action ?? runtime.browserAction;
    action?.onClicked.addListener(() => {
      void runtime.sidebarAction?.toggle();
    });
  }

  // Inicializar cliente puente Claude local
  claudeBridge = new ClaudeBridgeClient({
    getSettings: () => loadSettings(),
    getChartState: async (): Promise<BridgeChartState> => {
      const tabs = await browser.tabs.query({}).catch(() => []);
      const paintableTab = tabs.find((t) => t.url && PAINTABLE_URL.test(t.url));
      let tabUrlHost: string | null = null;
      if (paintableTab?.url) {
        try {
          tabUrlHost = new URL(paintableTab.url).host;
        } catch {
          tabUrlHost = null;
        }
      }
      const symbol = tvChart?.symbol ?? latest?.symbol ?? null;
      const timeframe = tvChart?.tf ?? latest?.timeframe ?? null;
      const connected = tvState === 'ready' || Boolean(paintableTab);
      const settings = await loadSettings();
      return {
        connected,
        symbol,
        timeframe,
        paintEnabled: settings.paintOnChart,
        tabUrlHost,
      };
    },
    sendPaint: (command) => sendPaintCommand(command),
    setResolution: async (resolution) => {
      const timeframe = (Object.keys(TIMEFRAME_TO_RESOLUTION) as Timeframe[]).find(
        (tf) => TIMEFRAME_TO_RESOLUTION[tf] === resolution,
      );
      if (!timeframe) return { ok: false, error: 'invalid resolution' };
      const tabs = await browser.tabs.query({ url: 'https://www.binance.com/*/futures/*' }).catch(() => []);
      const tab = tabs.find((t) => t.active) ?? tabs[0];
      if (tab?.id == null) return { ok: false, error: 'no Binance futures tab open' };
      return requestResolution(tab.id, timeframe);
    },
  });
  void claudeBridge.start();

  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[SETTINGS_KEY]) {
        const next = settingsFromStorage({ settings: changes[SETTINGS_KEY].newValue });
        claudeBridge?.updateSettings(next);
      }
    });
  } catch {
    // storage.onChanged no disponible en este entorno
  }

  // Cuenta e IA: enrutador puro con guarda de remitente. No toca los mensajes
  // de abajo (devuelve null y deja que los atienda el otro oyente).
  const router = createRouter({
    runtimeId: browser.runtime.id,
    extensionUrl: browser.runtime.getURL('/'),
    vault: createIdbVault(),
    now: () => Date.now(),
    fetch: (input, init) => fetch(input, init),
    makeClient: (signer) =>
      createSignedClient({ fetch: (input, init) => fetch(input, init), signer, now: () => Date.now() }),
    chat: (request) => chat(request, { fetch: (input, init) => fetch(input, init) }),
    loadSettings: () => loadSettings(),
    cache: storageStore('local'),
    session: storageStore('session'),
    uiLanguages: () => uiLanguages(),
  });

  setupScannerAlarm();

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isPrivilegedType((message as { type?: unknown } | null)?.type)) return;
    void router.handle(message, sender).then((reply) => sendResponse(reply));
    return true;
  });

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'get-claude-bridge-status') {
      sendResponse({ status: claudeBridge?.getStatus() ?? 'disconnected' });
      return;
    }
    const parsed = parseRuntimeMessage(message);
    if (!parsed) return;
    if (parsed.type === 'market-context') {
      void remember(parsed.context);
      return;
    }
    if (parsed.type === 'tv-state') {
      tvState = parsed.state;
      tvChart = parsed.chart ?? null;
      return;
    }
    if (parsed.type === 'get-tv-state') {
      sendResponse({ type: 'tv-state-result', state: tvState, chart: tvChart ?? undefined });
      return;
    }
    if (parsed.type === 'swal:hotkey-set-timeframe') {
      const tabId = _sender.tab?.id;
      if (tabId != null) {
        void requestResolution(tabId, parsed.timeframe);
      }
      return;
    }
    if (parsed.type === 'get-context') {
      void ready.then(() => {
        sendResponse({ type: 'context-result', context: latest });
      });
      return true;
    }
  });
});
