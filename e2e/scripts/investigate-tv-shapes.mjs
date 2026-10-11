#!/usr/bin/env node
/**
 * Step 2 investigation: what can we ACTUALLY draw with Binance's same-origin
 * TradingView iframe API, and with which overrides?
 *
 * Facts already verified in step 1 (commit da88477):
 * - the "Trading View" tab renders a same-origin iframe exposing
 *   window.tradingViewApi with activeChart();
 * - createShape/createMultipointShape resolve to string ids;
 * - removeEntity(id) is sync and cleans;
 * - creating before a visible range exists throws "Cannot create ... shape".
 *
 * This script pins down the rest: which shape names work for horizontal lines,
 * trend lines, rectangles, arrows and text, whether locked/disableSelection
 * overrides hold, and what getAllShapes() reports for each.
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

const NEUTRAL = '#4a4a4a';

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
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 200)));

  await page.goto('https://www.binance.com/en/futures/BTCUSDT', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(9000);
  // Only interaction allowed with the page: dismiss the cookie banner.
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

  const report = await page.evaluate(async (neutral) => {
    const out = { shapeResults: [], overridesResults: [], listenerProbe: {}, misc: {} };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const findApi = () => {
      for (const el of document.querySelectorAll('iframe')) {
        try {
          const win = el.contentWindow;
          if (win && win.tradingViewApi && typeof win.tradingViewApi.activeChart === 'function') {
            return win;
          }
        } catch {
          // cross-origin iframe (accounts.binance.com): skip
        }
      }
      return null;
    };

    let win = findApi();
    for (let i = 0; i < 20 && !win; i++) {
      await sleep(500);
      win = findApi();
    }
    if (!win) return { error: 'tradingViewApi not reachable from the page world' };

    // The iframe itself also exposes the api: record both paths for the bridge.
    let selfWorld = null;
    for (const el of document.querySelectorAll('iframe')) {
      try {
        if (el.contentWindow === win) {
          const inner = el.contentWindow.eval('typeof tradingViewApi');
          selfWorld = inner;
        }
      } catch {}
    }
    out.misc.iframeSelfApi = selfWorld;

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
    out.misc.range = { from, to };
    out.misc.symbol = (() => {
      try {
        return chart.symbol();
      } catch (error) {
        return 'ERR ' + error;
      }
    })();
    out.misc.resolution = (() => {
      try {
        return chart.resolution ? chart.resolution() : null;
      } catch (error) {
        return 'ERR ' + error;
      }
    })();
    out.listenerProbe = {};
    for (const name of [
      'onSymbolChanged',
      'onIntervalChanged',
      'onDataLoaded',
      'onVisibleRangeChanged',
      'onTick',
    ]) {
      out.listenerProbe[name] = typeof chart[name];
    }
    // Cross-world subscription test: does a listener set from the page world fire?
    const seen = [];
    try {
      chart.onIntervalChanged(() => seen.push('interval'));
      chart.onSymbolChanged(() => seen.push('symbol'));
      out.misc.subscribedFromPageWorld = true;
    } catch (error) {
      out.misc.subscribedFromPageWorld = 'ERR ' + error;
    }
    out.misc.seenBeforeChange = [...seen];

    const price = Number(
      (document.title.split('|')[0] || '').replace(/,/g, ''),
    );
    out.misc.price = price;

    const track = async (label, make) => {
      const before = chart.getAllShapes().length;
      const entry = { label, before };
      try {
        const id = await make();
        entry.id = typeof id === 'object' && id !== null ? 'object' : id;
        entry.idType = typeof id;
        await sleep(350);
        entry.afterCreate = chart.getAllShapes().length;
        entry.shapes = chart
          .getAllShapes()
          .map((shape) => {
            try {
              return { id: shape.id, name: shape.name, locked: shape.locked };
            } catch {
              return 'unreadable';
            }
          })
          .slice(-2);
      } catch (error) {
        entry.error = String(error).slice(0, 160);
      }
      out.shapeResults.push(entry);
      return entry;
    };

    const base = { linecolor: neutral, linewidth: 1, textcolor: neutral, fontsize: 11 };
    const t = (fraction) => Math.floor(from + span * fraction);

    // 1. single-point shapes
    for (const shape of [
      'horizontal_line',
      'horizontal_ray',
      'vertical_line',
      'text',
      'price_label',
      'arrow_up',
      'arrow_down',
      'icon',
      'emoji',
      'balloon',
      'comment',
    ]) {
      await track(`single:${shape}`, () =>
        chart.createShape(
          { time: t(0.5), price },
          { shape, text: 'prueba swal', overrides: { ...base } },
        ),
      );
    }

    // 2. multi-point shapes
    for (const shape of [
      'trend_line',
      'ray',
      'rectangle',
      'path',
      'polygon',
      'arrow',
      'arrow_line',
      'parallel_channel',
      'triangle',
    ]) {
      const points = [
        { time: t(0.2), price: price * 1.002 },
        { time: t(0.4), price: price * 0.998 },
        { time: t(0.6), price: price * 1.001 },
      ];
      await track(`multi:${shape}`, () =>
        chart.createMultipointShape(points, { shape, text: 'prueba swal', overrides: { ...base } }),
      );
    }

    // 3. arrow with a single point (direction from overrides)
    await track('multi:arrow_line-1pt', () =>
      chart.createMultipointShape([{ time: t(0.5), price }], {
        shape: 'arrow_line',
        overrides: { ...base },
      }),
    );

    // 4. lock / selection overrides on a fresh line
    await track('locked:horizontal_line', () =>
      chart.createShape(
        { time: t(0.5), price },
        {
          shape: 'horizontal_line',
          text: 'bloqueada',
          overrides: {
            ...base,
            locked: true,
            disableSelection: true,
            showLabel: true,
            horzLabelsAlign: 'right',
            linewidth: 1,
            linestyle: 2,
          },
        },
      ),
    );
    await track('locked:rectangle', () =>
      chart.createMultipointShape(
        [
          { time: t(0.3), price: price * 1.001 },
          { time: t(0.7), price: price * 0.999 },
        ],
        { shape: 'rectangle', overrides: { ...base, locked: true, disableSelection: true, backgroundColor: neutral, backgroundFilled: true, transparency: 75 } },
      ),
    );

    // 5. what does removeEntity accept and what does getAllShapes expose?
    const created = chart.getAllShapes();
    out.misc.countBeforeCleanup = created.length;
    const removableIds = [];
    for (const shape of created) {
      let id = null;
      try {
        id = shape.id;
        if (typeof id !== 'string') {
          id = await new Promise((resolve) => {
            const value = Promise.resolve(id).then((x) => resolve(typeof x === 'string' ? x : null));
            if (value && typeof value.then === 'function') value.then(resolve);
          });
        }
      } catch {}
      if (typeof id === 'string') removableIds.push(id);
    }
    out.misc.removableIds = removableIds.slice(0, 5);
    out.misc.removableIdCount = removableIds.length;
    for (const id of removableIds) {
      try {
        chart.removeEntity(id);
      } catch (error) {
        out.misc.removeError = String(error).slice(0, 160);
        break;
      }
    }
    await sleep(400);
    out.misc.countAfterCleanup = chart.getAllShapes().length;

    // 6. symbol/interval change behaviour: do entities survive? do listeners fire?
    out.misc.shapesSurviveSymbolChange = null;
    try {
      const lineId = await chart.createShape(
        { time: t(0.5), price },
        { shape: 'horizontal_line', text: 'supervivencia', overrides: { ...base, locked: true } },
      );
      await sleep(400);
      const beforeSwitch = chart.getAllShapes().length;
      chart.setResolution('1h');
      await sleep(1200);
      const afterSwitch = chart.getAllShapes().length;
      const stillThere = chart
        .getAllShapes()
        .some((shape) => String(shape.id) === String(lineId) || shape.id === lineId);
      out.misc.shapesSurviveSymbolChange = {
        beforeSwitch,
        afterSwitch,
        stillThere,
        seen,
      };
      chart.removeEntity(lineId);
    } catch (error) {
      out.misc.shapesSurviveSymbolChange = 'ERR ' + String(error).slice(0, 160);
    }

    await sleep(300);
    try {
      out.misc.finalCount = chart.getAllShapes().length;
    } catch (error) {
      out.misc.finalCount = 'ERR ' + error;
    }
    return out;
  }, NEUTRAL);

  report.title = await page.title();
  report.pageErrors = pageErrors;
  await browser.close();
  await writeFile(path.join(outDir, 'tv-shapes.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1));
  console.log(`\nreport: ${path.join(outDir, 'tv-shapes.json')}`);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
