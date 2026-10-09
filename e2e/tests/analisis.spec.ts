import { expect, test, assertClean } from './site-test';

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
