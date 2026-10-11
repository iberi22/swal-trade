#!/usr/bin/env node
/**
 * Step 2b: read back what the API reports about the entities we create, so the
 * bridge can prove that its shapes are locked and styled as intended.
 *
 * Public page only. No login, no order forms, no account data.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'investigation');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    viewport: { width: 1680, height: 1000 },
    userAgent: USER_AGENT,
    locale: 'en-US',
  });
  const page = await context.newPage();
  await page.goto('https://www.binance.com/en/futures/BTCUSDT', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(9000);
  for (const sel of ['button:has-text("Accept")', 'button:has-text("Aceptar")']) {
    try {
      const button = page.locator(sel).first();
      if (await button.isVisible({ timeout: 600 })) {
        await button.click({ timeout: 1500 });
        break;
      }
    } catch {}
  }
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const matches = [...document.querySelectorAll('div,span,a,button,li')].filter(
      (el) =>
        el.childElementCount <= 2 &&
        /^\s*Trading\s*View\s*$/i.test(el.textContent ?? '') &&
        el.offsetParent !== null,
    );
    matches[matches.length - 1]?.click();
  });
  await page.waitForTimeout(7000);

  const report = await page.evaluate(async () => {
    const out = {};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const findApi = () => {
      for (const el of document.querySelectorAll('iframe')) {
        try {
          const win = el.contentWindow;
          if (win && win.tradingViewApi && typeof win.tradingViewApi.activeChart === 'function') {
            return win;
          }
        } catch {}
      }
      return null;
    };
    let win = findApi();
    for (let i = 0; i < 20 && !win; i++) {
      await sleep(500);
      win = findApi();
    }
    if (!win) return { error: 'api not reachable' };
    const chart = win.tradingViewApi.activeChart();
    let range = chart.getVisibleRange();
    for (let i = 0; i < 60 && (!range || !Number(range.from)); i++) {
      await sleep(500);
      try {
        range = chart.getVisibleRange();
      } catch {
        range = null;
      }
    }
    const from = Number(range.from);
    const to = Number(range.to);
    const span = to - from;
    const price = Number((document.title.split('|')[0] || '').replace(/,/g, ''));
    const t = (fraction) => Math.floor(from + span * fraction);

    const neutral = '#4a4a4a';
    const overrides = {
      linecolor: neutral,
      linewidth: 1,
      linestyle: 2,
      textcolor: neutral,
      fontsize: 11,
      showLabel: true,
      horzLabelsAlign: 'right',
      locked: true,
      disableSelection: true,
    };

    const lineId = await chart.createShape(
      { time: t(0.4), price },
      { shape: 'horizontal_line', text: 'confirma 83000', overrides },
    );
    const dashedId = await chart.createShape(
      { time: t(0.45), price: price * 0.99 },
      { shape: 'horizontal_line', text: 'invalida 82000', overrides: { ...overrides, linestyle: 0 } },
    );
    const textId = await chart.createShape(
      { time: t(0.5), price: price * 1.002 },
      { shape: 'text', text: 'cuello 83k', overrides: { ...overrides, fontsize: 11 } },
    );
    const arrowId = await chart.createShape(
      { time: t(0.55), price: price * 0.995 },
      { shape: 'arrow_down', text: 'venta agresiva', overrides: { ...overrides, showLabel: false } },
    );
    const zoneId = await chart.createMultipointShape(
      [
        { time: t(0.2), price: price * 1.005 },
        { time: t(0.6), price: price * 0.99 },
      ],
      {
        shape: 'rectangle',
        overrides: {
          linecolor: neutral,
          linewidth: 1,
          backgroundColor: neutral,
          backgroundFilled: true,
          transparency: 85,
          locked: true,
          disableSelection: true,
          showLabel: false,
        },
      },
    );
    const trendId = await chart.createMultipointShape(
      [
        { time: t(0.2), price: price * 1.002 },
        { time: t(0.8), price: price * 0.998 },
      ],
      {
        shape: 'trend_line',
        text: 'triangulo',
        overrides: { ...overrides, linestyle: 0, showLabel: false },
      },
    );
    await sleep(600);

    const readBack = async (id, label) => {
      const entry = { label, id };
      try {
        const shape = chart.getShapeById(id);
        entry.found = shape !== undefined && shape !== null;
        if (shape) {
          const props =
            typeof shape.properties === 'function'
              ? shape.properties()
              : (shape.properties ?? null);
          entry.name = shape.name;
          entry.keys = Object.keys(shape).slice(0, 20);
          entry.props = props
            ? JSON.parse(
                JSON.stringify(props, (key, value) =>
                  typeof value === 'function' ? '[fn]' : value,
                ),
              )
            : null;
        }
      } catch (error) {
        entry.error = String(error).slice(0, 160);
      }
      return entry;
    };

    out.readBack = [];
    for (const [id, label] of [
      [lineId, 'hline-solid'],
      [dashedId, 'hline-dashed'],
      [textId, 'text'],
      [arrowId, 'arrow'],
      [zoneId, 'zone'],
      [trendId, 'trend'],
    ]) {
      out.readBack.push(await readBack(id, label));
    }

    out.allShapes = chart
      .getAllShapes()
      .map((shape) => {
        let props = null;
        try {
          props = typeof shape.properties === 'function' ? shape.properties() : (shape.properties ?? null);
        } catch {}
        return {
          id: shape.id,
          name: shape.name,
          props: props
            ? JSON.parse(JSON.stringify(props, (k, v) => (typeof v === 'function' ? '[fn]' : v)))
            : null,
        };
      });

    // Does the label text survive as the entity text?
    out.texts = out.allShapes.map((shape) => ({
      name: shape.name,
      text: shape.props?.text ?? null,
      linestyle: shape.props?.linestyle ?? null,
      locked: shape.props?.locked ?? null,
      disableSelection: shape.props?.disableSelection ?? null,
    }));

    for (const id of [lineId, dashedId, textId, arrowId, zoneId, trendId]) {
      try {
        chart.removeEntity(id);
      } catch {}
    }
    await sleep(400);
    out.finalCount = chart.getAllShapes().length;
    return out;
  });

  await browser.close();
  await writeFile(path.join(outDir, 'tv-shape-props.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1));
  console.log(`\nreport: ${path.join(outDir, 'tv-shape-props.json')}`);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
