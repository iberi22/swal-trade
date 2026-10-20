// Drawing: the «Tu dibujo» card and its hotkey.
//
// One side-panel area per file: all network is mocked by helpers/panel.ts.
import { expect, test } from '@playwright/test';
import { FUTURES_TAB_FAKE, openSidePanel, openTab } from './helpers/panel';

test('hotkey «Tu dibujo» from Ajustes selects Operación and focuses the drawing card', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    await openTab(page, 'Ajustes');
    await expect(page.getByTestId('drawing-card')).toBeHidden();

    // Alt+Shift+D es el atajo por defecto de «Tu dibujo». Antes de este
    // arreglo el panel cambiaba su pestaña activa pero la barra seguía
    // mostrando Ajustes, así que la tarjeta nunca se veía.
    await page.keyboard.press('Alt+Shift+D');

    await expect(page.getByRole('tab', { name: 'Operación' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Ajustes' })).toHaveAttribute('aria-selected', 'false');
    const card = page.getByTestId('drawing-card');
    await expect(card).toBeVisible();
    await expect(card).toBeFocused();
    // La pestaña elegida por el atajo también se guarda.
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Operación' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('drawing-card')).toBeVisible();
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('tu dibujo: lee la posición dibujada en Trading View y la cuenta en largo/corto', async () => {
  const panel = await openSidePanel(undefined, undefined, FUTURES_TAB_FAKE);
  try {
    const { page } = panel;
    const card = page.getByTestId('drawing-card');
    await expect(card).toBeVisible();
    // Arranca apagado: una línea y el botón de activar.
    await expect(page.getByTestId('drawing-summary')).toHaveCount(0);
    await expect(page.getByTestId('drawing-enable')).toBeVisible();

    // Lo que el puente MAIN-world deja en storage.session: el dibujo del usuario
    // (entrada 100, 1000 ticks de stop = 10 y 2000 ticks de objetivo = 20).
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const api = (window as unknown as {
            chrome: { storage: { session: { set(v: unknown, cb: () => void): void } } };
          }).chrome;
          api.storage.session.set(
            {
              positionTools: {
                '7:BTCUSDT': {
                  type: 'swal:position-tools',
                  version: 2,
                  symbol: 'BTCUSDT',
                  minmov: 1,
                  pricescale: 100,
                  tools: [
                    {
                      id: 'tv-e2e-1',
                      name: 'LineToolRiskRewardLong',
                      entry: 100,
                      stopLevel: 1000,
                      profitLevel: 2000,
                    },
                  ],
                },
              },
            },
            resolve,
          );
        }),
    );

    await page.getByTestId('drawing-enable').click();

    const summary = page.getByTestId('drawing-summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('R:R');
    await expect(page.getByTestId('drawing-honest')).toContainText('no una predicción');
    await expect(page.getByTestId('drawing-copy')).toBeVisible();
    await expect(page.getByTestId('drawing-load')).toBeVisible();
    await expect(page.getByTestId('drawing-ai')).toBeVisible();
    await expect(card).toContainText('Stop');
    await expect(card).toContainText('Objetivo');

    const text = (await card.innerText()).toLowerCase();
    expect(text).not.toContain('comprar');
    expect(text).not.toContain('vender');
    expect(text).not.toMatch(/tasa de acierto|probabilidad/);
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});
