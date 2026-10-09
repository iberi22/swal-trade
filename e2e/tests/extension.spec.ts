import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from '@playwright/test';
import { fulfillJson } from '../fixtures/browser';
import { toBinanceKlines } from '../fixtures/candles.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensionDir = path.join(repoRoot, 'apps/extension/.output/chrome-mv3');

test('side panel renders the chart and findings from mocked klines', async () => {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(`Falta el build de la extensión en ${extensionDir}. Corre: npm ci && npm run build en apps/extension`);
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

  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
    const extensionId = new URL(worker.url()).host;

    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.routeWebSocket(/fstream\.binance\.com/, () => {});
    await page.route(/https:\/\/fapi\.binance\.com\/fapi\/v1\/klines/, (route) => fulfillJson(route, toBinanceKlines()));

    await page.goto(`chrome-extension://${extensionId}/${sidePath}`);
    const findings = page.getByRole('region', { name: 'Hallazgos' });
    await expect(findings).toContainText('fuerza');
    await expect(findings).toContainText('Doble suelo');
    await expect(findings).not.toContainText(/probabilidad/i);
    const canvas = page.locator('.chart canvas').first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box && box.width > 20 && box.height > 20).toBe(true);
    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    await context.close();
    await rm(userData, { recursive: true, force: true });
  }
});
