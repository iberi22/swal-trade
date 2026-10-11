import { expect, test, assertClean } from './site-test';
import { fulfillJson } from '../fixtures/browser';
import { aggressiveBuyKlines } from '../fixtures/candles.mjs';

test('chart, fuerza, focus, timeframe and fear & greed', async ({ page, problems }) => {
  const klines: string[] = [];
  page.on('request', (req) => {
    if (!req.url().includes('/fapi/v1/klines')) return;
    const url = new URL(req.url());
    klines.push(`${url.searchParams.get('interval')}:${url.searchParams.get('limit')}`);
  });

  await page.goto('/analisis/', { waitUntil: 'load' });
  const findings = page.locator('#findings');
  await expect(findings).toContainText('fuerza');
  await expect(findings).not.toContainText(/probabilidad/i);
  const doble = findings.locator('li', { hasText: 'Doble suelo' });
  await expect(doble).toBeVisible();
  const canvas = page.locator('#chart canvas').first();
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box && box.width > 20 && box.height > 20).toBe(true);

  await expect(page.locator('#fng')).toHaveText('12');
  await expect(page.locator('#fng-label')).toContainText('Miedo extremo');

  expect(klines).toContain('15m:500');

  const next = page.waitForRequest((req) => {
    if (!req.url().includes('/fapi/v1/klines')) return false;
    const url = new URL(req.url());
    return url.searchParams.get('interval') === '1h' && url.searchParams.get('limit') === '500';
  });
  await page.locator('#timeframe').selectOption('1h');
  await next;

  await doble.click();
  await expect(doble).toHaveClass(/active/);
  await assertClean(page, problems);
});

test('el panel de CVD se pinta bajo el gráfico con velas que traen volumen taker', async ({ page, problems }) => {
  // Ruta registrada después de los mocks genéricos: gana esta.
  await page.route(/https:\/\/fapi\.binance\.com\/fapi\/v1\/klines/, (route) =>
    fulfillJson(route, aggressiveBuyKlines()),
  );

  await page.goto('/analisis/', { waitUntil: 'load' });

  // La leyenda explica qué es el CVD, en una línea y sin jerga.
  await expect(page.locator('#cvd-legend')).toContainText(
    'CVD = compra agresiva acumulada − venta agresiva acumulada (volumen taker)',
  );

  // El panel vive debajo del de velas y pinta las dos series (línea e histograma).
  const price = page.locator('#chart canvas').first();
  const cvd = page.locator('#cvd-pane canvas').first();
  await expect(price).toBeVisible();
  await expect(cvd).toBeVisible();
  const priceBox = await price.boundingBox();
  const cvdBox = await cvd.boundingBox();
  expect(priceBox && cvdBox).toBeTruthy();
  expect(cvdBox!.width).toBeGreaterThan(100);
  expect(cvdBox!.height).toBeGreaterThan(40);
  expect(cvdBox!.y).toBeGreaterThan(priceBox!.y + priceBox!.height - 1);

  // Los puntos pintados salen de las velas mockeadas (71), no de un hueco vacío.
  await expect(page.locator('#cvd-pane')).toHaveAttribute('data-cvd-points', '71');
  await expect(page.locator('#cvd-pane')).toHaveAttribute('data-delta-bars', '71');

  // El choque de compra agresiva llega a la lista de hallazgos (y al gráfico).
  await expect(page.locator('#findings')).toContainText('Compra agresiva');
  await assertClean(page, problems);
});

test('sin volumen taker el panel de CVD lo dice en lugar de inventar flujo', async ({ page }) => {
  // Filas sin índice 9: el campo no existe, no es que valga cero.
  const rows = aggressiveBuyKlines().map((row) => row.slice(0, 9));
  await page.route(/https:\/\/fapi\.binance\.com\/fapi\/v1\/klines/, (route) => fulfillJson(route, rows));
  await page.goto('/analisis/', { waitUntil: 'load' });
  await expect(page.locator('#cvd-legend')).toContainText('no trae volumen taker');
  await expect(page.locator('#cvd-pane')).toHaveAttribute('data-cvd-points', '0');
  await expect(page.locator('#findings')).not.toContainText('Compra agresiva');
});
