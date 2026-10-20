// Sizing: sizer, scale-in, trade cards, position card and page balance.
//
// One side-panel area per file: all network is mocked by helpers/panel.ts.
import { expect, test } from '@playwright/test';
import { openSidePanel, toBinanceKlines } from './helpers/panel';

/** Answers `acct:snapshot` from the panel itself, as if the background had a read key. */
const MOCK_ACCOUNT_SCRIPT = `
(() => {
  const runtime = window.chrome && window.chrome.runtime;
  if (!runtime) return;
  const original = runtime.sendMessage.bind(runtime);
  window.__acctRequests = [];
  runtime.sendMessage = (message, ...rest) => {
    if (message && message.type === 'acct:snapshot') {
      window.__acctRequests.push(message.symbol);
      const now = Date.now();
      const positions = message.symbol === 'BTCUSDT' ? [{
        symbol: 'BTCUSDT', side: 'long', size: 0.1, entry: 100, mark: 105, liq: 80,
        leverage: 5, marginType: 'cross', uPnl: 0.5, breakEven: null, notional: 10.5,
        stop: null, firstFillMs: null,
      }] : [];
      return Promise.resolve({
        snapshot: { fetchedAt: now, equity: 1000, dailyPnl: null, positions, fundingRate: null, nextFundingMs: null },
        source: 'api',
        fetchedAt: now,
      });
    }
    return original(message, ...rest);
  };
})();
`;

test('with an open position the sizing form is gone and the position card shows', async () => {
  const panel = await openSidePanel(undefined, toBinanceKlines(), MOCK_ACCOUNT_SCRIPT);
  try {
    const { page } = panel;
    // Una clave de lectura configurada: el panel empieza a preguntar por la cuenta.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const api = (window as unknown as {
            chrome: { storage: { local: { set(v: unknown, cb: () => void): void } } };
          }).chrome;
          api.storage.local.set(
            { settings: { acctMeta: { configured: true, kind: 'ed25519', last4: 'abcd' } } },
            resolve,
          );
        }),
    );
    await page.reload();

    const card = page.getByTestId('position-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('LARGO · 0.1 BTCUSDT · 5x · cruzado');
    await expect(card).toContainText('SIN STOP');
    // Reglas: sin stop es crítica y va primero, con prefijo y sin depender del color.
    await expect(page.getByTestId('rules-list')).toContainText('!! Sin stop');
    await expect(card).toContainText('Liquidación a 23.8 %');
    await expect(page.getByTestId('sizing-card')).toHaveCount(0);
    await expect(page.getByTestId('mode-notice')).toHaveCount(0);
    const requests = await page.evaluate(() => (window as unknown as { __acctRequests: string[] }).__acctRequests);
    expect(requests[0]).toBe('BTCUSDT');
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('manual position works without credentials, runs the rules and can be removed', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    await expect(page.getByTestId('sizing-card')).toHaveCount(1);
    await expect(page.getByTestId('position-card')).toHaveCount(0);

    await page.getByTestId('manual-open').click();
    await expect(page.getByTestId('manual-form')).toBeVisible();
    // Dato malo: se queda en el formulario con una frase corta.
    await page.getByTestId('manual-save').click();
    await expect(page.getByTestId('manual-error')).toBeVisible();

    await page.locator('input[name=entry]').fill('100');
    await page.locator('input[name=size]').fill('0.5');
    await page.locator('input[name=leverage]').fill('5');
    await page.getByTestId('manual-save').click();

    const card = page.getByTestId('position-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('LARGO · 0.5 BTCUSDT · 5x');
    await expect(card).toContainText('MANUAL');
    await expect(card).toContainText('SIN STOP');
    await expect(page.getByTestId('rules-list')).toContainText('!! Sin stop');
    await expect(page.getByTestId('sizing-card')).toHaveCount(0);

    // Sobrevive a una recarga (storage.session) y se puede quitar.
    await page.reload();
    await expect(page.getByTestId('position-card')).toContainText('MANUAL');
    await page.getByTestId('manual-remove').click();
    await expect(page.getByTestId('position-card')).toHaveCount(0);
    await expect(page.getByTestId('sizing-card')).toHaveCount(1);
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('sizing: escalonar en 3 tramos shows the tranches and the honest note, never a probability', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    const card = page.getByTestId('sizing-card');
    await expect(card).toHaveCount(1);
    await card.getByLabel('Capital de la cuenta', { exact: true }).fill('1000');
    await card.getByLabel('Riesgo por operación', { exact: true }).fill('1');
    await card.getByLabel('Precio de entrada', { exact: true }).fill('100');
    await card.getByLabel('Stop loss', { exact: true }).fill('90');

    const fold = page.getByTestId('scale-in');
    await expect(fold.locator('summary')).toHaveText('Escalonar en 3 tramos');
    await expect(fold).not.toHaveAttribute('open', '');
    await fold.locator('summary').click();

    // Entradas por defecto: 40 % y 80 % de la distancia (96 y 92).
    await expect(page.getByLabel('Entrada del tramo 2')).toHaveValue('96');
    await expect(page.getByLabel('Entrada del tramo 3')).toHaveValue('92');
    const lines = page.getByTestId('scale-in-tranches').locator('li');
    await expect(lines).toHaveCount(3);
    await expect(lines.nth(0)).toContainText('Tramo 1 (25 %): 100');
    await expect(lines.nth(1)).toContainText('Tramo 2 (35 %): 96');
    await expect(lines.nth(2)).toContainText('Tramo 3 (40 %): 92');
    await expect(page.getByTestId('scale-in-loss-all')).toContainText('USD');
    await expect(page.getByTestId('scale-in-loss-first')).toContainText('Si solo se llena el primero');
    await expect(page.getByTestId('scale-in-honest')).toContainText('no mejora la esperanza');
    await expect(page.getByTestId('scale-in-honest')).toContainText('pierdes el riesgo máximo');

    const text = await fold.innerText();
    expect(text).not.toMatch(/\d\s?%\s+de\s+(probabilidad|acierto)/i);
    expect(text).not.toMatch(/tasa de acierto|winrate/i);
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('tarjetas de operación: ticket con stop, línea honesta y sin lenguaje de compra o venta', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    await expect(page.getByTestId('trade-cards')).toBeVisible();
    await expect(page.getByTestId('trade-card').first()).toBeVisible();
    await page.getByTestId('trade-card').first().click();
    const ticket = page.getByTestId('trade-ticket');
    await expect(ticket).toBeVisible();
    await expect(ticket).toContainText('Stop');
    await expect(ticket).toContainText('R:R no es probabilidad');
    await expect(page.getByTestId('trade-copy')).toBeVisible();
    await expect(page.getByTestId('trade-load')).toBeVisible();
    const text = (await page.locator('body').innerText()).toLowerCase();
    expect(text).not.toContain('comprar');
    expect(text).not.toContain('vender');
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('operación: sin clave usa la posición leída de la página y la marca como tal', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const api = (window as unknown as {
            chrome: {
              storage: {
                session: { set(v: unknown, cb: () => void): void };
                local: { set(v: unknown, cb: () => void): void };
              };
            };
          }).chrome;
          api.storage.session.set(
            {
              'pageAccount.positions': {
                positions: [
                  {
                    symbol: 'BTCUSDT',
                    contract: 'perp',
                    leverage: 30,
                    marginMode: 'cross',
                    side: 'long',
                    sizeQuote: null,
                    sizeBase: 0.004,
                    uPnl: 2.1,
                    roiPct: 19,
                    entry: 82644.1,
                    breakEven: 82300,
                    mark: 82500,
                    liq: 70000,
                  },
                ],
                capturedAt: Date.now(),
                tzOffsetMinutes: -300,
              },
            },
            () => api.storage.local.set({ settings: { readPageAccount: true } }, resolve),
          );
        }),
    );
    await page.reload();

    // Sin clave de API, el modo deja de ser «no sé»: la página dice que hay posición.
    const card = page.getByTestId('position-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('LARGO · 0.004 BTCUSDT · 30x · cruzado');
    await expect(card).toContainText('página de Binance');
    await expect(page.getByTestId('sizing-card')).toHaveCount(0);
    await expect(page.getByTestId('mode-notice')).toHaveCount(0);
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('operación: el saldo de la página en USDC se usa como capital con un par USDC', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    // Lo que el content script deja tras leer la caja de cuenta: 71,9636 USDC.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const api = (window as unknown as {
            chrome: {
              storage: {
                session: { set(v: unknown, cb: () => void): void };
                local: { set(v: unknown, cb: () => void): void };
              };
            };
          }).chrome;
          api.storage.session.set(
            {
              'pageAccount.positions': {
                balance: {
                  asset: 'USDC',
                  marginBalance: 71.9636,
                  walletBalance: 72.4075,
                  available: 70.83,
                  unrealizedPnl: -0.4439,
                  maintenanceMargin: 0.9782,
                  marginMode: 'cross',
                },
                positions: [],
                capturedAt: Date.now(),
                tzOffsetMinutes: -300,
              },
            },
            () => api.storage.local.set({ settings: { readPageAccount: true } }, resolve),
          );
        }),
    );
    await page.reload();

    // Un par que cotiza en USDC: el saldo de la página es del mismo activo.
    const symbolInput = page.getByRole('textbox', { name: 'Símbolo', exact: true });
    await symbolInput.fill('BTCUSDC');
    await symbolInput.press('Enter');
    await expect(page.getByTestId('sizing-card')).toBeVisible();

    const pageButton = page.getByTestId('capital-source-page');
    await expect(pageButton).toBeVisible();
    await pageButton.click();
    await expect(pageButton).toHaveAttribute('aria-pressed', 'true');

    const line = page.getByTestId('capital-page-line');
    await expect(line).toContainText('saldo de la página: 71,96 USDC');
    await expect(line).toContainText('capital 71,96 USDC');
    // Nada de respaldo manual: hay dato de la página que sirve.
    await expect(page.getByTestId('capital-fallback-note')).toHaveCount(0);
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('operación: un saldo en otra moneda no se ofrece como capital', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    // La página dice USDT; el par cotiza en USDC: no puede usarse ese saldo.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const api = (window as unknown as {
            chrome: {
              storage: {
                session: { set(v: unknown, cb: () => void): void };
                local: { set(v: unknown, cb: () => void): void };
              };
            };
          }).chrome;
          api.storage.session.set(
            {
              'pageAccount.positions': {
                balance: { asset: 'USDT', marginBalance: 71.9636, walletBalance: 72.4075 },
                positions: [],
                capturedAt: Date.now(),
                tzOffsetMinutes: -300,
              },
            },
            () => api.storage.local.set({ settings: { readPageAccount: true } }, resolve),
          );
        }),
    );
    await page.reload();

    const symbolInput = page.getByRole('textbox', { name: 'Símbolo', exact: true });
    await symbolInput.fill('BTCUSDC');
    await symbolInput.press('Enter');
    await expect(page.getByTestId('sizing-card')).toBeVisible();
    await expect(page.getByTestId('capital-source-page')).toHaveCount(0);
    await expect(page.getByTestId('capital-source-manual')).toHaveAttribute('aria-pressed', 'true');
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('sizing: fee-inclusive loss never above the budget and quantities truncated', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;

    const sizingCard = page.getByTestId('sizing-card');
    await expect(sizingCard).toBeVisible();
    await sizingCard.getByLabel('Capital de la cuenta', { exact: true }).fill('1100');

    await expect(page.getByTestId('trade-cards')).toBeVisible();
    await page.getByTestId('trade-card').first().click();

    const ticket = page.getByTestId('trade-ticket');
    await expect(ticket).toBeVisible();

    const lossText = await ticket.locator('dt:has-text("Pérdida en stop") + dd').innerText();
    const lossMatch = lossText.match(/([\d,]+)\s+USD/);
    expect(lossMatch).toBeTruthy();
    const lossVal = parseFloat((lossMatch?.[1] ?? '0').replace(',', '.'));
    expect(lossVal).toBeLessThanOrEqual(11);

    const entryText = await ticket.locator('dt:has-text("Entrada") + dd').first().innerText();
    const qtyMatch = entryText.match(/cant\.\s+([0-9.]+)/);
    expect(qtyMatch).toBeTruthy();

    const qtyVal = qtyMatch?.[1] ?? '0';
    expect(qtyVal).toBe('5.555');

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('sizing: wrong-side stop never pre-filled', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    const card = page.getByTestId('sizing-card');

    await expect(card.getByText('invalida hallazgo')).toBeVisible();
    await expect(card.getByLabel('Stop loss', { exact: true })).not.toHaveValue('');

    await card.getByLabel('Stop loss', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Corto' }).click();

    await expect(card.getByLabel('Stop loss', { exact: true })).toHaveValue('');

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('sizing: margin cards keep their exact quantity when loaded', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;

    const cardFold = page.getByTestId('trade-card').first();
    await cardFold.click();
    const loadBtn = page.getByTestId('trade-load');
    await expect(loadBtn).toBeVisible();

    const ticketStr = await page.getByTestId('trade-ticket').innerText();
    const match = ticketStr.match(/cant\.\s+([0-9,.]+)/);
    const qtyStrRaw = match ? match[1] : '';
    expect(qtyStrRaw).toBeTruthy();
    const qtyStr = qtyStrRaw.replace('.', ',');

    await loadBtn.click();

    const sizingResults = page.getByTestId('sizing-results');
    await expect(sizingResults).toContainText(qtyStr);
    await expect(page.getByTestId('sizing-from-card')).toBeVisible();

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('operación: el saldo de la página muestra cuando es un dato viejo (más de 60 s)', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const api = (window as unknown as {
            chrome: {
              storage: {
                session: { set(v: unknown, cb: () => void): void };
                local: { set(v: unknown, cb: () => void): void };
              };
            };
          }).chrome;
          api.storage.session.set(
            {
              'pageAccount.positions': {
                balance: { asset: 'USDC', marginBalance: 71.9636, walletBalance: 72.4075 },
                positions: [],
                capturedAt: Date.now() - 65000,
                tzOffsetMinutes: -300,
              },
            },
            () => api.storage.local.set({ settings: { readPageAccount: true } }, resolve),
          );
        }),
    );
    await page.reload();

    const symbolInput = page.getByRole('textbox', { name: 'Símbolo', exact: true });
    await symbolInput.fill('BTCUSDC');
    await symbolInput.press('Enter');

    const pageButton = page.getByTestId('capital-source-page');
    await pageButton.click();

    const line = page.getByTestId('capital-page-line');
    await expect(line).toContainText('dato viejo');
    await expect(line).toHaveClass(/stale/);

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});
