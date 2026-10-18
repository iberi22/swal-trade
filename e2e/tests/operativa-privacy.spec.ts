import { expect, test, assertClean } from './site-test';
import { fulfillJson } from '../fixtures/browser';

const generatedAt = new Date('2026-10-09T12:00:00.000Z');
const pos2Min = new Date(generatedAt.getTime() - 2 * 60 * 1000).toISOString();
const pos40Min = new Date(generatedAt.getTime() - 40 * 60 * 1000).toISOString();

const inlineSnapshot = {
  schema: 'synapse.public.snapshot/v1',
  generated_at: generatedAt.toISOString(),
  mode: 'paper',
  engine: {
    status: 'ok',
    feed_ok: true,
    last_price_update_at: generatedAt.toISOString(),
    uptime_s: 10,
    strategies_registered: 0,
  },
  account: {
    initial_capital: 1000,
    equity_pct: 0,
    daily_pnl_pct: 0,
    max_drawdown_pct: 0,
    open_positions: 0,
    total_trades: 0,
    win_rate: null,
  },
  points_formula: '1 punto = 1 pb de rendimiento neto',
  bots: [
    { id: 'bot-1', name: 'Bot Test', research_verdict: 'x' }
  ],
  open_positions: [
    { bot: 'Bot Test', symbol: 'BTCUSDT', side: 'LONG', opened_at: pos2Min },
    { bot: 'Bot Test', symbol: 'ETHUSDT', side: 'SHORT', opened_at: pos40Min }
  ],
  recent_trades: [],
  equity_curve: [],
};

test('verdict never displayed and no Veredicto column', async ({ page, problems }) => {
  await page.route('**/public/v1/snapshot', (route) => fulfillJson(route, inlineSnapshot));

  await page.goto('/operativa/', { waitUntil: 'load' });

  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain('verdict');
  expect(bodyText).not.toContain('x'); // research_verdict value should not be displayed

  // 'Veredicto Investigación' shouldn't exist anymore as per the task requirements
  const ths = await page.locator('th').allInnerTexts();
  expect(ths.join(' ')).not.toContain('Veredicto');
  expect(ths.join(' ')).not.toContain('verdict');

  await assertClean(page, problems);
});

test('only old positions are displayed', async ({ page }) => {
  await page.route('**/public/v1/snapshot', (route) => fulfillJson(route, inlineSnapshot));

  await page.goto('/operativa/', { waitUntil: 'load' });

  // Verify only the older position (40 min) is shown, 2 min position should be hidden/dropped
  const positionsText = await page.locator('#positions-table-body').innerText();
  expect(positionsText).not.toContain('BTCUSDT'); // pos2Min
  expect(positionsText).toContain('ETHUSDT');   // pos40Min
});

test('no external requests made for snapshots', async ({ page }) => {
  const externalRequests: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      externalRequests.push(req.url());
    }
  });

  await page.route('**/public/v1/snapshot', (route) => fulfillJson(route, inlineSnapshot));
  await page.goto('/operativa/', { waitUntil: 'load' });

  expect(externalRequests).toEqual([]);
});
