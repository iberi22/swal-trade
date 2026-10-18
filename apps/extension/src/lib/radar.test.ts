import { describe, expect, it, vi } from 'vitest';
import {
  fetchRadarSnapshot, formatR, formatWilson, radarDirectionLabel,
  radarStatusLabel, sanitizeRadarAlert, sanitizeRadarStats, shapesForRadarAlert, type RadarAlert,
  gradeView,
} from './radar';

describe('radar mappings & formatters', () => {
  it('traduce estados y direcciones', () => {
    expect(radarStatusLabel('pending')).toBe('Pendiente');
    expect(radarStatusLabel('win_2r')).toBe('Ganó 2R');
    expect(radarDirectionLabel('long')).toBe('Largo');
    expect(radarDirectionLabel('short')).toBe('Corto');
  });
  it('formatea intervalos Wilson y R neto', () => {
    expect(formatWilson({ rate: 0.5, low: 0.35, high: 0.65 })).toBe('[35,0% - 65,0%]');
    expect(formatWilson(null)).toBe('');
    expect(formatR(0.12)).toBe('+0,12 R');
    expect(formatR(-0.5)).toBe('-0,50 R');
  });
});

describe('sanitizeRadarAlert', () => {
  const valid = { id: 1, source: 'core', symbol: 'BTCUSDC', tf: '15m', kind: 'fvg', title: 'FVG',
    direction: 'long', entry: 82000, stop: 81000, target_1r: 83000, target_2r: 84000, strength: 0.8, status: 'pending' };

  it('valida alerta y descarta payloads hostiles o sin precios finitos', () => {
    expect(sanitizeRadarAlert(valid)?.symbol).toBe('BTCUSDC');
    expect(sanitizeRadarAlert(null)).toBeNull();
    expect(sanitizeRadarAlert({ ...valid, entry: NaN })).toBeNull();
    // An unknown status must not become an invented open alert.
    expect(sanitizeRadarAlert({ ...valid, status: 'hack' })).toBeNull();
    expect(sanitizeRadarAlert({ ...valid, direction: 'inv' })).toMatchObject({ status: 'pending', direction: 'long' });
    expect(sanitizeRadarAlert({ ...valid, status: 'missed' })).toMatchObject({ status: 'missed' });
    expect(radarStatusLabel('missed')).toBe('Entrada superada');
  });

  it('extrae cell_grade y cell_n con valores por defecto seguros', () => {
    const alert = sanitizeRadarAlert({ ...valid, cell_grade: 'validated', cell_n: 42 });
    expect(alert).toMatchObject({ cellGrade: 'validated', cellN: 42 });
  });

  it('usa no_evidence y 0 si faltan cell_grade o cell_n', () => {
    const alert = sanitizeRadarAlert({ ...valid });
    expect(alert).toMatchObject({ cellGrade: 'no_evidence', cellN: 0 });
  });

  it('protege de tipos invalidos en cell_grade y cell_n', () => {
    const alert = sanitizeRadarAlert({ ...valid, cell_grade: null, cell_n: 'muchos' });
    expect(alert).toMatchObject({ cellGrade: 'no_evidence', cellN: 0 });
  });
});

describe('gradeView', () => {
  it('mapea grado negative', () => {
    expect(gradeView('negative', 40)).toMatchObject({ label: 'Resultado negativo (n=40)', tone: 'warn' });
  });
  it('mapea grado promising', () => {
    expect(gradeView('promising', 50)).toMatchObject({ label: 'Prometedora, falta validar (n=50)', tone: 'info' });
  });
  it('mapea grado validated', () => {
    expect(gradeView('validated', 140)).toMatchObject({ label: 'Validada (n=140)', tone: 'ok' });
  });
  it('mapea grado no_evidence', () => {
    expect(gradeView('no_evidence', 25)).toMatchObject({ label: 'Sin evidencia (n=25)', tone: 'muted' });
  });
  it('aplica fallback a no_evidence para grados desconocidos', () => {
    expect(gradeView('inventado', 10)).toMatchObject({ label: 'Sin evidencia (n=10)', tone: 'muted' });
    expect(gradeView('inventado', 10).tone).not.toBe('ok');
  });
  it('maneja n faltante, nulo o cero mostrando Sin evidencia', () => {
    expect(gradeView(undefined, 0)).toMatchObject({ label: 'Sin evidencia', tone: 'muted' });
    expect(gradeView(null, null)).toMatchObject({ label: 'Sin evidencia', tone: 'muted' });
  });
  it('maneja n negativo limitando a cero', () => {
    expect(gradeView('validated', -5)).toMatchObject({ label: 'Validada (n=0)', tone: 'ok' });
  });
});

describe('sanitizeRadarStats & honesty', () => {
  it('aplica regla: sin evidencia si n_resolved < 30', () => {
    const raw = { overall: { n_resolved: 10, label: 'ventaja' }, taken: { n_resolved: 5 } };
    const s = sanitizeRadarStats(raw);
    expect(s.overall.label).toBe('sin evidencia (n<30)');
    expect(s.taken.label).toBe('sin evidencia (n<30)');
  });
  it('permite etiqueta con n_resolved >= 30', () => {
    const raw = { overall: { n_resolved: 35, label: 'evidencia' }, by_kind: [{ n_resolved: 30, kind: 'fvg', label: 'ok' }] };
    const s = sanitizeRadarStats(raw);
    expect(s.overall.label).toBe('evidencia');
    expect(s.by_kind[0]?.label).toBe('ok');
  });
});

describe('shapesForRadarAlert', () => {
  it('construye 4 niveles con prefijo Radar:', () => {
    const alert: RadarAlert = { id: 1, source: 'core', symbol: 'BTCUSDC', tf: '15m', kind: 'fvg', title: 'FVG',
      direction: 'long', entry: 82000, stop: 81000, target_1r: 83000, target_2r: 84000, strength: 0.8, status: 'pending',
      created_at: '2026-10-16T00:00:00Z', triggered_at: null, resolved_at: null, outcome_r: null, mfe_r: 0, mae_r: 0,
      taken_by_user: false, user_entry: null, user_pnl: null, cellGrade: 'no_evidence', cellN: 0 };
    const shapes = shapesForRadarAlert(alert);
    expect(shapes).toHaveLength(4);
    expect(shapes.every(s => s.kind === 'level' && s.text.startsWith('Radar:'))).toBe(true);
    expect(shapes.find(s => s.id.includes('stop'))?.style).toBe('dashed');
  });
});

describe('fetchRadarSnapshot', () => {
  it('devuelve reachable: false y no lanza si el servidor falla', async () => {
    const mock = vi.fn().mockRejectedValue(new Error('fail'));
    const snap = await fetchRadarSnapshot(47322, mock as unknown as typeof fetch);
    expect(snap.reachable).toBe(false);
  });
  it('devuelve snapshot con servidor sano', async () => {
    const mock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/v1/health')) return { ok: true, json: async () => ({ ok: true, version: '1.0.0' }) };
      if (url.includes('/v1/alerts')) return { ok: true, json: async () => ({ alerts: [] }) };
      return { ok: true, json: async () => ({ overall: { n_resolved: 0 } }) };
    });
    const snap = await fetchRadarSnapshot(47322, mock as unknown as typeof fetch);
    expect(snap.reachable).toBe(true);
    expect(snap.version).toBe('1.0.0');
  });
});
