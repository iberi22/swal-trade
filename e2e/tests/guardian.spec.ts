import { fulfillJson } from '../fixtures/browser';
import { createLicense } from '../fixtures/license.mjs';
import { expect, test, assertClean } from './site-test';

async function saveAndWatch(page: import('@playwright/test').Page) {
  await page.getByLabel('API key').fill('e2e-read-only-key');
  await page.getByLabel('API secret').fill('e2e-read-only-secret');
  await page.getByLabel('Límite de pérdida diaria (USD)').fill('50');
  await page.getByLabel('Zona horaria (horas UTC)').fill('0');
  await page.getByRole('button', { name: 'Guardar y empezar' }).click();
  await expect(page.locator('#breach-list')).toContainText('límite diario alcanzado');
  await expect(page.locator('#breach-list')).toContainText('SIN STOP: BTCUSDT');
  await expect(page.locator('#perm-status')).toHaveText('Permisos: solo lectura.');
}

test('free tier shows the daily breach and only the largest position', async ({ page, problems }) => {
  await page.goto('/guardian/', { waitUntil: 'load' });
  await expect(page.locator('#tier-badge')).toHaveText('Gratis (1 posición vigilada)');
  await expect(page.locator('#tg-section')).toBeHidden();
  await expect(page.locator('#tg-locked')).toBeVisible();
  await expect(page.locator('#selfhost-link')).toBeHidden();

  await saveAndWatch(page);
  const rows = page.locator('#pos-body tr');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('BTCUSDT');
  await expect(rows).toContainText('SIN STOP');
  await expect(page.locator('#pos-body')).not.toContainText('ETHUSDT');
  await expect(page.locator('#free-note')).toContainText('Plan gratuito');
  await expect(page.locator('#free-note')).toContainText('1 sin vigilar');
  await assertClean(page, problems);
});

test('a valid Ed25519 license unlocks Pro', async ({ page, problems }) => {
  const license = createLicense();
  await page.addInitScript((token) => {
    localStorage.setItem(
      'swal.license',
      JSON.stringify({
        token,
        plan: 'pro_month',
        account_id: 'acc_e2e',
        expires_at: '2099-01-01T00:00:00.000Z',
        valid_until: '2099-01-01T00:00:00.000Z',
        grace_days: 3,
        stored_at: new Date().toISOString(),
      }),
    );
  }, license.token);

  const pubkeyHit = page.waitForRequest((req) => req.url().startsWith('https://pay.swal.network/v1/pubkey'));
  await page.route(/https:\/\/pay\.swal\.network\/v1\/pubkey/, (route) =>
    fulfillJson(route, {
      algorithm: 'Ed25519',
      spki_base64: license.spkiBase64,
      issuer: 'swal-trade-billing',
    }),
  );

  await page.goto('/guardian/', { waitUntil: 'load' });
  await pubkeyHit;
  await expect(page.locator('#lic-info')).toHaveText('Licencia Pro válida.');
  await expect(page.locator('#tier-badge')).toHaveText('Pro');
  await expect(page.locator('#tg-locked')).toBeHidden();
  await expect(page.locator('#tg-section')).toBeVisible();
  await expect(page.locator('#selfhost-link')).toBeVisible();

  await saveAndWatch(page);
  await expect(page.locator('#pos-body')).toContainText('BTCUSDT');
  await expect(page.locator('#pos-body')).toContainText('ETHUSDT');
  await expect(page.locator('#pos-body')).toContainText('SIN STOP');
  await expect(page.locator('#pos-body')).toContainText('con stop');
  await expect(page.locator('#free-note')).toHaveText('');
  await assertClean(page, problems);
});
