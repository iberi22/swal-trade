import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  atr14, alertDict, barsFromKlines, breadth, canonicalJson, CooldownTracker, detectEvents, indexOf,
  plansForEvent, relBtc, retW, specSha, SPEC, takerImb, volRatio, volTier, type Bar,
} from './movers';

const DIR = new URL('./spec/golden/', import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (n: string): any => JSON.parse(readFileSync(new URL(n + '.json', DIR), 'utf8'));

function expectClose(actual: unknown, expected: unknown, path = '$'): void {
  if (typeof expected === 'number') {
    expect(typeof actual, path).toBe('number');
    const a = actual as number;
    expect(Math.abs(a - expected), `${path}: ${a} vs ${expected}`).toBeLessThanOrEqual(1e-9 + 1e-9 * Math.abs(expected));
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, path).toBe(expected.length);
    expected.forEach((e, n) => expectClose((actual as unknown[])[n], e, `${path}[${n}]`));
  } else if (expected && typeof expected === 'object') {
    expect(actual && typeof actual === 'object', path).toBeTruthy();
    const a = actual as Record<string, unknown>;
    expect(Object.keys(a).sort(), path).toEqual(Object.keys(expected).sort());
    for (const k of Object.keys(expected)) expectClose(a[k], (expected as Record<string, unknown>)[k], `${path}.${k}`);
  } else {
    expect(actual, path).toBe(expected);
  }
}

const mk = (n: number, close: number, extra: Partial<Bar> = {}): Bar => ({
  open_time_ms: 1_000_000_000 + n * 300000, open: close, high: close, low: close, close,
  volume: 1, quote_volume: close, taker_buy_volume: 0.5, ...extra,
});

describe('spec', () => {
  it('sha equals the one recorded in every golden', async () => {
    const sha = await specSha();
    for (const n of ['detect', 'plans', 'alerts', 'metrics', 'cooldown', 'burst']) {
      expect(load(n).spec_sha, n).toBe(sha);
    }
  });
  it('canonical json is compact and sorted', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
});

describe('golden detect', () => {
  const g = load('detect');
  for (const c of g.cases) {
    it(c.name, () => {
      // el golden no guarda q24 por simbolo: se recupera de los eventos esperados (solo importan esos simbolos)
      const q24: Record<string, number> = {};
      for (const e of c.expected) q24[e.symbol] = e.q24;
      const ev = detectEvents(g.datasets[c.dataset], c.i_time, q24, SPEC, c.btc_symbol);
      expectClose(ev, c.expected);
    });
  }
  it('has events on the signal bar and none on unknown bar', () => {
    const by = (n: string) => g.cases.find((c: { name: string }) => c.name === n).expected;
    expect(by('main_signal_bar').length).toBeGreaterThan(0);
    expect(by('unknown_bar')).toEqual([]);
    expect(by('main_bar_after')).toEqual([]);
  });
});

describe('golden plans', () => {
  for (const c of load('plans').cases) it(c.name, () => expectClose(plansForEvent(c.event, SPEC), c.expected));
});

describe('golden alerts', () => {
  for (const c of load('alerts').cases) {
    it(c.name, () => expectClose(alertDict(c.symbol, c.event, c.plan, SPEC), c.expected));
  }
});

describe('golden metrics', () => {
  const g = load('metrics');
  for (const c of g.cases) {
    it(c.name, () => {
      const bars: Bar[] = g.datasets[c.dataset][c.symbol];
      expectClose(
        {
          ret_w: retW(bars, c.i, c.W),
          vol_ratio: volRatio(bars, c.i, c.W, SPEC),
          taker_imb: takerImb(bars, c.i, c.W),
          atr14: atr14(bars, c.i),
        },
        c.expected,
      );
    });
  }
  it('tiers', () => {
    for (const t of g.tiers) expect(volTier(t.q24, SPEC), String(t.q24)).toBe(t.expected);
  });
});

describe('golden cooldown', () => {
  const g = load('cooldown');
  it('sequence', () => {
    const tr = new CooldownTracker(SPEC);
    for (const s of g.steps) expectClose(tr.process(s.events), s.expected, s.name);
  });
});

describe('golden burst', () => {
  const g = load('burst');
  it('steps', () => {
    const tr = new CooldownTracker(SPEC);
    // paso 1 con el tracker A; paso 2 con uno nuevo; paso 3 con el tracker A otra vez
    expectClose(tr.process(g.steps[0].events), g.steps[0].expected, g.steps[0].name);
    expectClose(new CooldownTracker(SPEC).process(g.steps[1].events), g.steps[1].expected, g.steps[1].name);
    expectClose(tr.process(g.steps[2].events), g.steps[2].expected, g.steps[2].name);
  });
  it('wide events are detected from the dataset and collapse to market events', () => {
    const q24: Record<string, number> = {};
    for (const e of g.steps[0].events) q24[e.symbol] = e.q24;
    const ev = detectEvents(g.datasets.wide, g.steps[0].i_time, q24, SPEC);
    expectClose(ev, g.steps[0].events);
    expect(g.steps[0].expected.every((o: { event: { symbol: string } }) => o.event.symbol === 'MARKET')).toBe(true);
  });
});

describe('edge cases', () => {
  const flat = (n: number) => Array.from({ length: n }, (_, k) => mk(k, 100));

  it('gap inside the window gives null', () => {
    const bars = flat(10);
    expect(retW(bars, 9, 6)).toBe(0);
    bars.splice(5, 1);
    expect(retW(bars, 8, 6)).toBeNull();
    expect(retW(bars, 2, 6)).toBeNull(); // short history
  });

  it('indexOf finds only exact open times', () => {
    const bars = flat(5);
    expect(indexOf(bars, bars[3].open_time_ms)).toBe(3);
    expect(indexOf(bars, bars[3].open_time_ms + 1)).toBeNull();
  });

  const path = (closes: number[]) => closes.map((c, k) => mk(k, c));
  const base = new Array(30).fill(100);

  it('edge trigger: fires once on the crossing, not while still above T', () => {
    const closes = [...base, 100, 100, 100, 100, 100, 104, 104.2, 104.5, 104.8];
    const bars = path(closes);
    const at = (i: number) => detectEvents({ X: bars }, bars[i].open_time_ms, { X: 1e6 }, SPEC);
    const hit = at(35);
    expect(hit.filter((e) => e.signal === 'move30' && e.threshold === 3)).toHaveLength(1);
    expect(at(36)).toEqual([]);
    expect(at(37)).toEqual([]);
    expect(at(38)).toEqual([]);
  });

  it('a gap in the previous window means no event', () => {
    const closes = [...base, 100, 100, 100, 100, 100, 104];
    const bars = path(closes);
    bars.splice(31, 1); // hueco dentro de la ventana de i-1
    const i = bars.length - 1;
    expect(detectEvents({ X: bars }, bars[i].open_time_ms, { X: 1e6 }, SPEC)).toEqual([]);
  });

  it('percent comparison is abs(ret)*100 >= T for down moves too', () => {
    const bars = path([...base, 100, 100, 100, 100, 100, 94]);
    const i = bars.length - 1;
    const ev = detectEvents({ X: bars }, bars[i].open_time_ms, { X: 1e6 }, SPEC);
    expect(ev.map((e) => [e.signal, e.threshold, e.move]).sort()).toContainEqual(['move30', 3, 'down']);
    expect(ev.every((e) => e.close_time_ms === e.open_time_ms + 300000)).toBe(true);
  });

  it('fast2 is never detected (bar_minutes differs)', () => {
    const bars = path([...base, 100, 100, 100, 100, 100, 104]);
    const i = bars.length - 1;
    const ev = detectEvents({ X: bars }, bars[i].open_time_ms, { X: 1e6 }, SPEC);
    expect(ev.some((e) => e.signal === 'fast2')).toBe(false);
  });

  it('plans: entry beyond close for follow and fade', () => {
    const up = plansForEvent({ ret: 0.04, close: 100, atr14: 1 }, SPEC);
    expect(up.follow!.entry).toBeCloseTo(100.25, 12);
    expect(up.follow!.direction).toBe('long');
    expect(up.fade!.entry).toBeCloseTo(99.75, 12);
    expect(up.fade!.direction).toBe('short');
    const dn = plansForEvent({ ret: -0.04, close: 100, atr14: 1 }, SPEC);
    expect(dn.follow!.entry).toBeCloseTo(99.75, 12);
    expect(dn.follow!.direction).toBe('short');
    expect(dn.fade!.entry).toBeCloseTo(100.25, 12);
    expect(dn.fade!.direction).toBe('long');
  });

  it('plans: stop floor, cap skip, one side only, missing atr', () => {
    const floor = plansForEvent({ ret: 0.04, close: 100, atr14: 0.04 }, SPEC);
    expect(floor.follow!.stop_dist).toBeCloseTo(0.003 * floor.follow!.entry, 12);
    expect(plansForEvent({ ret: 0.04, close: 100, atr14: 4 }, SPEC)).toEqual({ follow: null, fade: null });
    const one = plansForEvent({ ret: 0.04, close: 100, atr14: 3.33 }, SPEC);
    expect(one.follow).not.toBeNull();
    expect(one.fade).toBeNull();
    expect(plansForEvent({ ret: 0.04, close: 100, atr14: null }, SPEC)).toEqual({ follow: null, fade: null });
    expect(plansForEvent({ ret: 0.04, close: 100, atr14: 0 }, SPEC)).toEqual({ follow: null, fade: null });
  });

  it('breadth, relBtc, takerImb', () => {
    expect(breadth({ a: null }, 1, 3)).toBeNull();
    expect(breadth({ a: 0.02, b: -0.02, c: 0.001, d: null }, 1, 3)).toBeCloseTo(1 / 3, 12);
    expect(relBtc(0.05, null)).toBeNull();
    expect(relBtc(0.05, 0.01)).toBeCloseTo(0.04, 12);
    expect(takerImb(flat(5).map((b) => ({ ...b, volume: 0 })), 4, 3)).toBeNull();
  });

  it('alert title uses comma decimal and round-half-even like Python', () => {
    const ev = { move: 'up' as const, window_min: 30, threshold: 3, tier: 'mid', ret: 0.0425, signal: 'move30', close_time_ms: 5000 };
    const plan = plansForEvent({ ret: 0.0425, close: 100, atr14: 1 }, SPEC).follow!;
    const a = alertDict('X', ev, plan, SPEC);
    expect(a.title.startsWith('Sube 4,')).toBe(true);
    expect(a.created_at).toBe(5);
    expect(a.strength).toBe(0.5);
  });

  it('barsFromKlines maps indexes 0,1,2,3,4,5,7,9', () => {
    const row = [1000, '1', '2', '0.5', '1.5', '10', 1999, '15', 7, '4', '0', '0'];
    expect(barsFromKlines([row])).toEqual([
      { open_time_ms: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, quote_volume: 15, taker_buy_volume: 4 },
    ]);
  });
});
