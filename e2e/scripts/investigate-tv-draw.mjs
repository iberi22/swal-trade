#!/usr/bin/env node
/**
 * Step 1 follow-up: prove createShape/createMultipointShape really register
 * entities and that removeEntity cleans them up, using a REAL price read from
 * the public page title. The whole probe runs from the PAGE WORLD through
 * iframe.contentWindow, exactly like a MAIN-world content script would.
 * Public pages only; no login, no order forms.
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

const report = {};

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, userAgent: USER_AGENT, locale: 'en-US' });
  const page = await context.newPage();
  page.on('pageerror', (err) => {
    const text = String(err);
    report.pageErrors = [...(report.pageErrors ?? []), text.slice(0, 200)];
    if (/Cannot create/.test(text)) log('PAGE ERROR (shape):', text.slice(0, 200));
  });
  await page.goto('https://www.binance.com/en/futures/BTCUSDT', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(9000);
  for (const sel of ['button:has-text("Accept")', 'button:has-text("Aceptar")']) {
    try {
      const b = page.locator(sel).first();
      if (await b.isVisible({ timeout: 600 })) { await b.click({ timeout: 1500 }); break; }
    } catch {}
  }
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const matches = [...document.querySelectorAll('div,span,a,button,li')].filter(
      (el) => el.childElementCount <= 2 && /^\s*Trading\s*View\s*$/i.test(el.textContent ?? '') && el.offsetParent !== null,
    );
    matches[matches.length - 1]?.click();
  });
  await page.waitForTimeout(7000);
  report.title = await page.title();
  log('title:', report.title);

  // Single page-world probe, exactly like a MAIN-world content script:
  // find the same-origin iframe exposing tradingViewApi, draw, count, remove.
  report.result = await page.evaluate(async () => {
    const out = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const findApi = () => {
      for (const el of document.querySelectorAll('iframe')) {
        try {
          const w = el.contentWindow;
          if (w && w.tradingViewApi && typeof w.tradingViewApi.activeChart === 'function') return w;
        } catch {
          // cross-origin iframe (e.g. accounts): skip
        }
      }
      return null;
    };
    let win = findApi();
    for (let i = 0; i < 20 && !win; i++) {
      await sleep(500);
      win = findApi();
    }
    if (!win) return { error: 'tradingViewApi not reachable from page world' };
    out.reachable = true;
    out.iframeUrl = (() => { for (const el of document.querySelectorAll('iframe')) { try { if (el.contentWindow === win) return el.src; } catch {} } return null; })();

    const chart = win.tradingViewApi.activeChart();
    // Wait until the chart really has data: an all-zero visible range means
    // the library is still booting and createShape throws "Cannot create".
    let range = chart.getVisibleRange();
    for (let i = 0; i < 60 && (!range || !Number(range.from)); i++) {
      await sleep(500);
      try { range = chart.getVisibleRange(); } catch { range = null; }
    }
    out.visibleRange = range;
    const from = Number(range.from);
    const to = Number(range.to);
    const mid = Math.floor((from + to) / 2);
    out.symbol = (() => { try { return chart.symbol(); } catch (e) { return 'ERR ' + e; } })();
    out.resolution = (() => { try { return chart.resolution ? chart.resolution() : null; } catch (e) { return 'ERR ' + e; } })();
    out.listenerMethods = {};
    for (const name of ['onSymbolChanged', 'onIntervalChanged', 'onDataLoaded', 'onVisibleRangeChanged']) {
      out.listenerMethods[name] = typeof chart[name];
    }

    // real price from the page title (e.g. "82,955.8 | BTCUSDT ...")
    const price = Number(document.title.split('|')[0].replace(/,/g, ''));
    out.price = price;

    const lineOptions = {
      shape: 'horizontal_line',
      text: 'cuello 82.9k',
      overrides: {
        linecolor: '#121212', linewidth: 1, linestyle: 2,
        showLabel: true, textcolor: '#121212', fontsize: 10, horzLabelsAlign: 'right',
      },
    };
    out.lineIdType = '';
    let lineId;
    try {
      lineId = chart.createShape({ time: mid, price }, lineOptions);
      out.lineIdType = typeof lineId;
      out.lineId = typeof lineId === 'object' ? JSON.parse(JSON.stringify(lineId)) : lineId;
    } catch (e) {
      out.createShapeError = String(e).slice(0, 300);
    }

    const trendPoints = [
      { time: from + Math.floor((to - from) * 0.2), price: price * 1.001 },
      { time: from + Math.floor((to - from) * 0.8), price: price * 0.999 },
    ];
    let trendId;
    try {
      trendId = chart.createMultipointShape(trendPoints, {
        shape: 'trend_line',
        overrides: { linecolor: '#121212', linewidth: 1, linestyle: 0, showLabel: false },
      });
      out.trendIdType = typeof trendId;
      out.trendId = typeof trendId === 'object' ? JSON.parse(JSON.stringify(trendId)) : trendId;
    } catch (e) {
      out.createMultipointError = String(e).slice(0, 300);
    }

    await sleep(900);
    try {
      out.entitiesAfterDraw = chart.getAllShapes().length;
      out.getShapeByIdLine = typeof lineId !== 'undefined' && chart.getShapeById(lineId) !== undefined;
      out.getShapeByIdTrend = typeof trendId !== 'undefined' && chart.getShapeById(trendId) !== undefined;
    } catch (e) {
      out.entitiesAfterDrawError = String(e).slice(0, 200);
    }

    try {
      chart.removeEntity(lineId);
      chart.removeEntity(trendId);
      out.removeOk = true;
    } catch (e) {
      out.removeError = String(e).slice(0, 300);
    }
    await sleep(900);
    try {
      out.entitiesAfterRemove = chart.getAllShapes().length;
    } catch (e) {
      out.entitiesAfterRemoveError = String(e).slice(0, 200);
    }

    // Also verify: redrawing after a symbol/interval change is needed at all?
    out.symbolAfterDraw = (() => { try { return chart.symbol(); } catch (e) { return 'ERR ' + e; } })();
    return out;
  });
  log(JSON.stringify(report.result, null, 1));
  await page.screenshot({ path: path.join(outDir, 'binance-tv-tab.png') });
  await browser.close();
  await writeFile(path.join(outDir, 'draw-test.json'), JSON.stringify(report, null, 2));
  log(`\nreport: ${path.join(outDir, 'draw-test.json')}`);
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1); });
