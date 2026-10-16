import { expect, test, assertClean } from './site-test';
import { cspParts, expectedCsp, FORBIDDEN, PAGES, textForClaimCheck } from '../fixtures/csp.mjs';

test('each route is HTTP 200 with its Content-Security-Policy', async ({ request }) => {
  for (const path of PAGES) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()['content-type'], path).toMatch(/text\/html/);
    expect(cspParts(response.headers()['content-security-policy']), path).toEqual(cspParts(expectedCsp(path)));
  }
});

for (const path of PAGES) {
  test(`${path} renders without console errors, CSP violations, or profit claims`, async ({ page, problems }) => {
    const response = await page.goto(path, { waitUntil: 'load' });
    expect(response?.status()).toBe(200);
    expect(cspParts(response?.headers()['content-security-policy']), path).toEqual(cspParts(expectedCsp(path)));
    await expect(page.locator('h1')).toBeVisible();

    if (path === '/analisis/') {
      await expect(page.locator('#findings')).toContainText('fuerza');
      await expect(page.locator('#chart canvas').first()).toBeVisible();
    }
    if (path === '/checkout/') {
      await expect(page.getByRole('button', { name: 'Crear cuenta nueva' })).toBeVisible();
    }
    if (path === '/operativa/') {
      await expect(page.locator('#chip-engine-status')).not.toHaveText('—');
    }
    if (path === '/guardian/') {
      await expect(page.locator('#tier-badge')).toHaveText('Gratis');
    }

    const text = textForClaimCheck(path, await page.locator('body').innerText());
    expect(text, path).not.toMatch(FORBIDDEN);
    await assertClean(page, problems);
  });
}

test('nav and footer links open a 200 document', async ({ page, problems }) => {
  const seen = new Set<string>();
  for (const path of PAGES) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    const hrefs = await page.locator('a[href^="/"]').evaluateAll((els) =>
      els.map((el) => el.getAttribute('href')).filter((href): href is string => Boolean(href)),
    );
    for (const href of hrefs) {
      const key = href.split('#')[0];
      if (!key || seen.has(key)) continue;
      seen.add(key);
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      const target = new URL(href, page.url());
      const there = target.href.split('#')[0];
      if (page.url().split('#')[0] === there) {
        await page.goto(there.endsWith('/contact/') ? '/pricing/' : '/contact/');
        await page.goto(path, { waitUntil: 'domcontentloaded' });
      }
      // Guardian duplica Self-host: el primero está en #selfhost-link (oculto en el plan gratis).
      const fresh = page.locator(`a[href="${href}"]:visible`).first();
      const [response] = await Promise.all([
        page.waitForResponse(
          (res) => res.request().resourceType() === 'document' && res.url().split('#')[0] === there,
        ),
        fresh.click(),
      ]);
      expect(response.status(), `${path} -> ${href}`).toBe(200);
      await expect(page).toHaveURL(there);
    }
  }
  expect(seen.has('/pricing/')).toBe(true);
  expect(seen.has('/guardian/')).toBe(true);
  expect(seen.has('/risk/')).toBe(true);
  await assertClean(page, problems);
});

test('screenshots of /apoyar/ and /extension/ at 390 and 1280 px in /tmp/swt-support/', async ({ page, problems }) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const outDir = '/tmp/swt-support';
  fs.mkdirSync(outDir, { recursive: true });

  const routes = ['/apoyar/', '/extension/'];
  const viewports = [
    { width: 390, height: 844, suffix: '390' },
    { width: 1280, height: 800, suffix: '1280' },
  ];

  for (const route of routes) {
    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const response = await page.goto(route, { waitUntil: 'load' });
      expect(response?.status()).toBe(200);

      const name = `${route.replace(/\//g, '')}-${vp.suffix}.png`;
      await page.screenshot({ path: path.join(outDir, name), fullPage: true });

      const filteredErrors = problems.consoleErrors.filter(
        (err) => !err.includes('static.cloudflareinsights.com'),
      );
      expect(filteredErrors, `Console errors on ${route} at ${vp.suffix}px`).toEqual([]);
      expect(problems.pageErrors).toEqual([]);
    }
  }
});
