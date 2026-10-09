import { browser } from 'wxt/browser';
import type { MarketContext } from '../lib/types';
import { parseRuntimeMessage } from '../lib/messages';

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
    if (parsed.type === 'get-context') {
      void ready.then(() => {
        sendResponse({ type: 'context-result', context: latest });
      });
      return true;
    }
  });
});
