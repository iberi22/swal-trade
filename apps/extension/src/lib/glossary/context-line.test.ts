import { describe, expect, it } from 'vitest';
import { entryById } from './entries';
import { trendContext, trendFromDirection, trendFromRegimen, trendLabel } from './context-line';
import { entryText, uiText } from './text';
import type { TimeframeTrend } from '../types';

describe('trendContext', () => {
  it('antepone la tendencia actual al texto de esa tendencia', () => {
    const entry = entryById('prevDayHigh')!;
    for (const [trend, label] of [
      ['up', 'alcista'],
      ['down', 'bajista'],
      ['range', 'lateral'],
    ] as const) {
      const text = trendContext(entry, trend);
      expect(text).not.toBeNull();
      expect(text!.startsWith(`Tendencia actual: ${label} — `)).toBe(true);
      expect(text).toContain(entryText(entry.id, trend));
      expect(text).toContain(uiText(`trend_${trend}`));
    }
  });

  it('sin tendencia no hay línea (no se inventa contexto)', () => {
    expect(trendContext(entryById('prevDayHigh')!, null)).toBeNull();
    expect(trendContext(null, 'up')).toBeNull();
    expect(trendContext(undefined, 'down')).toBeNull();
  });

  it('etiquetas de tendencia en español', () => {
    expect(trendLabel('up')).toBe('alcista');
    expect(trendLabel('down')).toBe('bajista');
    expect(trendLabel('range')).toBe('lateral');
  });
});

describe('trendFromRegimen', () => {
  const row = (timeframe: TimeframeTrend['timeframe'], direction: TimeframeTrend['direction']): TimeframeTrend => ({
    timeframe,
    direction,
    label: direction,
  });

  it('prefiere 1h y traduce neutral a lateral', () => {
    expect(trendFromRegimen([row('15m', 'down'), row('1h', 'up'), row('4h', 'down')])).toBe('up');
    expect(trendFromRegimen([row('15m', 'up'), row('1h', 'neutral')])).toBe('range');
    expect(trendFromRegimen([row('15m', 'up'), row('4h', 'down')])).toBe('up');
  });

  it('sin régimen no hay tendencia', () => {
    expect(trendFromRegimen(null)).toBeNull();
    expect(trendFromRegimen(undefined)).toBeNull();
    expect(trendFromRegimen([])).toBeNull();
    expect(trendFromDirection('raro')).toBeNull();
  });
});
