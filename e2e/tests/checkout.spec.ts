import { installCheckoutMock } from '../fixtures/browser';
import { expect, test, assertClean } from './site-test';

test('secret once, exact amount, QR, poll until paid, license stored', async ({ page, problems }) => {
  await page.clock.install();
  const pay = await installCheckoutMock(page);

  await page.goto('/checkout/', { waitUntil: 'load' });
  await page.getByRole('button', { name: 'Crear cuenta nueva' }).click();

  const secret = page.getByLabel('Secreto de cuenta', { exact: true });
  await expect(secret).toHaveText(pay.secret);
  await expect(page.getByText('Se muestra una sola vez')).toBeVisible();
  const continueBtn = page.getByRole('button', { name: 'Continuar' });
  await expect(continueBtn).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Lo guardé' }).check();
  await expect(continueBtn).toBeEnabled();
  await continueBtn.click();

  await expect(page.locator('#secret-box')).toBeHidden();
  await expect(page.locator('#secret-value')).toHaveText('');
  await expect(page.locator('body')).not.toContainText(pay.secret);
  await expect(page.getByText('Cuenta lista en este navegador.')).toBeVisible();

  await page.reload({ waitUntil: 'load' });
  await expect(page.locator('#secret-box')).toBeHidden();
  await expect(page.locator('#secret-value')).toHaveText('');
  await expect(page.getByText('Cuenta lista en este navegador.')).toBeVisible();

  await page.getByRole('button', { name: 'USDT en BNB Smart Chain (BEP-20)' }).click();
  await expect(page.locator('#amount')).toContainText('10.00');
  await expect(page.locator('#amount .tag')).toHaveText('37');
  await expect(page.locator('#amount-tag')).toHaveText('37');
  await expect(page.locator('#pay-address')).toHaveText('0x1111111111111111111111111111111111111111');
  const qr = page.locator('#qr svg');
  await expect(qr).toBeVisible();
  await expect(qr).toHaveAttribute('role', 'img');
  await expect(qr.locator('path')).toHaveAttribute('d', /.+/);
  await expect(page.locator('#status')).toHaveText('Esperando tu pago…');

  await page.clock.fastForward(15_000);
  await expect.poll(() => pay.invoiceGets()).toBe(1);
  await expect(page.locator('#status')).toHaveText('Esperando tu pago…');

  await page.clock.fastForward(15_000);
  await expect.poll(() => pay.invoiceGets()).toBe(2);
  await expect(page.getByRole('heading', { name: 'Listo, eres socio Pro' })).toBeVisible();

  const stored = await page.evaluate(() => localStorage.getItem('swal.license'));
  expect(stored).toBeTruthy();
  const license = JSON.parse(stored ?? '{}') as { token?: string; plan?: string; account_id?: string };
  expect(license.token).toBe('e2e-header.e2e-sig');
  expect(license.plan).toBe('pro_month');
  expect(license.account_id).toBe('acc_e2e');
  await assertClean(page, problems);
});
