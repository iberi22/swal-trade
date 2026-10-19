import { describe, it, expect } from 'vitest';
import {
  cellFor, cellKey, emptyStats, fetchMoversStats, gradeFor, isCellKey, muted, sanitizeCell, sanitizeMoversStats,
  STATS_TTL_MS, type FetchFn, type StatsCell,
} from './stats';
import type { KeyValueStorage } from './settings';

const cell = (over: Partial<StatsCell> = {}): StatsCell => ({
  signal: 'move30', mode: 'follow', direction: 'long', threshold: 5, vol_tier: 'hi', context: 'all',
  n: 300, n_clusters: 120, wins_1r: 140, win_rate: 0.47, ci_low: 0.42, ci_high: 0.52, breakeven: 0.5,
  mean_net_r: -0.1, net_r_ci_low: -0.2, net_r_ci_high: -0.01, median_stop_pct: 0.01, events_per_day: 1.2,
  grade: 'negative', ...over,
});
const doc = (cells: unknown[] = [cell()], over: Record<string, unknown> = {}) => ({
  schema: 'swal.movers-stats.v1', method: 'study', spec_version: '2026-10-19.1',
  period: { from: 'a', to: 'b' }, universe: { quote: 'USDT', top_n: 100, rank_rule: 'q24' },
  bar: '5m', cost_round_trip: 0.0008, evaluator: 'ev', generated_at: '2026-10-19T00:00:00Z', cells, note: 'n', ...over,
});
const Q = { mode: 'follow' as const, direction: 'long' as const, threshold: 5, tier: 'hi', signal: 'move30', context: 'all' };

describe('sanitizeMoversStats', () => {
  it('accepts a good doc and strips unknown top-level keys', () => {
    const s = sanitizeMoversStats(doc([cell()], { extra: 1 }))!;
    expect(s.cells).toHaveLength(1);
    expect(s).not.toHaveProperty('extra');
    expect(s.spec_version).toBe('2026-10-19.1');
  });
  it('rejects bad documents', () => {
    for (const bad of [
      null, [], 'x', doc([], { schema: 'other' }), doc([], { method: 'live' }), doc([], { spec_version: 'a b' }),
      doc([], { cost_round_trip: 1 }), doc([], { cells: 'x' }),
    ]) {
      expect(sanitizeMoversStats(bad)).toBeNull();
    }
    expect(sanitizeMoversStats(doc(new Array(501).fill(cell())))).toBeNull();
  });
  it('drops invalid cells but keeps valid ones', () => {
    const s = sanitizeMoversStats(doc([
      cell(),
      cell({ threshold: 4 as 5 }),
      cell({ mode: 'x' as 'fade' }),
      cell({ n_clusters: 999 }),
      cell({ ci_low: 0.6 }),
      cell({ mean_net_r: 11, net_r_ci_high: 12 }),
      { ...cell(), extra: 1 },
      cell({ grade: 'validated' }), // sin evidencia suficiente
      cell({ grade: 'promising' }), // net_r_ci_low <= 0
      cell({ grade: 'bogus' as 'negative' }),
      5,
    ]))!;
    expect(s.cells).toHaveLength(1);
  });
  it('mirrors grade coherence', () => {
    const good = cell({ grade: 'validated', n_clusters: 100, ci_low: 0.55, ci_high: 0.6, win_rate: 0.57, breakeven: 0.5, mean_net_r: 0.2, net_r_ci_low: 0.1, net_r_ci_high: 0.3 });
    expect(sanitizeCell(good)).not.toBeNull();
    expect(sanitizeCell({ ...good, n_clusters: 99 })).toBeNull();
    expect(sanitizeCell({ ...good, ci_low: 0.51 })).toBeNull();
  });
  it('empty published doc is treated as no data', () => {
    const s = sanitizeMoversStats({ schema: 'swal.movers-stats.v1', method: 'study', cells: [], note: 'Aun no hay datos publicados.' })!;
    expect(s.cells).toEqual([]);
    expect(s.spec_version).toBe('');
  });
});

describe('cell lookup, grade and mute', () => {
  const stats = sanitizeMoversStats(doc())!;
  it('cellFor finds by all dimensions', () => {
    expect(cellFor(stats, Q)).not.toBeNull();
    expect(cellFor(stats, { ...Q, threshold: 7 })).toBeNull();
    expect(cellFor(stats, { ...Q, context: 'idio' })).toBeNull();
    expect(cellFor(null, Q)).toBeNull();
  });
  it('gradeFor reuses gradeView labels', () => {
    const g = gradeFor(stats, '2026-10-19.1', Q);
    expect(g.grade).toBe('negative');
    expect(g.view.label).toBe('Resultado negativo (n=300)');
    expect(g.note).toBeNull();
  });
  it('spec_version mismatch -> no_evidence with note and no cell', () => {
    const g = gradeFor(stats, '2099-01-01.1', Q);
    expect(g.grade).toBe('no_evidence');
    expect(g.cell).toBeNull();
    expect(g.note).toMatch(/versión/);
    expect(g.view.label).toBe('Sin evidencia');
  });
  it('no cell or unreachable stats -> no_evidence', () => {
    expect(gradeFor(stats, '2026-10-19.1', { ...Q, threshold: 3 }).grade).toBe('no_evidence');
    const e = gradeFor(emptyStats(), '2026-10-19.1', Q);
    expect(e.grade).toBe('no_evidence');
    expect(e.note).toBeTruthy();
    expect(gradeFor(null, 'x', Q).grade).toBe('no_evidence');
  });
  it('negative muted by default; user overrides win per cell key', () => {
    const neg = cell();
    const key = cellKey(neg);
    expect(key).toBe('move30|follow|long|5|hi|all');
    expect(isCellKey(key)).toBe(true);
    expect(muted(neg)).toBe(true);
    expect(muted(neg, { unmutedCells: [key] })).toBe(false);
    const prom = cell({ grade: 'promising', net_r_ci_low: 0.1, mean_net_r: 0.2, net_r_ci_high: 0.3 });
    expect(muted(prom)).toBe(false);
    expect(muted(prom, { mutedCells: [key] })).toBe(true);
    expect(muted(neg, { mutedCells: [key], unmutedCells: [key] })).toBe(false);
    expect(muted(null)).toBe(false);
  });
});

describe('fetchMoversStats', () => {
  const memStorage = (): KeyValueStorage & { data: Map<string, unknown> } => {
    const data = new Map<string, unknown>();
    return { data, get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v) };
  };
  const okFetch = (body: unknown, calls: string[] = []): FetchFn => async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => body };
  };

  it('fetches study, caches for 6 hours then refetches', async () => {
    const st = memStorage();
    const calls: string[] = [];
    let t = 1_000_000;
    const opts = { storage: st, now: () => t };
    const a = await fetchMoversStats(okFetch(doc(), calls), 'study', opts);
    expect(a.cells).toHaveLength(1);
    expect(calls).toEqual(['https://trade.swal.network/api/movers-stats?method=study']);
    t += STATS_TTL_MS - 1;
    await fetchMoversStats(okFetch(doc(), calls), 'study', opts);
    expect(calls).toHaveLength(1);
    t += 2;
    await fetchMoversStats(okFetch(doc(), calls), 'study', opts);
    expect(calls).toHaveLength(2);
  });
  it('failures return empty stats', async () => {
    const thr: FetchFn = async () => { throw new Error('offline'); };
    expect((await fetchMoversStats(thr, 'study')).cells).toEqual([]);
    const bad: FetchFn = async () => ({ ok: false, status: 500, json: async () => ({}) });
    expect((await fetchMoversStats(bad, 'study')).spec_version).toBe('');
    expect((await fetchMoversStats(okFetch({ junk: 1 }), 'study')).cells).toEqual([]);
    expect((await fetchMoversStats(okFetch(doc([], { method: 'forward' })), 'study')).cells).toEqual([]);
  });
  it('times out a hanging request', async () => {
    const hang: FetchFn = (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('abort'))));
    expect((await fetchMoversStats(hang, 'study', { timeoutMs: 10 })).cells).toEqual([]);
  });
  it('does not cache a bad document', async () => {
    const st = memStorage();
    await fetchMoversStats(okFetch({ junk: 1 }), 'study', { storage: st });
    expect(st.data.size).toBe(0);
  });
});
