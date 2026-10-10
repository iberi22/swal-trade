#!/usr/bin/env node
/**
 * Step 1 investigation: is Binance Futures' TradingView chart reachable from
 * the page, and does its drawing API work?
 *
 * Standalone Playwright script (no webServer needed). Public pages only:
 * it never logs in, never touches order forms, balances or account data.
 *
 * Usage: node investigate-binance-tv.mjs [url] [original|tv|both]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'https://www.binance.com/en/futures/BTCUSDT';
/** which chart tab to probe: the default Binance chart, the TradingView tab, or both */
const mode = process.argv[3] ?? 'both';
const outDir = path.join(here, 'investigation');

const VIEWPORT = { width: 1680, height: 1000 };
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const log = (...args) => console.log(...args);

/** Probing function evaluated inside a frame: find widget-like objects on window. */
const SCAN_WINDOW = `
(() => {
  const hits = [];
  for (const key of Object.getOwnPropertyNames(window)) {
    let value;
    try { value = window[key]; } catch { continue; }
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
    if (typeof value.activeChart !== 'function' && typeof value.chart !== 'function') continue;
    hits.push({
      key,
      hasActiveChart: typeof value.activeChart === 'function',
      hasChart: typeof value.chart === 'function',
      ctor: value.constructor && value.constructor.name,
    });
  }
  return hits;
})()
`;

/** If a widget is reachable: probe its chart()/activeChart() API surface. */
const PROBE_WIDGET = (key) => `
(() => {
  const w = window[${JSON.stringify(key)}];
  if (!w) return { key: ${JSON.stringify(key)}, error: 'gone' };
  const out = { key: ${JSON.stringify(key)} };
  const accessor = typeof w.activeChart === 'function' ? 'activeChart' : (typeof w.chart === 'function' ? 'chart' : null);
  if (!accessor) return { ...out, error: 'no chart accessor' };
  out.accessor = accessor;
  let chart;
  try { chart = w[accessor](); } catch (e) { return { ...out, error: String(e) }; }
  if (!chart) return { ...out, error: 'accessor returned falsy' };
  out.methods = {};
  for (const name of [
    'createShape', 'createMultipointShape', 'removeEntity', 'removeAllShapes',
    'getAllShapes', 'getShapeById', 'setSymbol', 'setResolution', 'symbol',
    'getVisibleRange', 'visibleTimeRange', 'getAllSeries',
  ]) {
    out.methods[name] = typeof chart[name] === 'function';
  }
  try {
    out.visibleRange = chart.getVisibleRange ? chart.getVisibleRange() : (chart.visibleTimeRange ? chart.visibleTimeRange() : null);
  } catch (e) { out.visibleRange = 'ERR ' + String(e).slice(0, 120); }
  try {
    const series = chart.getAllSeries ? chart.getAllSeries()[0] : null;
    out.seriesFound = Boolean(series);
    if (series && typeof series.coordinateToPrice === 'function') {
      out.midPrice = series.coordinateToPrice(Math.round(window.innerHeight / 2));
    }
  } catch (e) { out.seriesFound = 'ERR ' + String(e).slice(0, 120); }
  return out;
})()
`;

async function dismissCookieBanner(page) {
  const candidates = [
    'button:has-text("Accept")',
    'button:has-text("Accept All")',
    'button:has-text("I Agree")',
    'button:has-text("Aceptar")',
    'button:has-text("Aceptar todo")',
    'button:has-text("De acuerdo")',
    'button#onetrust-accept-btn-handler',
    '.bn-cookie-safetyButton button',
  ];
  for (const selector of candidates) {
    try {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 800 })) {
        await button.click({ timeout: 2000 });
        return selector;
      }
    } catch {}
  }
  return null;
}

/** Find the "Original / Trading View" tab elements, click Trading View if present. */
async function switchToTradingViewTab(page) {
  const find = async () =>
    page.evaluate(() => {
      const matches = [...document.querySelectorAll('div,span,a,button,li')].filter(
        (el) => el.childElementCount <= 2 && /^\s*Trading\s*View\s*$/i.test(el.textContent ?? '') && el.offsetParent !== null,
      );
      const best = matches[matches.length - 1];
      return best ? { tag: best.tagName, text: best.textContent?.trim() } : null;
    });
  const found = await find();
  if (!found) return { found: false };
  try {
    await page.evaluate(() => {
      const matches = [...document.querySelectorAll('div,span,a,button,li')].filter(
        (el) => el.childElementCount <= 2 && /^\s*Trading\s*View\s*$/i.test(el.textContent ?? '') && el.offsetParent !== null,
      );
      matches[matches.length - 1]?.click();
    });
    await page.waitForTimeout(6000);
    return { found: true, clicked: found };
  } catch (err) {
    return { found: true, error: String(err).slice(0, 200) };
  }
}

async function snapshotState(page, label) {
  const out = { label, url: page.url() };
  out.frames = page.frames().map((frame) => {
    let origin = null;
    try {
      origin = new URL(frame.url()).origin;
    } catch {
      origin = frame.url() ? '<about:blank>' : null;
    }
    return { url: (frame.url() || 'page').slice(0, 150), name: frame.name() || null, origin };
  });
  const pageOrigin = new URL(page.url()).origin;

  // Only poke the page window and SAME-ORIGIN frames: a page script can never
  // touch a cross-origin frame's window anyway (and we must not touch the
  // accounts.binance.com login iframe).
  const targets = page.frames().filter((frame) => {
    try {
      return new URL(frame.url()).origin === pageOrigin;
    } catch {
      return false;
    }
  });
  out.widgetScan = [];
  for (const frame of targets) {
    let hits = [];
    try {
      hits = await frame.evaluate(SCAN_WINDOW);
    } catch (err) {
      out.widgetScan.push({ frame: (frame.url() || 'page').slice(0, 120), error: String(err).slice(0, 160) });
      continue;
    }
    for (const hit of hits) {
      log(`[${label}] widget candidate window.${hit.key} in ${(frame.url() || 'page').slice(0, 70)} :: ${JSON.stringify(hit)}`);
      out.widgetScan.push({ frame: (frame.url() || 'page').slice(0, 120), ...hit });
    }
  }
  if (out.widgetScan.length === 0) log(`[${label}] no widget-like object (activeChart/chart fn) on page or same-origin frames`);

  out.chartDom = await page.evaluate(() => {
    const dom = { iframes: [], canvases: [], tvScripts: [], axisLikeTexts: [] };
    for (const el of document.querySelectorAll('iframe[src],script[src]')) {
      const src = el.src || el.getAttribute('src') || '';
      if (/tradingview|charting_library|tv(\.|-|_)/i.test(src)) dom.tvScripts.push(src.slice(0, 200));
    }
    for (const iframe of document.querySelectorAll('iframe')) {
      dom.iframes.push({
        src: (iframe.src || '').slice(0, 150),
        id: iframe.id,
        className: String(iframe.className).slice(0, 120),
        rect: iframe.getBoundingClientRect().toJSON(),
      });
    }
    for (const canvas of document.querySelectorAll('canvas')) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 200 && rect.height > 200) {
        dom.canvases.push({
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          parentClass: String(canvas.parentElement?.className ?? '').slice(0, 120),
          grandClass: String(canvas.parentElement?.parentElement?.className ?? '').slice(0, 120),
        });
      }
    }
    // Would a canvas overlay be able to read the price axis from the DOM?
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    let count = 0;
    while ((node = walker.nextNode()) && count < 300) {
      const text = (node.nodeValue || '').trim();
      if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text) && node.parentElement?.offsetParent !== null) {
        dom.axisLikeTexts.push(text);
        count++;
      }
    }
    dom.bigCanvasCount = dom.canvases.length;
    return dom;
  });
  log(`[${label}] frames: ${out.frames.length} (same-origin: ${targets.length}), big canvases: ${out.chartDom.bigCanvasCount}, tv srcs: ${out.chartDom.tvScripts.length}, axis-like DOM texts: ${out.chartDom.axisLikeTexts.length}`);
  for (const frame of out.frames) log(`  - [${frame.origin}] ${frame.name ? `(${frame.name}) ` : ''}${frame.url}`);
  for (const canvas of out.chartDom.canvases.slice(0, 8)) log(`  canvas ${canvas.w}x${canvas.h} in .${canvas.parentClass} > .${canvas.grandClass}`);

  // If a widget is reachable, probe and exercise the drawing API inside
  // the frame that owns it (page.evaluate cannot see the iframe's window).
  const widget = out.widgetScan.find((entry) => entry.hasActiveChart) ?? out.widgetScan[0];
  if (widget) {
    const widgetFrame = page.frames().find((frame) => (frame.url() || 'page').slice(0, 120) === widget.frame) ?? page.mainFrame();
    out.apiProbe = await widgetFrame.evaluate(PROBE_WIDGET(widget.key));
    log(`[${label}] API surface (in-frame):`, JSON.stringify(out.apiProbe?.methods ?? {}));
    out.drawTest = await widgetFrame.evaluate(`
    (() => {
      const w = window[${JSON.stringify(widget.key)}];
      const chart = w.${out.apiProbe?.accessor ?? 'activeChart'}();
      const results = {};
      const range = chart.getVisibleRange ? chart.getVisibleRange() : null;
      const from = Number(range?.from ?? 0);
      const to = Number(range?.to ?? 0);
      const midTime = Math.floor((from + to) / 2);
      const series = chart.getAllSeries ? chart.getAllSeries()[0] : null;
      const price = series && typeof series.coordinateToPrice === 'function'
        ? series.coordinateToPrice(Math.round(window.innerHeight / 2))
        : 0;
      results.params = { midTime, price, range };
      try {
        const line = chart.createShape({ time: midTime, price }, {
          shape: 'horizontal_line',
          text: 'SWAL probe',
          overrides: { linecolor: '#121212', linewidth: 1, linestyle: 2, showLabel: true, textcolor: '#121212', fontsize: 10 },
        });
        results.horizontalLine = line;
        results.entitiesAfterLine = chart.getAllShapes ? chart.getAllShapes().length : null;
        results.removeHorizontal = typeof chart.removeEntity === 'function' ? chart.removeEntity(line) : 'no removeEntity';
        results.entitiesAfterRemove = chart.getAllShapes ? chart.getAllShapes().length : null;
      } catch (e) {
        results.horizontalLineError = String(e).slice(0, 300);
      }
      try {
        const trend = chart.createMultipointShape(
          [{ time: midTime, price: price * 1.002 }, { time: Math.max(from + 1, to - 1), price: price * 0.998 }],
          { shape: 'trend_line', overrides: { linecolor: '#121212', linewidth: 1, linestyle: 0 } },
        );
        results.trendLine = trend;
        try { results.removeTrend = chart.removeEntity(trend); } catch (e) { results.removeTrend = String(e).slice(0, 200); }
      } catch (e) {
        results.trendLineError = String(e).slice(0, 300);
      }
      return results;
    })()`);
    log(`[${label}] draw test (in-frame):`, JSON.stringify(out.drawTest));

    // What a MAIN-world content script in the page would do: reach the iframe
    // through contentWindow (same-origin) from the page's own world.
    out.crossWorldProbe = await page.evaluate(`
    (() => {
      const iframe = [...document.querySelectorAll('iframe')].find((el) =>
        (el.getAttribute('name') || '').startsWith('tradingview'));
      if (!iframe || !iframe.contentWindow) return { reachable: false, reason: 'iframe not found' };
      const api = iframe.contentWindow.tradingViewApi;
      if (!api) return { reachable: false, reason: 'no tradingViewApi on iframe window' };
      const chart = typeof api.activeChart === 'function' ? api.activeChart() : api.chart();
      const range = chart.getVisibleRange ? chart.getVisibleRange() : null;
      return {
        reachable: true,
        hasCreateShape: typeof chart.createShape === 'function',
        hasCreateMultipointShape: typeof chart.createMultipointShape === 'function',
        hasRemoveEntity: typeof chart.removeEntity === 'function',
        visibleRange: range,
      };
    })()`);
    log(`[${label}] cross-world probe from page world:`, JSON.stringify(out.crossWorldProbe));
  }
  return out;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({ viewport: VIEWPORT, userAgent: USER_AGENT, locale: 'en-US' });
  const page = await context.newPage();

  const report = { url, mode, investigatedAt: new Date().toISOString(), headless: true };
  page.on('pageerror', (err) => (report.pageErrors = [...(report.pageErrors ?? []), String(err).slice(0, 200)]));

  log(`\n== Loading ${url} (headless, ${VIEWPORT.width}x${VIEWPORT.height}) ==`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    report.loadError = String(err);
  }
  await page.waitForTimeout(9000);
  report.title = await page.title();
  log('title:', report.title);
  report.cookieBannerDismissed = await dismissCookieBanner(page);
  log('cookie banner dismissed via:', report.cookieBannerDismissed);
  await page.waitForTimeout(5000);

  const states = [];
  if (mode === 'original' || mode === 'both') {
    states.push(await snapshotState(page, 'original-tab'));
  }
  if (mode === 'tv' || mode === 'both') {
    report.tabSwitch = await switchToTradingViewTab(page);
    log('tab switch:', JSON.stringify(report.tabSwitch));
    states.push(await snapshotState(page, 'tradingview-tab'));
    await page.screenshot({ path: path.join(outDir, `binance-futures-${mode}.png`) });
  } else {
    await page.screenshot({ path: path.join(outDir, `binance-futures-${mode}.png`) });
  }
  report.states = states;
  const tvState = states.find((s) => s.label === 'tradingview-tab') ?? states[0];

  await browser.close();
  await writeFile(path.join(outDir, `investigation-${mode}.json`), JSON.stringify(report, null, 2));
  log(`\n== report: ${path.join(outDir, `investigation-${mode}.json`)} ==`);
}

main().catch((err) => {
  console.error('INVESTIGATION FAILED:', err);
  process.exit(1);
});
