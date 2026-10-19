import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from '@playwright/test';
import { FNG, fulfillJson } from '../fixtures/browser';
import { aggressiveBuyKlines, toBinanceKlines } from '../fixtures/candles.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensionDir = path.join(repoRoot, 'apps/extension/.output/chrome-mv3');

/** Mismo host que la tarjeta de titulares pide. */
const NEWS_URL = 'trade.swal.network/api/news';

interface SidePanel {
  page: import('@playwright/test').Page;
  extensionId: string;
  errors: string[];
  newsRequests: string[];
  close(): Promise<void>;
}

/**
 * Carga el build de la extensión en un Chromium persistente con las llamadas de
 * red interceptadas: velas de Binance y titulares de trade.swal.network.
 * `klines` permite mockear otra ventana (por ejemplo con volumen taker).
 */
async function openSidePanel(
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

/** Abre una pestaña del panel por su nombre. */
async function openTab(page: import('@playwright/test').Page, name: 'Operación' | 'Análisis' | 'Ajustes') {
  await page.getByRole('tab', { name }).click();
  await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
}

/** Cinco titulares con tonos distintos: positivo, negativo y neutral. */
function newsItemsFixture() {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  return {
    symbol: 'BTC',
    asOf: new Date().toISOString(),
    items: [
      {
        id: '1'.repeat(64),
        title: 'Bitcoin rompe maximos anuales con rally institucional',
        url: 'https://ejemplo.test/btc-rally',
        source: 'Ejemplo Crypto',
        publishedAt: minutesAgo(4),
        snippet: 'Las entradas de fondos marcan un record.',
        provider: 'brave',
        symbols: ['BTC'],
        sentiment: { score: 0.8, label: 'positivo' },
      },
      {
        id: '2'.repeat(64),
        title: 'Un exchange sufre un hack y el mercado se desploma',
        url: 'https://ejemplo.test/hack',
        source: 'Ejemplo News',
        publishedAt: minutesAgo(95),
        snippet: 'Retiros suspendidos por precaucion.',
        provider: 'tavily',
        symbols: ['BTC'],
        sentiment: { score: -0.7, label: 'negativo' },
      },
      {
        id: '3'.repeat(64),
        title: 'La SEC retrasa la decision sobre el ETF',
        url: 'https://ejemplo.test/sec',
        source: 'Ejemplo Wire',
        publishedAt: minutesAgo(60 * 26),
        snippet: 'Sin fecha nueva por ahora.',
        provider: 'firecrawl',
        symbols: ['BTC'],
        sentiment: { score: 0, label: 'neutral' },
      },
      {
        id: '4'.repeat(64),
        title: 'Ethereum aprueba la actualizacion de la red',
        url: 'https://ejemplo.test/eth-upgrade',
        source: 'Ejemplo Crypto',
        publishedAt: minutesAgo(60 * 3),
        snippet: 'La comunidad celebra la aprobacion.',
        provider: 'brave',
        symbols: ['ETH'],
        sentiment: { score: 0.5, label: 'positivo' },
      },
      {
        // Fila inválida: el panel tiene que descartarla, no romperse.
        id: '5'.repeat(64),
        title: 'Titular sin enlace',
        url: 'not-a-url',
        source: 'Ejemplo Roto',
        publishedAt: minutesAgo(10),
        snippet: '',
        provider: 'brave',
        symbols: ['BTC'],
        sentiment: { score: 0.1, label: 'positivo' },
      },
    ],
  };
}

test('side panel clears paint on unmount and pagehide', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;

    // Mock the browser tabs query and sendMessage locally
    await page.evaluate(() => {
      const w = window as any;
      w._paintCommands = [];
      w.chrome.tabs = w.chrome.tabs || {};
      w.chrome.tabs.query = async () => [{ id: 1, url: 'https://www.binance.com/en/futures/BTCUSDT' }];
      const origSendMessage = w.chrome.tabs.sendMessage;
      w.chrome.tabs.sendMessage = async (tabId: number, msg: any) => {
        if (msg && msg.type === 'tv-paint') {
          w._paintCommands.push(msg);
        }
        if (origSendMessage) return origSendMessage(tabId, msg);
      };
    });

    // We toggle paint on first to register any setting
    await openTab(page, 'Ajustes');
    const paintToggle = page.getByRole('checkbox', { name: 'Pintar en el gráfico de Binance (pestaña Trading View)' });
    await paintToggle.check();
    // Await for some rendering
    await page.waitForTimeout(500);

    // Despachar el evento pagehide en la ventana del panel.
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    // Comprobar que se ha capturado el comando.
    const commands = await page.evaluate(() => {
      return (window as any)._paintCommands;
    });

    expect(commands).toBeDefined();
    const lastCommand = commands[commands.length - 1];
    expect(lastCommand).toBeDefined();
    expect(lastCommand.enabled).toBe(false);

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('side panel renders the chart and findings from mocked klines', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    const findings = page.getByRole('region', { name: 'Hallazgos' });
    await expect(findings).toContainText('fuerza');
    await expect(findings).toContainText('Doble suelo');
    // Los tres primeros son una línea «etiqueta · fuerza N»; la explicación va plegada.
    await expect(findings.locator('summary').first()).toHaveText(/^.+ · fuerza \d+$/);
    await expect(findings.locator('details.finding[open]')).toHaveCount(0);
    await expect(findings).not.toContainText(/probabilidad/i);
    const canvas = page.locator('.chart canvas').first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box && box.width > 20 && box.height > 20).toBe(true);
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('the chart overlay renders every top finding, not only the selected one', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    const legend = page.getByRole('list', { name: 'Leyenda del gráfico' });
    await expect(legend).toBeVisible();

    // La serie de velas tiene un doble suelo y tres hallazgos más en el top.
    const rows = legend.locator('li > button');
    await expect(rows).toHaveCount(4);

    // Todos los hallazgos del top están en la leyenda, con su confirmación.
    await expect(legend).toContainText('Doble suelo');
    await expect(legend).toContainText('Divergencia alcista RSI');
    await expect(legend).toContainText('Perfil de volumen');
    await expect(legend).toContainText('Zona de soporte');
    await expect(legend).toContainText('confirma 120.3');
    await expect(legend).toContainText('invalida 109.5');
    await expect(legend).not.toContainText(/probabilidad/i);

    // Marcadores de varios hallazgos: la leyenda no es solo del elegido.
    const ids = await rows.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-finding-id')),
    );
    expect(new Set(ids).size).toBe(4);

    // Al pulsar un hallazgo se resalta; el resto sigue en la leyenda.
    const volumeRow = legend.locator('button').filter({ hasText: 'Perfil de volumen' });
    await volumeRow.click();
    await expect(volumeRow).toHaveAttribute('aria-pressed', 'true');
    await expect(legend.locator('button').filter({ hasText: 'Perfil de volumen' })).toHaveCount(1);
    await expect(legend).toContainText('Doble suelo');

    // La lista de hallazgos y la leyenda comparten la selección.
    const findingButton = page
      .getByRole('region', { name: 'Hallazgos' })
      .locator('summary', { hasText: 'Doble suelo' });
    await findingButton.click();
    await expect(legend.locator('button').filter({ hasText: 'Doble suelo' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('el panel de CVD pinta el flujo de volumen de las velas mockeadas', async () => {
  const panel = await openSidePanel(undefined, aggressiveBuyKlines());
  try {
    const { page } = panel;
    const flow = page.getByRole('region', { name: 'Flujo de volumen' });
    await expect(flow).toBeVisible();
    // Plegado por defecto: el resumen ya dice hacia dónde empuja el flujo.
    await expect(flow.locator('summary')).toHaveText(/^Flujo CVD · /);
    await expect(flow.locator('canvas').first()).toBeHidden();
    await flow.locator('summary').click();

    // La leyenda explica el CVD en una línea.
    await expect(flow.locator('.flow-legend')).toContainText(
      'CVD = compra agresiva acumulada − venta agresiva acumulada (volumen taker)',
    );

    // El panel vive debajo del gráfico de precio y pinta sus propias series.
    const price = page.locator('.chart canvas').first();
    const cvd = flow.locator('canvas').first();
    await expect(price).toBeVisible();
    await expect(cvd).toBeVisible();
    const priceBox = await price.boundingBox();
    const cvdBox = await cvd.boundingBox();
    expect(priceBox && cvdBox).toBeTruthy();
    expect(cvdBox!.width).toBeGreaterThan(100);
    expect(cvdBox!.height).toBeGreaterThan(40);
    expect(cvdBox!.y).toBeGreaterThan(priceBox!.y + priceBox!.height - 1);

    // 71 velas mockeadas, ninguna inventada.
    await expect(flow.locator('.flow-chart')).toHaveAttribute('data-cvd-points', '71');

    // La compra agresiva sale en la lista con su etiqueta en español.
    await expect(page.getByRole('region', { name: 'Hallazgos' })).toContainText('Compra agresiva');

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('news card shows headlines from the mocked api with relative time and sentiment', async () => {
  const panel = await openSidePanel(async () => newsItemsFixture());
  try {
    const { page, newsRequests } = panel;
    const news = page.getByRole('region', { name: 'Titulares' });
    await expect(news).toBeVisible();
    await expect(news.locator('summary')).toHaveText(/^Titulares · 4 · último hace \d/);
    await news.locator('summary').click();

    // Pide al endpoint público con el activo del símbolo abierto.
    await expect
      .poll(() => newsRequests.filter((url) => url.includes('symbol=BTC')).length)
      .toBeGreaterThan(0);
    expect(newsRequests.some((url) => url.includes('/api/news'))).toBe(true);

    // Cuatro titulares válidos; el quinto se descarta por no traer enlace.
    const items = news.locator('li');
    await expect(items).toHaveCount(4);
    await expect(news).toContainText('rally institucional');
    await expect(news).toContainText('se desploma');
    await expect(news).toContainText('retrasa la decision');
    await expect(news).not.toContainText('Titular sin enlace');

    // Fuente, hace cuánto y el tono como texto.
    await expect(items.first()).toContainText('Ejemplo Crypto');
    await expect(items.first()).toContainText(/hace \d/);
    await expect(news.locator('[data-label="positivo"]').first()).toHaveText('positivo');
    await expect(news.locator('[data-label="negativo"]')).toHaveText('negativo');
    await expect(news.locator('[data-label="neutral"]')).toHaveText('neutral');
    await expect(news).not.toContainText(/probabilidad/i);

    // El enlace apunta fuera y se abre en otra pestaña.
    const link = items.first().locator('a');
    await expect(link).toHaveAttribute('href', 'https://ejemplo.test/btc-rally');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('news card degrades to a note when the service has nothing', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    const news = page.getByRole('region', { name: 'Titulares' });
    await news.locator('summary').click();
    await expect(news).toContainText('Sin titulares recientes.');
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('settings persist to storage.local and gate the symbol and timeframe', async () => {
  const panel = await openSidePanel();
  try {
    const { page, extensionId } = panel;
    await openTab(page, 'Ajustes');
    const settings = page.locator('section.settings');
    // Los controles se habilitan cuando storage.local ha respondido.
    const timeframeSelect = settings.locator('select').first();
    await expect(timeframeSelect).toBeEnabled();

    // La temporalidad por defecto se guarda y sobrevive a una recarga.
    await timeframeSelect.selectOption('1h');
    const symbolInput = settings.locator('input[type="text"]');
    await symbolInput.fill('ETH');
    await symbolInput.blur();

    const readSettings = () =>
      page.evaluate(
        () =>
          new Promise<{ settings?: Record<string, unknown> }>((resolve) => {
            const api = (
              window as unknown as {
                chrome: { storage: { local: { get(k: string, cb: (v: unknown) => void): void } } };
              }
            ).chrome;
            api.storage.local.get('settings', (value) => resolve(value as { settings?: unknown }));
          }),
      );

    const stored = await readSettings();
    expect(stored.settings).toMatchObject({ defaultTimeframe: '1h', symbols: ['ETH'], autoSync: true });

    // El interruptor de pintar en el gráfico de Binance arranca apagado.
    const paintToggle = page.getByRole('checkbox', {
      name: 'Pintar en el gráfico de Binance (pestaña Trading View)',
    });
    await expect(paintToggle).not.toBeChecked();
    expect((await readSettings()).settings).toMatchObject({ paintOnChart: false });
    await paintToggle.check();
    await expect.poll(async () => (await readSettings()).settings?.paintOnChart).toBe(true);
    await paintToggle.uncheck();
    await expect.poll(async () => (await readSettings()).settings?.paintOnChart).toBe(false);

    // El panel solo sigue al ETH: el BTC que trae por defecto se bloquea.
    await expect(page.locator('.header p.hint')).toContainText('Fuera de tu lista de símbolos');

    // Apagar el seguimiento deja de aplicar el contexto de la página.
    await settings.locator('input[type="checkbox"]').first().uncheck();
    await expect.poll(async () => (await readSettings()).settings?.autoSync).toBe(false);

    await expect(page.locator('input[aria-label="Símbolo"]')).toHaveValue('BTCUSDT');
    expect(extensionId.length).toBeGreaterThan(0);
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('explain card: opt-in gate, mocked AI answer, and local fallback on 429', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    let mode: 'ai' | 'rate_limited' = 'rate_limited';
    const explainRequests: string[] = [];
    await page.route(/trade\.swal\.network\/api\/explain/, async (route) => {
      explainRequests.push(route.request().url());
      if (mode === 'rate_limited') {
        await fulfillJson(route, { error: 'rate_limited', retryAfterS: 600 }, 429);
        return;
      }
      await fulfillJson(route, {
        source: 'ai',
        summary: 'El análisis ve un doble suelo sobre el soporte.',
        scenarios: [
          {
            name: 'Doble suelo',
            condition: 'cierre por encima de 101',
            invalidation: 'cierre por debajo de 98',
            risk_note: 'stop detrás de 98',
          },
        ],
        caution: 'La fuerza del patrón no es una tasa de acierto.',
      });
    });

    const card = page.getByTestId('explain-card');
    await expect(card).toBeVisible();
    const button = page.getByTestId('explain-button');
    await expect(button).toBeDisabled();
    await expect(card).toContainText('Explicación educativa. No es una recomendación de compra o venta.');
    await expect(card).toContainText('nunca datos de tu cuenta');
    expect(explainRequests).toEqual([]);

    // Sin encender el interruptor no sale ninguna petición, ni al pulsar.
    await card.getByRole('checkbox', { name: 'Explicaciones con IA' }).check();
    await expect(button).toBeEnabled();

    // 429: explicación local con el motivo, sin romper el panel.
    await button.click();
    const answer = page.getByTestId('explain-answer');
    await expect(answer).toHaveAttribute('data-source', 'fallback');
    await expect(answer).toContainText('límite por hora alcanzado');
    await expect(answer).toContainText('Doble suelo');
    await expect(answer).not.toContainText(/probabilidad/i);

    // Al cambiar de temporalidad la explicación anterior se limpia.
    mode = 'ai';
    await page.locator('select[aria-label="Temporalidad"]').selectOption('1h');
    await expect(page.getByTestId('explain-answer')).toHaveCount(0);
    await button.click();
    await expect(answer).toHaveAttribute('data-source', 'ai');
    await expect(answer).toContainText('doble suelo sobre el soporte');
    await expect(answer).toContainText('confirma');
    await expect(answer).toContainText('invalida');
    expect(explainRequests).toEqual([
      'https://trade.swal.network/api/explain',
      'https://trade.swal.network/api/explain',
    ]);

    // El 429 deliberado deja una traza «Failed to load resource» en consola:
    // es ruido de red esperado, no un fallo de la tarjeta.
    const unexpected = panel.errors.filter((line) => !/429|Too Many Requests/.test(line));
    expect(unexpected, unexpected.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

/** Responde `acct:snapshot` desde el propio panel, como si el background tuviera una clave de lectura. */
const MOCK_ACCOUNT_SCRIPT = `
(() => {
  const runtime = window.chrome && window.chrome.runtime;
  if (!runtime) return;
  const original = runtime.sendMessage.bind(runtime);
  window.__acctRequests = [];
  runtime.sendMessage = (message, ...rest) => {
    if (message && message.type === 'acct:snapshot') {
      window.__acctRequests.push(message.symbol);
      const now = Date.now();
      const positions = message.symbol === 'BTCUSDT' ? [{
        symbol: 'BTCUSDT', side: 'long', size: 0.1, entry: 100, mark: 105, liq: 80,
        leverage: 5, marginType: 'cross', uPnl: 0.5, breakEven: null, notional: 10.5,
        stop: null, firstFillMs: null,
      }] : [];
      return Promise.resolve({
        snapshot: { fetchedAt: now, equity: 1000, dailyPnl: null, positions, fundingRate: null, nextFundingMs: null },
        source: 'api',
        fetchedAt: now,
      });
    }
    return original(message, ...rest);
  };
})();
`;

test('panel has three tabs, keyboard navigation and sections collapsed by default', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    const tablist = page.getByRole('tablist');
    await expect(tablist.getByRole('tab')).toHaveText(['Operación', 'Análisis', 'Ajustes']);
    await expect(page.getByRole('tab', { name: 'Operación' })).toHaveAttribute('aria-selected', 'true');

    // Sin posición conocida y sin clave: modo unknown, con el aviso y el dimensionador.
    await expect(page.getByTestId('mode-notice')).toHaveText(
      'No sé si tienes posición. Conecta una clave de solo lectura (Ajustes).',
    );
    await expect(page.getByTestId('sizing-card')).toHaveCount(1);

    // Pulso, titulares, CVD y hallazgos extra: plegados y con resumen corto.
    await expect(page.getByRole('region', { name: 'Hallazgos' })).toBeVisible();
    await expect(page.locator('details[open]')).toHaveCount(0);
    const summaries = await page.locator('details.fold > summary, details.finding > summary').allTextContents();
    expect(summaries.length).toBeGreaterThan(3);
    for (const text of summaries) expect(text.length).toBeLessThanOrEqual(70);
    await expect(page.getByRole('region', { name: 'Pulso de mercado' }).locator('summary')).toHaveText(/^Pulso · /);

    // Teclado: flechas cambian de pestaña y la elegida sobrevive a una recarga.
    await page.getByRole('tab', { name: 'Operación' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Análisis' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Análisis con IA — próximamente')).toBeVisible();
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'Ajustes' })).toHaveAttribute('aria-selected', 'true');
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Ajustes' })).toHaveAttribute('aria-selected', 'true');
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('with an open position the sizing form is gone and the position card shows', async () => {
  const panel = await openSidePanel(undefined, toBinanceKlines(), MOCK_ACCOUNT_SCRIPT);
  try {
    const { page } = panel;
    // Una clave de lectura configurada: el panel empieza a preguntar por la cuenta.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const api = (window as unknown as {
            chrome: { storage: { local: { set(v: unknown, cb: () => void): void } } };
          }).chrome;
          api.storage.local.set(
            { settings: { acctMeta: { configured: true, kind: 'ed25519', last4: 'abcd' } } },
            resolve,
          );
        }),
    );
    await page.reload();

    const card = page.getByTestId('position-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('LARGO · 0.1 BTCUSDT · 5x · cruzado');
    await expect(card).toContainText('SIN STOP');
    // Reglas: sin stop es crítica y va primero, con prefijo y sin depender del color.
    await expect(page.getByTestId('rules-list')).toContainText('!! Sin stop');
    await expect(card).toContainText('Liquidación a 23.8 %');
    await expect(page.getByTestId('sizing-card')).toHaveCount(0);
    await expect(page.getByTestId('mode-notice')).toHaveCount(0);
    const requests = await page.evaluate(() => (window as unknown as { __acctRequests: string[] }).__acctRequests);
    expect(requests[0]).toBe('BTCUSDT');
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('manual position works without credentials, runs the rules and can be removed', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    await expect(page.getByTestId('sizing-card')).toHaveCount(1);
    await expect(page.getByTestId('position-card')).toHaveCount(0);

    await page.getByTestId('manual-open').click();
    await expect(page.getByTestId('manual-form')).toBeVisible();
    // Dato malo: se queda en el formulario con una frase corta.
    await page.getByTestId('manual-save').click();
    await expect(page.getByTestId('manual-error')).toBeVisible();

    await page.locator('input[name=entry]').fill('100');
    await page.locator('input[name=size]').fill('0.5');
    await page.locator('input[name=leverage]').fill('5');
    await page.getByTestId('manual-save').click();

    const card = page.getByTestId('position-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('LARGO · 0.5 BTCUSDT · 5x');
    await expect(card).toContainText('MANUAL');
    await expect(card).toContainText('SIN STOP');
    await expect(page.getByTestId('rules-list')).toContainText('!! Sin stop');
    await expect(page.getByTestId('sizing-card')).toHaveCount(0);

    // Sobrevive a una recarga (storage.session) y se puede quitar.
    await page.reload();
    await expect(page.getByTestId('position-card')).toContainText('MANUAL');
    await page.getByTestId('manual-remove').click();
    await expect(page.getByTestId('position-card')).toHaveCount(0);
    await expect(page.getByTestId('sizing-card')).toHaveCount(1);
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

/** Simula las respuestas del background a los mensajes acct:* (sin secretos). */
const MOCK_CREDENTIALS_SCRIPT = `
(() => {
  const runtime = window.chrome && window.chrome.runtime;
  if (!runtime) return;
  const original = runtime.sendMessage.bind(runtime);
  window.__acctSent = [];
  runtime.sendMessage = (message, ...rest) => {
    const type = message && message.type;
    if (type === 'acct:meta') return Promise.resolve({ configured: false, kind: 'none', last4: '' });
    if (type === 'acct:gen-ed25519') {
      return Promise.resolve({ publicPem: '-----BEGIN PUBLIC KEY-----\\nfake-visible-marker-a\\n-----END PUBLIC KEY-----' });
    }
    if (type === 'acct:set-key') { window.__acctSent.push(message.kind); return Promise.resolve({ ok: true }); }
    if (type === 'acct:snapshot') return Promise.resolve({ error: 'no_key' });
    if (type === 'acct:test') return Promise.resolve(window.__testReply || { ok: false, error: 'clock' });
    return original(message, ...rest);
  };
})();
`;

test('settings tab: credential sections, password inputs, key generation and error mapping', async () => {
  const panel = await openSidePanel(undefined, toBinanceKlines(), MOCK_CREDENTIALS_SCRIPT);
  try {
    const { page } = panel;
    await openTab(page, 'Ajustes');
    await expect(page.getByTestId('cred-binance')).toBeVisible();
    await expect(page.getByTestId('cred-ai')).toBeVisible();
    await expect(page.getByTestId('rules-settings')).toBeVisible();

    const keyInput = page.locator('input[name=binance-api-key]');
    await expect(keyInput).toHaveAttribute('type', 'password');
    await expect(page.locator('input[name=binance-hmac-key]')).toHaveAttribute('type', 'password');
    await expect(page.locator('input[name=binance-hmac-secret]')).toHaveAttribute('type', 'password');
    await expect(page.locator('input[name=ai-key]')).toHaveAttribute('type', 'password');
    await expect(page.getByTestId('cred-hmac')).not.toHaveAttribute('open', '');

    await page.getByRole('button', { name: 'Generar clave' }).click();
    await expect(page.getByTestId('cred-pem')).toContainText('BEGIN PUBLIC KEY');

    await keyInput.fill('fakevisiblemarkera');
    await page.getByTestId('cred-binance').getByRole('button', { name: 'Guardar clave' }).click();
    await expect(keyInput).toHaveValue('');
    await expect(page.getByTestId('cred-binance-status')).toContainText('termina en kera');

    // Error mapeado a una frase en español.
    await page.getByRole('button', { name: 'Probar' }).click();
    await expect(page.getByTestId('cred-error')).toContainText('reloj');

    // Clave con permiso de Futuros: aviso visible y solo rutas de lectura.
    await page.evaluate(() => {
      (window as unknown as { __testReply: unknown }).__testReply = {
        ok: true,
        restrictions: { ipRestrict: false, enableReading: true, tradingEnabled: true },
      };
    });
    await page.getByRole('button', { name: 'Probar' }).click();
    await expect(page.getByTestId('cred-ip')).toContainText('Restricción de IP: no');
    await expect(page.getByTestId('cred-trading-note')).toContainText('La extensión solo usa rutas de lectura.');

    // Retiros: rechazo claro.
    await page.evaluate(() => {
      (window as unknown as { __testReply: unknown }).__testReply = { ok: false, error: 'key_has_trading_or_withdraw' };
    });
    await page.getByRole('button', { name: 'Probar' }).click();
    await expect(page.getByTestId('cred-error')).toContainText('Esta clave puede retirar fondos. Créala sin permiso de retiros.');

    // IA: el consentimiento nombra al proveedor y los campos.
    await expect(page.getByTestId('ai-consent-text')).toContainText('OpenCode');
    await expect(page.getByTestId('ai-consent-text')).toContainText('sin importes en USD ni cantidades');
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});
