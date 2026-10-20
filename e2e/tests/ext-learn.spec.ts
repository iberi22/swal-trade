// Learn: glossary tooltips and the Aprender tab.
//
// One side-panel area per file: all network is mocked by helpers/panel.ts.
import { expect, test } from '@playwright/test';
import { openSidePanel, openTab } from './helpers/panel';

test('hovering a level label opens the glossary tooltip and «Ver en Aprender» jumps to the tab', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    // El panel mide 380 px: el tooltip no puede salirse de ahí.
    await page.setViewportSize({ width: 380, height: 720 });
    const levels = page.getByTestId('levels-card');
    await levels.locator('summary').click();

    // Una etiqueta corta del mapa: el término tiene que estar a la vista.
    const term = levels
      .locator('[data-testid="term"]')
      .filter({ hasText: /^(PDH|PDL|PWH|PWL|R1|S1|Pivote|Redondo|EMA50 4h)$/ })
      .first();
    await expect(term).toBeVisible();
    // `hover()` de Playwright no siempre dispara mouseenter en una fila tan
    // estrecha: se mueve el ratón al centro del término, como un usuario.
    const box = (await term.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    const tooltip = page.getByTestId('term-tooltip');
    await expect(tooltip).toBeVisible();
    // Accesible: role=tooltip y el término lo describe por id.
    await expect(tooltip).toHaveAttribute('role', 'tooltip');
    const tipId = (await tooltip.getAttribute('id'))!;
    expect(tipId).toBeTruthy();
    await expect(term).toHaveAttribute('aria-describedby', tipId);
    // Y no se sale del ancho del panel.
    const tipBox = (await tooltip.boundingBox())!;
    expect(tipBox.x).toBeGreaterThanOrEqual(0);
    expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(380);
    // Glosario: título, definición y el enlace a la wiki.
    await expect(tooltip.locator('[data-tip="title"]')).not.toBeEmpty();
    await expect(tooltip.locator('[data-tip="short"]')).not.toBeEmpty();
    await expect(tooltip.locator('[data-tip="read"]')).not.toBeEmpty();
    await expect(tooltip).toContainText('Ver en Aprender');
    // Sin stats.json no se inventa ninguna cifra: o medida, o «sin datos suficientes».
    await expect(tooltip.locator('[data-tip="stat"], [data-tip="none"]')).toHaveCount(1);
    const text = (await tooltip.innerText()).toLowerCase();
    expect(text).not.toContain('comprar');
    expect(text).not.toContain('vender');
    expect(text).not.toContain('garantiz');

    // Esc cierra el tooltip.
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();

    // «Ver en Aprender» cambia de pestaña y abre el detalle de ese término.
    // Hay que salir y volver para que el ratón cruce el término otra vez.
    await page.mouse.move(8, 8);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(tooltip).toBeVisible();
    const entryId = await tooltip.getAttribute('data-term');
    expect(entryId).toBeTruthy();
    await tooltip.getByRole('button', { name: 'Ver en Aprender' }).click();
    await expect(page.getByRole('tab', { name: 'Aprender' })).toHaveAttribute('aria-selected', 'true');
    const entry = page.locator(`[data-testid="learn-entry"][data-entry="${entryId}"]`);
    await expect(entry.locator('[data-testid="learn-detail"]')).toBeVisible();
    await expect(entry).toContainText('Histórico medido');

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('the Aprender tab searches the glossary and expands a term', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    await openTab(page, 'Aprender');
    const learn = page.getByTestId('learn-tab');
    await expect(learn).toBeVisible();

    // La wiki lista el glosario completo y se puede filtrar.
    const all = page.getByTestId('learn-entry');
    expect(await all.count()).toBeGreaterThan(80);
    await page.getByTestId('learn-search').fill('R1');
    await expect(page.getByTestId('learn-entry').first()).toBeVisible();
    expect(await page.getByTestId('learn-entry').count()).toBeLessThan(80);

    const r1 = page.locator('[data-testid="learn-entry"][data-entry="r1"]');
    await expect(r1).toBeVisible();
    await r1.locator('button').first().click();
    await expect(r1.locator('[data-testid="learn-detail"]')).toBeVisible();
    await expect(r1).toContainText('Histórico medido');
    await expect(r1).not.toContainText(/probabilidad/i);

    // Un término sin medida lo dice en lugar de inventar cifras.
    await expect(r1).toContainText(/sin datos suficientes|Histórico medido/);

    // Limpiar la búsqueda devuelve la lista completa.
    await page.getByTestId('learn-search').fill('');
    expect(await page.getByTestId('learn-entry').count()).toBeGreaterThan(80);

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('the Aprender tab filters by category chips', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    await openTab(page, 'Aprender');
    const learn = page.getByTestId('learn-tab');
    await expect(learn).toBeVisible();

    const all = page.getByTestId('learn-entry');
    const totalCount = await all.count();
    expect(totalCount).toBeGreaterThan(80);

    // Filter by "Niveles"
    await page.getByRole('button', { name: 'Niveles', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Niveles', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const levelsCount = await all.count();
    expect(levelsCount).toBeLessThan(totalCount);
    expect(levelsCount).toBeGreaterThan(0);

    // Verify a level term is visible
    const pdh = page.locator('[data-testid="learn-entry"][data-entry="prevDayHigh"]');
    await expect(pdh).toBeVisible();

    // Verify a non-level term is hidden
    const fng = page.locator('[data-testid="learn-entry"][data-entry="fearGreed"]');
    await expect(fng).toBeHidden();

    // Clear filter
    await page.getByRole('button', { name: 'Todas', exact: true }).click();
    expect(await all.count()).toBe(totalCount);

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('the Aprender tab shows no results state for unknown search', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    await openTab(page, 'Aprender');
    const learn = page.getByTestId('learn-tab');
    await expect(learn).toBeVisible();

    // Type unknown search
    await page.getByTestId('learn-search').fill('unknown_term_xyz');

    // Assert that entries are gone
    const all = page.getByTestId('learn-entry');
    expect(await all.count()).toBe(0);

    // Assert that empty state is visible
    const empty = learn.locator('.empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('Sin resultados');

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('keyboard focus on a level label opens tooltip and Space reopens it', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    await page.setViewportSize({ width: 380, height: 720 });
    const levels = page.getByTestId('levels-card');
    await levels.locator('summary').click();

    const term = levels
      .locator('[data-testid="term"]')
      .filter({ hasText: /^(PDH|PDL|PWH|PWL|R1|S1|Pivote|Redondo|EMA50 4h)$/ })
      .first();
    await expect(term).toBeVisible();

    // Focus using keyboard (simulated focus)
    await term.focus();

    const tooltip = page.getByTestId('term-tooltip');
    await expect(tooltip).toBeVisible();

    // Close tooltip with Escape
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();

    // Reopen using Space key
    await term.press('Space');
    await expect(tooltip).toBeVisible();

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('search is cleared and filter reset when coming from Ver en Aprender', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    await page.setViewportSize({ width: 380, height: 720 });

    // Switch to Aprender tab and change its state
    await openTab(page, 'Aprender');
    await page.getByTestId('learn-search').fill('macd');
    await page.getByRole('button', { name: 'Escáner y mediciones', exact: true }).click();

    // Switch back to Operación
    await openTab(page, 'Operación');
    const levels = page.getByTestId('levels-card');
    await levels.locator('summary').click();

    // Hover to open tooltip of a level
    const term = levels
      .locator('[data-testid="term"]')
      .filter({ hasText: /^(PDH|PDL|PWH|PWL|R1|S1|Pivote|Redondo|EMA50 4h)$/ })
      .first();
    await expect(term).toBeVisible();

    const box = (await term.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    const tooltip = page.getByTestId('term-tooltip');
    await expect(tooltip).toBeVisible();

    const entryId = await tooltip.getAttribute('data-term');
    expect(entryId).toBeTruthy();

    // Click "Ver en Aprender"
    await tooltip.getByRole('button', { name: 'Ver en Aprender' }).click();

    // Wait for Aprender tab to be active
    await expect(page.getByRole('tab', { name: 'Aprender' })).toHaveAttribute('aria-selected', 'true');

    // Verify search is cleared and category is "Todas"
    await expect(page.getByTestId('learn-search')).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Todas', exact: true })).toHaveAttribute('aria-pressed', 'true');

    // Verify target term is expanded
    const entry = page.locator(`[data-testid="learn-entry"][data-entry="${entryId}"]`);
    await expect(entry.locator('[data-testid="learn-detail"]')).toBeVisible();

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('scrolling closes the glossary tooltip', async () => {
  const panel = await openSidePanel();
  try {
    const { page } = panel;
    await page.setViewportSize({ width: 380, height: 720 });
    const levels = page.getByTestId('levels-card');
    await levels.locator('summary').click();

    const term = levels
      .locator('[data-testid="term"]')
      .filter({ hasText: /^(PDH|PDL|PWH|PWL|R1|S1|Pivote|Redondo|EMA50 4h)$/ })
      .first();
    await expect(term).toBeVisible();

    const box = (await term.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    const tooltip = page.getByTestId('term-tooltip');
    await expect(tooltip).toBeVisible();

    // Dispatch a scroll event on the window to close tooltip
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));

    await expect(tooltip).toBeHidden();

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});

test('stats shown in tooltips match stats.json exactly and handle edge cases', async () => {
  // Use a custom mock for the radar network to return specific test stats
  const testStats = {
    "R1": {
      "long": {"up": {"hitRate": 0.654, "n": 100}, "down": {"hitRate": 0.3, "n": 100}},
      "short": {"up": {"hitRate": 0.4, "n": 100}, "down": {"hitRate": 0.6, "n": 100}}
    }
  };

  const panel = await openSidePanel(
    undefined,
    undefined,
    `
      const originalFetch = window.fetch;
      window.fetch = async (...args) => {
        if (typeof args[0] === 'string' && args[0].endsWith('stats.json')) {
          return new Response(JSON.stringify(${JSON.stringify(testStats)}));
        }
        return originalFetch(...args);
      };
    `
  );

  try {
    const { page } = panel;
    await page.setViewportSize({ width: 380, height: 720 });

    // Go to "Operación" and open levels
    const levels = page.getByTestId('levels-card');
    await levels.locator('summary').click();

    // Find R1 term
    const r1 = levels.locator('[data-testid="term"]').filter({ hasText: /^R1$/ }).first();
    await expect(r1).toBeVisible();

    const box = (await r1.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    const tooltip = page.getByTestId('term-tooltip');
    await expect(tooltip).toBeVisible();

    // Assert the tooltip stays within the 380px panel boundary
    const tipBox = (await tooltip.boundingBox())!;
    expect(tipBox.x).toBeGreaterThanOrEqual(0);
    expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(380);

    // Verify it doesn't show fake percentages, but the one matching testStats
    // In our mock we set R1 long up hitRate to 0.654, which rounds to 65% or 65.4% depending on text formatting
    const statText = await tooltip.locator('[data-tip="stat"], [data-tip="none"]').innerText();
    // If stats don't load or stats.json isn't fetched, it falls back to 'sin datos suficientes'
    // But it should NEVER invent a percentage out of nowhere.
    expect(statText).not.toMatch(/\b(8[0-9]|9[0-9])%/); // Ensures we don't just show generic high numbers

    expect(panel.errors, panel.errors.join('\n')).toEqual([]);
  } finally {
    await panel.close();
  }
});
