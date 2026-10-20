// Scanner: public mover scan with mocked Binance candles.
//
// One side-panel area per file: all network is mocked by helpers/panel.ts.
import { expect, test } from '@playwright/test';
import { SC_BAR, fulfillJson, openSidePanel, openTab, scannerKlines } from './helpers/panel';

test('scanner tab lists a 6 % drop with no evidence, no levels and no probability wording', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    // Hora del servidor: 100 s dentro de una vela de 5 m, asi la ultima cerrada es la vela del disparo.
    const serverNow = Math.floor(Date.now() / SC_BAR) * SC_BAR + 100_000;
    const lastOpen = Math.floor((serverNow - 1000 - SC_BAR) / SC_BAR) * SC_BAR;
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT'];
    await page.route(/fapi\.binance\.com\/fapi\/v1\/time/, (route) => fulfillJson(route, { serverTime: serverNow }));
    await page.route(/fapi\.binance\.com\/fapi\/v1\/exchangeInfo/, (route) =>
      fulfillJson(route, {
        symbols: symbols.map((symbol) => ({
          symbol, status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', underlyingType: 'COIN',
        })),
      }),
    );
    await page.route(/fapi\.binance\.com\/fapi\/v1\/ticker\/24hr/, (route) =>
      fulfillJson(route, symbols.map((symbol, i) => ({ symbol, quoteVolume: String(symbol === 'SOLUSDT' ? 412e6 : (5 - i) * 3e8) }))),
    );
    await page.route(/trade\.swal\.network\/api\/movers-stats/, (route) =>
      fulfillJson(route, { schema: 'swal.movers-stats.v1', method: 'study', cells: [], note: 'Aun no hay datos publicados.' }),
    );
    await page.route(/fapi\.binance\.com\/fapi\/v1\/klines/, (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('interval') !== '5m') return route.fallback();
      const drop = url.searchParams.get('symbol') === 'SOLUSDT';
      return fulfillJson(route, scannerKlines(lastOpen, drop ? 93.8 : 100));
    });

    await openTab(page, 'Escáner');
    await expect(page.getByTestId('scanner-off')).toContainText('datos públicos de Binance');
    await page.getByTestId('scanner-switch').check();

    const scanner = page.getByRole('region', { name: 'Escáner' });
    const rows = scanner.getByTestId('scanner-row');
    await expect(rows.first()).toContainText('SOLUSDT');
    await expect(rows.first()).toContainText('baja 6,2 %');
    await expect(rows.first()).toContainText('Sin evidencia');
    await expect(rows.filter({ hasText: 'BTCUSDT' })).toHaveCount(0);

    await rows.first().getByRole('button').first().click();
    const detail = rows.first().getByTestId('scanner-detail');
    const table = detail.getByTestId('scanner-plans');
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(2);
    await expect(table).toContainText('FOLLOW');
    await expect(table).toContainText('FADE');
    await expect(detail.getByTestId('scanner-levels')).toHaveCount(0);
    await expect(detail.getByTestId('scanner-geometry')).toContainText('Geometría de medición (no es una señal)');
    await expect(detail.getByTestId('scanner-open-pair')).toHaveText('Abrir en Binance');
    await expect(detail.getByTestId('scanner-analysis')).toContainText('no superaron al azar');

    const text = await scanner.innerText();
    expect(text).not.toMatch(/probabilidad/i);
    expect(text).not.toMatch(/tasa de acierto/i);
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('scanner tab: universe selector persists across a panel reload', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    await openTab(page, 'Escáner');
    await page.getByTestId('scanner-settings').locator('summary').click();
    await page.getByTestId('scanner-universe').selectOption('USDC');

    // Reload the panel to test persistence
    await page.reload();
    await openTab(page, 'Escáner');
    await page.getByTestId('scanner-settings').locator('summary').click();

    await expect(page.getByTestId('scanner-universe')).toHaveValue('USDC');
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('scanner tab: mocked mover with plans still displays "Sin evidencia" and no probability wording', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    const serverNow = Math.floor(Date.now() / SC_BAR) * SC_BAR + 100_000;
    const lastOpen = Math.floor((serverNow - 1000 - SC_BAR) / SC_BAR) * SC_BAR;
    const symbols = ['BTCUSDT'];
    await page.route(/fapi\.binance\.com\/fapi\/v1\/time/, (route) => fulfillJson(route, { serverTime: serverNow }));
    await page.route(/fapi\.binance\.com\/fapi\/v1\/exchangeInfo/, (route) =>
      fulfillJson(route, {
        symbols: symbols.map((symbol) => ({
          symbol, status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', underlyingType: 'COIN',
        })),
      }),
    );
    await page.route(/fapi\.binance\.com\/fapi\/v1\/ticker\/24hr/, (route) =>
      fulfillJson(route, symbols.map((symbol) => ({ symbol, quoteVolume: String(3e8) }))),
    );

    // Provide a mocked study with plans but with "no_evidence" grade
    await page.route(/trade\.swal\.network\/api\/movers-stats/, (route) =>
      fulfillJson(route, {
        schema: 'swal.movers-stats.v1',
        method: 'study',
        cells: [
          {
            symbol: 'BTCUSDT',
            direction: 'up',
            mode: 'follow',
            grade: 'no_evidence',
            n: 15,
            win_rate: 0.55,
            ci_low: 0.3,
            ci_high: 0.8,
            breakeven: 0.45,
            mean_net_r: 1.2,
            net_r_ci_low: 0.5,
            net_r_ci_high: 2.0
          }
        ],
        note: 'Mocked plans'
      }),
    );

    await page.route(/fapi\.binance\.com\/fapi\/v1\/klines/, (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('interval') !== '5m') return route.fallback();
      // Make BTCUSDT drop 6%
      return fulfillJson(route, scannerKlines(lastOpen, 93.8));
    });

    await openTab(page, 'Escáner');
    await page.getByTestId('scanner-switch').check();

    const scanner = page.getByRole('region', { name: 'Escáner' });
    const rows = scanner.getByTestId('scanner-row');

    // BTCUSDT row should be visible with "Sin evidencia"
    await expect(rows.first()).toContainText('BTCUSDT');
    await expect(rows.first()).toContainText('Sin evidencia');

    await rows.first().getByRole('button').first().click();
    const detail = rows.first().getByTestId('scanner-detail');
    const table = detail.getByTestId('scanner-plans');
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(2);

    // It should have text but NO probability/hit rate wording that asserts predictive power
    const text = await scanner.innerText();
    expect(text).not.toMatch(/probabilidad/i);
    expect(text).not.toMatch(/tasa de acierto/i);
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('scanner tab: background-watch toggle displays health notes when enabled', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    await openTab(page, 'Escáner');
    await page.getByTestId('scanner-settings').locator('summary').click();

    const backgroundCheckbox = page.getByTestId('scanner-background');
    await backgroundCheckbox.check();

    await expect(page.getByTestId('scanner-background-note')).toBeVisible();

    // Unchecking hides the note
    await backgroundCheckbox.uncheck();
    await expect(page.getByTestId('scanner-background-note')).not.toBeVisible();

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});
