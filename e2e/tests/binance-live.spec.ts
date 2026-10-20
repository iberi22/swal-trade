import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from '@playwright/test';
import { fulfillJson } from '../fixtures/browser';
import { liveBinanceKlines } from '../fixtures/candles.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensionDir = path.join(repoRoot, 'apps/extension/.output/chrome-mv3');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PAGE_URL = 'https://www.binance.com/en/futures/BTCUSDT';
const NEWS_URL = /trade\.swal\.network\/api\/news/;
const KLINES = /https:\/\/fapi\.binance\.com\/fapi\/v1\/klines/;

/**
 * Esta prueba corre contra la página PÚBLICA de Binance: necesita red, tarda
 * decenas de segundos y Binance puede cambiar su DOM cuando quiera. Por eso es
 * opcional: `npm run e2e:binance-live` desde `e2e/`. Sin la variable se salta.
 *
 * Lo que demuestra: que el puente MAIN-world llega al iframe de la pestaña
 * "Trading View", que pinta las formas de nuestros hallazgos y que las borra al
 * apagar el interruptor. Ni login, ni formularios de orden, ni cuenta.
 */
const LIVE = process.env.E2E_BINANCE_LIVE === '1';

/** Entidades que la API de TradingView tiene ahora mismo en el chart. */

async function chartResolution(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    for (const frame of document.querySelectorAll('iframe')) {
      const chart = (frame.contentWindow as any)?.tradingViewApi?.activeChart?.();
      if (typeof chart?.resolution === 'function') return String(chart.resolution());
    }
    return null;
  });
}

async function chartShapes(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    for (const frame of document.querySelectorAll('iframe')) {
      let win: Window | null = null;
      try {
        win = frame.contentWindow;
        // La página tiene iframes de otros orígenes: tocarlos lanza SecurityError.
        const api = (win as unknown as { tradingViewApi?: { activeChart(): unknown } } | null)
          ?.tradingViewApi;
        if (!api) continue;
        const chart = api.activeChart() as {
          getAllShapes(): Array<{ id: string; name: string }>;
        };
        return chart.getAllShapes().map((shape) => ({ id: shape.id, name: shape.name }));
      } catch {
        continue;
      }
    }
    return null;
  });
}

/**
 * true si el iframe de la Charting Library (pestaña "Trading View") se ve. Binance
 * deja el iframe montado pero oculto al volver a Original, así que no basta con
 * que exista en el DOM.
 */
function tradingViewShown(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => {
    const frame = [...document.querySelectorAll('iframe')].find((f) =>
      (f.getAttribute('src') ?? '').includes('/static/chart/tradingview/'),
    );
    if (!frame) return false;
    const rect = frame.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

/** Abre la página pública, descarta el banner y cambia a la pestaña indicada (por defecto Trading View). */
async function openFuturesPage(
  page: import('playwright/test').Page,
  tab: 'Trading View' | 'Original' = 'Trading View',
) {
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(9_000);
  // Único clic permitido sobre la página: el banner de cookies.
  for (const selector of ['button:has-text("Accept")', 'button:has-text("Aceptar")']) {
    try {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 600 })) {
        await button.click({ timeout: 1500 });
        break;
      }
    } catch {
      // Sin banner no hay nada que descartar.
    }
  }
  await page.waitForTimeout(2_000);
  // Clic por texto exacto: el heurístico de "último elemento visible" dejó de
  // acertar con el DOM actual de Binance.
  await page
    .getByText(tab === 'Original' ? 'Original' : 'Trading View', { exact: true })
    .first()
    .click({ timeout: 15_000 });
  if (tab === 'Original') return;
  // El iframe tarda en montar el chart y en tener rango visible.
  await expect
    .poll(() => chartShapes(page), { timeout: 45_000, intervals: [1_000] })
    .not.toBeNull();
}

test.describe('Binance, pestaña Trading View (en vivo, opcional)', () => {
  test.skip(
    !LIVE,
    'Prueba opcional: hace falta red y la página pública de Binance. Corre `npm run e2e:binance-live` desde e2e/.',
  );

  test('pinta los niveles al encender el interruptor y los borra al apagarlo', async () => {
    const manifestRaw = await readFile(path.join(extensionDir, 'manifest.json'), 'utf8').catch(() => {
      throw new Error(
        `Falta el build de la extensión en ${extensionDir}. Corre npm run build en apps/extension.`,
      );
    });
    const sidePath =
      (JSON.parse(manifestRaw) as { side_panel?: { default_path?: string } }).side_panel
        ?.default_path ?? 'sidepanel.html';

    const userData = await mkdtemp(path.join(tmpdir(), 'swal-binance-live-'));
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

    try {
      let worker = context.serviceWorkers()[0];
      if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
      const extensionId = new URL(worker.url()).host;

      const page = await context.newPage();
      // Las velas y los titulares van mockeados a nivel de contexto: también
      // entren al panel lateral, que es quien calcula los hallazgos. La prueba
      // no depende del mercado de hoy.
      await context.routeWebSocket(/fstream\.binance\.com/, () => {});
      await context.route(KLINES, (route) => fulfillJson(route, liveBinanceKlines()));
      await context.route(NEWS_URL, (route) => fulfillJson(route, { items: [] }));

      await openFuturesPage(page);

      // Antes de tocar nada, el gráfico está como estaba.
      expect(await chartShapes(page)).toEqual([]);

      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/${sidePath}`);

      // Los ajustes viven en la pestaña «Ajustes» del panel.
      await panel.getByRole('tab', { name: 'Ajustes' }).click();
      const toggle = panel.getByRole('checkbox', {
        name: 'Pintar en el gráfico de Binance (pestaña Trading View)',
      });
      await expect(toggle).toBeEnabled();
      // Apagado por defecto: es una anotación sobre la página, no un añadido.
      await expect(toggle).not.toBeChecked();

      await toggle.check();

      // El panel manda las formas y el puente las crea en el iframe.
      await expect
        .poll(async () => (await chartShapes(page))?.length ?? 0, { timeout: 30_000, intervals: [1_000] })
        .toBeGreaterThan(0);

      const painted = await chartShapes(page);
      expect(painted).not.toBeNull();
      const names = (painted ?? []).map((shape) => shape.name);
      // Niveles como líneas horizontales y, si el análisis los trae, más formas.
      expect(names).toContain('horizontal_line');
      expect(new Set(names).size).toBeGreaterThan(1);

      // El panel avisa de que está pintando, y el aviso no bloquea nada.
      await expect(panel.locator('[data-testid="paint-hint"]')).toBeVisible();

      // Evidencia: cómo queda el gráfico con el interruptor encendido.
      await page.screenshot({ path: path.join(repoRoot, 'e2e/test-results/binance-tv-painted.png') });

      // Al apagar el interruptor desaparecen solo las nuestras.
      await toggle.uncheck();
      await expect
        .poll(async () => (await chartShapes(page))?.length ?? -1, { timeout: 30_000, intervals: [1_000] })
        .toBe(0);

      // Y se vuelven a pintar si se enciende otra vez.
      await toggle.check();
      await expect
        .poll(async () => (await chartShapes(page))?.length ?? 0, { timeout: 30_000, intervals: [1_000] })
        .toBeGreaterThan(0);
      await toggle.uncheck();
      await expect
        .poll(async () => (await chartShapes(page))?.length ?? -1, { timeout: 30_000, intervals: [1_000] })
        .toBe(0);
    } finally {
      await context.close();
      await rm(userData, { recursive: true, force: true });
    }
  });

  test('atajo F3 en el frame del gráfico cambia la resolución a 15', async () => {
    const userData = await mkdtemp(path.join(tmpdir(), 'swal-binance-live-'));
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
    const context = await chromium.launchPersistentContext(userData, {
      headless: false,
      ...(executablePath ? { executablePath } : {}),
      args: ['--headless=new', `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
      ignoreDefaultArgs: ['--disable-extensions'],
    });
    try {
      const page = await context.newPage();
      await context.routeWebSocket(/fstream\.binance\.com/, () => {});
      await context.route(KLINES, (route) => fulfillJson(route, liveBinanceKlines()));
      await context.route(NEWS_URL, (route) => fulfillJson(route, { items: [] }));
      await openFuturesPage(page);
      const tvFrame = page.frames().find((f) => f.url().includes('tradingview')) ?? page.mainFrame();
      if ((await chartResolution(page)) === '15') {
        await tvFrame.locator('body').press('F1');
        await expect.poll(() => chartResolution(page), { timeout: 30_000, intervals: [1_000] }).toBe('1');
      }
      await tvFrame.locator('body').press('F3');
      await expect.poll(() => chartResolution(page), { timeout: 30_000, intervals: [1_000] }).toBe('15');
      await page.screenshot({ path: path.join(repoRoot, 'e2e/test-results/binance-tv-f3-resolution.png') });
    } finally {
      await context.close();
      await rm(userData, { recursive: true, force: true });
    }
  });

  test('desde Original, pintar cambia a Trading View y "Volver a Original" regresa', async () => {
    const manifestRaw = await readFile(path.join(extensionDir, 'manifest.json'), 'utf8').catch(() => {
      throw new Error(
        `Falta el build de la extensión en ${extensionDir}. Corre npm run build en apps/extension.`,
      );
    });
    const sidePath =
      (JSON.parse(manifestRaw) as { side_panel?: { default_path?: string } }).side_panel
        ?.default_path ?? 'sidepanel.html';

    const userData = await mkdtemp(path.join(tmpdir(), 'swal-binance-live-'));
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
    const context = await chromium.launchPersistentContext(userData, {
      headless: false,
      ...(executablePath ? { executablePath } : {}),
      args: ['--headless=new', `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
      ignoreDefaultArgs: ['--disable-extensions'],
    });
    try {
      let worker = context.serviceWorkers()[0];
      if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
      const extensionId = new URL(worker.url()).host;

      const page = await context.newPage();
      await context.routeWebSocket(/fstream\.binance\.com/, () => {});
      await context.route(KLINES, (route) => fulfillJson(route, liveBinanceKlines()));
      await context.route(NEWS_URL, (route) => fulfillJson(route, { items: [] }));
      await openFuturesPage(page, 'Original');

      // Original activa: no hay iframe de Trading View montado.
      await expect
        .poll(() => tradingViewShown(page), { timeout: 15_000, intervals: [500] })
        .toBe(false);

      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/${sidePath}`);
      // Los ajustes viven en la pestaña «Ajustes» del panel.
      await panel.getByRole('tab', { name: 'Ajustes' }).click();
      const toggle = panel.getByRole('checkbox', {
        name: 'Pintar en el gráfico de Binance (pestaña Trading View)',
      });
      await expect(toggle).toBeEnabled();
      await toggle.check();

      // (a) El content script cambia la página a Trading View antes de pintar.
      await expect
        .poll(() => tradingViewShown(page), { timeout: 45_000, intervals: [1_000] })
        .toBe(true);

      // (b) El puente confirmó el canal y dibujó las formas en el chart.
      await expect
        .poll(async () => (await chartShapes(page))?.length ?? 0, { timeout: 45_000, intervals: [1_000] })
        .toBeGreaterThan(0);
      const painted = (await chartShapes(page)) ?? [];
      expect(painted.map((shape) => shape.name)).toContain('horizontal_line');
      await page.screenshot({ path: path.join(repoRoot, 'e2e/test-results/binance-tv-auto-switched.png') });

      // Volver a Original desde el panel: el iframe de Trading View deja de verse.
      const backButton = panel.getByRole('button', { name: 'Volver a Original' });
      await expect(backButton).toBeVisible({ timeout: 15_000 });
      await backButton.click();
      await expect
        .poll(() => tradingViewShown(page), { timeout: 30_000, intervals: [1_000] })
        .toBe(false);
      await page.screenshot({ path: path.join(repoRoot, 'e2e/test-results/binance-original-restored.png') });
    } finally {
      await context.close();
      await rm(userData, { recursive: true, force: true });
    }
  });
});
