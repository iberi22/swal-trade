#!/usr/bin/env node
/**
 * Step 1 follow-up 4: tradingview.com/chart API reachability + canvas overlay
 * price->pixel feasibility. Public pages only.
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
  const report = {};
  page.on('pageerror', (err) => (report.pageErrors = [...(report.pageErrors ?? []), String(err).slice(0, 160)]));
  try {
    await page.goto('https://www.tradingview.com/chart/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    report.loadError = String(err);
  }
  await page.waitForTimeout(10000);
  report.title = await page.title();
  report.url = page.url();
  report.widgetKeys = await page.evaluate(() => {
    const names = ['tvWidget', 'widget', 'tradingViewApi', 'TradingViewApi', 'TradingView', 'tradingview', '_exposed_chartWidgetCollection'];
    const found = {};
    for (const name of names) {
      try {
        const v = window[name];
        if (v !== undefined) found[name] = typeof v === 'object' && v ? Object.keys(v).slice(0, 10) : typeof v;
      } catch (e) {
        found[name] = 'THROWS';
      }
    }
    return found;
  });
  report.scan = await page.evaluate(() => {
    const hits = [];
    for (const key of Object.getOwnPropertyNames(window)) {
      let value;
      try { value = window[key]; } catch { continue; }
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
      if (typeof value.activeChart !== 'function' && typeof value.chart !== 'function') continue;
      hits.push(key);
    }
    return hits;
  });
  report.frames = page.frames().map((f) => ({ name: f.name(), url: f.url().slice(0, 120) }));
  report.origin = await page.evaluate(() => location.origin);
  log('title:', report.title);
  log('widget keys:', JSON.stringify(report.widgetKeys));
  log('scan hits:', JSON.stringify(report.scan));
  log('origin:', report.origin);
  log('frames:', JSON.stringify(report.frames));
  await page.screenshot({ path: path.join(outDir, 'tradingview-chart.png') });
  await browser.close();
  await writeFile(path.join(outDir, 'tv-chart-page.json'), JSON.stringify(report, null, 2));
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1); });
