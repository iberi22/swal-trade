import { describe, it, expect } from 'vitest';
import { CooldownTracker } from './movers';
import {
  lastClosedOpen, runScanCycle, scheduleNextCycle, ServerClock,
  type ResponseLike, type ScanDeps, type ScanFetch, type ScanState,
} from './scan-cycle';

const BAR = 300000;
const B = 1_800_000_000_000; // multiplo de 5 min

/** Filas kline: closes[last] es la vela con open time endOpen (la vela abierta). */
function klines(endOpen: number, closes: number[]): Array<Array<string | number>> {
  return closes.map((c, i) => {
    const open = endOpen - (closes.length - 1 - i) * BAR;
    return [open, String(c), String(c), String(c), String(c), '10', open + BAR - 1, String(c * 10), 5, '5', '0', '0'];
  });
}
const flat = (n: number, v = 100): number[] => new Array(n).fill(v);

function resp(status: number, body: unknown, headers: Record<string, string> = {}): ResponseLike {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (n) => h[n.toLowerCase()] ?? null }, json: async () => body };
}

const symOf = (url: string): string => new URL(url).searchParams.get('symbol') ?? '';

const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const Q24 = { BTCUSDT: 5e9, ETHUSDT: 1.5e8, SOLUSDT: 5e7, XRPUSDT: 1e7 } as Record<string, number>;

function mk(over: Partial<ScanDeps> & { fetch: ScanFetch }): ScanDeps {
  return {
    now: () => B + 3000,
    universe: SYMS,
    q24: Q24,
    cooldown: new CooldownTracker(),
    ...over,
  };
}

/** 38 velas planas, una cerrada con cierre `closedClose` y la abierta con el mismo valor. */
const jumpSeries = (endOpen: number, closedClose: number) => klines(endOpen, [...flat(38), closedClose, closedClose]);

describe('scheduleNextCycle', () => {
  it('returns ms to next 5 minute close + 3 s', () => {
    expect(scheduleNextCycle(B)).toBe(3000);
    expect(scheduleNextCycle(B + 1000)).toBe(2000);
    expect(scheduleNextCycle(B + 3000)).toBe(BAR);
    expect(scheduleNextCycle(B + 299_999)).toBe(3001);
  });
  it('lastClosedOpen keeps a 1 s margin', () => {
    expect(lastClosedOpen(B + 3000)).toBe(B - BAR);
    expect(lastClosedOpen(B + 1000)).toBe(B - BAR);
    expect(lastClosedOpen(B + 999)).toBe(B - 2 * BAR);
    expect(lastClosedOpen(B + BAR + 1000)).toBe(B);
  });
});

describe('ServerClock', () => {
  it('measures drift and resyncs hourly', async () => {
    let local = 1000;
    const calls: string[] = [];
    const f: ScanFetch = async (url) => {
      calls.push(url);
      return resp(200, { serverTime: local + 120_000 });
    };
    const clock = new ServerClock(f, () => local);
    expect(clock.needsSync()).toBe(true);
    expect(await clock.sync()).toBe(true);
    expect(calls[0]).toBe('https://fapi.binance.com/fapi/v1/time');
    expect(clock.now()).toBe(local + 120_000);
    local += 10_000;
    expect(clock.now()).toBe(local + 120_000);
    await clock.ensure();
    expect(calls).toHaveLength(1);
    local += 3_600_000;
    expect(clock.needsSync()).toBe(true);
    await clock.ensure();
    expect(calls).toHaveLength(2);
  });
  it('keeps the old offset when sync fails', async () => {
    let local = 0;
    const clock = new ServerClock(async () => { throw new Error('x'); }, () => local);
    expect(await clock.sync()).toBe(false);
    expect(clock.now()).toBe(0);
    const c2 = new ServerClock(async () => resp(500, {}), () => local);
    expect(await c2.sync()).toBe(false);
    const c3 = new ServerClock(async () => resp(200, { serverTime: 'x' }), () => local);
    expect(await c3.sync()).toBe(false);
  });
  it('a cycle uses server time even when the local clock drifts', async () => {
    const local = B + 3000 - 600_000; // reloj local 10 minutos atrasado
    const clock = new ServerClock(async () => resp(200, { serverTime: B + 3000 }), () => local);
    await clock.sync();
    const f: ScanFetch = async (url) => resp(200, jumpSeries(B, 108));
    const r = await runScanCycle(mk({ fetch: f, now: () => clock.now() }));
    expect(r.status).toBe('ok');
    expect(r.market?.barOpenMs).toBe(B - BAR);
    expect(r.events.length).toBeGreaterThan(0);
  });
});

describe('closed bar logic', () => {
  it('drops the still-open candle and uses the last closed bar', async () => {
    // el salto esta SOLO en la vela abierta: no debe haber eventos
    const f: ScanFetch = async () => resp(200, klines(B, [...flat(39), 108]));
    const r = await runScanCycle(mk({ fetch: f }));
    expect(r.status).toBe('ok');
    expect(r.events).toEqual([]);
  });
  it('a bar closing less than 1 s ago is not yet closed', async () => {
    const f: ScanFetch = async () => resp(200, klines(B, [...flat(38), 108, 108]));
    // B+500: la vela B-300000 cerro hace 501 ms -> aun no cuenta; la ultima cerrada es B-600000 (plana)
    const r = await runScanCycle(mk({ fetch: f, now: () => B + 500 }));
    expect(r.market?.barOpenMs).toBe(B - 2 * BAR);
    expect(r.events).toEqual([]);
    const r2 = await runScanCycle(mk({ fetch: f, now: () => B + 1000 }));
    expect(r2.market?.barOpenMs).toBe(B - BAR);
    expect(r2.events.length).toBeGreaterThan(0);
  });
  it('detects events, attaches plans and requests the right url', async () => {
    const urls: string[] = [];
    const f: ScanFetch = async (url) => { urls.push(url); return resp(200, symOf(url) === 'SOLUSDT' ? jumpSeries(B, 108) : klines(B, flat(40))); };
    const r = await runScanCycle(mk({ fetch: f }));
    expect(urls).toHaveLength(4);
    expect(urls[0]).toBe('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=40');
    const sol = r.events.filter((e) => (e.event as { symbol: string }).symbol === 'SOLUSDT');
    expect(sol.map((e) => (e.event as { signal: string }).signal).sort()).toEqual(['move15', 'move30']);
    for (const e of sol) {
      expect(e.type).toBe('new');
      expect((e.event as { threshold: number }).threshold).toBe(7);
      expect((e.event as unknown as { tier: string }).tier).toBe('mid');
      expect(e.plans?.follow?.direction).toBe('long');
      expect(e.plans?.fade?.direction).toBe('short');
    }
    expect(r.stats).toMatchObject({ symbols: 4, failed: 0 });
    expect(r.market?.collapsed).toBe(false);
  });
  it('ignores invalid symbols without fetching them', async () => {
    const urls: string[] = [];
    const f: ScanFetch = async (url) => { urls.push(url); return resp(200, klines(B, flat(40))); };
    await runScanCycle(mk({ fetch: f, universe: ['BTCUSDT', 'A/B', 'x&y=1'] }));
    expect(urls).toHaveLength(1);
  });
});

describe('idempotence per bar', () => {
  it('the same bar twice yields no new events; the next bar runs again', async () => {
    const state: ScanState = { lastBarOpenMs: null };
    const f: ScanFetch = async (url) => resp(200, symOf(url) === 'SOLUSDT' ? jumpSeries(B, 108) : klines(B, flat(40)));
    const cooldown = new CooldownTracker();
    const r1 = await runScanCycle(mk({ fetch: f, state, cooldown }));
    expect(r1.events.length).toBeGreaterThan(0);
    expect(state.lastBarOpenMs).toBe(B - BAR);
    let calls = 0;
    const counting: ScanFetch = async (u, i) => { calls++; return f(u, i); };
    const r2 = await runScanCycle(mk({ fetch: counting, state, cooldown }));
    expect(r2.status).toBe('same_bar');
    expect(r2.events).toEqual([]);
    expect(calls).toBe(0);
    const r3 = await runScanCycle(mk({ fetch: f, state, cooldown, now: () => B + BAR + 3000 }));
    expect(r3.status).toBe('ok');
    expect(state.lastBarOpenMs).toBe(B);
  });
  it('failed cycles do not consume the bar', async () => {
    const state: ScanState = { lastBarOpenMs: null };
    const r = await runScanCycle(mk({ fetch: async () => resp(500, {}), state }));
    expect(r.status).toBe('aborted');
    expect(state.lastBarOpenMs).toBeNull();
  });
});

describe('cooldown escalation', () => {
  it('a higher threshold inside the cooldown is an update with prev_threshold', async () => {
    const cooldown = new CooldownTracker();
    const f1: ScanFetch = async (url) => resp(200, symOf(url) === 'SOLUSDT' ? jumpSeries(B, 103.5) : klines(B, flat(40)));
    const r1 = await runScanCycle(mk({ fetch: f1, cooldown }));
    const sol1 = r1.events.filter((e) => (e.event as { symbol: string }).symbol === 'SOLUSDT');
    expect(sol1.every((e) => e.type === 'new' && (e.event as { threshold: number }).threshold === 3)).toBe(true);
    const f2: ScanFetch = async (url) =>
      resp(200, symOf(url) === 'SOLUSDT' ? klines(B + BAR, [...flat(37), 103.5, 106, 106]) : klines(B + BAR, flat(40)));
    const r2 = await runScanCycle(mk({ fetch: f2, cooldown, now: () => B + BAR + 3000 }));
    const sol2 = r2.events.filter((e) => (e.event as { symbol: string }).symbol === 'SOLUSDT');
    expect(sol2.length).toBe(2);
    for (const e of sol2) {
      expect(e.type).toBe('update');
      expect(e.prev_threshold).toBe(3);
      expect((e.event as { threshold: number }).threshold).toBe(5);
    }
  });
});

describe('market burst', () => {
  it('more than 10 market-wide events in one bar collapse into MARKET rows', async () => {
    const universe = ['BTCUSDT', ...Array.from({ length: 11 }, (_, i) => `COIN${String.fromCharCode(65 + i)}USDT`)];
    const q24 = Object.fromEntries(universe.map((s) => [s, 5e7]));
    const f: ScanFetch = async () => resp(200, jumpSeries(B, 108));
    const r = await runScanCycle(mk({ fetch: f, universe, q24 }));
    expect(r.market?.collapsed).toBe(true);
    expect(r.market?.marketWideEvents).toBeGreaterThan(10);
    const syms = r.events.map((e) => (e.event as { symbol: string }).symbol);
    expect(new Set(syms)).toEqual(new Set(['MARKET']));
    expect(r.events).toHaveLength(2);
    expect(r.events.every((e) => e.plans === null)).toBe(true);
    expect((r.events[0]!.event as { symbols: string[] }).symbols).toHaveLength(12);
  });
});

describe('budget and errors', () => {
  const many = Array.from({ length: 20 }, (_, i) => `C${String.fromCharCode(65 + i)}XUSDT`);

  it('stops the cycle when used weight exceeds 1200 (1200 itself is fine)', async () => {
    let calls = 0;
    const heavy: ScanFetch = async () => { calls++; return resp(200, klines(B, flat(40)), { 'X-MBX-USED-WEIGHT-1M': calls === 1 ? '1201' : '10' }); };
    const r = await runScanCycle(mk({ fetch: heavy, universe: many, q24: {} }));
    expect(r.status).toBe('weight');
    expect(r.events).toEqual([]);
    expect(calls).toBeLessThan(many.length);
    const edge: ScanFetch = async () => resp(200, klines(B, flat(40)), { 'X-MBX-USED-WEIGHT-1M': '1200' });
    const ok = await runScanCycle(mk({ fetch: edge, universe: many, q24: {} }));
    expect(ok.status).toBe('ok');
    expect(ok.stats.weight).toBe(1200);
  });
  it('429 respects Retry-After', async () => {
    const f: ScanFetch = async () => resp(429, {}, { 'Retry-After': '30' });
    const state: ScanState = { lastBarOpenMs: null };
    const r = await runScanCycle(mk({ fetch: f, universe: many, q24: {}, state }));
    expect(r.status).toBe('paused');
    expect(r.paused_until).toBe(B + 3000 + 30_000);
    expect(state.lastBarOpenMs).toBeNull();
  });
  it('418 stops with banned_until', async () => {
    let calls = 0;
    const f: ScanFetch = async () => { calls++; return resp(418, {}, { 'Retry-After': '120' }); };
    const r = await runScanCycle(mk({ fetch: f, universe: many, q24: {} }));
    expect(r.status).toBe('banned');
    expect(r.banned_until).toBe(B + 3000 + 120_000);
    expect(calls).toBeLessThanOrEqual(4);
  });
  it('aborts when more than 50% of requests fail, continues at exactly 50%', async () => {
    const ten = many.slice(0, 10);
    const failFirst = (n: number): ScanFetch => {
      const bad = new Set(ten.slice(0, n));
      return async (url) => (bad.has(symOf(url)) ? resp(500, {}) : resp(200, klines(B, flat(40))));
    };
    const r6 = await runScanCycle(mk({ fetch: failFirst(6), universe: ten, q24: {} }));
    expect(r6.status).toBe('aborted');
    expect(r6.events).toEqual([]);
    const r5 = await runScanCycle(mk({ fetch: failFirst(5), universe: ten, q24: {} }));
    expect(r5.status).toBe('ok');
    expect(r5.stats).toMatchObject({ symbols: 5, failed: 5 });
  });
  it('a hanging request is aborted after the timeout and counts as a failure', async () => {
    const hang: ScanFetch = (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('abort'))));
    const r = await runScanCycle(mk({ fetch: hang, settings: { timeoutMs: 15 } }));
    expect(r.status).toBe('aborted');
    expect(r.stats.failed).toBeGreaterThan(2);
  });
  it('malformed bodies count as failures', async () => {
    const r = await runScanCycle(mk({ fetch: async () => resp(200, { not: 'rows' }) }));
    expect(r.status).toBe('aborted');
  });
});

describe('concurrency', () => {
  it('never exceeds 4 in flight and reaches 4', async () => {
    let inflight = 0;
    let peak = 0;
    const f: ScanFetch = async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 2));
      inflight--;
      return resp(200, klines(B, flat(40)));
    };
    const universe = Array.from({ length: 30 }, (_, i) => `N${String.fromCharCode(65 + (i % 26))}${i}USDT`);
    const progress: number[] = [];
    const r = await runScanCycle(mk({ fetch: f, universe, q24: {}, onProgress: (p) => progress.push(p.done) }));
    expect(r.status).toBe('ok');
    expect(peak).toBe(4);
    expect(progress).toHaveLength(30);
    expect(progress[progress.length - 1]).toBe(30);
  });
  it('a larger requested concurrency is capped at 4', async () => {
    let inflight = 0;
    let peak = 0;
    const f: ScanFetch = async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 2));
      inflight--;
      return resp(200, klines(B, flat(40)));
    };
    const universe = Array.from({ length: 12 }, (_, i) => `M${i}USDT`);
    await runScanCycle(mk({ fetch: f, universe, q24: {}, settings: { concurrency: 50 } }));
    expect(peak).toBe(4);
  });
});
