import { describe, expect, it } from 'vitest';
import type { ScannerEvent } from './events';
import type { Plans } from './movers';
import type { StatsCell } from './stats';
import {
  ANALYSIS_NOTE, DEFAULT_FILTERS, GEOMETRY_TITLE, STUDY_LABEL, analysisLines, detailLines, filterEvents,
  geometry, hasEvidence, hhmm, isMutedEvent, mutedLabel, notificationText, planRows, rowText, sortEvents,
  verdictFor, volumeText,
} from './view';

const T0 = new Date(2026, 9, 19, 12, 35).getTime();

const plans: Plans = {
  follow: { mode: 'follow', direction: 'short', entry: 93.7, stop: 94.3, t1: 93.1, t2: 92.5, stop_dist: 0.6 },
  fade: { mode: 'fade', direction: 'long', entry: 93.9, stop: 93.3, t1: 94.5, t2: 95.1, stop_dist: 0.6 },
};

function cell(mode: 'follow' | 'fade', grade: StatsCell['grade'], over: Partial<StatsCell> = {}): StatsCell {
  return {
    signal: 'move30', mode, direction: mode === 'follow' ? 'short' : 'long', threshold: 5, vol_tier: 'hi', context: 'idio',
    n: 120, n_clusters: 110, wins_1r: 55, win_rate: 0.46, ci_low: 0.37, ci_high: 0.55, breakeven: 0.5, mean_net_r: -0.08,
    net_r_ci_low: -0.3, net_r_ci_high: 0.14, median_stop_pct: 0.006, events_per_day: 0.2, grade, ...over,
  };
}

function ev(over: Partial<ScannerEvent> = {}): ScannerEvent {
  return {
    id: 'SOLUSDT:move30:down:1', symbol: 'SOLUSDT', signal: 'move30', threshold: 5, move: 'down', ret: -0.062,
    vol_ratio: 3.1, tier: 'hi', q24: 412e6, takerImb: -0.2, marketWide: false, createdAtMs: T0, updatedAtMs: T0,
    prevThreshold: null, plans, cells: { follow: null, fade: null }, seen: false, ...over,
  };
}

describe('rowText', () => {
  it('matches the documented example and stays plain', () => {
    expect(rowText(ev())).toBe('12:35 SOLUSDT baja 6,2 % 30m · vol 3,1× · 412 M · Sin evidencia');
  });
  it('is at most 90 chars even with a long grade label and a long symbol', () => {
    const e = ev({
      symbol: '1000SHIBUSDT',
      cells: { follow: cell('follow', 'promising', { n: 123456 }), fade: null },
    });
    const t = rowText(e);
    expect(t.length).toBeLessThanOrEqual(90);
    expect(t).toContain('Prometedora');
  });
  it('never uses forbidden words', () => {
    for (const grade of ['no_evidence', 'negative', 'promising', 'validated'] as const) {
      const t = rowText(ev({ cells: { follow: cell('follow', grade), fade: null } })).toLowerCase();
      expect(t).not.toContain('probabilidad');
      expect(t).not.toContain('tasa de acierto');
    }
  });
  it('uses the best grade of the two cells', () => {
    const e = ev({ cells: { follow: cell('follow', 'negative'), fade: cell('fade', 'no_evidence', { n: 8 }) } });
    expect(rowText(e)).toContain('Sin evidencia (n=8)');
  });
  it('renders market rows', () => {
    const e = ev({ symbol: 'MARKET', ret: null, vol_ratio: null, q24: null, tier: null, count: 14, marketWide: true });
    expect(rowText(e)).toBe('12:35 Movimiento de mercado baja ≥ 5 % 30m · 14 pares');
  });
  it('hhmm and volumeText', () => {
    expect(hhmm(T0)).toBe('12:35');
    expect(volumeText(412e6)).toBe('412 M');
    expect(volumeText(1.25e9)).toBe('1,3 mil M');
  });
});

describe('detailLines', () => {
  it('lists move, volume, taker, market-wide and relative strength, never funding', () => {
    const lines = detailLines({ ...ev(), relBtc: -0.041 });
    const text = lines.join('\n');
    expect(text).toContain('Movimiento en 30 min: -6,2 %');
    expect(text).toContain('Volumen 3,1×');
    expect(text).toContain('Desequilibrio taker');
    expect(text).toContain('Movimiento de todo el mercado: no');
    expect(text).toContain('Fuerza relativa frente a BTC: -4,1 puntos');
    expect(text.toLowerCase()).not.toContain('funding');
  });
  it('mentions escalation', () => {
    expect(detailLines(ev({ threshold: 7, prevThreshold: 5 })).join('\n')).toContain('escaló desde 5 %');
  });
});

describe('planRows and geometry', () => {
  it('shows no levels without promising/validated cells, only the labelled geometry', () => {
    const e = ev({ cells: { follow: cell('follow', 'no_evidence'), fade: cell('fade', 'negative') } });
    const rows = planRows(e);
    expect(rows.map((r) => r.mode)).toEqual(['follow', 'fade']);
    expect(rows.every((r) => r.levels === null)).toBe(true);
    expect(rows[0]!.source).toBe(STUDY_LABEL);
    expect(rows[0]!.winRate).toContain('46,0 %');
    expect(rows[0]!.winRate).toContain('[37,0% - 55,0%]');
    expect(rows[0]!.breakeven).toBe('50,0 %');
    const g = geometry(e);
    expect(g?.title).toBe(GEOMETRY_TITLE);
    expect(g?.lines).toHaveLength(2);
    expect(g?.lines[0]).toContain('Entrada 93.7');
  });
  it('shows levels only for the promising cell', () => {
    const e = ev({ cells: { follow: cell('follow', 'promising', { net_r_ci_low: 0.05, mean_net_r: 0.1 }), fade: cell('fade', 'negative') } });
    const rows = planRows(e);
    expect(rows[0]!.levels).toContain('Stop 94.3');
    expect(rows[1]!.levels).toBeNull();
    expect(geometry(e)?.lines).toHaveLength(1);
  });
  it('handles missing cells and missing plans', () => {
    const e = ev({ plans: null });
    const rows = planRows(e);
    expect(rows[0]!.hasCell).toBe(false);
    expect(rows[0]!.grade).toBe('Sin evidencia');
    expect(geometry(e)).toBeNull();
  });
  it('directions follow the move', () => {
    expect(planRows(ev({ move: 'down' })).map((r) => r.direction)).toEqual(['Corto', 'Largo']);
    expect(planRows(ev({ move: 'up' })).map((r) => r.direction)).toEqual(['Largo', 'Corto']);
  });
});

describe('analysis verdict', () => {
  it('supports or opposes by direction', () => {
    expect(verdictFor('up', 'long')).toBe('supports');
    expect(verdictFor('up', 'short')).toBe('opposes');
    expect(verdictFor('down', 'short')).toBe('supports');
    expect(verdictFor('neutral', 'short')).toBe('neutral');
  });
  it('always carries the honesty note', () => {
    const lines = analysisLines({ label: 'Doble suelo', direction: 'up' }, ev());
    expect(lines[0]).toContain('Doble suelo');
    expect(lines.at(-1)).toBe(ANALYSIS_NOTE);
    expect(analysisLines(null, ev()).at(-1)).toBe(ANALYSIS_NOTE);
  });
});

describe('filters, muting and sorting', () => {
  const a = ev({ id: 'a', symbol: 'AUSDT', tier: 'hi', q24: 5e8, updatedAtMs: T0 });
  const b = ev({ id: 'b', symbol: 'BUSDT', tier: 'mid', q24: 5e7, updatedAtMs: T0 + 1000, marketWide: true,
    cells: { follow: cell('follow', 'promising'), fade: null } });
  const c = ev({ id: 'c', symbol: 'CUSDT', tier: 'lo', signal: 'move15', q24: 1e6, updatedAtMs: T0 + 2000,
    cells: { follow: cell('follow', 'negative'), fade: cell('fade', 'negative') } });
  const all = [a, b, c];

  it('isMutedEvent: only when every known cell is muted; overrides win', () => {
    expect(isMutedEvent(a)).toBe(false);
    expect(isMutedEvent(c)).toBe(true);
    expect(isMutedEvent(b)).toBe(false);
    const key = 'move30|follow|short|5|hi|idio';
    expect(isMutedEvent(c, { unmutedCells: [key] })).toBe(false);
  });
  it('hasEvidence', () => {
    expect(hasEvidence(a)).toBe(false);
    expect(hasEvidence(b)).toBe(true);
  });
  it('filters by tier, signal, evidence, market-wide and muted', () => {
    expect(filterEvents(all, { ...DEFAULT_FILTERS, tier: 'mid' }).map((e) => e.id)).toEqual(['b']);
    expect(filterEvents(all, { ...DEFAULT_FILTERS, signal: 'move15' }).map((e) => e.id)).toEqual(['c']);
    expect(filterEvents(all, { ...DEFAULT_FILTERS, onlyEvidence: true }).map((e) => e.id)).toEqual(['b']);
    expect(filterEvents(all, { ...DEFAULT_FILTERS, hideMarketWide: true }).map((e) => e.id)).toEqual(['a', 'c']);
    expect(filterEvents(all, { ...DEFAULT_FILTERS, showMuted: false }).map((e) => e.id)).toEqual(['a', 'b']);
    expect(filterEvents(all, DEFAULT_FILTERS)).toHaveLength(3);
  });
  it('sorts by recency or volume without mutating', () => {
    expect(sortEvents(all, 'recent').map((e) => e.id)).toEqual(['c', 'b', 'a']);
    expect(sortEvents(all, 'volume').map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(all.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
  it('mutedLabel', () => {
    expect(mutedLabel(3)).toBe('Silenciadas (3)');
  });
});

describe('notificationText', () => {
  it('builds from numbers and a validated symbol only', () => {
    expect(notificationText(ev())).toEqual({ title: 'SOLUSDT baja 6,2 % en 30 min', message: 'Volumen 3,1× · Sin evidencia' });
    expect(notificationText(ev({ symbol: '<b>x</b>' }))).toBeNull();
  });
});
