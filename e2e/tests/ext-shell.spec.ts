// Shell: panel tabs, keyboard navigation and collapsed sections.
//
// One side-panel area per file: all network is mocked by helpers/panel.ts.
import { expect, test } from '@playwright/test';
import { openSidePanel } from './helpers/panel';

test('panel tabs exist, keyboard navigation and sections collapsed by default', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    const tablist = page.getByRole('tablist');
    // Por nombre, no por número: otras pestañas pueden añadirse. «Análisis» ya
    // no es una pestaña: su contenido vive dentro de «Mis trades».
    for (const name of ['Operación', 'Aprender', 'Ajustes', 'Escáner', 'Mis trades']) {
      await expect(tablist.getByRole('tab', { name })).toHaveCount(1);
    }
    await expect(tablist.getByRole('tab', { name: 'Análisis' })).toHaveCount(0);
    const tabs = tablist.getByRole('tab');
    const tabCount = await tabs.count();
    expect(tabCount).toBeGreaterThanOrEqual(5);
    await expect(page.getByRole('tab', { name: 'Operación' })).toHaveAttribute('aria-selected', 'true');

    // Sin posición conocida y sin clave: modo unknown, con el aviso y el dimensionador.
    await expect(page.getByTestId('mode-notice')).toHaveText(
      'No sé si tienes posición. Conecta una clave de solo lectura (Ajustes).',
    );
    await expect(page.getByTestId('sizing-card')).toHaveCount(1);

    // Pulso, titulares, CVD y hallazgos extra: plegados y con resumen corto.
    await expect(page.getByRole('region', { name: 'Hallazgos' })).toBeVisible();
    // Solo la banda de contexto va abierta de serie.
    await expect(page.locator('details[open]')).toHaveCount(1);
    await expect(page.getByTestId('context-band').locator('details')).toHaveAttribute('open', '');
    const summaries = await page.locator('details.fold > summary, details.finding > summary').allTextContents();
    expect(summaries.length).toBeGreaterThan(3);
    for (const text of summaries) expect(text.length).toBeLessThanOrEqual(70);
    await expect(page.getByRole('region', { name: 'Pulso de mercado' }).locator('summary')).toHaveText(/^Pulso · /);

    // Teclado: flechas cambian de pestaña y la elegida sobrevive a una recarga.
    await page.getByRole('tab', { name: 'Operación' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Aprender' })).toHaveAttribute('aria-selected', 'true');
    // «Mis trades» arranca en la página de Binance y ofrece el historial de la
    // clave al cambiar de origen.
    await page.getByRole('tab', { name: 'Mis trades' }).click();
    await expect(page.getByTestId('mytrades-page-panel')).toBeVisible();
    await page.getByTestId('mytrades-source').selectOption('api');
    await expect(page.getByTestId('history-card')).toBeVisible();
    await page.getByTestId('mytrades-source').selectOption('page');
    await expect(page.getByTestId('mytrades-page-panel')).toBeVisible();
    // Inicio y Fin van a la primera y a la última pestaña, sean cuantas sean.
    await page.keyboard.press('End');
    await expect(tabs.nth(tabCount - 1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    await expect(tabs.nth(tabCount - 2)).toHaveAttribute('aria-selected', 'true');
    await page.reload();
    await expect(tabs.nth(tabCount - 2)).toHaveAttribute('aria-selected', 'true');
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});
