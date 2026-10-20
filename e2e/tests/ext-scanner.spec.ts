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
