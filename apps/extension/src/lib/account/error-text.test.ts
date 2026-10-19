import { describe, expect, it } from 'vitest';
import { errorText } from './error-text';

describe('errorText', () => {
  it('mapea cada codigo conocido a una frase corta', () => {
    for (const code of ['ip_or_perm', 'clock', 'net', 'no_key', 'bad_response', 'key_has_trading_or_withdraw', 'unsupported', 'vault']) {
      const t = errorText(code);
      expect(t.length).toBeGreaterThan(5);
      expect(t.length).toBeLessThanOrEqual(100);
      expect(t).not.toBe('Error desconocido.');
    }
  });
  it('retiros: mensaje exacto', () => {
    expect(errorText('key_has_trading_or_withdraw')).toBe('Esta clave puede retirar fondos. Créala sin permiso de retiros.');
  });
  it('http_N', () => {
    expect(errorText('http_401')).toContain('401');
    expect(errorText('http_429')).toContain('429');
    expect(errorText('http_503')).toContain('503');
    expect(errorText('http_404')).toContain('404');
  });
  it('basura => desconocido', () => {
    expect(errorText(undefined)).toBe('Error desconocido.');
    expect(errorText('???')).toBe('Error desconocido.');
    expect(errorText('http_abc')).toBe('Error desconocido.');
  });
});
