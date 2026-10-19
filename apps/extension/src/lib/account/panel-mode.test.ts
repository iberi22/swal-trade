import { describe, expect, it } from 'vitest';
import { nextMode, type Mode, type ModeInput } from './panel-mode';

const NOW = 1_000_000;
const pos = { symbol: 'BTCUSDT', size: 0.1 };
const base: ModeInput = {
  symbol: 'BTCUSDT',
  klinesOk: true,
  source: 'api',
  lastMode: 'loading',
  now: NOW,
  sinceSymbolChangeMs: 10_000,
};

const cases: Array<[string, Partial<ModeInput>, Mode, boolean]> = [
  ['api, no snapshot, 500 ms after change -> loading', { sinceSymbolChangeMs: 500 }, 'loading', false],
  ['api, no snapshot, 1999 ms -> loading', { sinceSymbolChangeMs: 1999 }, 'loading', false],
  ['loading never longer than 2 s', { sinceSymbolChangeMs: 2000 }, 'unknown', false],
  ['loading never longer than 2 s (no klines)', { sinceSymbolChangeMs: 2500, klinesOk: false }, 'no-data', false],
  ['fresh snapshot with position -> position', { snapshot: { fetchedAt: NOW - 1000, positions: [pos] } }, 'position', false],
  ['position beats loading window', { sinceSymbolChangeMs: 100, snapshot: { fetchedAt: NOW, positions: [pos] } }, 'position', false],
  ['fresh snapshot, other symbol only -> flat', { snapshot: { fetchedAt: NOW, positions: [{ symbol: 'ETHUSDT', size: 1 }] } }, 'flat', false],
  ['fresh empty snapshot -> flat', { snapshot: { fetchedAt: NOW - 60_000, positions: [] } }, 'flat', false],
  ['zero-size row is not a position -> flat', { snapshot: { fetchedAt: NOW, positions: [{ symbol: 'BTCUSDT', size: 0 }] } }, 'flat', false],
  ['stale after position keeps position', { lastMode: 'position', snapshot: { fetchedAt: NOW - 61_000, positions: [] } }, 'position', true],
  ['errored after position keeps position', { lastMode: 'position', error: 'net', snapshot: { fetchedAt: NOW, positions: [] } }, 'position', true],
  ['error and no snapshot after position keeps position', { lastMode: 'position', error: 'http_500' }, 'position', true],
  ['stale snapshot that still has the position -> position stale', { snapshot: { fetchedAt: NOW - 120_000, positions: [pos] } }, 'position', true],
  ['stale snapshot, last flat -> not flat', { lastMode: 'flat', snapshot: { fetchedAt: NOW - 120_000, positions: [] } }, 'unknown', true],
  ['source none -> unknown', { source: 'none' }, 'unknown', false],
  ['source none, no klines -> unknown', { source: 'none', klinesOk: false }, 'unknown', false],
  ['dom source without snapshot and no klines -> no-data', { source: 'dom', klinesOk: false }, 'no-data', false],
  ['manual source with klines, no snapshot -> unknown', { source: 'manual' }, 'unknown', false],
  ['dom source not subject to loading', { source: 'dom', sinceSymbolChangeMs: 10 }, 'unknown', false],
];

describe('nextMode', () => {
  it.each(cases)('%s', (_name, patch, mode, stale) => {
    expect(nextMode({ ...base, ...patch })).toEqual({ mode, stale });
  });

  it('never returns flat when last mode was position and data is not fresh', () => {
    for (const age of [61_000, 600_000]) {
      const r = nextMode({ ...base, lastMode: 'position', snapshot: { fetchedAt: NOW - age, positions: [] } });
      expect(r.mode).toBe('position');
    }
  });
});
