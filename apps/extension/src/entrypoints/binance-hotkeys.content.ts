import { browser } from 'wxt/browser';
import { shouldHandleHotkey, showTimeframeToast } from '../lib/hotkeys';
import { DEFAULT_SETTINGS, SETTINGS_KEY, settingsFromStorage, type ExtensionSettings } from '../lib/settings';

export default defineContentScript({
  matches: ['https://www.binance.com/*/futures/*', 'https://www.binance.com/static/chart/tradingview/*'],
  allFrames: true,
  runAt: 'document_start',
  world: 'ISOLATED',
  main() {
    let settings: ExtensionSettings = { ...DEFAULT_SETTINGS, symbols: [] };
    const load = () => { browser.storage.local?.get(SETTINGS_KEY).then((s) => { settings = settingsFromStorage(s?.settings ?? s); }).catch(() => {}); };
    load();
    browser.storage.onChanged?.addListener((ch, area) => { if (area === 'local' && ch[SETTINGS_KEY]) settings = settingsFromStorage(ch[SETTINGS_KEY].newValue); });

    const onKeyDown = (e: KeyboardEvent) => {
      const tf = shouldHandleHotkey(e, settings.hotkeyMap, settings.hotkeysEnabled);
      if (!tf) return;
      e.preventDefault();
      e.stopPropagation();
      try { showTimeframeToast((window.top || window).document, tf); } catch { showTimeframeToast(document, tf); }
      void browser.runtime.sendMessage({ type: 'swal:hotkey-set-timeframe', timeframe: tf }).catch(() => {});
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pagehide', () => window.removeEventListener('keydown', onKeyDown, true));
  },
});
