// Captura dos PNG 1280x800 del panel de la extensión para la ficha de la tienda.
// Reutiliza el enfoque de e2e/tests/helpers/panel.ts: Chromium con la extensión
// cargada, velas de Binance mockeadas y titulares mockeados. No llama a la red.
//
// Requiere apps/extension/.output/chrome-mv3 (npm run build o npm run zip) y
// las dependencias de e2e (npm install en e2e/).
//
// Uso, desde la raíz del repo:
//   node e2e/scripts/store-screenshots.mjs
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { toBinanceKlines } from '../fixtures/candles.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensionDir = path.join(repoRoot, 'apps/extension/.output/chrome-mv3');
const outDir = path.join(repoRoot, 'apps/extension/store-assets');
const WIDTH = 1280;
const HEIGHT = 800;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': '*',
  'content-type': 'application/json',
};

async function fulfillJson(route, body) {
  if (route.request().method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: CORS });
    return;
  }
  await route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(body) });
}

function newsFixture() {
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
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
    ],
  };
}

function pngSize(buf) {
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error('la captura no es un PNG');
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colorType: buf[25],
    bytes: buf.length,
  };
}

/** PNG24 opaco, sin chunks de texto que puedan guardar una ruta local. */
function stripPng(src, dest) {
  const magick = ['magick', 'convert'].find((bin) => {
    try {
      execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
  if (!magick) throw new Error('hace falta magick o convert para dejar el PNG sin canal alfa');
  execFileSync(magick, [src, '-strip', '-background', 'white', '-alpha', 'remove', '-alpha', 'off', `png24:${dest}`], {
    stdio: 'inherit',
  });
}

async function main() {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  let manifestRaw;
  try {
    manifestRaw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(
      `Falta el build de la extensión en ${extensionDir}. Corre: npm run build en apps/extension`,
    );
  }
  const manifest = JSON.parse(manifestRaw);
  const sidePath = manifest.side_panel?.default_path ?? 'sidepanel.html';
  const userData = await mkdtemp(path.join(tmpdir(), 'swal-store-shot-'));
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const context = await chromium.launchPersistentContext(userData, {
    headless: false,
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    colorScheme: 'light',
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

    await context.route(/https:\/\/fapi\.binance\.com\/fapi\/v1\/klines/, (route) =>
      fulfillJson(route, toBinanceKlines()),
    );
    await context.route(/trade\.swal\.network\/api\/news/, (route) => fulfillJson(route, newsFixture()));
    await context.routeWebSocket(/fstream\.binance\.com/, () => {});
    await context.route(/https:\/\/www\.binance\.com\//, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html lang="es"><head><title>BTCUSDT | Binance Futures</title></head><body><p>Gráfico de prueba</p></body></html>',
      }),
    );

    const binance = await context.newPage();
    await binance.setViewportSize({ width: WIDTH, height: HEIGHT });
    await binance.goto('https://www.binance.com/en/futures/BTCUSDT?interval=15m', {
      waitUntil: 'domcontentloaded',
    });

    const deadline = Date.now() + 15_000;
    let published = false;
    while (Date.now() < deadline) {
      const stored = await worker.evaluate(async () => {
        const bag = await chrome.storage.session.get('marketContext');
        return bag.marketContext ?? null;
      });
      if (stored?.symbol === 'BTCUSDT' && stored?.timeframe === '15m' && stored?.timeframeInferred === false) {
        published = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!published) {
      throw new Error('el content script no publicó BTCUSDT 15m');
    }

    const page = await context.newPage();
    await page.setViewportSize({ width: WIDTH, height: HEIGHT });
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/${sidePath}`);
    const findings = page.getByRole('region', { name: 'Hallazgos' });
    await findings.getByRole('button', { name: /Doble suelo/ }).first().waitFor({ timeout: 20_000 });
    await findings.getByText('fuerza').first().waitFor();
    const canvas = page.locator('.chart canvas').first();
    await canvas.waitFor();
    const box = await canvas.boundingBox();
    if (!box || box.width < 20 || box.height < 20) throw new Error('el gráfico no tiene tamaño');
    await page.getByText('Abre un futuro en Binance').waitFor({ state: 'hidden', timeout: 10_000 });
    await page.addStyleTag({
      content: '.app { scrollbar-width: none; } .app::-webkit-scrollbar { display: none; }',
    });
    await page.waitForTimeout(600);
    if (errors.length) throw new Error(errors.join('\n'));

    const rawChart = path.join(outDir, '.chart-raw.png');
    const rawNews = path.join(outDir, '.news-raw.png');
    const chartPng = path.join(outDir, 'sidepanel-chart-1280x800.png');
    const newsPng = path.join(outDir, 'sidepanel-news-1280x800.png');

    await page.screenshot({ path: rawChart, type: 'png', fullPage: false });

    await page.locator('summary', { hasText: 'Ajustes' }).click();
    await page.locator('.settings-body').waitFor();
    await page.getByText('Bitcoin rompe maximos anuales').waitFor();
    await page.locator('.app').evaluate((el) => {
      const settings = el.querySelector('.settings');
      if (!settings) return;
      const bottom = settings.offsetTop + settings.offsetHeight;
      el.scrollTop = Math.max(0, bottom - el.clientHeight + 12);
    });
    await page.locator('text=Seguir la página abierta').waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: rawNews, type: 'png', fullPage: false });

    stripPng(rawChart, chartPng);
    stripPng(rawNews, newsPng);
    await rm(rawChart, { force: true });
    await rm(rawNews, { force: true });

    for (const file of [chartPng, newsPng]) {
      const info = pngSize(await readFile(file));
      const bytes = (await stat(file)).size;
      if (info.width !== WIDTH || info.height !== HEIGHT) {
        throw new Error(`${file} es ${info.width}x${info.height}, se esperaba ${WIDTH}x${HEIGHT}`);
      }
      if (info.colorType !== 2) {
        throw new Error(`${file} tiene colorType ${info.colorType}; la tienda pide RGB sin alfa`);
      }
      if (bytes < 10_000) throw new Error(`${file} pesa ${bytes} B; parece vacío`);
      process.stdout.write(`${path.relative(repoRoot, file)} ${info.width}x${info.height} ${bytes} B\n`);
    }
  } finally {
    await context.close();
    await rm(userData, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
