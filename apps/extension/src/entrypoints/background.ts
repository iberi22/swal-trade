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
import { dropTab, mergePositionToolsStore, POSITION_TOOLS_STORAGE_KEY } from '../lib/tv-bridge/relay';
import type { BridgePositionToolsMessage } from '../lib/tv-bridge/schema';
import { createIdbPageHistory } from '../lib/page-account/idb-page-history';
import { historyMetrics } from '../lib/page-account/metrics';
import {
  PAGE_ACCOUNT_CLEAR,
  PAGE_ACCOUNT_DIAGNOSE,
  PAGE_ACCOUNT_DIAGNOSE_REQUEST,
  PAGE_ACCOUNT_DIAGNOSE_RESULT,
  PAGE_ACCOUNT_GET,
  PAGE_ACCOUNT_RESULT,
  PAGE_ACCOUNT_SESSION_KEY,
  PAGE_ACCOUNT_SYNCED_KEY,
  PAGE_ACCOUNT_UPDATE,
  parsePageAccountDiagnoseResult,
  parsePageAccountMessage,
  parseStoredPagePositions,
  type PageAccountUpdate,
} from '../lib/page-account/messages';

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

/**
 * Último dibujo de posición leído del gráfico, por PESTAÑA y símbolo
 * (storage.session). La clave lleva el id de la pestaña que lo mandó: dos
 * pestañas con el mismo par y dibujos distintos no se pisan. El background no
 * lo interpreta: solo lo guarda para que el panel lo lea al abrirse. Nada sale
 * del navegador y no se toca la cuenta.
 */
async function rememberPositionTools(tools: BridgePositionToolsMessage, tabId: number | undefined): Promise<void> {
  try {
    const session = browser.storage.session;
    if (!session || tabId === undefined) return;
    const stored = await session.get(POSITION_TOOLS_STORAGE_KEY);
    const merged = mergePositionToolsStore(stored?.[POSITION_TOOLS_STORAGE_KEY], tools, tabId);
    if (merged.changed) await session.set({ [POSITION_TOOLS_STORAGE_KEY]: merged.store });
  } catch {
    // Sin storage.session no hay dibujos en el panel; no es un error de la página.
  }
}

/**
 * Al cerrar una pestaña o al navegar a otra página se tiran sus dibujos: si no,
 * el panel podría enseñar el dibujo de un gráfico que ya no existe. Se usan
 * `tabs.onRemoved`/`onUpdated`, disponibles sin el permiso `tabs`.
 */
async function forgetPositionTools(tabId: number): Promise<void> {
  try {
    const session = browser.storage.session;
    if (!session) return;
    const stored = await session.get(POSITION_TOOLS_STORAGE_KEY);
    const dropped = dropTab(stored?.[POSITION_TOOLS_STORAGE_KEY], tabId);
    if (dropped.changed) await session.set({ [POSITION_TOOLS_STORAGE_KEY]: dropped.store });
  } catch {
    // Sin storage.session no hay nada que limpiar.
  }
}

function setupPositionToolsCleanup(): void {
  const tabs = browser.tabs;
  if (!tabs) return;
  try {
    tabs.onRemoved.addListener((tabId: number) => {
      void forgetPositionTools(tabId);
    });
    tabs.onUpdated.addListener((tabId: number, change: { url?: string }) => {
      if (change?.url) void forgetPositionTools(tabId);
    });
  } catch {
    // Sin eventos de pestañas: el panel acota por pestaña y símbolo de todos modos.
  }
}

// --- Posiciones e historial leídos de la página de Binance ----------------
// Local y opt-in: el content script solo manda lo que ya se ve. Las posiciones
// abiertas viven en `storage.session` (se pierden al cerrar el navegador); el
// historial se acumula en IndexedDB hasta 2000 filas y el usuario lo puede
// borrar desde el panel.
const pageHistory = createIdbPageHistory();

/** Guarda el aviso del content script. Nunca lanza hacia el remitente. */
async function storePageAccountUpdate(update: PageAccountUpdate): Promise<void> {
  try {
    await browser.storage.session?.set({
      [PAGE_ACCOUNT_SESSION_KEY]: {
        balance: update.balance,
        positions: update.positions,
        capturedAt: update.capturedAt,
        tzOffsetMinutes: update.tzOffsetMinutes,
      },
    });
  } catch {
    // Sin storage.session las posiciones no llegan al panel; no es un error de la página.
  }
  const merged = await pageHistory.merge(update.history);
  // Instante de la última fusión: el panel lo enseña como «última
  // sincronización hace X». Vive en la sesión: no hace falta en disco.
  if (merged.length > 0) {
    try {
      await browser.storage.session?.set({ [PAGE_ACCOUNT_SYNCED_KEY]: Date.now() });
    } catch {
      // Sin storage.session el panel no puede fechar la sincronización.
    }
  }
}

async function readPageAccountState(): Promise<Record<string, unknown>> {
  let stored: unknown;
  try {
    stored = (await browser.storage.session?.get(PAGE_ACCOUNT_SESSION_KEY))?.[PAGE_ACCOUNT_SESSION_KEY];
  } catch {
    stored = undefined;
  }
  const session = parseStoredPagePositions(stored);
  let syncedAt: number | null = null;
  try {
    const raw = (await browser.storage.session?.get(PAGE_ACCOUNT_SYNCED_KEY))?.[PAGE_ACCOUNT_SYNCED_KEY];
    syncedAt = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    syncedAt = null;
  }
  const history = await pageHistory.load();
  return {
    type: PAGE_ACCOUNT_RESULT,
    balance: session?.balance ?? null,
    positions: session?.positions ?? [],
    capturedAt: session?.capturedAt ?? null,
    tzOffsetMinutes: session?.tzOffsetMinutes ?? 0,
    syncedAt,
    history,
    metrics: historyMetrics(history),
  };
}

async function clearPageAccount(): Promise<Record<string, unknown>> {
  try {
    await browser.storage.session?.remove([PAGE_ACCOUNT_SESSION_KEY, PAGE_ACCOUNT_SYNCED_KEY]);
  } catch {
    // nada que borrar
  }
  await pageHistory.clear();
  return { ok: true };
}

/** Pide al content script la pestaña de futuros el esquema ya anonimizado. */
async function requestPageDiagnose(): Promise<Record<string, unknown>> {
  const empty = { type: PAGE_ACCOUNT_DIAGNOSE_RESULT, outline: '' };
  try {
    const tabs = await browser.tabs.query({ url: 'https://www.binance.com/*/futures/*' }).catch(() => []);
    const tab = tabs.find((candidate) => candidate.active) ?? tabs[0];
    if (tab?.id == null) return empty;
    const reply = await browser.tabs.sendMessage(tab.id, { type: PAGE_ACCOUNT_DIAGNOSE_REQUEST });
    return { type: PAGE_ACCOUNT_DIAGNOSE_RESULT, outline: parsePageAccountDiagnoseResult(reply) ?? '' };
  } catch {
    return empty;
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
  setupPositionToolsCleanup();

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isPrivilegedType((message as { type?: unknown } | null)?.type)) return;
    void router.handle(message, sender).then((reply) => sendResponse(reply));
    return true;
  });

  // Lectura de la página: el aviso lo manda un content script; las consultas y
  // el borrado, solo el panel de la propia extensión.
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const parsed = parsePageAccountMessage(message);
    if (!parsed) return;
    const extUrl = browser.runtime.getURL('/');
    const fromExtensionPage = Boolean(
      sender &&
        sender.id === browser.runtime.id &&
        typeof sender.url === 'string' &&
        sender.url.startsWith(extUrl),
    );
    if (parsed.type === PAGE_ACCOUNT_UPDATE) {
      // Solo desde un content script de la página, nunca desde el panel. Ojo:
      // un side panel viaja con `sender.tab` puesto, así que la pestaña no basta
      // para distinguirlos; la URL sí.
      if (!sender?.tab || fromExtensionPage) return;
      void storePageAccountUpdate(parsed.update);
      return;
    }
    if (!fromExtensionPage) return;
    if (parsed.type === PAGE_ACCOUNT_GET) {
      void readPageAccountState().then(sendResponse);
      return true;
    }
    if (parsed.type === PAGE_ACCOUNT_CLEAR) {
      void clearPageAccount().then(sendResponse);
      return true;
    }
    if (parsed.type === PAGE_ACCOUNT_DIAGNOSE) {
      void requestPageDiagnose().then(sendResponse);
      return true;
    }
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
    if (parsed.type === 'tv-position-tools') {
      void rememberPositionTools(parsed.tools, _sender.tab?.id);
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
