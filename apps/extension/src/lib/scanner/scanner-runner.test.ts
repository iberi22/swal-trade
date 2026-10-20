import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScannerEvent } from './events';
import type { ScanEvent, ScanResult } from './scan-cycle';
import { SCANNER_SETTINGS_KEY, defaultScannerSettings, type KeyValueStorage } from './settings';
import {
  EVENTS_KEY, badgeText, cellsForEvent, createScannerRunner, parseStoredEvent, parseStoredEvents,
  passesThreshold, serializeEvents, statusFor, thresholdFor, type RunnerState,
} from './scanner-runner';
import type { MoversStats, StatsCell } from './stats';

const BAR = 300000;
const BASE = Math.floor(1_800_000_000_000 / BAR) * BAR;
const NOW = BASE + 100_000; // 100 s dentro de una vela
const LAST_OPEN = BASE - BAR;

function memoryStorage(initial: Record<string, unknown> = {}): KeyValueStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    async get(k) { return data.get(k); },
    async set(k, v) { data.set(k, JSON.parse(JSON.stringify(v))); },
  };
}

const kl = (open: number, close: number) => [
  open, String(close), String(close * 1.002), String(close * 0.998), String(close), '1000', open + BAR - 1,
  String(close * 1000), 10, '500', '0', '0',
];

function klines(lastClose: number, lastOpen = LAST_OPEN): unknown[] {
  const rows: unknown[] = [];
  for (let i = 39; i >= 0; i--) {
    const open = lastOpen - i * BAR;
    rows.push(kl(open, i === 0 ? lastClose : 100));
  }
  return rows;
}

const exchangeInfo = {
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT'].map((symbol) => ({
    symbol, status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', underlyingType: 'COIN',
  })),
};
const ticker = [
  ['BTCUSDT', 5e9], ['ETHUSDT', 2e9], ['SOLUSDT', 412e6], ['XRPUSDT', 300e6], ['ADAUSDT', 250e6], ['DEADUSDT', 1e3],
].map(([symbol, quoteVolume]) => ({ symbol, quoteVolume: String(quoteVolume) }));

interface Hooks { klinesStatus?: number; tickerStatus?: number; dropSol?: boolean }

function makeFetch(h: Hooks = {}) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n: string) => headers[n] ?? null },
      json: async () => body,
    });
    const u = new URL(url);
    if (u.pathname === '/fapi/v1/time') return res(200, { serverTime: Date.now() });
    if (u.pathname === '/fapi/v1/exchangeInfo') return res(200, exchangeInfo);
    if (u.pathname === '/fapi/v1/ticker/24hr') return res(h.tickerStatus ?? 200, ticker, h.tickerStatus === 429 ? { 'Retry-After': '120' } : {});
    if (u.pathname === '/api/movers-stats') return res(200, { schema: 'swal.movers-stats.v1', method: 'study', cells: [], note: 'x' });
    if (u.pathname === '/fapi/v1/klines') {
      if (h.klinesStatus) return res(h.klinesStatus, [], h.klinesStatus === 418 ? { 'Retry-After': '600' } : {});
      const sym = u.searchParams.get('symbol');
      const last = Math.floor((Date.now() - 1000 - BAR) / BAR) * BAR;
      return res(200, klines(sym === 'SOLUSDT' && h.dropSol !== false ? 93.8 : 100, last));
    }
    return res(404, {});
  });
  return Object.assign(fn, { calls });
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('pure helpers', () => {
  const result = (status: ScanResult['status'], extra: Partial<ScanResult> = {}): ScanResult => ({
    status, events: [], market: null, stats: { symbols: 150, failed: 2, weight: 200 }, ...extra,
  });

  it('statusFor covers every scan status in Spanish', () => {
    expect(statusFor(result('ok'))).toMatchObject({ kind: 'ok', text: 'Vigilando 150 pares · 2 sin datos' });
    expect(statusFor(result('paused', { paused_until: 5 }))).toMatchObject({ kind: 'paused', retryUntil: 5 });
    expect(statusFor(result('banned', { banned_until: 9 })).text).toContain('418');
    expect(statusFor(result('weight')).kind).toBe('paused');
    expect(statusFor(result('aborted')).kind).toBe('error');
    expect(statusFor(result('empty')).kind).toBe('error');
    expect(statusFor(result('same_bar')).kind).toBe('ok');
  });

  it('badgeText shows unseen only when enabled, wanted and the tab is closed', () => {
    const on = { enabled: true, badge: true, tabActive: false };
    expect(badgeText(3, on)).toBe('3');
    expect(badgeText(120, on)).toBe('99+');
    expect(badgeText(0, on)).toBe('');
    expect(badgeText(3, { ...on, tabActive: true })).toBe('');
    expect(badgeText(3, { ...on, badge: false })).toBe('');
    expect(badgeText(3, { ...on, enabled: false })).toBe('');
  });

  it('thresholds per tier filter events', () => {
    const s = defaultScannerSettings(); // hi 5, mid 7, lo 7
    expect(thresholdFor(s, 'hi')).toBe(5);
    expect(thresholdFor(s, null)).toBe(5);
    const mk = (threshold: number, tier: string): ScanEvent =>
      ({ type: 'new', prev_threshold: null, plans: null, event: { symbol: 'X', signal: 'move30', move: 'up', threshold, tier, open_time_ms: 0, close_time_ms: 0 } });
    expect(passesThreshold(s, mk(3, 'hi'))).toBe(false);
    expect(passesThreshold(s, mk(5, 'hi'))).toBe(true);
    expect(passesThreshold(s, mk(5, 'mid'))).toBe(false);
  });

  it('cellsForEvent picks the exact context and falls back to all', () => {
    const cell = (mode: 'follow' | 'fade', context: StatsCell['context']): StatsCell => ({
      signal: 'move30', mode, direction: mode === 'follow' ? 'short' : 'long', threshold: 5, vol_tier: 'hi', context,
      n: 50, n_clusters: 40, wins_1r: 20, win_rate: 0.4, ci_low: 0.3, ci_high: 0.5, breakeven: 0.5, mean_net_r: -0.1,
      net_r_ci_low: -0.3, net_r_ci_high: 0.1, median_stop_pct: 0.01, events_per_day: 1, grade: 'no_evidence',
    });
    const stats: MoversStats = {
      schema: 'swal.movers-stats.v1', method: 'study', spec_version: '2026-10-19.1', cost_round_trip: 0.0008,
      cells: [cell('follow', 'idio'), cell('fade', 'all')],
    };
    const ev = { signal: 'move30', threshold: 5, move: 'down' as const, tier: 'hi', marketWide: false };
    const out = cellsForEvent(stats, ev);
    expect(out.follow?.context).toBe('idio');
    expect(out.fade?.context).toBe('all');
    expect(cellsForEvent(null, ev)).toEqual({ follow: null, fade: null });
    expect(cellsForEvent({ ...stats, spec_version: 'otra' }, ev)).toEqual({ follow: null, fade: null });
    expect(cellsForEvent(stats, { ...ev, tier: null })).toEqual({ follow: null, fade: null });
  });
});

describe('persistence parsing', () => {
  const good: ScannerEvent = {
    id: 'SOLUSDT:move30:down:1', symbol: 'SOLUSDT', signal: 'move30', threshold: 5, move: 'down', ret: -0.06, vol_ratio: 2,
    tier: 'hi', q24: 4e8, takerImb: 0.1, marketWide: false, createdAtMs: 10, updatedAtMs: 20, prevThreshold: null,
    plans: { follow: { mode: 'follow', direction: 'short', entry: 1, stop: 2, t1: 3, t2: 4, stop_dist: 1 }, fade: null },
    cells: { follow: null, fade: null }, seen: true,
  };

  it('round-trips a valid event', () => {
    const parsed = parseStoredEvents(serializeEvents([good]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ symbol: 'SOLUSDT', ret: -0.06, seen: true });
    expect(parsed[0]!.plans?.follow?.stop).toBe(2);
  });

  it('drops bad symbols, thresholds, shapes and duplicates; caps at 200', () => {
    expect(parseStoredEvent({ ...good, symbol: '<script>' })).toBeNull();
    expect(parseStoredEvent({ ...good, threshold: 4 })).toBeNull();
    expect(parseStoredEvent({ ...good, move: 'sideways' })).toBeNull();
    expect(parseStoredEvent({ ...good, createdAtMs: 'x' })).toBeNull();
    expect(parseStoredEvent(null)).toBeNull();
    expect(parseStoredEvents('basura')).toEqual([]);
    expect(parseStoredEvents([good, good])).toHaveLength(1);
    const many = Array.from({ length: 300 }, (_, i) => ({ ...good, id: `e${i}`, updatedAtMs: i + 1 }));
    const parsed = parseStoredEvents({ events: many });
    expect(parsed).toHaveLength(200);
    expect(parsed[0]!.updatedAtMs).toBeGreaterThan(parsed[1]!.updatedAtMs);
  });

  it('discards invalid stored cells instead of trusting them', () => {
    const e = parseStoredEvent({ ...good, cells: { follow: { grade: 'validated' }, fade: null } });
    expect(e?.cells.follow).toBeNull();
  });

  it('validates market rows', () => {
    const m = parseStoredEvent({ ...good, id: 'MARKET:move30:down:1', symbol: 'MARKET', plans: null, count: 12, symbols: ['AUSDT', '<x>'], marketWide: true });
    expect(m?.count).toBe(12);
    expect(m?.symbols).toEqual(['AUSDT']);
    expect(parseStoredEvent({ ...good, symbol: 'MARKET', count: -1 })).toBeNull();
  });
});

describe('runner', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(settings: Record<string, unknown> | null, hooks: Hooks = {}, extra: Record<string, unknown> = {}) {
    const storage = memoryStorage({
      ...(settings ? { [SCANNER_SETTINGS_KEY]: settings } : {}),
      ...extra,
    });
    const fetch = makeFetch(hooks);
    const badges: string[] = [];
    const beep = vi.fn();
    const notify = vi.fn();
    const runner = createScannerRunner({
      fetch,
      storage,
      setBadge: (t) => badges.push(t),
      beep,
      notify,
      notificationsAllowed: async () => true,
    });
    const states: RunnerState[] = [];
    runner.subscribe((s) => states.push(s));
    return { storage, fetch, badges, beep, notify, runner, states };
  }

  it('does nothing while disabled', async () => {
    const t = setup({ enabled: false });
    await t.runner.init();
    await flush();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.runner.getState()).toMatchObject({ running: false, loaded: true, statusKind: 'off' });
  });

  it('runs a cycle when enabled, finds the drop, persists, badges and schedules the next bar', async () => {
    const t = setup({ enabled: true, sound: true });
    await t.runner.init();
    await vi.advanceTimersByTimeAsync(50);
    const s = t.runner.getState();
    expect(s.running).toBe(true);
    expect(s.statusKind).toBe('ok');
    expect(s.events.map((e) => `${e.symbol}:${e.signal}`).sort()).toEqual(['SOLUSDT:move15', 'SOLUSDT:move30']);
    expect(s.events[0]).toMatchObject({ threshold: 5, move: 'down', tier: 'hi', seen: false });
    expect(s.unseen).toBe(2);
    expect(s.lastCycleAt).not.toBeNull();
    expect(s.nextCycleAt).not.toBeNull();
    expect(t.badges.at(-1)).toBe('2');
    expect(t.beep).toHaveBeenCalledTimes(1);
    const stored = t.storage.data.get(EVENTS_KEY) as { events: unknown[] };
    expect(stored.events).toHaveLength(2);
    // exchangeInfo una sola vez, ticker y velas por ciclo
    expect(t.fetch.calls.filter((u) => u.includes('exchangeInfo'))).toHaveLength(1);
    expect(t.fetch.calls.filter((u) => u.includes('ticker/24hr'))).toHaveLength(1);
    expect(t.fetch.calls.filter((u) => u.includes('klines'))).toHaveLength(5);

    // abrir la pestana limpia la insignia; salir marca todo como visto
    t.runner.setTabActive(true);
    expect(t.badges.at(-1)).toBe('');
    t.runner.setTabActive(false);
    expect(t.runner.getState().unseen).toBe(0);

    // proximo cierre de 5 minutos + 3 s
    await vi.advanceTimersByTimeAsync(BAR + 5000);
    expect(t.fetch.calls.filter((u) => u.includes('ticker/24hr')).length).toBeGreaterThanOrEqual(2);
    expect(t.fetch.calls.filter((u) => u.includes('exchangeInfo'))).toHaveLength(1);
    t.runner.destroy();
  });

  it('restores stored events on open', async () => {
    const first = setup({ enabled: true });
    await first.runner.init();
    await vi.advanceTimersByTimeAsync(50);
    const stored = first.storage.data.get(EVENTS_KEY);
    first.runner.destroy();
    const second = setup({ enabled: false }, {}, { [EVENTS_KEY]: stored });
    await second.runner.init();
    expect(second.runner.getState().events.map((e) => e.symbol)).toEqual(['SOLUSDT', 'SOLUSDT']);
    expect(second.fetch).not.toHaveBeenCalled();
  });

  it('the universe survives two quick setting changes (no stale write)', async () => {
    const t = setup({ enabled: false });
    await t.runner.init();
    // Dos cambios sin esperar al primero: antes el segundo escribía USDT otra vez.
    const first = t.runner.setSettings({ universe: 'USDC' });
    const second = t.runner.setSettings({ sound: true });
    await Promise.all([first, second]);
    const stored = t.storage.data.get(SCANNER_SETTINGS_KEY) as { universe: string; sound: boolean };
    expect(stored.universe).toBe('USDC');
    expect(stored.sound).toBe(true);
    expect(t.runner.getState().settings.universe).toBe('USDC');
    t.runner.destroy();
  });

  it('restores a stored USDC universe on open', async () => {
    const t = setup({ enabled: false }, {}, {
      [SCANNER_SETTINGS_KEY]: { ...defaultScannerSettings(), universe: 'USDC' },
    });
    await t.runner.init();
    expect(t.runner.getState().settings.universe).toBe('USDC');
    t.runner.destroy();
  });

  it('turning the switch on and off starts and stops the loop', async () => {
    const t = setup({ enabled: false });
    await t.runner.init();
    await t.runner.setSettings({ enabled: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(t.runner.getState().running).toBe(true);
    expect((t.storage.data.get(SCANNER_SETTINGS_KEY) as { enabled: boolean }).enabled).toBe(true);
    await t.runner.setSettings({ enabled: false });
    const calls = t.fetch.calls.length;
    await vi.advanceTimersByTimeAsync(2 * BAR);
    expect(t.fetch.calls.length).toBe(calls);
    expect(t.runner.getState()).toMatchObject({ running: false, statusKind: 'off', nextCycleAt: null });
    t.runner.destroy();
  });

  it('429 on the ticker pauses and respects Retry-After', async () => {
    const t = setup({ enabled: true }, { tickerStatus: 429 });
    await t.runner.init();
    await vi.advanceTimersByTimeAsync(50);
    const s = t.runner.getState();
    expect(s.statusKind).toBe('paused');
    expect(s.statusText).toContain('pausa');
    // no vuelve a pedir en el siguiente cierre de vela: espera mas de 120 s
    expect(s.nextCycleAt! - NOW).toBeGreaterThanOrEqual(120_000 - 1000);
    expect(s.events).toEqual([]);
    t.runner.destroy();
  });

  it('418 on klines stops scanning with a banned status', async () => {
    const t = setup({ enabled: true }, { klinesStatus: 418 });
    await t.runner.init();
    await vi.advanceTimersByTimeAsync(50);
    const s = t.runner.getState();
    expect(s.statusKind).toBe('banned');
    expect(s.statusText).toContain('418');
    expect(s.nextCycleAt! - NOW).toBeGreaterThanOrEqual(600_000 - 1000);
    t.runner.destroy();
  });

  it('does not poll while the panel is hidden and resumes when visible', async () => {
    const t = setup({ enabled: true });
    await t.runner.init();
    t.runner.setVisible(false);
    await vi.advanceTimersByTimeAsync(3 * BAR);
    const before = t.fetch.calls.filter((u) => u.includes('ticker/24hr')).length;
    await vi.advanceTimersByTimeAsync(3 * BAR);
    expect(t.fetch.calls.filter((u) => u.includes('ticker/24hr')).length).toBe(before);
    expect(t.runner.getState().statusKind).toBe('paused');
    t.runner.setVisible(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(t.fetch.calls.filter((u) => u.includes('ticker/24hr')).length).toBeGreaterThan(before);
    t.runner.destroy();
  });

  it('notifies only with permission and a validated symbol, and respects the sound flag', async () => {
    const quiet = setup({ enabled: true, sound: false, notifications: false });
    await quiet.runner.init();
    await vi.advanceTimersByTimeAsync(50);
    expect(quiet.beep).not.toHaveBeenCalled();
    expect(quiet.notify).not.toHaveBeenCalled();
    quiet.runner.destroy();

    const loud = setup({ enabled: true, notifications: true });
    await loud.runner.init();
    await vi.advanceTimersByTimeAsync(50);
    expect(loud.notify).toHaveBeenCalledTimes(2);
    const titles = loud.notify.mock.calls.map((c) => (c[0] as { title: string }).title).sort();
    expect(titles).toEqual(['SOLUSDT baja 6,2 % en 15 min', 'SOLUSDT baja 6,2 % en 30 min']);
    const arg = loud.notify.mock.calls[0]![0] as { title: string; message: string };
    expect(JSON.stringify(arg).toLowerCase()).not.toContain('probabilidad');
    loud.runner.destroy();
  });
});
