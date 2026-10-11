import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from '@playwright/test';
import { fulfillJson } from '../fixtures/browser';
import { toBinanceKlines } from '../fixtures/candles.mjs';

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
 */
async function openSidePanel(fetchImpl?: () => Promise<unknown>): Promise<SidePanel> {
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
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.routeWebSocket(/fstream\.binance\.com/, () => {});
  await page.route(/https:\/\/fapi\.binance\.com\/fapi\/v1\/klines/, (route) =>
    fulfillJson(route, toBinanceKlines()),
  );
  await page.route(new RegExp(NEWS_URL), async (route) => {
    newsRequests.push(route.request().url());
    return fulfillJson(route, fetchImpl ? await fetchImpl() : { items: [] });
  });

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

test('side panel renders the chart and findings from mocked klines', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    const findings = page.getByRole('region', { name: 'Hallazgos' });
    await expect(findings).toContainText('fuerza');
    await expect(findings).toContainText('Doble suelo');
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
      .locator('button', { hasText: 'Doble suelo' });
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

test('news card shows headlines from the mocked api with relative time and sentiment', async () => {
  const panel = await openSidePanel(async () => newsItemsFixture());
  try {
    const { page, newsRequests } = panel;
    const news = page.getByRole('region', { name: 'Titulares' });
    await expect(news).toBeVisible();

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
    const settings = page.locator('details.settings');
    await settings.locator('summary').click();
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
    await settings.locator('input[type="checkbox"]').uncheck();
    await expect.poll(async () => (await readSettings()).settings?.autoSync).toBe(false);

    await expect(page.locator('input[aria-label="Símbolo"]')).toHaveValue('BTCUSDT');
    expect(extensionId.length).toBeGreaterThan(0);
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});
