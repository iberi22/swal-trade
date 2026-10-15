import { browser } from 'wxt/browser';
import { parseRuntimeMessage } from '../lib/messages';
import type { TvChartState } from '../lib/tv-paint';
import { PAINTABLE_URL } from '../lib/tv-paint';
import type { MarketContext } from '../lib/types';
import { loadSettings, SETTINGS_KEY, settingsFromStorage } from '../lib/settings';
import { ClaudeBridgeClient, type BridgeChartState } from '../lib/claude-bridge';
import { sendPaintCommand } from '../lib/tv-paint-send';

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
    if (parsed.type === 'get-context') {
      void ready.then(() => {
        sendResponse({ type: 'context-result', context: latest });
      });
      return true;
    }
  });
});
