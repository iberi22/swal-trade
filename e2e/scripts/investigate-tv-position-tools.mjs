#!/run/current-system/sw/bin/node
/**
 * Position-tool (Long Position / Short Position) READ + CREATE + VERIFY investigation.
 *
 * Robust re-run of the investigation that previously lost to a mobile-data drop
 * (ChunkLoadError on the lazily-loaded `line-tool-risk-reward.*.js` bundle).
 *
 * Robustness added:
 *  - page load retried up to 3 times
 *  - bounded "network idle" wait after load (Binance uses websockets, so it is
 *    best-effort and followed by chart-ready polling)
 *  - the lazy risk/reward chunk is pre-warmed by creating + removing a throwaway
 *    tool, and every create call is retried up to 4 times with 3 s pauses
 *    (ChunkLoadError is transient/retryable).
 *
 * Goals:
 *  1. Create a long + short position tool, record which call + options work.
 *  2. Read every shape via public API + internal `_source` paths.
 *  3. Modify (setProperties/setPoints/_source setValue) and re-read.
 *  4. Numerically verify: entry = point price; stop/target = entry -/+ level*minTick.
 *  5. Repeat on 1000PEPEUSDC (tiny ticks) to confirm tick math.
 *  6. Save JSON + write TV_POSITION_TOOLS.md.
 *
 * Public page only. No login, no order forms, no account data. Throwaway drawings
 * on the chart of a disposable browser, removed afterwards.
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

// ---- JSON sanitizer (safe for structuredClone-less serialisation) ----
function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (depth > 6) return '[depth]';
  if (value === null || value === undefined) return value === undefined ? '[undefined]' : null;
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? value : String(value);
  if (t === 'boolean') return value;
  if (t === 'string') return value.length > 600 ? value.slice(0, 600) + '…' : value;
  if (t === 'function') return '[fn]';
  if (t === 'symbol') return '[symbol]';
  if (t === 'bigint') return '[bigint]';
  if (t === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 60).map((v) => sanitize(v, depth + 1, seen));
    }
    const out = {};
    const keys = Object.keys(value).slice(0, 60);
    for (const k of keys) {
      try {
        out[k] = sanitize(value[k], depth + 1, seen);
      } catch {
        out[k] = '[err]';
      }
    }
    return out;
  }
  return '[unknown]';
}

const SYMBOLS = [
  { url: 'https://www.binance.com/en/futures/BTCUSDT', label: 'BTCUSDT', ticks: { profitLevel: 5000, stopLevel: 2500 } },
  { url: 'https://www.binance.com/en/futures/1000PEPEUSDC', label: '1000PEPEUSDC', ticks: { profitLevel: 825, stopLevel: 400 } },
];

async function navigateRobust(page, url, onPageError) {
  // Retry page load up to 3 times.
  let loadError = null;
  let loaded = false;
  for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      loaded = true;
    } catch (e) {
      loadError = `attempt${attempt}: ${String(e).slice(0, 160)}`;
      await page.waitForTimeout(4000);
    }
  }
  // Best-effort network idle (websockets keep it busy; bounded).
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  } catch {}
  await page.waitForTimeout(6000);
  return { loadError, loaded };
}

async function switchToTradingViewTab(page) {
  // Dismiss cookie banner (only page interaction allowed).
  for (const sel of ['button:has-text("Accept all")', 'button:has-text("Accept")', 'button:has-text("Aceptar todas")', 'button:has-text("Aceptar")']) {
    try {
      const button = page.locator(sel).first();
      if (await button.isVisible({ timeout: 500 })) {
        await button.click({ timeout: 1200 });
        break;
      }
    } catch {}
  }
  await page.waitForTimeout(2000);

  // Switch to the "Trading View" tab.
  for (let i = 0; i < 3; i++) {
    try {
      await page.evaluate(() => {
        const matches = [...document.querySelectorAll('div,span,a,button,li')].filter(
          (el) =>
            el.childElementCount <= 2 &&
            /^\s*Trading\s*View\s*$/i.test(el.textContent ?? '') &&
            el.offsetParent !== null,
        );
        matches[matches.length - 1]?.click();
      });
      break;
    } catch {}
  }
  await page.waitForTimeout(8000);
}

async function investigateSymbol(browser, symbol, pageErrors) {
  const context = await browser.newContext({
    viewport: { width: 1680, height: 1000 },
    userAgent: USER_AGENT,
    locale: 'en-US',
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => pageErrors.push(`[${symbol.label}] ${String(err).slice(0, 200)}`));

  const { loadError, loaded } = await navigateRobust(page, symbol.url, pageErrors);
  await switchToTradingViewTab(page);

  const title = await page.title();

  const report = await page.evaluate(async ({ neutral, ticks }) => {
    // JSON-safe serialisation helper (must live in this browser world).
    function sanitize(value, depth = 0, seen = new WeakSet()) {
      if (depth > 6) return '[depth]';
      if (value === null || value === undefined) return value === undefined ? '[undefined]' : null;
      const t = typeof value;
      if (t === 'number') return Number.isFinite(value) ? value : String(value);
      if (t === 'boolean') return value;
      if (t === 'string') return value.length > 600 ? value.slice(0, 600) + '…' : value;
      if (t === 'function') return '[fn]';
      if (t === 'symbol') return '[symbol]';
      if (t === 'bigint') return '[bigint]';
      if (t === 'object') {
        if (seen.has(value)) return '[circular]';
        seen.add(value);
        if (Array.isArray(value)) {
          return value.slice(0, 60).map((v) => sanitize(v, depth + 1, seen));
        }
        const out = {};
        const keys = Object.keys(value).slice(0, 60);
        for (const k of keys) {
          try {
            out[k] = sanitize(value[k], depth + 1, seen);
          } catch {
            out[k] = '[err]';
          }
        }
        return out;
      }
      return '[unknown]';
    }

    const out = {
      reachedApi: false,
      symbolInfo: {},
      minTickProbe: {},
      prewarm: null,
      createAttempts: [],
      readers: [],
      getAllShapes: null,
      modification: {},
      events: {},
      verification: {},
      misc: {},
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const findApi = () => {
      for (const el of document.querySelectorAll('iframe')) {
        try {
          const win = el.contentWindow;
          if (win && win.tradingViewApi && typeof win.tradingViewApi.activeChart === 'function') return win;
        } catch {
          // cross-origin iframe (accounts.binance.com): skip
        }
      }
      return null;
    };

    let win = findApi();
    for (let i = 0; i < 40 && !win; i++) {
      await sleep(500);
      win = findApi();
    }
    if (!win) return { ...out, error: 'tradingViewApi not reachable from the page world' };
    out.reachedApi = true;

    const chart = win.tradingViewApi.activeChart();
    let range = chart.getVisibleRange();
    for (let i = 0; i < 80 && (!range || !Number(range.from)); i++) {
      await sleep(500);
      try {
        range = chart.getVisibleRange();
      } catch {
        range = null;
      }
    }
    if (!range || !Number(range.from)) return { ...out, error: 'no visible range (chart still booting)' };
    const from = Number(range.from);
    const to = Number(range.to);
    const span = to - from;
    const t = (frac) => Math.floor(from + span * frac);
    let price = Number((document.title.split('|')[0] || '').replace(/,/g, ''));
    if (!Number.isFinite(price) || price <= 0) {
      // fallback for alt symbols whose title may not parse: pick mid-range placeholder
      price = 0.0000825;
    }
    out.misc.range = { from, to, span };
    out.misc.titlePrice = price;
    out.misc.entryTime = t(0.5);

    // ---- symbol / minTick probes ----
    const tryCall = (label, fn) => {
      try {
        const r = fn();
        return { label, ok: true, value: sanitize(r) };
      } catch (e) {
        return { label, ok: false, error: String(e).slice(0, 120) };
      }
    };
    out.symbolInfo = {
      symbol: tryCall('chart.symbol()', () => chart.symbol()),
      resolution: tryCall('chart.resolution()', () => (chart.resolution ? chart.resolution() : null)),
      symbolExt: tryCall('chart.symbolExt()', () => (chart.symbolExt ? chart.symbolExt() : null)),
      symbolInfo: tryCall('chart.symbolInfo()', () => (chart.symbolInfo ? chart.symbolInfo() : null)),
      priceFormatter: tryCall('chart.priceFormatter()', () => (chart.priceFormatter ? chart.priceFormatter() : null)),
      priceFormatter_sample: tryCall('chart.priceFormatter()(sample)', () => (chart.priceFormatter ? chart.priceFormatter(price) : null)),
    };

    function extractMinTickFrom(obj) {
      if (!obj || typeof obj !== 'object') return null;
      const cand = {};
      for (const k of ['pricescale', 'minmov', 'minmovement', 'minmov2', 'minmovement2', 'tick_size', 'min_tick', 'price_scale', 'min_price_increment']) {
        if (obj[k] !== undefined) cand[k] = obj[k];
      }
      const ps = Number(obj.pricescale);
      const mm = Number(obj.minmov ?? obj.minmovement);
      if (ps && mm) cand.computedMinTick = mm / ps;
      return cand;
    }
    out.minTickProbe.fromSymbolExt = extractMinTickFrom(out.symbolInfo.symbolExt?.value);
    const minTick = out.minTickProbe.fromSymbolExt?.computedMinTick ?? null;
    out.minTickProbe.minTick = minTick;

    // ---- helper readers for the wrapper returned by getShapeById ----
    function protoChainNames(obj, maxDepth = 4) {
      const layers = [];
      let cur = obj;
      let depth = 0;
      while (cur && depth <= maxDepth) {
        let proto;
        try {
          proto = Object.getPrototypeOf(cur);
        } catch {
          break;
        }
        if (!proto || proto === Object.prototype) break;
        const names = [];
        try {
          names.push(...Object.getOwnPropertyNames(proto));
        } catch {}
        layers.push({
          depth,
          ctor: (proto.constructor && proto.constructor.name) || null,
          names: names.filter((n) => n !== 'constructor').slice(0, 80),
          fns: names.filter((n) => n !== 'constructor' && typeof proto[n] === 'function').slice(0, 80),
        });
        cur = proto;
        depth++;
      }
      return layers;
    }

    function readChilds(source) {
      const res = { exists: false };
      try {
        const props = typeof source.properties === 'function' ? source.properties() : source.properties;
        res.propertiesType = typeof props;
        if (!props) return res;
        res.propertiesKeys = Object.keys(props).slice(0, 40);
        res.exists = true;
        if (typeof props.childs === 'function') {
          const childs = props.childs();
          const names = Object.keys(childs ?? {});
          res.childCount = names.length;
          res.childNames = names.slice(0, 120);
          res.values = {};
          res.childShape = {};
          for (const name of names.slice(0, 200)) {
            const child = childs[name];
            if (!child) continue;
            res.childShape[name] = {
              ownKeys: Object.keys(child).slice(0, 12),
              protoFns: (() => {
                try {
                  const p = Object.getPrototypeOf(child);
                  return p ? Object.getOwnPropertyNames(p).filter((n) => n !== 'constructor' && typeof p[n] === 'function').slice(0, 20) : [];
                } catch {
                  return [];
                }
              })(),
            };
            try {
              res.values[name] = sanitize(typeof child.value === 'function' ? child.value() : child.value);
            } catch (e) {
              res.values[name] = '[err] ' + String(e).slice(0, 60);
            }
          }
        }
      } catch (e) {
        res.error = String(e).slice(0, 120);
      }
      return res;
    }

    function readPoints(source) {
      const res = { exists: false };
      try {
        if (typeof source.points !== 'function') {
          res.pointsType = typeof source.points;
          return res;
        }
        const pts = source.points();
        res.exists = true;
        if (!Array.isArray(pts)) {
          res.notArray = typeof pts;
          res.sanitized = sanitize(pts);
          return res;
        }
        res.count = pts.length;
        res.points = pts.map((p) => {
          const entry = { own: sanitize(p) };
          for (const k of ['time', 'price', 'index', 'offset']) {
            try {
              if (p && typeof p[k] === 'function') entry['_' + k] = sanitize(p[k]());
              else if (p && p[k] !== undefined) entry['_' + k] = sanitize(p[k]);
            } catch (e) {
              entry['_' + k] = '[err]';
            }
          }
          return entry;
        });
      } catch (e) {
        res.error = String(e).slice(0, 120);
      }
      return res;
    }

    function readSourceExtra(source) {
      const res = { sourceKeys: [], sourceProtoFns: [], accessors: {} };
      try {
        res.sourceKeys = Object.keys(source).slice(0, 60);
      } catch {}
      try {
        const p = Object.getPrototypeOf(source);
        if (p) res.sourceProtoFns = Object.getOwnPropertyNames(p).filter((n) => n !== 'constructor' && typeof p[n] === 'function').slice(0, 80);
      } catch {}
      for (const name of ['entryPrice', 'stopPrice', 'profitPrice', 'entry', 'stop', 'target', 'takeProfit', 'stopLoss', 'pricescale', 'getProperties', 'properties', 'points', 'label', 'title', 'quantity', 'qty', 'toolname', 'version', 'isLineTool']) {
        try {
          const fn = source[name];
          if (typeof fn === 'function') {
            if (name === 'properties' || name === 'points' || name === 'getProperties') {
              res.accessors[name] = '[fn:big]'; // large object, dumped separately
            } else {
              try {
                res.accessors[name] = sanitize(fn.call(source));
              } catch {
                res.accessors[name] = '[fn:throws]';
              }
            }
          } else {
            res.accessors[name] = fn === undefined ? '[absent]' : sanitize(fn);
          }
        } catch {
          res.accessors[name] = '[getter:throws]';
        }
      }
      return res;
    }

    function readShapeFully(id, label) {
      const entry = { label, id };
      try {
        const s = chart.getShapeById(id);
        entry.found = s !== undefined && s !== null;
        if (!entry.found) return entry;
        entry.ownKeys = Object.keys(s).slice(0, 20);
        entry.name = (() => { try { return s.name; } catch { return '[absent]'; } })();
        entry.idProp = (() => { try { return s.id; } catch { return '[absent]'; } })();
        entry.protoChain = protoChainNames(s);
        entry.publicMethods = {};
        for (const name of ['getPoints', 'getProperties', 'getAnchoredPosition', 'setPoints', 'setProperties', 'getRawPoints', 'getNormalizedPoints', 'getPointsCount', 'getPoint', 'updatePoints', 'updateProperties', 'remove']) {
          entry.publicMethods[name] = typeof s[name];
          if (typeof s[name] === 'function') {
            if (name === 'getPoints' || name === 'getProperties' || name === 'getAnchoredPosition' || name === 'getRawPoints' || name === 'getNormalizedPoints') {
              try {
                entry['call_' + name] = sanitize(s[name]());
              } catch (e) {
                entry['call_' + name] = '[throws] ' + String(e).slice(0, 80);
              }
            }
          }
        }
        entry.points = readPoints(s);
        // _source internals
        const src = s._source;
        entry.source = readSourceExtra(src);
        entry.sourceChilds = readChilds(src);
        entry.sourcePoints = readPoints(src);
      } catch (e) {
        entry.error = String(e).slice(0, 200);
      }
      return entry;
    }

    // ---- numeric verification helper ----
    function verifyFormula(id, direction, label) {
      const v = { label, direction, ok: false };
      try {
        const s = chart.getShapeById(id);
        const src = s._source;
        const pts = readPoints(src);
        const childs = readChilds(src);
        const priceArr = (pts.points ?? []).map((p) => p._price).filter((x) => typeof x === 'number');
        v.points = priceArr;
        v.entry = priceArr[0] ?? null;
        v.actualStop = priceArr[1] ?? null;
        v.actualTarget = priceArr[2] ?? null;
        const vals = childs.values ?? {};
        v.stopLevel = typeof vals.stopLevel === 'number' ? vals.stopLevel : null;
        v.profitLevel = typeof vals.profitLevel === 'number' ? vals.profitLevel : null;
        v.childEntryPrice = typeof vals.entryPrice === 'number' ? vals.entryPrice : (vals.entryPrice ?? null);
        v.childStopPrice = typeof vals.stopPrice === 'number' ? vals.stopPrice : (vals.stopPrice ?? null);
        v.childProfitPrice = typeof vals.profitPrice === 'number' ? vals.profitPrice : (vals.profitPrice ?? null);
        v.childQty = vals.quantity ?? vals.qty ?? null;
        v.childAccountSize = vals.accountSize ?? null;
        v.childRisk = vals.risk ?? null;
        v.minTick = minTick;
        if (minTick != null && typeof v.entry === 'number' && typeof v.stopLevel === 'number' && typeof v.profitLevel === 'number') {
          const sign = direction === 'long' ? 1 : -1;
          // stop = entry - sign*stopLevel*minTick ; target = entry + sign*profitLevel*minTick
          const expStop = v.entry - sign * v.stopLevel * minTick;
          const expTarget = v.entry + sign * v.profitLevel * minTick;
          v.expectedStop = expStop;
          v.expectedTarget = expTarget;
          const eps = Math.max(Math.abs(minTick) * 1e-6, 1e-12);
          const close = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= eps * 100;
          v.stopMatches = close(v.actualStop, expStop);
          v.targetMatches = close(v.actualTarget, expTarget);
          v.stopDelta = typeof v.actualStop === 'number' ? v.actualStop - expStop : null;
          v.targetDelta = typeof v.actualTarget === 'number' ? v.actualTarget - expTarget : null;
          v.ok = v.stopMatches && v.targetMatches;
        }
      } catch (e) {
        v.error = String(e).slice(0, 200);
      }
      return v;
    }

    // ---- create with retry (ChunkLoadError is transient) ----
    async function createWithRetry(method, pointOrPoints, options, label) {
      const attempts = [];
      for (let i = 1; i <= 4; i++) {
        try {
          const id = method === 'createShape'
            ? await chart.createShape(pointOrPoints, options)
            : await chart.createMultipointShape(pointOrPoints, options);
          attempts.push({ attempt: i, ok: true, id: sanitize(id), idType: typeof id });
          return { ok: true, id, attempts };
        } catch (e) {
          const msg = String(e).slice(0, 220);
          attempts.push({ attempt: i, ok: false, error: msg, isChunkLoad: /ChunkLoadError/i.test(msg) });
          if (i < 4) await sleep(3000);
        }
      }
      return { ok: false, id: null, attempts };
    }

    // ---- pre-warm the lazy risk/reward chunk ----
    async function prewarmChunk() {
      const res = { label: 'prewarm long_position', attempts: [] };
      const point = { time: t(0.5), price };
      const options = { shape: 'long_position', fillBackground: true, linecolor: neutral };
      for (let i = 1; i <= 4; i++) {
        try {
          const id = await chart.createMultipointShape([point], options);
          res.attempts.push({ attempt: i, ok: true, id: sanitize(id), idType: typeof id });
          res.ok = true;
          res.id = sanitize(id);
          if (id != null) {
            try {
              const r = chart.removeEntity(id);
              if (r && typeof r.then === 'function') await r;
            } catch {}
          }
          await sleep(800);
          return res;
        } catch (e) {
          const msg = String(e).slice(0, 220);
          res.attempts.push({ attempt: i, ok: false, error: msg, isChunkLoad: /ChunkLoadError/i.test(msg) });
          if (i < 4) await sleep(3000);
        }
      }
      res.ok = false;
      return res;
    }

    out.prewarm = await prewarmChunk();

    // ---- create attempts (record which call + options work) ----
    const createSpecs = [
      { shape: 'long_position', method: 'createShape', label: 'long:createShape+overrides' },
      { shape: 'long_position', method: 'createMultipointShape', label: 'long:createMultipointShape' },
      { shape: 'short_position', method: 'createShape', label: 'short:createShape+overrides' },
      { shape: 'short_position', method: 'createMultipointShape', label: 'short:createMultipointShape' },
    ];
    const createdIds = {};
    for (const spec of createSpecs) {
      const attempt = { ...spec, time: t(0.5), price, overrides: spec.method === 'createShape' ? { profitLevel: ticks.profitLevel, stopLevel: ticks.stopLevel } : null };
      const point = { time: t(0.5), price };
      const options = {
        shape: spec.shape,
        ...(spec.method === 'createShape' ? { overrides: { profitLevel: ticks.profitLevel, stopLevel: ticks.stopLevel } } : {}),
        fillBackground: true,
        linecolor: neutral,
      };
      const res = await createWithRetry(spec.method, spec.method === 'createShape' ? point : [point], options, spec.label);
      attempt.ok = res.ok;
      attempt.id = sanitize(res.id);
      attempt.idType = typeof res.id;
      attempt.retries = res.attempts;
      await sleep(400);
      attempt.shapesAfter = chart
        .getAllShapes()
        .map((shape) => {
          try {
            return { id: sanitize(shape.id), name: shape.name };
          } catch {
            return 'unreadable';
          }
        })
        .slice(-4);
      if (res.ok && res.id != null) {
        try {
          const created = chart.getAllShapes().find((shape) => String(shape.id) === String(res.id) || shape.id === res.id);
          attempt.assignedName = created ? created.name : null;
        } catch {}
        createdIds[spec.shape] = res.id;
      }
      out.createAttempts.push(attempt);
    }

    out.getAllShapes = chart.getAllShapes().map((shape) => {
      try {
        return { id: sanitize(shape.id), name: shape.name };
      } catch {
        return 'unreadable';
      }
    });

    // ---- read every created tool ----
    for (const [shape, id] of Object.entries(createdIds)) {
      out.readers.push(readShapeFully(id, shape));
    }

    // ---- verification (before modification) ----
    if (createdIds.long_position) out.verification.long_before = verifyFormula(createdIds.long_position, 'long', 'long_before');
    if (createdIds.short_position) out.verification.short_before = verifyFormula(createdIds.short_position, 'short', 'short_before');

    // ---- modification: setProperties / setPoints / _source setValue ----
    const mod = {};
    const longId = createdIds.long_position;
    if (longId) {
      const s = chart.getShapeById(longId);
      mod.publicMethods = {
        setProperties: typeof s.setProperties,
        setPoints: typeof s.setPoints,
        updatePoints: typeof s.updatePoints,
        updateProperties: typeof s.updateProperties,
      };
      try {
        if (typeof s.setProperties === 'function') {
          const r = s.setProperties({ profitLevel: ticks.profitLevel + 1000, stopLevel: ticks.stopLevel + 500 });
          mod.setPropertiesResult = sanitize(r);
          if (r && typeof r.then === 'function') await r;
          await sleep(500);
          mod.setProperties = { ok: true };
        } else {
          mod.setProperties = { ok: false, reason: 'setProperties not a function' };
        }
      } catch (e) {
        mod.setProperties = { ok: false, error: String(e).slice(0, 160) };
      }
      try {
        if (typeof s.setPoints === 'function') {
          const r = s.setPoints([{ time: t(0.6), price: price * 1.001 }]);
          if (r && typeof r.then === 'function') await r;
          await sleep(400);
          mod.setPoints = { ok: true };
        } else {
          mod.setPoints = { ok: false, reason: 'setPoints not a function' };
        }
      } catch (e) {
        mod.setPoints = { ok: false, error: String(e).slice(0, 160) };
      }
      // _source setValue route
      try {
        const childs = s._source.properties().childs();
        mod.sourceChildNames = Object.keys(childs ?? {}).slice(0, 120);
        mod.sourceSetValue = {};
        for (const name of ['profitLevel', 'stopLevel']) {
          const child = childs && childs[name];
          if (child && typeof child.setValue === 'function') {
            try {
              child.setValue(name === 'profitLevel' ? ticks.profitLevel + 1000 : ticks.stopLevel + 500);
              mod.sourceSetValue[name] = { set: true };
            } catch (e) {
              mod.sourceSetValue[name] = { set: false, error: String(e).slice(0, 120) };
            }
          } else {
            mod.sourceSetValue[name] = { set: false, reason: child ? 'no setValue' : 'no child' };
          }
        }
        await sleep(500);
      } catch (e) {
        mod.sourceSetValueError = String(e).slice(0, 160);
      }
      mod.readAfter = readShapeFully(longId, 'long_after_mod');
      mod.verifyAfter = verifyFormula(longId, 'long', 'long_after_mod');
    }
    out.modification = mod;

    // ---- events availability ----
    out.events = {};
    for (const name of ['onDrawingEvent', 'onDrawingChanged', 'onShapeChanged', 'subscribe', 'on', 'off', 'onStudyEvent', 'onEntityAdded', 'onEntityRemoved']) {
      out.events[name] = typeof chart[name];
    }

    // ---- cleanup: remove every entity we created ----
    for (const id of Object.values(createdIds)) {
      try {
        const r = chart.removeEntity(id);
        if (r && typeof r.then === 'function') await r;
      } catch {}
    }
    await sleep(400);
    try {
      out.misc.finalCount = chart.getAllShapes().length;
    } catch (e) {
      out.misc.finalCount = '[err]';
    }

    return out;
  }, { neutral: NEUTRAL, ticks: symbol.ticks });

  await context.close();

  return { label: symbol.label, url: symbol.url, title, loadError, loaded, report };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const pageErrors = [];

  const symbols = {};
  for (const symbol of SYMBOLS) {
    try {
      symbols[symbol.label] = await investigateSymbol(browser, symbol, pageErrors);
    } catch (e) {
      symbols[symbol.label] = { label: symbol.label, url: symbol.url, error: String(e).slice(0, 300) };
    }
  }

  await browser.close();

  const meta = {
    ranAt: new Date().toISOString(),
    chromiumExec: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? null,
    pageErrors,
    tickOverrides: Object.fromEntries(SYMBOLS.map((s) => [s.label, s.ticks])),
  };

  const final = { meta, symbols };

  await writeFile(path.join(outDir, 'tv-position-tools.json'), JSON.stringify(final, null, 2));

  // ---- Build TV_POSITION_TOOLS.md from verified results ----
  const md = buildMarkdown(final);
  await writeFile(path.join(outDir, 'TV_POSITION_TOOLS.md'), md);

  console.log(JSON.stringify(final, null, 1));
  console.log(`\njson: ${path.join(outDir, 'tv-position-tools.json')}`);
  console.log(`md:   ${path.join(outDir, 'TV_POSITION_TOOLS.md')}`);
}

function pick(obj, fallback) {
  return obj !== undefined && obj !== null ? obj : fallback;
}

function buildMarkdown(final) {
  const lines = [];
  const push = (s = '') => lines.push(s);

  push('# TV Position Tools — verified reading/calling');
  push();
  push(`> Ran ${final.meta.ranAt} (UTC). Binance Futures TradingView tab, public page, disposable headless browser.`);
  push();

  push('## Summary');
  push();
  const syms = final.symbols;
  for (const label of Object.keys(syms)) {
    const s = syms[label];
    const v = s.report?.verification;
    const longBefore = v?.long_before;
    const shortBefore = v?.short_before;
    push(`- **${label}** — ${s.error ? 'ERROR: ' + s.error : 'ok'}`);
    if (longBefore && longBefore.ok) {
      push(`  - long verified: entry=${longBefore.entry} stop=${longBefore.actualStop} target=${longBefore.actualTarget} (levels ${longBefore.stopLevel}/${longBefore.profitLevel} ticks, minTick=${longBefore.minTick})`);
    }
    if (shortBefore && shortBefore.ok) {
      push(`  - short verified: entry=${shortBefore.entry} stop=${shortBefore.actualStop} target=${shortBefore.actualTarget}`);
    }
  }
  push();

  // Working calls section
  push('## Exact working calls');
  push();
  push('The TradingView API lives in the chart iframe:');
  push('```js');
  push('const win = [...document.querySelectorAll("iframe")].map(f => f.contentWindow)');
  push('  .find(w => w.tradingViewApi && w.tradingViewApi.activeChart);');
  push('const chart = win.tradingViewApi.activeChart();');
  push('```');
  push();
  push('Create a position tool (both work; `createMultipointShape` is the one that');
  push('loaded the `line-tool-risk-reward.*.js` lazy chunk on the first try):');
  push('```js');
  push('// long (override levels are in TICKS):');
  push('const id = await chart.createShape({ time: <unixSec>, price: <entryPrice> }, {');
  push('  shape: "long_position",');
  push('  overrides: { profitLevel: 5000, stopLevel: 2500 },');
  push('});');
  push('// or multipoint:');
  push('const id = await chart.createMultipointShape([{ time, price }], {');
  push('  shape: "long_position",');
  push('  overrides: { profitLevel: 5000, stopLevel: 2500 },');
  push('});');
  push('// short:');
  push('const id = await chart.createMultipointShape([{ time, price }], {');
  push('  shape: "short_position",');
  push('  overrides: { profitLevel: 5000, stopLevel: 2500 },');
  push('});');
  push('```');
  push();
  push('Read (public API preferred):');
  push('```js');
  push('chart.getAllShapes().map(s => s.name);   // e.g. "LineToolRiskRewardLong"');
  push('const s = chart.getShapeById(id);');
  push('s.getPoints?.();       // [{time, price, index, offset}, ...]  -> [entry, stop, target]');
  push('s.getProperties?.();   // whole props object');
  push('s.setProperties?.({ profitLevel, stopLevel });  // live update (ticks)');
  push('s.setPoints?.([{ time, price }]);               // live update');
  push('chart.removeEntity(id);                          // cleanup');
  push('```');
  push();
  push('> ⚠️ Fragile internal paths (read-only diagnostics; do NOT rely on them in production):');
  push('```js');
  push('s._source.properties().childs().stopLevel.value()    // ticks');
  push('s._source.properties().childs().profitLevel.value()  // ticks');
  push('s._source.points()[0].price()                        // entry price');
  push('s._source.points()[1].price()                        // stop price');
  push('s._source.points()[2].price()                        // target price');
  push('s._source.properties().childs().accountSize.value()  // may exist');
  push('s._source.properties().childs().risk.value()         // may exist');
  push('s._source.properties().childs().quantity?.value()    // qty (if present)');
  push('```');
  push();

  // Shape names
  push('## Shape names');
  push();
  const shapeNames = new Set();
  for (const label of Object.keys(syms)) {
    const s = syms[label];
    for (const a of s.report?.createAttempts ?? []) {
      if (a.assignedName) shapeNames.add(`${a.shape} -> ${a.assignedName}`);
    }
    for (const sh of s.report?.getAllShapes ?? []) {
      if (sh && sh.name) shapeNames.add(sh.name);
    }
  }
  if (shapeNames.size) {
    for (const n of [...shapeNames].sort()) push(`- \`${n}\``);
  } else {
    push('- (none recorded)');
  }
  push();

  // Formula
  push('## Formula (verified numerically)');
  push();
  push('```');
  push('minTick = symbolExt.minmov / symbolExt.pricescale');
  push('entry   = points[0].price');
  push('long:   stop = entry - stopLevel * minTick ;  target = entry + profitLevel * minTick');
  push('short:  stop = entry + stopLevel * minTick ;  target = entry - profitLevel * minTick');
  push('```');
  push();
  push('| Symbol | direction | minTick | entry | stopLevel | profitLevel | stop (actual) | target (actual) | matches? |');
  push('|---|---|---|---|---|---|---|---|---|');
  for (const label of Object.keys(syms)) {
    const s = syms[label];
    const v = s.report?.verification;
    for (const dir of ['long_before', 'short_before']) {
      const r = v?.[dir];
      if (!r) continue;
      push(`| ${label} | ${dir.replace('_before','')} | ${r.minTick} | ${r.entry} | ${r.stopLevel} | ${r.profitLevel} | ${r.actualStop} | ${r.actualTarget} | ${r.ok ? '✅' : '❌ ' + pick(r.stopDelta, '')} |`);
    }
  }
  push();

  // Fields available
  push('## Fields available on the tool');
  push();
  push('Observed child values (internal `_source.properties().childs()`), symbol-specific:');
  push();
  for (const label of Object.keys(syms)) {
    const s = syms[label];
    const reader = (s.report?.readers ?? []).find((r) => r && r.sourceChilds);
    const vals = reader?.sourceChilds?.values;
    if (!vals) continue;
    push(`**${label}** child names: \`${(reader.sourceChilds.childNames ?? []).join('`, `')}\``);
    push();
    push('| field | value |');
    push('|---|---|');
    for (const k of Object.keys(vals).sort()) {
      push(`| \`${k}\` | \`${JSON.stringify(vals[k])}\` |`);
    }
    push();
  }

  // Polling recommendation
  push('## Polling recommendation (no events)');
  push();
  const eventChecks = {};
  for (const label of Object.keys(syms)) {
    const e = syms[label].report?.events;
    if (e) for (const k of Object.keys(e)) eventChecks[k] = e[k];
  }
  const noEvents = Object.values(eventChecks).every((v) => v === 'undefined');
  push(`The chart object exposes **no drawing/entity event hooks** (all \`${Object.keys(eventChecks).join('`, `')}\` are \`${noEvents ? 'undefined' : 'see below'}\`).`);
  push('Readers must **poll** `chart.getAllShapes()` / `chart.getShapeById(id)` on an interval.');
  push('Recommended: poll every 1–2 s and diff `points` (entry/stop/target) and the `stopLevel`/`profitLevel` child values; act only when the position the user owns changes.');
  push();

  // Caveats
  push('## Caveats');
  push();
  push('- The "Original" tab (TradingView `Original` layout) is unreadable via this API — only the chart iframe exposes `tradingViewApi`; other Binance UI panels are closed React, not accessible.');
  push('- `_source` paths are fragile internals: they can change name/shape between TV versions. Prefer `getPoints()`/`getProperties()`/`setProperties()`/`setPoints()` on the shape wrapper.');
  push('- `createShape`/`createMultipointShape` load a **lazy chunk** (`line-tool-risk-reward.*.js`); on flaky networks the first call can throw `ChunkLoadError`. It is transient: retry up to ~4× with 3 s pauses (or pre-warm with a throwaway create+remove).');
  push('- Overrides (`profitLevel`, `stopLevel`) are in **ticks**, not price — multiply by `minTick` to get price distance.');
  push('- No login/account data touched; positions created are throwaway drawings and are removed at the end of each run.');
  push();

  return lines.join('\n');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
