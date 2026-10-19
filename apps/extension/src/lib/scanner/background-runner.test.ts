import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALARM_NAME, BG_STATE_KEY, HEALTH_KEY, PANEL_FRESH_MS, createBackgroundScanner, desiredAlarm, parseHealth,
  type BackgroundDeps,
} from './background-runner';
import { EVENTS_KEY, PANEL_ACTIVE_KEY } from './scanner-runner';
import { SCANNER_SETTINGS_KEY, defaultScannerSettings, type KeyValueStorage } from './settings';
import type { StatsCell } from './stats';

const BAR = 300000;
const BASE = Math.floor(1_800_000_000_000 / BAR) * BAR;
const NOW = BASE + 100_000;

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
function klines(lastClose: number, lastOpen: number): unknown[] {
  const rows: unknown[] = [];
  for (let i = 39; i >= 0; i--) rows.push(kl(lastOpen - i * BAR, i === 0 ? lastClose : 100));
  return rows;
}

const exchangeInfo = {
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].map((symbol) => ({
    symbol, status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', underlyingType: 'COIN',
  })),
};
const ticker = [['BTCUSDT', 5e9], ['ETHUSDT', 2e9], ['SOLUSDT', 412e6]].map(([symbol, quoteVolume]) => ({
  symbol, quoteVolume: String(quoteVolume),
}));

function makeFetch(opts: { klinesStatus?: number; statsCells?: unknown[] } = {}) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
      ok: status >= 200 && status < 300, status, headers: { get: (n: string) => headers[n] ?? null }, json: async () => body,
    });
    const u = new URL(url);
    if (u.pathname === '/fapi/v1/time') return res(200, { serverTime: Date.now() });
    if (u.pathname === '/fapi/v1/exchangeInfo') return res(200, exchangeInfo);
    if (u.pathname === '/fapi/v1/ticker/24hr') return res(200, ticker);
    if (u.pathname === '/api/movers-stats') {
      return res(200, {
        schema: 'swal.movers-stats.v1', method: 'study', spec_version: '2026-10-19.1', cost_round_trip: 0.0008,
        cells: opts.statsCells ?? [],
      });
    }
    if (u.pathname === '/fapi/v1/klines') {
      if (opts.klinesStatus) return res(opts.klinesStatus, [], { 'Retry-After': '600' });
      const last = Math.floor((Date.now() - 1000 - BAR) / BAR) * BAR;
      return res(200, klines(u.searchParams.get('symbol') === 'SOLUSDT' ? 93.8 : 100, last));
    }
    return res(404, {});
  });
  return Object.assign(fn, { calls });
}

const negative = (mode: 'follow' | 'fade', direction: 'long' | 'short', signal: string, threshold: number): StatsCell => ({
  signal, mode, direction, threshold: threshold as 3 | 5 | 7, vol_tier: 'hi', context: 'all', n: 50, n_clusters: 40, wins_1r: 15,
  win_rate: 0.3, ci_low: 0.2, ci_high: 0.4, breakeven: 0.5, mean_net_r: -0.2, net_r_ci_low: -0.4, net_r_ci_high: -0.05,
  median_stop_pct: 0.01, events_per_day: 1, grade: 'negative',
});

describe('desiredAlarm', () => {
  it('is null unless enabled and backgroundMode', () => {
    expect(desiredAlarm({ enabled: false, backgroundMode: true }, NOW)).toBeNull();
    expect(desiredAlarm({ enabled: true, backgroundMode: false }, NOW)).toBeNull();
  });
  it('aligns to the next 5 minute close + 3 s with a 5 min period', () => {
    expect(desiredAlarm({ enabled: true, backgroundMode: true }, NOW)).toEqual({
      name: ALARM_NAME, when: BASE + BAR + 3000, periodInMinutes: 5,
    });
    expect(desiredAlarm({ enabled: true, backgroundMode: true }, BASE + 1000)?.when).toBe(BASE + 3000);
    expect(desiredAlarm({ enabled: true, backgroundMode: true }, BASE + 3000)?.when).toBe(BASE + BAR + 3000);
  });
});

describe('parseHealth', () => {
  it('validates the stored document', () => {
    expect(parseHealth({ lastCycleAt: 5, lastStatus: 'ok', cycles: 2, errors: 1 })).toEqual({ lastCycleAt: 5, lastStatus: 'ok', cycles: 2, errors: 1 });
    expect(parseHealth({ lastCycleAt: 5, lastStatus: '<b>', cycles: 2, errors: 1 })?.lastStatus).toBe('unknown');
    expect(parseHealth('x')).toBeNull();
    expect(parseHealth({ cycles: 'a', errors: 1 })).toBeNull();
  });
});

describe('background scanner', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const on = (patch: Record<string, unknown> = {}) => ({
    ...defaultScannerSettings(), enabled: true, backgroundMode: true, notifications: true, ...patch,
  });

  function setup(settings: Record<string, unknown> | null, extra: Record<string, unknown> = {}, fetchOpts = {}, allowed = true) {
    const storage = memoryStorage({ ...(settings ? { [SCANNER_SETTINGS_KEY]: settings } : {}), ...extra });
    const fetch = makeFetch(fetchOpts);
    const badges: string[] = [];
    const notify = vi.fn();
    const deps: BackgroundDeps = {
      fetch, storage, setBadge: (t) => badges.push(t), notify, notificationsAllowed: async () => allowed,
    };
    return { storage, fetch, badges, notify, scanner: createBackgroundScanner(deps) };
  }

  const stored = (s: ReturnType<typeof memoryStorage>) => ((s.data.get(EVENTS_KEY) as { events: Array<Record<string, unknown>> } | undefined)?.events ?? []);
  const klineCalls = (f: ReturnType<typeof makeFetch>) => f.calls.filter((c) => c.includes('/klines')).length;

  it('does nothing when the setting is off', async () => {
    const t = setup({ ...on(), backgroundMode: false });
    expect(await t.scanner.onAlarm()).toBe('off');
    expect(t.fetch).not.toHaveBeenCalled();
    const t2 = setup(null);
    expect(await t2.scanner.onAlarm()).toBe('off');
  });

  it('skips while the panel heartbeat is fresh and runs when stale', async () => {
    const fresh = setup(on(), { [PANEL_ACTIVE_KEY]: NOW - 60_000 });
    expect(await fresh.scanner.onAlarm()).toBe('panel_active');
    expect(fresh.fetch).not.toHaveBeenCalled();

    const stale = setup(on(), { [PANEL_ACTIVE_KEY]: NOW - PANEL_FRESH_MS - 1 });
    expect(await stale.scanner.onAlarm()).toBe('ok');
    expect(klineCalls(stale.fetch)).toBe(3);
    expect(stored(stale.storage).length).toBeGreaterThan(0);
  });

  it('writes health and does not rescan the same bar', async () => {
    const t = setup(on());
    expect(await t.scanner.onAlarm()).toBe('ok');
    expect(t.storage.data.get(HEALTH_KEY)).toEqual({ lastCycleAt: NOW, lastStatus: 'ok', cycles: 1, errors: 0 });
    expect(await t.scanner.onAlarm()).toBe('same_bar');
    expect(klineCalls(t.fetch)).toBe(3);
  });

  it('counts errors in health', async () => {
    const t = setup(on(), {}, { klinesStatus: 500 });
    expect(await t.scanner.onAlarm()).toBe('error');
    expect(t.storage.data.get(HEALTH_KEY)).toMatchObject({ cycles: 1, errors: 1, lastStatus: 'aborted' });
  });

  it('rebuilds the cooldown from persisted events (no duplicate row across worker restarts)', async () => {
    const first = setup(on());
    await first.scanner.onAlarm();
    const rows = stored(first.storage);
    expect(rows.length).toBeGreaterThan(0);
    // un worker nuevo, sin estado en memoria ni bgState: mismo almacen, otra vela cinco minutos despues
    const data = Object.fromEntries(first.storage.data);
    delete data[BG_STATE_KEY];
    vi.setSystemTime(NOW + BAR);
    const second = setup(on(), data);
    expect(await second.scanner.onAlarm()).toBe('ok');
    expect(stored(second.storage)).toHaveLength(rows.length);
  });

  it('sets the badge with the unseen count', async () => {
    const t = setup(on());
    await t.scanner.onAlarm();
    const n = stored(t.storage).length;
    expect(t.badges.at(-1)).toBe(String(n));
    const off = setup(on({ badge: false }));
    await off.scanner.onAlarm();
    expect(off.badges.at(-1)).toBe('');
  });

  it('notifies only with the permission, the setting and a valid symbol', async () => {
    const yes = setup(on());
    await yes.scanner.onAlarm();
    expect(yes.notify).toHaveBeenCalled();
    const first = yes.notify.mock.calls[0]![0] as { title: string };
    expect(first.title).toContain('SOLUSDT');

    const noPerm = setup(on(), {}, {}, false);
    await noPerm.scanner.onAlarm();
    expect(noPerm.notify).not.toHaveBeenCalled();
    expect(stored(noPerm.storage).length).toBeGreaterThan(0);

    const noSetting = setup(on({ notifications: false }));
    await noSetting.scanner.onAlarm();
    expect(noSetting.notify).not.toHaveBeenCalled();
  });

  it('is silent in quiet hours but still records the rows', async () => {
    const d = new Date(NOW);
    const hh = (h: number) => `${String((h + 24) % 24).padStart(2, '0')}:00`;
    const quietHours = { enabled: true, from: hh(d.getHours() - 1), to: hh(d.getHours() + 2) };
    const t = setup(on({ quietHours }));
    await t.scanner.onAlarm();
    expect(t.notify).not.toHaveBeenCalled();
    expect(stored(t.storage).length).toBeGreaterThan(0);
  });

  it('respects the hourly cap with a +N summary', async () => {
    const probe = setup(on());
    await probe.scanner.onAlarm();
    const total = stored(probe.storage).length;
    expect(total).toBeGreaterThan(1);
    const t = setup(on({ maxPerHour: 1, thresholds: { hi: 3, mid: 3, lo: 3 } }));
    await t.scanner.onAlarm();
    const n = stored(t.storage).length;
    expect(n).toBeGreaterThan(1);
    expect(t.notify).toHaveBeenCalledTimes(2);
    expect((t.notify.mock.calls[1]![0] as { message: string }).message).toBe(`+${n - 1} más`);
  });

  it('never notifies events whose measured cells are all negative', async () => {
    const probe = setup(on());
    await probe.scanner.onAlarm();
    const rows = stored(probe.storage) as Array<{ signal: string; threshold: number; move: string }>;
    const cells = rows.flatMap((r) => [
      negative('follow', r.move === 'up' ? 'long' : 'short', r.signal, r.threshold),
      negative('fade', r.move === 'up' ? 'short' : 'long', r.signal, r.threshold),
    ]);
    const t = setup(on(), {}, { statsCells: cells });
    await t.scanner.onAlarm();
    expect(stored(t.storage).length).toBe(rows.length);
    expect(t.notify).not.toHaveBeenCalled();
  });

  it('honors a 429 pause: remembers paused_until and skips alarms until then', async () => {
    const t = setup(on(), {}, { klinesStatus: 429 });
    expect(await t.scanner.onAlarm()).toBe('paused');
    expect((t.storage.data.get(BG_STATE_KEY) as { blockedUntil: number }).blockedUntil).toBeGreaterThanOrEqual(NOW + 600_000 - 5000);
    const calls = t.fetch.mock.calls.length;
    vi.setSystemTime(NOW + BAR);
    expect(await t.scanner.onAlarm()).toBe('blocked');
    expect(t.fetch.mock.calls.length).toBe(calls);
    vi.setSystemTime(NOW + 600_000 + BAR);
    expect(await t.scanner.onAlarm()).not.toBe('blocked');
  });

  it('honors a 418 ban', async () => {
    const t = setup(on(), {}, { klinesStatus: 418 });
    expect(await t.scanner.onAlarm()).toBe('banned');
    vi.setSystemTime(NOW + BAR);
    expect(await t.scanner.onAlarm()).toBe('blocked');
  });
});
