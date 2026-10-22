// Mis trades: page and API history, metrics, exports, analysis and AI card.
//
// One side-panel area per file: all network is mocked by helpers/panel.ts.
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import {
  KEY_META,
  MOCK_ANALYSIS_SCRIPT,
  openAnalysis,
  openSidePanel,
  seedSettings,
  toBinanceKlines,
} from './helpers/panel';

test('analysis tab without a key points to Ajustes and has nothing to export', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    await openAnalysis(page);
    await expect(page.getByTestId('history-no-key')).toContainText('Ajustes');
    await expect(page.getByRole('button', { name: /Cargar historial/ })).toHaveCount(0);
    await expect(page.getByTestId('metrics-card')).toContainText('Aún no hay historial');
    await expect(page.getByTestId('metrics-card')).toContainText('no predicen el futuro');
    await expect(page.getByRole('button', { name: 'Exportar CSV' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Exportar JSON' })).toBeDisabled();
    // La IA nunca arranca sola: sin clave ni modelo, los botones están apagados y no hay respuesta.
    await expect(page.getByTestId('ai-position')).toBeDisabled();
    await expect(page.getByTestId('ai-answer')).toHaveCount(0);
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('analysis tab loads a mocked history, shows sin evidencia for n<30 and exports a CSV', async () => {
  const panel = await openSidePanel(undefined, toBinanceKlines(), MOCK_ANALYSIS_SCRIPT);
  try {
    const { page } = panel;
    await seedSettings(page, KEY_META);
    await openAnalysis(page);
    await page.getByRole('button', { name: 'Cargar historial (6 meses)' }).click();

    const card = page.getByTestId('metrics-card');
    await expect(card).toContainText('Operaciones (n)');
    await expect(card.locator('dt', { hasText: 'Operaciones (n)' }).locator('+ dd')).toHaveText('3');
    await expect(page.getByTestId('metrics-grade')).toContainText('sin evidencia');
    await expect(card).toContainText('Ganadoras');
    await expect(card).toContainText('IC 95 %');
    await expect(card).not.toContainText(/probabilidad/i);
    await expect(page.getByTestId('metrics-partial')).toHaveCount(0);
    const paths = await page.evaluate(() => (window as unknown as { __acctGets: string[] }).__acctGets);
    expect(paths).toContain('/fapi/v1/income');
    expect(paths).toContain('/fapi/v1/userTrades');

    const [csv] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Exportar CSV' }).click(),
    ]);
    expect(csv.suggestedFilename()).toMatch(/^swal-historial-\d{4}-\d{2}-\d{2}\.csv$/);
    const path = await csv.path();
    const text = await readFile(path!, 'utf8');
    expect(text.split('\n')[0]).toContain('simbolo,lado,apertura_iso');
    expect(text.trim().split('\n')).toHaveLength(4);

    const [json] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Exportar JSON' }).click(),
    ]);
    expect(json.suggestedFilename()).toMatch(/\.json$/);
    expect(JSON.parse(await readFile((await json.path())!, 'utf8')).n).toBe(3);
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('AI card asks for consent before the first ai:analyze, then answers as plain text', async () => {
  const panel = await openSidePanel(undefined, toBinanceKlines(), MOCK_ANALYSIS_SCRIPT);
  try {
    const { page } = panel;
    await seedSettings(page, {
      ...KEY_META,
      ai: { provider: 'opencode', model: 'qwen-test-free', redaction: 'relative', consentedProviders: [] },
    });
    await openAnalysis(page);
    const aiRequests = () => page.evaluate(() => (window as unknown as { __aiRequests: unknown[] }).__aiRequests.length);

    // Aviso de modelo gratuito antes de enviar nada.
    await expect(page.getByTestId('ai-card').getByTestId('ai-free-warning')).toContainText('pueden usar lo que envías para entrenar');
    const button = page.getByRole('button', { name: 'Analizar mi posición' });
    await expect(button).toBeEnabled();
    await button.click();

    // Sin consentimiento previo: pantalla con el proveedor y los campos, y todavía ninguna petición.
    const consent = page.getByTestId('ai-consent');
    await expect(consent).toBeVisible();
    await expect(consent).toContainText('OpenCode');
    await expect(consent).toContainText('riesgo en % del capital');
    expect(await aiRequests()).toBe(0);

    await page.getByTestId('ai-consent-accept').click();
    const answer = page.getByTestId('ai-answer');
    await expect(answer).toContainText('Tu posición tiene stop');
    await expect(answer).toContainText('Revisar el tamaño');
    await expect(page.getByTestId('ai-disclaimer')).toContainText('No es una recomendación de compra o venta');
    await expect(page.getByTestId('ai-flag')).toHaveCount(0);
    expect(await aiRequests()).toBe(1);

    const stored = await page.evaluate(
      () =>
        new Promise<{ settings?: { ai?: { consentedProviders?: string[] } } }>((resolve) => {
          const api = (window as unknown as {
            chrome: { storage: { local: { get(k: string, cb: (v: unknown) => void): void } } };
          }).chrome;
          api.storage.local.get('settings', (value) => resolve(value as never));
        }),
    );
    expect(stored.settings?.ai?.consentedProviders).toContain('opencode');

    // Con el consentimiento dado, el siguiente clic manda directo; el error se explica en español.
    await page.evaluate(() => ((window as unknown as { __aiMode: string }).__aiMode = 'rate_limit'));
    await button.click();
    await expect(page.getByTestId('ai-consent')).toHaveCount(0);
    await expect(page.getByTestId('ai-error')).toContainText('limitó las peticiones');
    expect(await aiRequests()).toBe(2);

    // La bandera de promesa se muestra y la respuesta nunca se interpreta como HTML.
    await page.evaluate(() => ((window as unknown as { __aiMode: string }).__aiMode = 'flag'));
    await button.click();
    await expect(page.getByTestId('ai-flag')).toContainText('no podemos respaldar');
    expect(await page.locator('[data-testid="ai-answer"] script, [data-testid="ai-answer"] img').count()).toBe(0);
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('"Ver lo que se envía" shows the exact JSON and relative mode carries no USD amounts', async () => {
  const panel = await openSidePanel(undefined, toBinanceKlines(), MOCK_ANALYSIS_SCRIPT);
  try {
    const { page } = panel;
    await seedSettings(page, {
      ...KEY_META,
      ai: { provider: 'opencode', model: 'qwen-test', redaction: 'relative', consentedProviders: [] },
    });
    await openAnalysis(page);
    const details = page.getByTestId('ai-preview');
    await details.locator('summary').click();
    const pre = page.getByTestId('ai-preview-position');
    await expect(pre).toBeVisible();
    const text = (await pre.textContent()) ?? '';
    const payload = JSON.parse(text) as Record<string, unknown>;
    expect(payload.schema).toBe('swal.position.v1');
    expect(payload.redaction).toBe('relative');
    expect(payload.stop).toBe('present');
    // Ni precios, ni capital, ni nocional, ni cantidad.
    expect(text.replace('BTCUSDT', 'SYMBOL')).not.toMatch(/precios|"equity"|notional|usd|"size"|"entry"|"mark"/i);
    for (const value of ['105', '1000', '10.5', '97"', '80']) expect(text).not.toContain(`:${value.replace('"', '')}`);
    // Ver el texto no envía nada.
    const sent = await page.evaluate(() => (window as unknown as { __aiRequests: unknown[] }).__aiRequests.length);
    expect(sent).toBe(0);
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('mis trades: lee la posición de la página y avisa de que no hay evidencia', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    // Lo que el content script dejó en storage.session (sin clave de API).
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
                    symbol: 'BTCUSDC',
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
    await page.getByRole('tab', { name: 'Mis trades' }).click();
    const tab = page.getByTestId('mytrades-tab');
    await expect(tab).toBeVisible();
    const positions = page.getByTestId('mytrades-positions');
    await expect(positions).toBeVisible();
    await expect(positions).toContainText('BTCUSDC');
    await expect(positions).toContainText('largo');
    await expect(positions).toContainText('uPnL +2.1 (+19 %)');
    // Sin historial leído: lo dice y no inventa métricas.
    await expect(page.getByTestId('mytrades-history-hint')).toContainText('Historial de posiciones');
    await expect(page.getByTestId('mytrades-metrics')).toContainText('Todavía no hay operaciones');
    await expect(page.getByTestId('mytrades-no-evidence')).toContainText(/sin evidencia/i);
    await expect(page.getByTestId('mytrades-export')).toBeVisible();
    await expect(page.getByTestId('mytrades-diagnose')).toBeVisible();
    await expect(page.getByTestId('mytrades-clear')).toBeVisible();
    // El botón de IA está, pero apagado: sin proveedor/modelo no se envía nada.
    await expect(page.getByTestId('mytrades-ai')).toBeDisabled();
    // Nada de lenguaje de compra/venta en esta pestaña.
    const text = (await tab.innerText()).toLowerCase();
    expect(text).not.toContain('comprar');
    expect(text).not.toContain('vender');
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('diagnostics are disabled when page reading is off', async () => {
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
    await page.getByRole('tab', { name: 'Mis trades' }).click();
    await expect(page.getByTestId('mytrades-page-panel')).toBeVisible();

    // Intercept sendMessage to return disabled report
    await page.evaluate(() => {
      const api = (window as unknown as { chrome: { runtime: { sendMessage: (...args: unknown[]) => Promise<unknown> } } }).chrome;
      const original = api.runtime.sendMessage.bind(api.runtime);
      api.runtime.sendMessage = async (message: unknown, ...args: unknown[]) => {
        if (message && typeof message === 'object' && (message as { type: string }).type === 'page-account:diagnose') {
          return { type: 'page-account:diagnose:result', outline: '', disabled: true };
        }
        return original(message, ...args);
      };
    });

    const diagnoseBtn = page.getByTestId('mytrades-diagnose');
    await expect(diagnoseBtn).toBeVisible();
    await diagnoseBtn.click();

    await expect(page.getByTestId('mytrades-note')).toContainText('El diagnóstico lee la página: activa «Leer mis posiciones e historial» en Ajustes');
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('history list has working symbol and side filters', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const baseTime = Date.now();
          const p1 = {
            key: 'BTCUSDT|' + (baseTime - 1000) + '|' + baseTime,
            symbol: 'BTCUSDT', side: 'long', closedAtMs: baseTime, openedAtMs: baseTime - 1000,
            realizedPnl: 10, roiPct: 5, leverage: 10, pnlAsset: 'USDT', status: 'closed',
            marginMode: 'cross', durationMs: 1000, closeVolume: 1, closeVolumeAsset: 'BTC', entry: 100, avgClose: 110, maxOpenInterest: null
          };
          const p2 = {
            key: 'ETHUSDT|' + (baseTime - 2000) + '|' + (baseTime - 1000),
            symbol: 'ETHUSDT', side: 'short', closedAtMs: baseTime - 1000, openedAtMs: baseTime - 2000,
            realizedPnl: -5, roiPct: -2, leverage: 5, pnlAsset: 'USDT', status: 'closed',
            marginMode: 'cross', durationMs: 1000, closeVolume: 1, closeVolumeAsset: 'ETH', entry: 100, avgClose: 110, maxOpenInterest: null
          };

          const request = indexedDB.open('swal-page-account', 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('kv')) {
              db.createObjectStore('kv');
            }
          };
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('kv', 'readwrite');
            const store = tx.objectStore('kv');
            store.put(p1, 'pagehist:' + p1.key);
            store.put(p2, 'pagehist:' + p2.key);
            tx.oncomplete = () => {
              const api = (window as unknown as { chrome: { storage: { local: { set(v: unknown, cb: () => void): void } } } }).chrome;
              api.storage.local.set({ settings: { readPageAccount: true } }, resolve);
            };
            tx.onerror = () => reject(tx.error);
          };
          request.onerror = () => reject(request.error);
        }),
    );
    await page.reload();
    await page.getByRole('tab', { name: 'Mis trades' }).click();
    await expect(page.getByTestId('mytrades-page-panel')).toBeVisible();

    const rows = page.getByTestId('mytrades-history-row');
    await expect(rows).toHaveCount(2);

    const filterSymbol = page.getByTestId('mytrades-filter-symbol');
    await filterSymbol.selectOption('BTCUSDT');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('BTCUSDT');

    await filterSymbol.selectOption(''); // Todos
    await expect(rows).toHaveCount(2);

    const filterSide = page.getByTestId('mytrades-filter-side');
    await filterSide.selectOption('short');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('ETHUSDT');

    await filterSide.selectOption('all');
    await expect(rows).toHaveCount(2);
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('clear data button removes the stored positions', async () => {
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
                    symbol: 'BTCUSDC',
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
    await page.getByRole('tab', { name: 'Mis trades' }).click();
    const positions = page.getByTestId('mytrades-positions');
    await expect(positions).toBeVisible();
    await expect(positions).toContainText('BTCUSDC');

    await page.getByTestId('mytrades-clear').click();

    await expect(positions).toContainText('Abre la página de futuros de Binance.');
    await expect(page.getByTestId('mytrades-note')).toContainText('Datos leídos borrados de este navegador.');
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});
