import { describe, expect, it } from 'vitest';
import type { PositionDrawing } from './types';
import { MAX_STOP_DISTANCE_PCT, validateDrawing } from './validate';

const base: PositionDrawing = {
  id: 'd1',
  side: 'long',
  entry: 100,
  stop: 98,
  target: 104,
  symbol: 'BTCUSDT',
};

const reason = (d: PositionDrawing): string | null => {
  const result = validateDrawing(d);
  return result.ok ? null : result.reason;
};

describe('validateDrawing', () => {
  it('acepta un largo válido', () => {
    expect(validateDrawing(base)).toEqual({ ok: true });
  });

  it('acepta un corto válido', () => {
    expect(validateDrawing({ ...base, side: 'short', stop: 102, target: 96 })).toEqual({ ok: true });
  });

  it('rechaza números no positivos o no finitos', () => {
    expect(validateDrawing({ ...base, entry: NaN })).toEqual({ ok: false, reason: 'non_positive_numbers' });
    expect(validateDrawing({ ...base, entry: 0 })).toEqual({ ok: false, reason: 'non_positive_numbers' });
    expect(validateDrawing({ ...base, stop: Infinity })).toEqual({ ok: false, reason: 'non_positive_numbers' });
    expect(validateDrawing({ ...base, target: -4 })).toEqual({ ok: false, reason: 'non_positive_numbers' });
  });

  it('rechaza el orden malo en largo y en corto', () => {
    // largo: stop debe quedar por debajo de la entrada
    expect(reason({ ...base, stop: 102 })).toBe('wrong_order');
    // corto: stop debe quedar por encima de la entrada
    expect(reason({ ...base, side: 'short', stop: 96, target: 102 })).toBe('wrong_order');
  });

  it('rechaza un lado inválido', () => {
    expect(validateDrawing({ ...base, side: 'longo' as never })).toEqual({ ok: false, reason: 'invalid_side' });
  });

  it('rechaza stops a más del 50 % de la entrada', () => {
    expect(validateDrawing({ ...base, stop: 49 })).toEqual({ ok: false, reason: 'stop_too_far' });
    // justo al 50 % sigue siendo aceptable
    expect(validateDrawing({ ...base, stop: 50 }).ok).toBe(true);
    expect(MAX_STOP_DISTANCE_PCT).toBe(50);
  });

  it('nunca lanza, ni con entrada nula', () => {
    expect(() => validateDrawing(null as never)).not.toThrow();
    expect(() => validateDrawing(undefined as never)).not.toThrow();
    expect(validateDrawing(null as never)).toEqual({ ok: false, reason: 'invalid_input' });
  });
});
