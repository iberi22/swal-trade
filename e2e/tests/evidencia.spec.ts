import { expect, test, assertClean } from './site-test';
import { fulfillJson } from '../fixtures/browser';

test('page loads with expected CSP, shows h1 Evidencia and 0 de 92', async ({ page, problems }) => {
  await page.route('**/api/hit-rates', (route) => fulfillJson(route, { cells: [] }));
  const response = await page.goto('/evidencia/', { waitUntil: 'load' });
  expect(response?.status()).toBe(200);

  const h1 = page.locator('h1');
  await expect(h1).toHaveText(/Evidencia/i);

  await expect(page.locator('body')).toContainText('0 de 92');

  await assertClean(page, problems);
});

test('shows Aún no hay datos publicados when /api/hit-rates returns empty', async ({ page }) => {
  await page.route('**/api/hit-rates', (route) => fulfillJson(route, { cells: [] }));
  await page.goto('/evidencia/', { waitUntil: 'load' });

  await expect(page.locator('body')).toContainText('Aún no hay datos publicados.');
});

test('renders two table rows and the n=12 row contains "sin evidencia"', async ({ page }) => {
  await page.route('**/api/hit-rates', (route) => fulfillJson(route, {
    cells: [
      { id: '1', n: 12, market: 'BTCUSDT', period: '1h', text: 'algo' },
      { id: '2', n: 35, market: 'ETHUSDT', period: '1h', text: 'algo' }
    ]
  }));
  await page.goto('/evidencia/', { waitUntil: 'load' });

  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(2);

  const row12 = rows.filter({ hasText: '12' });
  await expect(row12).toContainText('sin evidencia');
});

test('no request leaves the origin except allowed ones', async ({ page }) => {
  const externalRequests: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      externalRequests.push(req.url());
    }
  });

  await page.route('**/api/hit-rates', (route) => fulfillJson(route, { cells: [] }));
  await page.goto('/evidencia/', { waitUntil: 'load' });

  expect(externalRequests).toEqual([]);
});
