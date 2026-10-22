// Operación: context band, levels, findings, chart/CVD, paint and news.
//
// One side-panel area per file: all network is mocked by helpers/panel.ts.
import { expect, test } from '@playwright/test';
import { aggressiveBuyKlines, fulfillJson, openSidePanel, openTab, scannerKlines } from './helpers/panel';

/** Five headlines with distinct tones: positive, negative and neutral. */
function newsItemsFixture() {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  return {
    symbol: 'BTC',
    asOf: new Date().toISOString(),
    items: [
      {
        id: '1'.repeat(64),
        title: 'Bitcoin rompe maximos anuales con rally institucional',
        url: 'https://ejemplo.test/btc-rally',
        source: 'Ejemplo Crypto',
        publishedAt: minutesAgo(4),
        snippet: 'Las entradas de fondos marcan un record.',
        provider: 'brave',
        symbols: ['BTC'],
        sentiment: { score: 0.8, label: 'positivo' },
      },
      {
        id: '2'.repeat(64),
        title: 'Un exchange sufre un hack y el mercado se desploma',
        url: 'https://ejemplo.test/hack',
        source: 'Ejemplo News',
        publishedAt: minutesAgo(95),
        snippet: 'Retiros suspendidos por precaucion.',
        provider: 'tavily',
        symbols: ['BTC'],
        sentiment: { score: -0.7, label: 'negativo' },
      },
      {
        id: '3'.repeat(64),
        title: 'La SEC retrasa la decision sobre el ETF',
        url: 'https://ejemplo.test/sec',
        source: 'Ejemplo Wire',
        publishedAt: minutesAgo(60 * 26),
        snippet: 'Sin fecha nueva por ahora.',
        provider: 'firecrawl',
        symbols: ['BTC'],
        sentiment: { score: 0, label: 'neutral' },
      },
      {
        id: '4'.repeat(64),
        title: 'Ethereum aprueba la actualizacion de la red',
        url: 'https://ejemplo.test/eth-upgrade',
        source: 'Ejemplo Crypto',
        publishedAt: minutesAgo(60 * 3),
        snippet: 'La comunidad celebra la aprobacion.',
        provider: 'brave',
        symbols: ['ETH'],
        sentiment: { score: 0.5, label: 'positivo' },
      },
      {
        // Fila inválida: el panel tiene que descartarla, no romperse.
        id: '5'.repeat(64),
        title: 'Titular sin enlace',
        url: 'not-a-url',
        source: 'Ejemplo Roto',
        publishedAt: minutesAgo(10),
        snippet: '',
        provider: 'brave',
        symbols: ['BTC'],
        sentiment: { score: 0.1, label: 'positivo' },
      },
    ],
  };
}

test('side panel clears paint on unmount and pagehide', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;

    // Mock the browser tabs query and sendMessage locally
    await page.evaluate(() => {
      const w = window as any;
      w._paintCommands = [];
      w.chrome.tabs = w.chrome.tabs || {};
      w.chrome.tabs.query = async () => [{ id: 1, url: 'https://www.binance.com/en/futures/BTCUSDT' }];
      const origSendMessage = w.chrome.tabs.sendMessage;
      w.chrome.tabs.sendMessage = async (tabId: number, msg: any) => {
        if (msg && msg.type === 'tv-paint') {
          w._paintCommands.push(msg);
        }
        if (origSendMessage) return origSendMessage(tabId, msg);
      };
    });

    // We toggle paint on first to register any setting
    await openTab(page, 'Ajustes');
    const paintToggle = page.getByRole('checkbox', { name: 'Pintar en el gráfico de Binance (pestaña Trading View)' });
    await paintToggle.check();
    // Await for some rendering
    await page.waitForTimeout(500);

    // Despachar el evento pagehide en la ventana del panel.
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    // Comprobar que se ha capturado el comando.
    const commands = await page.evaluate(() => {
      return (window as any)._paintCommands;
    });

    expect(commands).toBeDefined();
    const lastCommand = commands[commands.length - 1];
    expect(lastCommand).toBeDefined();
    expect(lastCommand.enabled).toBe(false);

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('side panel renders the chart and findings from mocked klines', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    const findings = page.getByRole('region', { name: 'Hallazgos' });
    await expect(findings).toContainText('fuerza');
    await expect(findings).toContainText('Doble suelo');
    // Los tres primeros son una línea «etiqueta · fuerza N»; la explicación va plegada.
    await expect(findings.locator('summary').first()).toHaveText(/^.+ · fuerza \d+$/);
    await expect(findings.locator('details.finding[open]')).toHaveCount(0);
    await expect(findings).not.toContainText(/probabilidad/i);
    const canvas = page.locator('.chart canvas').first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box && box.width > 20 && box.height > 20).toBe(true);
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('the chart overlay renders every top finding, not only the selected one', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    const legend = page.getByRole('list', { name: 'Leyenda del gráfico' });
    await expect(legend).toBeVisible();

    // La serie de velas tiene un doble suelo y tres hallazgos más en el top.
    const rows = legend.locator('li > button');
    await expect(rows).toHaveCount(4);

    // Todos los hallazgos del top están en la leyenda, con su confirmación.
    await expect(legend).toContainText('Doble suelo');
    await expect(legend).toContainText('Divergencia alcista RSI');
    await expect(legend).toContainText('Perfil de volumen');
    await expect(legend).toContainText('Zona de soporte');
    await expect(legend).toContainText('confirma 120.3');
    await expect(legend).toContainText('invalida 109.5');
    await expect(legend).not.toContainText(/probabilidad/i);

    // Marcadores de varios hallazgos: la leyenda no es solo del elegido.
    const ids = await rows.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-finding-id')),
    );
    expect(new Set(ids).size).toBe(4);

    // Al pulsar un hallazgo se resalta; el resto sigue en la leyenda.
    const volumeRow = legend.locator('button').filter({ hasText: 'Perfil de volumen' });
    await volumeRow.click();
    await expect(volumeRow).toHaveAttribute('aria-pressed', 'true');
    await expect(legend.locator('button').filter({ hasText: 'Perfil de volumen' })).toHaveCount(1);
    await expect(legend).toContainText('Doble suelo');

    // La lista de hallazgos y la leyenda comparten la selección.
    const findingButton = page
      .getByRole('region', { name: 'Hallazgos' })
      .locator('summary', { hasText: 'Doble suelo' });
    await findingButton.click();
    await expect(legend.locator('button').filter({ hasText: 'Doble suelo' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('el panel de CVD pinta el flujo de volumen de las velas mockeadas', async () => {
  const panel = await openSidePanel(undefined, aggressiveBuyKlines());
  try {
    const { page } = panel;
    const flow = page.getByRole('region', { name: 'Flujo de volumen' });
    await expect(flow).toBeVisible();
    // Plegado por defecto: el resumen ya dice hacia dónde empuja el flujo.
    await expect(flow.locator('summary')).toHaveText(/^Flujo CVD · /);
    await expect(flow.locator('canvas').first()).toBeHidden();
    await flow.locator('summary').click();

    // La leyenda explica el CVD en una línea.
    await expect(flow.locator('.flow-legend')).toContainText(
      'CVD = compra agresiva acumulada − venta agresiva acumulada (volumen taker)',
    );

    // El panel vive debajo del gráfico de precio y pinta sus propias series.
    const price = page.locator('.chart canvas').first();
    const cvd = flow.locator('canvas').first();
    await expect(price).toBeVisible();
    await expect(cvd).toBeVisible();
    const priceBox = await price.boundingBox();
    const cvdBox = await cvd.boundingBox();
    expect(priceBox && cvdBox).toBeTruthy();
    expect(cvdBox!.width).toBeGreaterThan(100);
    expect(cvdBox!.height).toBeGreaterThan(40);
    expect(cvdBox!.y).toBeGreaterThan(priceBox!.y + priceBox!.height - 1);

    // 71 velas mockeadas, ninguna inventada.
    await expect(flow.locator('.flow-chart')).toHaveAttribute('data-cvd-points', '71');

    // La compra agresiva sale en la lista con su etiqueta en español.
    await expect(page.getByRole('region', { name: 'Hallazgos' })).toContainText('Compra agresiva');

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('news card shows headlines from the mocked api with relative time and sentiment', async () => {
  const panel = await openSidePanel(async () => newsItemsFixture());
  try {
    const { page, newsRequests } = panel;
    const news = page.getByRole('region', { name: 'Titulares' });
    await expect(news).toBeVisible();
    await expect(news.locator('summary')).toHaveText(/^Titulares · 4 · último hace \d/);
    await news.locator('summary').click();

    // Pide al endpoint público con el activo del símbolo abierto.
    await expect
      .poll(() => newsRequests.filter((url) => url.includes('symbol=BTC')).length)
      .toBeGreaterThan(0);
    expect(newsRequests.some((url) => url.includes('/api/news'))).toBe(true);

    // Cuatro titulares válidos; el quinto se descarta por no traer enlace.
    const items = news.locator('li');
    await expect(items).toHaveCount(4);
    await expect(news).toContainText('rally institucional');
    await expect(news).toContainText('se desploma');
    await expect(news).toContainText('retrasa la decision');
    await expect(news).not.toContainText('Titular sin enlace');

    // Fuente, hace cuánto y el tono como texto.
    await expect(items.first()).toContainText('Ejemplo Crypto');
    await expect(items.first()).toContainText(/hace \d/);
    await expect(news.locator('[data-label="positivo"]').first()).toHaveText('positivo');
    await expect(news.locator('[data-label="negativo"]')).toHaveText('negativo');
    await expect(news.locator('[data-label="neutral"]')).toHaveText('neutral');
    await expect(news).not.toContainText(/probabilidad/i);

    // El enlace apunta fuera y se abre en otra pestaña.
    const link = items.first().locator('a');
    await expect(link).toHaveAttribute('href', 'https://ejemplo.test/btc-rally');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('news card degrades to a note when the service has nothing', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    const news = page.getByRole('region', { name: 'Titulares' });
    await news.locator('summary').click();
    await expect(news).toContainText('Sin titulares recientes.');
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('explain card: opt-in gate, mocked AI answer, and local fallback on 429', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    let mode: 'ai' | 'rate_limited' = 'rate_limited';
    const explainRequests: string[] = [];
    await page.route(/trade\.swal\.network\/api\/explain/, async (route) => {
      explainRequests.push(route.request().url());
      if (mode === 'rate_limited') {
        await fulfillJson(route, { error: 'rate_limited', retryAfterS: 600 }, 429);
        return;
      }
      await fulfillJson(route, {
        source: 'ai',
        summary: 'El análisis ve un doble suelo sobre el soporte.',
        scenarios: [
          {
            name: 'Doble suelo',
            condition: 'cierre por encima de 101',
            invalidation: 'cierre por debajo de 98',
            risk_note: 'stop detrás de 98',
          },
        ],
        caution: 'La fuerza del patrón no es una tasa de acierto.',
      });
    });

    const card = page.getByTestId('explain-card');
    await expect(card).toBeVisible();
    const button = page.getByTestId('explain-button');
    await expect(button).toBeDisabled();
    await expect(card).toContainText('Explicación educativa. No es una recomendación de compra o venta.');
    await expect(card).toContainText('nunca datos de tu cuenta');
    expect(explainRequests).toEqual([]);

    // Sin encender el interruptor no sale ninguna petición, ni al pulsar.
    await card.getByRole('checkbox', { name: 'Explicaciones con IA' }).check();
    await expect(button).toBeEnabled();

    // 429: explicación local con el motivo, sin romper el panel.
    await button.click();
    const answer = page.getByTestId('explain-answer');
    await expect(answer).toHaveAttribute('data-source', 'fallback');
    await expect(answer).toContainText('límite por hora alcanzado');
    await expect(answer).toContainText('Doble suelo');
    await expect(answer).not.toContainText(/probabilidad/i);

    // Al cambiar de temporalidad la explicación anterior se limpia.
    mode = 'ai';
    await page.locator('select[aria-label="Temporalidad"]').selectOption('1h');
    await expect(page.getByTestId('explain-answer')).toHaveCount(0);
    await button.click();
    await expect(answer).toHaveAttribute('data-source', 'ai');
    await expect(answer).toContainText('doble suelo sobre el soporte');
    await expect(answer).toContainText('confirma');
    await expect(answer).toContainText('invalida');
    expect(explainRequests).toEqual([
      'https://trade.swal.network/api/explain',
      'https://trade.swal.network/api/explain',
    ]);

    // El 429 deliberado deja una traza «Failed to load resource» en consola:
    // es ruido de red esperado, no un fallo de la tarjeta.
    const unexpected = panel.errors.filter((line) => !/429|Too Many Requests/.test(line));
    expect(unexpected, unexpected.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('context band and levels map show references, never buy or sell wording', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    await expect(page.getByTestId('context-band')).toBeVisible();
    await expect(page.getByTestId('context-closes')).toBeVisible();
    await expect(page.getByTestId('context-closes').locator('li')).not.toHaveCount(0);
    await expect(page.getByTestId('context-disclaimer')).toHaveText(
      'Referencias, no predicciones: la dirección no está medida.',
    );
    await expect(page.getByTestId('context-sentiment')).toContainText('Miedo extremo');
    await expect(page.getByTestId('levels-card')).toHaveCount(1);
    await page.getByTestId('levels-card').locator('summary').click();
    await expect(page.getByTestId('levels-row').first()).toBeVisible();
    await expect(page.getByTestId('levels-card')).toContainText('Zonas de reacción posible');
    const text = (await page.locator('body').innerText()).toLowerCase();
    expect(text).not.toContain('comprar');
    expect(text).not.toContain('vender');
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('operacion tab: context band displays sentiment and next closes with data-testid', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    await expect(page.getByTestId('context-band')).toBeVisible();
    await expect(page.getByTestId('context-sentiment')).toBeVisible();
    await expect(page.getByTestId('context-closes')).toBeVisible();
    await expect(page.getByTestId('context-closes').locator('li')).not.toHaveCount(0);
    await expect(page.getByTestId('context-disclaimer')).toHaveText('Referencias, no predicciones: la dirección no está medida.');
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('operacion tab: levels map displays rows with data-testid', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    const levelsCard = page.getByTestId('levels-card');
    await expect(levelsCard).toBeVisible();
    await levelsCard.locator('summary').click();
    const rows = page.getByTestId('levels-row');
    await expect(rows.first()).toBeVisible();
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('operacion tab: findings list and legend interactions update selection', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    const findingsRegion = page.getByRole('region', { name: 'Hallazgos' });
    await expect(findingsRegion).toBeVisible();

    // Check that we have a findings list and expand the first one
    const firstFinding = findingsRegion.locator('details.finding').first();
    await firstFinding.locator('summary').click();
    await expect(firstFinding).toHaveClass(/selected/);

    // Click first legend to select it, which syncs with findings list
    const legend = page.locator('ol.legend');
    await expect(legend).toBeVisible();

    const firstLegendItem = legend.locator('button').first();
    await firstLegendItem.click();
    await expect(firstLegendItem).toHaveAttribute('aria-pressed', 'true');
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('operacion tab: CVD pane test region using aria labels', async () => {
  const panel = await openSidePanel(undefined, aggressiveBuyKlines());
  try {
    const { page } = panel;
    const cvdRegion = page.getByRole('region', { name: 'Flujo de volumen' });
    await expect(cvdRegion).toBeVisible();
    const summary = cvdRegion.locator('summary');
    await summary.click();
    const legend = cvdRegion.locator('.flow-legend');
    await expect(legend).toBeVisible();
    await expect(legend).toContainText('compra agresiva acumulada');
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('operacion tab: news card lists titles properly using aria labels', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    const newsRegion = page.getByRole('region', { name: 'Titulares' });
    await expect(newsRegion).toBeVisible();
    const summary = newsRegion.locator('summary');
    await summary.click();

    // Default empty state, since we have no explicit mock response applied
    await expect(newsRegion).toContainText('Sin titulares recientes.');
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('operacion tab: explain card opt-in using data-testid', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    const card = page.getByTestId('explain-card');
    await expect(card).toBeVisible();
    const checkbox = card.getByRole('checkbox', { name: 'Explicaciones con IA' });
    await expect(checkbox).toBeVisible();
    await checkbox.check();
    const button = page.getByTestId('explain-button');
    await expect(button).toBeEnabled();
    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('operacion tab: paint setting toggle sends tv-paint command and clears on pagehide', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;

    await page.evaluate(() => {
      const w = window as any;
      w._recordedCommands = [];
      w.chrome.tabs = w.chrome.tabs || {};
      w.chrome.tabs.query = async () => [{ id: 1, url: 'https://www.binance.com/en/futures/BTCUSDT' }];
      const origSendMessage = w.chrome.tabs.sendMessage;
      w.chrome.tabs.sendMessage = async (tabId: number, msg: any) => {
        if (msg && msg.type === 'tv-paint') {
          w._recordedCommands.push(msg);
        }
        if (origSendMessage) return origSendMessage(tabId, msg);
      };
    });

    await openTab(page, 'Ajustes');
    const paintToggle = page.getByRole('checkbox', { name: 'Pintar en el gráfico de Binance (pestaña Trading View)' });
    await paintToggle.check();
    await openTab(page, 'Operación');

    await expect.poll(async () => {
      const cmds = await page.evaluate(() => (window as any)._recordedCommands);
      return cmds && cmds.length > 0;
    }).toBeTruthy();

    await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    await expect.poll(async () => {
      const cmds = await page.evaluate(() => (window as any)._recordedCommands);
      const lastCmd = cmds && cmds.length > 0 ? cmds[cmds.length - 1] : null;
      return lastCmd && lastCmd.enabled === false;
    }).toBeTruthy();

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});
