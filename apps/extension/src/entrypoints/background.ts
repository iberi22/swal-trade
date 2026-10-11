import { browser } from 'wxt/browser';
import { parseRuntimeMessage } from '../lib/messages';
import type { TvChartState } from '../lib/tv-paint';
import type { MarketContext } from '../lib/types';

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

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
