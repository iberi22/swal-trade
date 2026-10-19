import { describe, expect, it } from 'vitest';
import type { Candle } from '../types';
import {
  atrFromCandles,
  buildRuleInput,
  currentR,
  fundingCountdown,
  initialStopKey,
  positionCardView,
  rememberInitialStop,
  ruleLine,
  stopDistancePct,
  topRules,
  type InitialStopStore,
} from './position-view-model';
import type { AccountSnapshot, PositionView } from './types';

const POS: PositionView = {
  symbol: 'BTCUSDT', side: 'long', size: 0.1, entry: 100, mark: 105, liq: 80, leverage: 5,
  marginType: 'cross', uPnl: 0.5, breakEven: null, notional: 10.5, stop: null, firstFillMs: null,
};
const SNAP: AccountSnapshot = {
  fetchedAt: 1000, equity: 1000, dailyPnl: null, positions: [POS], fundingRate: 0.0001, nextFundingMs: 1000 + 83 * 60_000,
};
const candle = (i: number, range = 2): Candle => ({ time: i, open: 100, high: 101 + range / 2, low: 99 - range / 2 + 1, close: 100, volume: 1 });

describe('atrFromCandles', () => {
  it('null con menos de 15 velas', () => {
    expect(atrFromCandles(Array.from({ length: 14 }, (_, i) => candle(i)))).toBeNull();
  });
  it('rango constante => ATR igual al rango', () => {
    const c = Array.from({ length: 30 }, (_, i) => ({ ...candle(i), high: 102, low: 98 }));
    expect(atrFromCandles(c)).toBeCloseTo(4, 9);
  });
  it('null con datos no finitos', () => {
    const c = Array.from({ length: 20 }, (_, i) => candle(i));
    c[5] = { ...c[5]!, high: NaN };
    expect(atrFromCandles(c)).toBeNull();
  });
});

describe('R y distancias', () => {
  it('sin stop => null', () => {
    expect(currentR(POS)).toBeNull();
    expect(stopDistancePct(POS)).toBeNull();
  });
  it('largo: stop 95, marca 105 => R=1', () => {
    const p = { ...POS, stop: { price: 95, kind: 'order' as const } };
    expect(currentR(p)).toBeCloseTo(1);
    expect(stopDistancePct(p)).toBeCloseTo((10 / 105) * 100);
  });
  it('corto con signo invertido', () => {
    const p: PositionView = { ...POS, side: 'short', mark: 95, stop: { price: 105, kind: 'order' } };
    expect(currentR(p)).toBeCloseTo(1);
  });
  it('stop en la entrada => null', () => {
    expect(currentR({ ...POS, stop: { price: 100, kind: 'order' } })).toBeNull();
  });
});

describe('rememberInitialStop', () => {
  const memory = (): InitialStopStore & { data: Map<string, number> } => {
    const data = new Map<string, number>();
    return { data, get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v) };
  };
  it('guarda el primer stop y lo conserva al moverse', async () => {
    const store = memory();
    const a = { ...POS, stop: { price: 95, kind: 'order' as const } };
    expect(await rememberInitialStop(store, a)).toBe(95);
    expect(await rememberInitialStop(store, { ...a, stop: { price: 90, kind: 'order' } })).toBe(95);
  });
  it('sin stop y sin registro => null y no guarda', async () => {
    const store = memory();
    expect(await rememberInitialStop(store, POS)).toBeNull();
    expect(store.data.size).toBe(0);
  });
  it('la sal separa entradas manuales distintas', () => {
    expect(initialStopKey(POS, 'a')).not.toBe(initialStopKey(POS, 'b'));
  });
  it('un almacén roto no lanza', async () => {
    const bad: InitialStopStore = { get: async () => { throw new Error('x'); }, set: async () => {} };
    expect(await rememberInitialStop(bad, POS)).toBeNull();
  });
});

describe('buildRuleInput', () => {
  it('arma ATR, stop inicial y reglas', () => {
    const candles = Array.from({ length: 20 }, (_, i) => candle(i));
    const input = buildRuleInput({
      position: POS, snapshot: SNAP, candles,
      rules: { maxRiskPct: 1, maxLeverage: 10, dailyLossUsd: 10, revengeMinutes: 15 },
      initialStopPrice: 95, now: 5,
    });
    expect(input.atr).not.toBeNull();
    expect(input.initialStopPrice).toBe(95);
    expect(input.now).toBe(5);
  });
});

describe('texto', () => {
  it('prefijos por gravedad y 90 caracteres como maximo', () => {
    expect(ruleLine({ sev: 'critical', text: 'a' })).toBe('!! a');
    expect(ruleLine({ sev: 'warn', text: 'a' })).toBe('! a');
    expect(ruleLine({ sev: 'info', text: 'a' })).toBe('i a');
    expect(ruleLine({ sev: 'info', text: 'x'.repeat(200) }).length).toBe(90);
  });
  it('topRules parte 3 y el resto', () => {
    const rs = Array.from({ length: 5 }, (_, i) => ({ code: String(i), sev: 'info' as const, text: 't', values: {} }));
    const { top, rest } = topRules(rs);
    expect(top).toHaveLength(3);
    expect(rest).toHaveLength(2);
  });
  it('cuenta atras de funding', () => {
    expect(fundingCountdown(0, 1)).toBe('ahora');
    expect(fundingCountdown(30 * 60_000, 0)).toBe('30 min');
    expect(fundingCountdown(120 * 60_000, 0)).toBe('2 h');
    expect(fundingCountdown(83 * 60_000, 0)).toBe('1 h 23 min');
  });
  it('tarjeta: sin stop, liquidacion y funding en 6 lineas o menos', () => {
    const v = positionCardView(POS, SNAP, 1000);
    expect(v.lines.length).toBeLessThanOrEqual(6);
    expect(v.lines[0]).toBe('LARGO · 0.1 BTCUSDT · 5x · cruzado');
    expect(v.lines).toContain('SIN STOP');
    expect(v.noStop).toBe(true);
    expect(v.lines.join('\n')).toContain('Liquidación a 23.8 %');
    expect(v.lines.at(-1)).toContain('cobro en 1 h 23 min');
  });
  it('tarjeta con stop, manual y caducado', () => {
    const p = { ...POS, stop: { price: 95, kind: 'order' as const } };
    const v = positionCardView(p, null, 0, { stale: true, manual: true });
    expect(v.lines[0]).toContain('MANUAL');
    expect(v.lines[0]).toContain('CADUCADO');
    expect(v.lines[1]).toContain('+1R');
    expect(v.lines[2]).toMatch(/^Stop a 9\.52 %/);
    expect(v.noStop).toBe(false);
    expect(v.lines).toHaveLength(4);
  });
});
