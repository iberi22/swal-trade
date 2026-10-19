import { describe, it, expect } from 'vitest';
import { EventLog, inQuietHours, NotificationGate, notifiable, toScannerEvent, type ScannerEvent } from './events';
import type { ScanEvent } from './scan-cycle';
import type { StatsCell } from './stats';

const scanEv = (over: Record<string, unknown> = {}, type: 'new' | 'update' = 'new', prev: number | null = null): ScanEvent => ({
  type,
  prev_threshold: prev,
  plans: null,
  event: {
    symbol: 'SOLUSDT', signal: 'move30', move: 'up', threshold: 3, window_min: 30, ret: 0.035,
    open_time_ms: 1000, close_time_ms: 301000, close: 100, q24: 5e7, tier: 'mid', vol_ratio: 2, taker_imb: 0.1,
    market_wide: false, ...over,
  },
});
const cellOf = (grade: StatsCell['grade']): StatsCell => ({ grade } as StatsCell);
const row = (i: number, cells?: { follow?: StatsCell | null; fade?: StatsCell | null }): ScannerEvent => {
  const e = toScannerEvent(scanEv({ symbol: `S${i}USDT` }));
  e.cells = { follow: cells?.follow ?? null, fade: cells?.fade ?? null };
  return e;
};

describe('EventLog', () => {
  it('inserts newest first and maps the view fields', () => {
    const log = new EventLog();
    const { inserted } = log.apply([scanEv(), scanEv({ symbol: 'ETHUSDT' })]);
    expect(inserted).toHaveLength(2);
    const e = log.list()[0]!;
    expect(e).toMatchObject({
      symbol: 'ETHUSDT', signal: 'move30', threshold: 3, move: 'up', tier: 'mid', q24: 5e7,
      takerImb: 0.1, vol_ratio: 2, marketWide: false, createdAtMs: 301000, seen: false,
    });
    expect(e.cells).toEqual({ follow: null, fade: null });
  });
  it('an update escalates the existing row instead of duplicating it', () => {
    const log = new EventLog();
    log.apply([scanEv()]);
    log.markAllSeen();
    expect(log.unseenCount()).toBe(0);
    const id = log.list()[0]!.id;
    const { inserted, updated } = log.apply([
      scanEv({ threshold: 5, ret: 0.06, close_time_ms: 601000 }, 'update', 3),
    ]);
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(log.list()).toHaveLength(1);
    expect(log.list()[0]).toMatchObject({ id, threshold: 5, ret: 0.06, prevThreshold: 3, createdAtMs: 301000, updatedAtMs: 601000, seen: false });
    expect(log.unseenCount()).toBe(1);
  });
  it('an update whose row was evicted is inserted', () => {
    const log = new EventLog();
    const { inserted } = log.apply([scanEv({ threshold: 5 }, 'update', 3)]);
    expect(inserted).toHaveLength(1);
  });
  it('keeps at most 200 rows (newest)', () => {
    const log = new EventLog();
    log.apply(Array.from({ length: 230 }, (_, i) => scanEv({ symbol: `S${i}USDT` })));
    expect(log.list()).toHaveLength(200);
    expect(log.list()[0]!.symbol).toBe('S229USDT');
    expect(log.unseenCount()).toBe(200);
  });
  it('market rows carry count and symbols', () => {
    const e = toScannerEvent(scanEv({ symbol: 'MARKET', market: true, count: 12, symbols: ['A', 'B'], ret: undefined, tier: undefined }));
    expect(e).toMatchObject({ symbol: 'MARKET', count: 12, symbols: ['A', 'B'], ret: null, tier: null });
  });
});

describe('quiet hours', () => {
  const q = { enabled: true, from: '23:00', to: '07:00' };
  const at = (h: number, m = 0) => new Date(2026, 9, 19, h, m);
  it('crosses midnight', () => {
    expect(inQuietHours(q, at(23, 0))).toBe(true);
    expect(inQuietHours(q, at(23, 59))).toBe(true);
    expect(inQuietHours(q, at(0, 30))).toBe(true);
    expect(inQuietHours(q, at(6, 59))).toBe(true);
    expect(inQuietHours(q, at(7, 0))).toBe(false);
    expect(inQuietHours(q, at(12))).toBe(false);
    expect(inQuietHours(q, at(22, 59))).toBe(false);
  });
  it('same-day window, disabled and empty window', () => {
    expect(inQuietHours({ enabled: true, from: '09:00', to: '17:00' }, at(10))).toBe(true);
    expect(inQuietHours({ enabled: true, from: '09:00', to: '17:00' }, at(18))).toBe(false);
    expect(inQuietHours({ ...q, enabled: false }, at(23, 30))).toBe(false);
    expect(inQuietHours({ enabled: true, from: '08:00', to: '08:00' }, at(8))).toBe(false);
  });
});

describe('NotificationGate', () => {
  const t0 = new Date(2026, 9, 19, 12, 0).getTime();
  it('caps at 6 per hour with a +N más summary (once)', () => {
    const gate = new NotificationGate();
    const r = gate.process(Array.from({ length: 10 }, (_, i) => row(i)), t0);
    expect(r.notify).toHaveLength(6);
    expect(r.summary).toBe('+4 más');
    const r2 = gate.process([row(20), row(21)], t0 + 60_000);
    expect(r2.notify).toHaveLength(0);
    expect(r2.summary).toBeNull();
    expect(r2.suppressed.cap).toBe(2);
    const r3 = gate.process([row(30)], t0 + 3_600_001);
    expect(r3.notify).toHaveLength(1);
  });
  it('respects maxPerHour from options', () => {
    const gate = new NotificationGate({ maxPerHour: 2 });
    const r = gate.process([row(1), row(2), row(3)], t0);
    expect(r.notify).toHaveLength(2);
    expect(r.summary).toBe('+1 más');
  });
  it('quiet hours silence notifications but not the list', () => {
    const gate = new NotificationGate({ quietHours: { enabled: true, from: '23:00', to: '07:00' } });
    const night = new Date(2026, 9, 19, 2, 0).getTime();
    const r = gate.process([row(1), row(2)], night);
    expect(r.notify).toHaveLength(0);
    expect(r.summary).toBeNull();
    expect(r.suppressed.quiet).toBe(2);
    expect(gate.process([row(3)], t0).notify).toHaveLength(1);
  });
  it('only events whose cells are not negative are notified', () => {
    expect(notifiable(row(1))).toBe(true);
    expect(notifiable(row(1, { follow: cellOf('negative'), fade: cellOf('negative') }))).toBe(false);
    expect(notifiable(row(1, { follow: cellOf('negative'), fade: cellOf('no_evidence') }))).toBe(true);
    const gate = new NotificationGate();
    const r = gate.process([
      row(1, { follow: cellOf('negative'), fade: cellOf('negative') }),
      row(2, { fade: cellOf('promising') }),
      row(3),
    ], t0);
    expect(r.notify.map((e) => e.symbol)).toEqual(['S2USDT', 'S3USDT']);
    expect(r.suppressed.negative).toBe(1);
  });
  it('a custom mute check also silences', () => {
    const gate = new NotificationGate();
    const r = gate.process([row(1), row(2)], t0, (e) => e.symbol === 'S1USDT');
    expect(r.notify).toHaveLength(1);
  });
});
