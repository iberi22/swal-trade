#!/usr/bin/env node
/**
 * Step 1 follow-up 3: awaited entity API. createShape/createMultipointShape/
 * removeEntity return Promises in this build. Verify draw + count + get +
 * remove with await.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'investigation');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const log = (...args) => console.log(...args);

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, userAgent: USER_AGENT, locale: 'en-US' });
  const page = await context.newPage();
  page.on('pageerror', (err) => log('pageerror:', String(err).slice(0, 200)));
  await page.goto('https://www.binance.com/en/futures/BTCUSDT', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(9000);
  for (const sel of ['button:has-text("Accept")', 'button:has-text("Aceptar")']) {
    try {
      const b = page.locator(sel).first();
      if (await b.isVisible({ timeout: 600 })) { await b.click({ timeout: 1500 }); break; }
    } catch {}
  }
  await page.evaluate(() => {
    const matches = [...document.querySelectorAll('div,span,a,button,li')].filter(
      (el) => el.childElementCount <= 2 && /^\s*Trading\s*View\s*$/i.test(el.textContent ?? '') && el.offsetParent !== null,
    );
    matches[matches.length - 1]?.click();
  });
  await page.waitForTimeout(7000);

  const result = await page.evaluate(async () => {
    const out = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const findApi = () => {
      for (const el of document.querySelectorAll('iframe')) {
        try {
          const w = el.contentWindow;
          if (w && w.tradingViewApi && typeof w.tradingViewApi.activeChart === 'function') return w;
        } catch {}
      }
      return null;
    };
    let win = findApi();
    for (let i = 0; i < 20 && !win; i++) { await sleep(500); win = findApi(); }
    if (!win) return { error: 'api unreachable' };
    const chart = win.tradingViewApi.activeChart();
    let range = chart.getVisibleRange();
    for (let i = 0; i < 60 && (!range || !Number(range.from)); i++) { await sleep(500); try { range = chart.getVisibleRange(); } catch { range = null; } }
    if (!range || !Number(range.from)) return { error: 'no visible range' };
    const from = Number(range.from), to = Number(range.to);
    const price = Number(document.title.split('|')[0].replace(/,/g, ''));

    // awaited create
    const lineId = await chart.createShape({ time: Math.floor((from + to) / 2), price }, {
      shape: 'horizontal_line',
      text: 'invalida 82.9k',
      overrides: { linecolor: '#121212', linewidth: 1, linestyle: 2, showLabel: true, textcolor: '#121212', fontsize: 10 },
    });
    out.lineId = { type: typeof lineId, value: typeof lineId === 'object' ? JSON.parse(JSON.stringify(lineId)) : lineId, str: String(lineId) };
    const trendId = await chart.createMultipointShape(
      [
        { time: from + Math.floor((to - from) * 0.2), price: price * 1.001 },
        { time: from + Math.floor((to - from) * 0.8), price: price * 0.999 },
      ],
      { shape: 'trend_line', overrides: { linecolor: '#121212', linewidth: 1, linestyle: 0 } },
    );
    out.trendId = { type: typeof trendId, value: typeof trendId === 'object' ? JSON.parse(JSON.stringify(trendId)) : trendId, str: String(trendId) };

    out.countAfterCreate = chart.getAllShapes().length;
    try { out.getByIdResolves = chart.getShapeById(lineId) !== undefined; } catch (e) { out.getByIdResolves = 'ERR ' + String(e).slice(0, 120); }

    const r1 = chart.removeEntity(lineId);
    out.removeReturns = r1 && typeof r1.then === 'function' ? 'promise' : typeof r1;
    if (r1 && typeof r1.then === 'function') await r1;
    await sleep(300);
    out.countAfterRemoveLine = chart.getAllShapes().length;

    const r2 = chart.removeEntity(trendId);
    if (r2 && typeof r2.then === 'function') await r2;
    await sleep(300);
    out.countAfterRemoveTrend = chart.getAllShapes().length;

    // rectangle shape for zones (sr_zone findings)
    try {
      const zone = await chart.createMultipointShape(
        [
          { time: from + Math.floor((to - from) * 0.1), price: price * 0.995 },
          { time: from + Math.floor((to - from) * 0.4), price: price * 0.99 },
        ],
        { shape: 'rectangle', overrides: { color: '#121212', backgroundColor: '#12121220', linewidth: 1, fillBackground: true } },
      );
      out.zoneId = String(zone);
      out.countWithZone = chart.getAllShapes().length;
      const rz = chart.removeEntity(zone);
      if (rz && typeof rz.then === 'function') await rz;
      await sleep(300);
      out.countAfterRemoveZone = chart.getAllShapes().length;
    } catch (e) {
      out.zoneError = String(e).slice(0, 200);
    }

    // does the chart survive many shapes + removals (simulating a redraw)?
    const many = [];
    for (let i = 0; i < 5; i++) {
      many.push(await chart.createShape({ time: mid_time(from, to, i), price: price * (1 + i * 0.001) }, { shape: 'horizontal_line' }));
    }
    function mid_time(f, t, i) { return Math.floor(f + ((t - f) * (i + 1)) / 7); }
    out.countMany = chart.getAllShapes().length;
    await Promise.all(many.map((id) => chart.removeEntity(id)));
    await sleep(500);
    out.countAfterManyRemove = chart.getAllShapes().length;
    return out;
  });
  log(JSON.stringify(result, null, 1));
  await browser.close();
  await writeFile(path.join(outDir, 'awaited-api.json'), JSON.stringify(result, null, 2));
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1); });
