// Shared harness for the extension side panel.
//
// No test() calls in this file: every ext-*.spec.ts imports what it needs from
// here. Anything that opens a panel, intercepts the network or builds fixture
// data belongs here so the specs stay about the panel area they cover.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Page } from '@playwright/test';
import { FNG, fulfillJson } from '../../fixtures/browser';
import { aggressiveBuyKlines, toBinanceKlines } from '../../fixtures/candles.mjs';

// Re-exported so a spec only needs one import path.
export { FNG, fulfillJson };
export { aggressiveBuyKlines, toBinanceKlines };

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const extensionDir = path.join(repoRoot, 'apps/extension/.output/chrome-mv3');

/** Same host the headlines card asks for. */
export const NEWS_URL = 'trade.swal.network/api/news';

export interface SidePanel {
  page: Page;
  extensionId: string;
  errors: string[];
  newsRequests: string[];
  close(): Promise<void>;
}

/** Fake active Binance Futures tab (id 7): the panel only shows drawings of the active tab. */
export const FUTURES_TAB_FAKE = `(() => {
  const tabs = globalThis.chrome && globalThis.chrome.tabs;
  if (!tabs) return;
  const fake = [{ id: 7, active: true, url: 'https://www.binance.com/en/futures/BTCUSDT' }];
  tabs.query = (_q, cb) => {
    if (typeof cb === 'function') { cb(fake); return; }
    return Promise.resolve(fake);
  };
})();`;

/**
 * Loads the extension build in a persistent Chromium with the network stubbed:
 * Binance klines/depth/premiumIndex/ticker/exchangeInfo, alternative.me, the
 * local radar at 127.0.0.1:47322, the news endpoint and every websocket.
 * `klines` overrides the candle window (for example with taker volume).
 */
export async function openSidePanel(
  fetchImpl?: () => Promise<unknown>,
  klines: unknown = toBinanceKlines(),
  initScript?: string,
): Promise<SidePanel> {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(
      `Falta el build de la extensión en ${extensionDir}. Corre: npm ci && npm run build en apps/extension`,
    );
  }
  const manifest = JSON.parse(manifestRaw) as { side_panel?: { default_path?: string } };
  const sidePath = manifest.side_panel?.default_path ?? 'sidepanel.html';

  const userData = await mkdtemp(path.join(tmpdir(), 'swal-ext-e2e-'));
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const context = await chromium.launchPersistentContext(userData, {
    headless: false,
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
    ignoreDefaultArgs: ['--disable-extensions'],
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;

  const page = await context.newPage();
  const errors: string[] = [];
  const newsRequests: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('requestfailed', (req) => errors.push(`requestfailed ${req.url()}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.routeWebSocket(/fstream\.binance\.com/, () => {});
  // Nada de red real: en CI Binance responde 451 desde IPs de EE. UU. y no hay radar ni puente local.
  await page.routeWebSocket(/127\.0\.0\.1/, () => {});
  await page.route(/https:\/\/fapi\.binance\.com\/fapi\/v1\/depth/, (route) =>
    fulfillJson(route, { lastUpdateId: 1, bids: [], asks: [] }),
  );
  await page.route(/https:\/\/fapi\.binance\.com\/fapi\/v1\/premiumIndex/, (route) =>
    fulfillJson(route, {
      symbol: 'BTCUSDT',
      markPrice: '100.30',
      indexPrice: '100.00',
      lastFundingRate: '0.00008000',
      nextFundingTime: Date.now() + 3_600_000,
      time: Date.now(),
    }),
  );
  await page.route(/https:\/\/fapi\.binance\.com\/fapi\/v1\/ticker\/24hr/, (route) =>
    fulfillJson(route, { symbol: 'BTCUSDT', priceChangePercent: '1.195' }),
  );
  // Filtros del par para las tarjetas de operación (el test del escáner registra después su propio mock, que manda).
  await page.route(/https:\/\/fapi\.binance\.com\/fapi\/v1\/exchangeInfo/, (route) =>
    fulfillJson(route, {
      symbols: [
        {
          symbol: 'BTCUSDT',
          status: 'TRADING',
          contractType: 'PERPETUAL',
          quoteAsset: 'USDT',
          filters: [
            { filterType: 'PRICE_FILTER', tickSize: '0.10' },
            { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
            { filterType: 'MIN_NOTIONAL', notional: '100' },
          ],
        },
      ],
    }),
  );
  await page.route(/https:\/\/api\.alternative\.me\//, (route) => fulfillJson(route, FNG));
  await page.route(/http:\/\/127\.0\.0\.1:47322\//, (route) => fulfillJson(route, { ok: true, alerts: [] }));
  await page.route(/https:\/\/fapi\.binance\.com\/fapi\/v1\/klines/, (route) =>
    fulfillJson(route, klines),
  );
  await page.route(new RegExp(NEWS_URL), async (route) => {
    newsRequests.push(route.request().url());
    return fulfillJson(route, fetchImpl ? await fetchImpl() : { items: [] });
  });

  if (initScript) await page.addInitScript(initScript);
  await page.goto(`chrome-extension://${extensionId}/${sidePath}`);
  return {
    page,
    extensionId,
    errors,
    newsRequests,
    async close() {
      await context.close();
      await rm(userData, { recursive: true, force: true });
    },
  };
}

/** Opens a panel tab by name and waits until it is selected. */
export async function openTab(
  page: import('@playwright/test').Page,
  name: 'Operación' | 'Aprender' | 'Ajustes' | 'Escáner' | 'Mis trades',
) {
  await page.getByRole('tab', { name }).click();
  await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
}

/** Opens the API-key history: «Mis trades» with the «Clave API» source. */
export async function openAnalysis(page: import('@playwright/test').Page) {
  await openTab(page, 'Mis trades');
  await page.getByTestId('mytrades-source').selectOption('api');
  await expect(page.getByTestId('mytrades-api-panel')).toBeVisible();
}

/**
 * Mock of the analysis surface: an account with a long position, Binance history
 * (income and userTrades, numbers as text) and an `ai:analyze` answer.
 * `window.__aiRequests` records what the panel would send; `__aiMode` changes the reply.
 */
export const MOCK_ANALYSIS_SCRIPT = `
(() => {
  const chromeApi = window.chrome;
  if (!chromeApi || !chromeApi.runtime) return;
  // El estrangulador del historial espera 1800 ms (income) y 300 ms (trades) entre peticiones: aquí sobran.
  const realSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms === 1800 || ms === 300 ? 0 : ms, ...rest);
  if (chromeApi.permissions) chromeApi.permissions.contains = async () => true;
  const runtime = chromeApi.runtime;
  const original = runtime.sendMessage.bind(runtime);
  window.__aiRequests = [];
  window.__aiMode = 'ok';
  window.__acctGets = [];
  const HOUR = 3600000;
  const base = Date.now() - 48 * HOUR;
  const fills = [];
  const income = [];
  for (let i = 0; i < 3; i++) {
    const t = base + i * 4 * HOUR;
    fills.push({ symbol: 'BTCUSDT', id: 100 + i * 2, orderId: 900 + i, side: 'BUY', price: '100.0', qty: '1.000', realizedPnl: '0', quoteQty: '100', commission: '0.05', commissionAsset: 'USDT', time: t, positionSide: 'BOTH', maker: false, buyer: true });
    fills.push({ symbol: 'BTCUSDT', id: 101 + i * 2, orderId: 910 + i, side: 'SELL', price: i === 1 ? '98.0' : '103.0', qty: '1.000', realizedPnl: i === 1 ? '-2.0' : '3.0', quoteQty: '103', commission: '0.05', commissionAsset: 'USDT', time: t + HOUR, positionSide: 'BOTH', maker: false, buyer: false });
    income.push({ symbol: 'BTCUSDT', incomeType: 'REALIZED_PNL', income: i === 1 ? '-2.0' : '3.0', asset: 'USDT', info: 'REALIZED_PNL', time: t + HOUR, tranId: 7000 + i, tradeId: '1' });
  }
  const inWindow = (rows, p) => rows.filter((r) => r.time >= p.startTime && r.time <= p.endTime);
  runtime.sendMessage = (message, ...rest) => {
    if (message && message.type === 'acct:snapshot') {
      const now = Date.now();
      const positions = message.symbol === 'BTCUSDT' ? [{
        symbol: 'BTCUSDT', side: 'long', size: 0.1, entry: 100, mark: 105, liq: 80,
        leverage: 5, marginType: 'cross', uPnl: 0.5, breakEven: null, notional: 10.5,
        stop: { price: 97, kind: 'algo' }, firstFillMs: now - 60 * 60000,
      }] : [];
      return Promise.resolve({
        snapshot: { fetchedAt: now, equity: 1000, dailyPnl: null, positions, fundingRate: 0.0001, nextFundingMs: now + 3600000 },
        source: 'api', fetchedAt: now,
      });
    }
    if (message && message.type === 'acct:get') {
      window.__acctGets.push(message.path);
      if (message.path === '/fapi/v1/income') return Promise.resolve({ data: inWindow(income, message.params) });
      if (message.path === '/fapi/v1/userTrades') return Promise.resolve({ data: inWindow(fills, message.params) });
      return Promise.resolve({ error: 'http_404' });
    }
    if (message && message.type === 'ai:analyze') {
      window.__aiRequests.push(message);
      if (window.__aiMode === 'rate_limit') return Promise.resolve({ view: null, reason: 'rate_limit' });
      return Promise.resolve({ view: {
        resumen: 'Tu posición tiene stop y margen a la liquidación.',
        lectura: ['El stop está a 3 % del precio.'],
        opciones: [{ accion: 'Revisar el tamaño', coste: 'menos exposición', no_aplica_si: 'ya es pequeña' }],
        preguntas: [], faltan: [],
        flag: window.__aiMode === 'flag' ? 'Esta respuesta afirma algo que no podemos respaldar.' : undefined,
        disclaimer: 'Explicación educativa. No es una recomendación de compra o venta.',
      } });
    }
    return original(message, ...rest);
  };
})();
`;

/** Writes settings into storage.local and reloads the panel so it reads them. */
export async function seedSettings(page: import('@playwright/test').Page, settings: Record<string, unknown>) {
  await page.evaluate(
    (value) =>
      new Promise<void>((resolve) => {
        const api = (window as unknown as {
          chrome: { storage: { local: { set(v: unknown, cb: () => void): void } } };
        }).chrome;
        api.storage.local.set({ settings: value }, resolve);
      }),
    settings,
  );
  await page.reload();
}

/** Account metadata of a configured read-only key. */
export const KEY_META = { acctMeta: { configured: true, kind: 'ed25519', last4: 'abcd' } };

/** Width of one scanner candle: 5 minutes. */
export const SC_BAR = 300_000;

/** Binance-shaped 5m candles: 40 closed ending at `lastOpen`, the last one closing at `lastClose`. */
export function scannerKlines(lastOpen: number, lastClose: number): unknown[] {
  const rows: unknown[] = [];
  for (let i = 39; i >= 0; i--) {
    const open = lastOpen - i * SC_BAR;
    const close = i === 0 ? lastClose : 100;
    rows.push([
      open, String(close), String(close * 1.002), String(close * 0.998), String(close), '1000', open + SC_BAR - 1,
      String(close * 1000), 10, '500', '0', '0',
    ]);
  }
  return rows;
}
