// Captura imágenes PNG 1280x800 del panel de la extensión para la tienda (Chrome Web Store / Firefox AMO).
// Carga el build real de apps/extension/.output/chrome-mv3 en Playwright Chromium con toda la red mockeada
// determinista: velas de Binance con volumen taker para CVD, muros del libro, liquidaciones, miedo/codicia,
// titulares y explicación educativa.
//
// Requisitos:
//   - Build de la extensión (npm run build en apps/extension)
//   - Dependencias de e2e (@playwright/test)
//   - ImageMagick (magick o convert) para dejar el PNG24 RGB sin canal alfa ni metadatos locales
//
// Uso desde la raíz del repo:
//   node apps/extension/scripts/store-screenshots.mjs

import { execFileSync, execSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// En entornos con TMPDIR especial (p. ej. agentes / sandboxes), usar /tmp para evitar fallos de Chromium en NixOS
if (process.env.TMPDIR && process.env.TMPDIR.includes('antigravity')) {
  process.env.TMPDIR = '/tmp';
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const extensionDir = path.join(repoRoot, 'apps/extension/.output/chrome-mv3');
const outDir = path.join(repoRoot, 'apps/extension/store-assets');
const WIDTH = 1280;
const HEIGHT = 800;

// Cargar Playwright desde e2e si no está en apps/extension
let chromium;
try {
  ({ chromium } = await import('@playwright/test'));
} catch {
  const require = createRequire(path.join(repoRoot, 'e2e/package.json'));
  ({ chromium } = require('@playwright/test'));
}

const { doubleBottomCandles } = await import(path.join(repoRoot, 'e2e/fixtures/candles.mjs'));

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': '*',
  'content-type': 'application/json',
};

async function fulfillJson(route, body, status = 200) {
  if (route.request().method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: CORS });
    return;
  }
  await route.fulfill({ status, headers: CORS, body: JSON.stringify(body) });
}

/** Velas con volumen taker variado para que el panel de CVD tenga delta positivo/negativo y curva. */
function buildKlines() {
  return doubleBottomCandles().map((cd) => {
    const share = cd.close >= cd.open ? 0.72 : 0.38;
    return [
      cd.time * 1000,
      String(cd.open),
      String(cd.high),
      String(cd.low),
      String(cd.close),
      String(cd.volume),
      cd.time * 1000 + 59_999,
      '0',
      Math.max(1, Math.round(cd.volume)),
      String(cd.volume * share),
      '0',
      '0',
      '0',
    ];
  });
}

/** Muros del libro de órdenes alrededor del precio medio ~116 con niveles grandes. */
function depthFixture() {
  return {
    bids: [
      ['115.8', '1.2'],
      ['115.5', '1.0'],
      ['115.2', '1.1'],
      ['114.8', '0.9'],
      ['114.0', '28.5'],
      ['112.5', '45.0'],
      ['110.0', '95.0'],
    ],
    asks: [
      ['116.2', '1.1'],
      ['116.5', '0.8'],
      ['116.8', '1.0'],
      ['117.2', '1.2'],
      ['117.8', '22.0'],
      ['119.5', '50.0'],
      ['122.0', '80.0'],
    ],
  };
}

/** Titulares mockeados con sentimiento léxico para el par BTC. */
function newsFixture() {
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  return {
    symbol: 'BTC',
    asOf: new Date().toISOString(),
    items: [
      {
        id: '1'.repeat(64),
        title: 'Bitcoin consolida tras tocar maximos anuales con entradas institucionales',
        url: 'https://ejemplo.test/btc-rally',
        source: 'Ejemplo Crypto',
        publishedAt: minutesAgo(4),
        snippet: 'Entradas constantes en fondos spot impulsan la estructura del mercado.',
        provider: 'brave',
        symbols: ['BTC'],
        sentiment: { score: 0.8, label: 'positivo' },
      },
      {
        id: '2'.repeat(64),
        title: 'Volatilidad contenida en futuros mientras se absorbe la liquidez del libro',
        url: 'https://ejemplo.test/orderbook',
        source: 'Ejemplo Markets',
        publishedAt: minutesAgo(42),
        snippet: 'Grandes bloques de órdenes pasivas sostienen el rango reciente.',
        provider: 'brave',
        symbols: ['BTC'],
        sentiment: { score: 0.1, label: 'neutral' },
      },
      {
        id: '3'.repeat(64),
        title: 'El regulador extiende el periodo de comentarios para nuevos derivados',
        url: 'https://ejemplo.test/regulatory',
        source: 'Ejemplo Wire',
        publishedAt: minutesAgo(115),
        snippet: 'Sin cambios en los calendarios previstos para los participantes de mercado.',
        provider: 'firecrawl',
        symbols: ['BTC'],
        sentiment: { score: 0, label: 'neutral' },
      },
      {
        id: '4'.repeat(64),
        title: 'Liquidaciones de cortos en la apertura europea impulsan el delta acumulado',
        url: 'https://ejemplo.test/liquidations',
        source: 'Ejemplo News',
        publishedAt: minutesAgo(180),
        snippet: 'La presión compradora agresiva supera el promedio de las últimas sesiones.',
        provider: 'tavily',
        symbols: ['BTC'],
        sentiment: { score: 0.65, label: 'positivo' },
      },
    ],
  };
}

/** Respuesta didáctica de explicación con IA basada en el análisis determinista. */
function explainFixture() {
  return {
    source: 'ai',
    summary: 'El análisis técnico detecta una formación de doble suelo sobre el nivel de soporte, con confirmación pendiente de rotura de cuello.',
    scenarios: [
      {
        name: 'Doble suelo',
        condition: 'cierre de 15m por encima de 120,3',
        invalidation: 'cierre por debajo de 109,5',
        risk_note: 'nivel de invalidación bajo el segundo mínimo en 109,5',
      },
    ],
    caution: 'La fuerza del patrón describe su definición técnica en las velas analizadas, no una probabilidad de acierto ni garantía de resultado.',
  };
}

function pngSize(buf) {
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error('La captura generada no es un PNG válido');
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colorType: buf[25],
    bytes: buf.length,
  };
}

/** Deja el PNG en RGB 24-bit sin canal alfa y sin texto con rutas locales. */
function stripPng(src, dest) {
  const magick = ['magick', 'convert'].find((bin) => {
    try {
      execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
  if (!magick) throw new Error('Se requiere magick o convert para convertir a PNG24 sin alfa');
  execFileSync(
    magick,
    [src, '-strip', '-background', 'white', '-alpha', 'remove', '-alpha', 'off', `png24:${dest}`],
    { stdio: 'ignore' },
  );
}

async function main() {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  let manifestRaw;
  try {
    manifestRaw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(`Falta el build de la extensión en ${extensionDir}. Corre: npm run build en apps/extension`);
  }
  const manifest = JSON.parse(manifestRaw);
  const sidePath = manifest.side_panel?.default_path ?? 'sidepanel.html';

  const tmpBase = process.env.TMPDIR && !process.env.TMPDIR.includes('antigravity') ? process.env.TMPDIR : '/tmp';
  const userData = await mkdtemp(path.join(tmpBase, 'swal-store-shot-'));

  let executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (!executablePath) {
    try {
      const found = execSync('ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | tail -1', {
        shell: '/bin/sh',
        encoding: 'utf8',
      }).trim();
      if (found) executablePath = found;
    } catch {}
  }

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

    const klinesData = buildKlines();
    await context.route(/https:\/\/fapi\.binance\.com\/fapi\/v1\/klines/, (route) => fulfillJson(route, klinesData));
    await context.route(/https:\/\/fapi\.binance\.com\/fapi\/v1\/depth/, (route) => fulfillJson(route, depthFixture()));
    await context.route(/api\.alternative\.me\/fng/, (route) =>
      fulfillJson(route, { data: [{ value: '37', value_classification: 'Fear', timestamp: '1700000000' }] }),
    );
    await context.route(/trade\.swal\.network\/api\/news/, (route) => fulfillJson(route, newsFixture()));
    await context.route(/trade\.swal\.network\/api\/explain/, (route) => fulfillJson(route, explainFixture()));

    // WebSocket mockeado: vela en vivo y liquidaciones
    await context.routeWebSocket(/fstream\.binance\.com/, (ws) => {
      ws.onMessage(() => {});
      const url = ws.url();
      if (url.includes('forceOrder')) {
        const now = Date.now();
        ws.send(
          JSON.stringify({
            e: 'forceOrder',
            E: now,
            o: { s: 'BTCUSDT', S: 'SELL', ap: '115.0', z: '450.0', T: now - 35_000 },
          }),
        );
        ws.send(
          JSON.stringify({
            e: 'forceOrder',
            E: now,
            o: { s: 'BTCUSDT', S: 'BUY', ap: '116.2', z: '180.0', T: now - 80_000 },
          }),
        );
      }
    });

    // Mock de página Binance Futures para vincular contexto de mercado (símbolo y temporalidad)
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
    if (!published) throw new Error('El content script no publicó BTCUSDT 15m');

    const page = await context.newPage();
    await page.setViewportSize({ width: WIDTH, height: HEIGHT });
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto(`chrome-extension://${new URL(worker.url()).host}/${sidePath}`);

    // Esperar a que el panel cargue gráfico, CVD, leyenda y hallazgos
    const findings = page.getByRole('region', { name: 'Hallazgos' });
    await findings.getByRole('button', { name: /Doble suelo/ }).first().waitFor({ timeout: 20_000 });
    await findings.getByText('fuerza').first().waitFor();
    const canvas = page.locator('.chart canvas').first();
    await canvas.waitFor();
    const box = await canvas.boundingBox();
    if (!box || box.width < 20 || box.height < 20) throw new Error('El gráfico de precio no renderizó');

    // Comprobar que el CVD tiene puntos
    await page.locator('.flow-chart canvas').first().waitFor();
    await page.getByText('Abre un futuro en Binance').waitFor({ state: 'hidden', timeout: 10_000 });

    // Ocultar barras de scroll y dar holgura inferior para poder encuadrar cada sección limpia en 800px
    await page.addStyleTag({
      content: '.app { scrollbar-width: none; padding-bottom: 700px !important; } .app::-webkit-scrollbar { display: none; }',
    });
    await page.waitForTimeout(500);

    const tempRaw = path.join(outDir, '.temp-raw.png');

    // 1. Panel principal: Gráfico de velas, CVD (volumen taker), leyenda y hallazgos
    await page.locator('.app').evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(400);
    const chartPng = path.join(outDir, 'sidepanel-chart-1280x800.png');
    await page.screenshot({ path: tempRaw, type: 'png', fullPage: false });
    stripPng(tempRaw, chartPng);
    await rm(tempRaw, { force: true });

    // 2. Pulso de mercado: Muros del libro, liquidaciones, miedo/codicia, régimen
    const pulse = page.getByRole('region', { name: 'Pulso de mercado' });
    await pulse.waitFor();
    await page.getByRole('article', { name: 'Muros del libro' }).waitFor();
    await page.locator('.app').evaluate((el) => {
      const p = el.querySelector('section.pulse');
      if (p) el.scrollTop = p.offsetTop - 16;
    });
    await page.waitForTimeout(400);
    const pulsePng = path.join(outDir, 'sidepanel-pulse-1280x800.png');
    await page.screenshot({ path: tempRaw, type: 'png', fullPage: false });
    stripPng(tempRaw, pulsePng);
    await rm(tempRaw, { force: true });

    // 3. Explicación educativa con IA: activar opt-in y generar respuesta explicativa
    const explainCard = page.getByTestId('explain-card');
    await explainCard.waitFor();
    const optIn = explainCard.getByRole('checkbox', { name: 'Explicaciones con IA' });
    await optIn.check();
    const explainBtn = page.getByTestId('explain-button');
    await explainBtn.waitFor({ state: 'visible' });
    await explainBtn.click();
    await page.getByTestId('explain-answer').waitFor({ timeout: 10_000 });
    await page.locator('.app').evaluate((el) => {
      const exp = el.querySelector('section.explain');
      if (exp) el.scrollTop = exp.offsetTop - 16;
    });
    await page.waitForTimeout(400);
    const explainPng = path.join(outDir, 'sidepanel-explain-1280x800.png');
    await page.screenshot({ path: tempRaw, type: 'png', fullPage: false });
    stripPng(tempRaw, explainPng);
    await rm(tempRaw, { force: true });

    // 4. Titulares de noticias de mercado
    await page.locator('.app').evaluate((el) => {
      const n = el.querySelector('section.news');
      if (n) el.scrollTop = n.offsetTop - 16;
    });
    await page.waitForTimeout(400);
    const newsPng = path.join(outDir, 'sidepanel-news-1280x800.png');
    await page.screenshot({ path: tempRaw, type: 'png', fullPage: false });
    stripPng(tempRaw, newsPng);
    await rm(tempRaw, { force: true });

    // 5. Ajustes del panel desplegados
    await page.locator('summary', { hasText: 'Ajustes' }).click();
    await page.locator('.settings-body').waitFor();
    await page.locator('.app').evaluate((el) => {
      const s = el.querySelector('details.settings');
      if (s) el.scrollTop = s.offsetTop - 16;
    });
    await page.waitForTimeout(400);
    const settingsPng = path.join(outDir, 'sidepanel-settings-1280x800.png');
    await page.screenshot({ path: tempRaw, type: 'png', fullPage: false });
    stripPng(tempRaw, settingsPng);
    await rm(tempRaw, { force: true });

    if (errors.length) {
      throw new Error(`Errores capturados en la página del panel:\n${errors.join('\n')}`);
    }

    const generatedFiles = [chartPng, pulsePng, explainPng, newsPng, settingsPng];
    for (const file of generatedFiles) {
      const info = pngSize(await readFile(file));
      const bytes = (await stat(file)).size;
      if (info.width !== WIDTH || info.height !== HEIGHT) {
        throw new Error(`${file} es ${info.width}x${info.height}, se esperaba ${WIDTH}x${HEIGHT}`);
      }
      if (info.colorType !== 2) {
        throw new Error(`${file} tiene colorType ${info.colorType}; se requiere RGB sin canal alfa`);
      }
      if (bytes < 10_000) throw new Error(`${file} pesa solo ${bytes} B`);
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
