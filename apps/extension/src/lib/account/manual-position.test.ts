import { describe, expect, it } from 'vitest';
import { manualToPositionView, parseStoredManual, validateManual, withManualPosition, manualStorageKey } from './manual-position';
import type { PanelState } from './panel-controller';

const OK = { side: 'long', entry: '100', size: '0,5', stop: '95', leverage: '5' };

describe('validateManual', () => {
  it('acepta datos validos (coma decimal)', () => {
    const r = validateManual('BTCUSDT', OK, 7);
    expect(r).toEqual({ ok: true, value: { symbol: 'BTCUSDT', side: 'long', entry: 100, size: 0.5, stop: 95, leverage: 5, savedMs: 7 } });
  });
  it('stop vacio => null', () => {
    const r = validateManual('BTCUSDT', { ...OK, stop: '' }, 0);
    expect(r.ok && r.value.stop).toBeNull();
  });
  it('rechaza cada campo malo', () => {
    for (const bad of [
      { side: 'x' }, { entry: '0' }, { entry: 'abc' }, { size: '-1' }, { leverage: '0' },
      { leverage: '2.5' }, { leverage: '200' }, { stop: '-3' }, { stop: 'x' },
    ]) {
      expect(validateManual('BTCUSDT', { ...OK, ...bad }, 0).ok).toBe(false);
    }
  });
});

describe('parseStoredManual', () => {
  it('solo del mismo simbolo y valido', () => {
    const value = { symbol: 'BTCUSDT', ...OK, savedMs: 3 };
    expect(parseStoredManual(value, 'BTCUSDT')?.savedMs).toBe(3);
    expect(parseStoredManual(value, 'ETHUSDT')).toBeNull();
    expect(parseStoredManual({ ...value, entry: -1 }, 'BTCUSDT')).toBeNull();
    expect(parseStoredManual(null, 'BTCUSDT')).toBeNull();
    expect(manualStorageKey('BTCUSDT')).toBe('manualPosition:BTCUSDT');
  });
});

describe('manualToPositionView', () => {
  const m = { symbol: 'BTCUSDT', side: 'short' as const, entry: 100, size: 2, stop: 110, leverage: 3, savedMs: 0 };
  it('usa el ultimo precio como marca y calcula uPnL', () => {
    const v = manualToPositionView(m, 95)!;
    expect(v.mark).toBe(95);
    expect(v.uPnl).toBeCloseTo(10);
    expect(v.stop).toEqual({ price: 110, kind: 'order' });
    expect(v.liq).toBeNull();
  });
  it('sin precio => null', () => {
    expect(manualToPositionView(m, null)).toBeNull();
    expect(manualToPositionView(m, 0)).toBeNull();
  });
});

describe('withManualPosition', () => {
  const view = manualToPositionView({ symbol: 'BTCUSDT', side: 'long', entry: 100, size: 1, stop: null, leverage: 2, savedMs: 0 }, 101)!;
  const base = (mode: PanelState['mode']): PanelState => ({ mode, stale: false, snapshot: null, error: null });
  it('unknown + manual => position con snapshot', () => {
    const p = withManualPosition(base('unknown'), view, 'BTCUSDT', 1000);
    expect(p.mode).toBe('position');
    expect(p.stale).toBe(false);
    expect(p.snapshot?.positions[0]).toBe(view);
  });
  it('otros modos o sin vista: intacto', () => {
    const flat = base('flat');
    expect(withManualPosition(flat, view, 'BTCUSDT', 1)).toBe(flat);
    const unk = base('unknown');
    expect(withManualPosition(unk, null, 'BTCUSDT', 1)).toBe(unk);
  });
});
