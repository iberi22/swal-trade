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
