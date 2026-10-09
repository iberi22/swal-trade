import { browser } from 'wxt/browser';
import { detectMarketContext, parseIntervalLabel } from '../lib/market-context';

/**
 * Lee el símbolo y la temporalidad de la URL (y, en TradingView, del título
 * y del control de intervalo). No lee balances, órdenes, formularios, cookies
 * ni el storage de la página.
 */
export default defineContentScript({
  matches: ['https://www.binance.com/*/futures/*', 'https://www.tradingview.com/chart/*'],
  runAt: 'document_idle',
  allFrames: false,
  world: 'ISOLATED',
  main() {
    let lastKey = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    const source = location.hostname.endsWith('tradingview.com') ? 'tradingview' : 'binance';

    const readDomInterval = (): string | null => {
      if (source === 'tradingview') {
        const active = document.querySelector(
          '#header-toolbar-intervals [aria-checked="true"], #header-toolbar-intervals [aria-pressed="true"]',
        );
        const text = active?.textContent?.trim() ?? '';
        return text.length > 0 && text.length <= 8 ? text : null;
      }
      const nodes = document.querySelectorAll('button, [role="tab"]');
      for (const node of nodes) {
        const text = node.textContent?.trim() ?? '';
        if (text.length === 0 || text.length > 8) continue;
        if (!parseIntervalLabel(text, { bare: false })) continue;
        const selected =
          node.getAttribute('aria-pressed') === 'true' ||
          node.getAttribute('aria-selected') === 'true' ||
          node.getAttribute('aria-checked') === 'true';
        const cls = String(node.className ?? '');
        if (selected || /(?:^|\s)active(?:\s|$)/i.test(cls) || cls.includes('--active')) return text;
      }
      return null;
    };

    const publish = () => {
      try {
        const context = detectMarketContext({
          href: location.href,
          title: document.title,
          domInterval: readDomInterval(),
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

    document.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const control = target.closest('button, [role="tab"]');
        if (!control) return;
        const text = control.textContent?.trim() ?? '';
        if (text.length === 0 || text.length > 8) return;
        if (!parseIntervalLabel(text, { bare: source === 'tradingview' })) return;
        schedule();
      },
      true,
    );

    schedule();
  },
});
