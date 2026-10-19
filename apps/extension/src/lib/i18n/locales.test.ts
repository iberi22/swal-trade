import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES, isLocaleCode, localeDir, resolveLocale } from './locales';

describe('LOCALES', () => {
  it('son 20, únicos, con rtl solo en ar y ur', () => {
    expect(LOCALES).toHaveLength(20);
    expect(new Set(LOCALES.map((l) => l.code)).size).toBe(20);
    expect(LOCALES.filter((l) => l.dir === 'rtl').map((l) => l.code)).toEqual(['ar', 'ur']);
    expect(localeDir('ar')).toBe('rtl');
    expect(localeDir('es')).toBe('ltr');
    expect(DEFAULT_LOCALE).toBe('es');
  });
  it('isLocaleCode', () => {
    expect(isLocaleCode('pt-BR')).toBe(true);
    expect(isLocaleCode('pt')).toBe(false);
    expect(isLocaleCode(3)).toBe(false);
  });
});

describe('resolveLocale', () => {
  it('coincidencia exacta', () => {
    expect(resolveLocale('de', ['fr'])).toBe('de');
    expect(resolveLocale('pt-BR', [])).toBe('pt-BR');
  });
  it('prefijo de idioma', () => {
    expect(resolveLocale('auto', ['pt-PT'])).toBe('pt-BR');
    expect(resolveLocale('auto', ['zh-TW'])).toBe('zh-CN');
    expect(resolveLocale('auto', ['zh-HK'])).toBe('zh-CN');
    expect(resolveLocale('auto', ['es-MX'])).toBe('es');
    expect(resolveLocale(null, ['en-GB', 'es'])).toBe('en');
  });
  it('ignora mayúsculas y guion bajo', () => {
    expect(resolveLocale('auto', ['PT-br'])).toBe('pt-BR');
    expect(resolveLocale('auto', ['ZH_cn'])).toBe('zh-CN');
    expect(resolveLocale('AUTO', ['fr-CA'])).toBe('fr');
  });
  it('salta lo desconocido y cae a en', () => {
    expect(resolveLocale('auto', ['xx-YY', 'ko-KR'])).toBe('ko');
    expect(resolveLocale('auto', ['xx-YY'])).toBe('en');
    expect(resolveLocale('xx-YY', ['it'])).toBe('it');
  });
  it('null, undefined, vacío y basura no lanzan', () => {
    expect(resolveLocale(null, [])).toBe('en');
    expect(resolveLocale(undefined, [])).toBe('en');
    expect(resolveLocale('', [])).toBe('en');
    expect(resolveLocale('', ['ja'])).toBe('ja');
    expect(resolveLocale('auto', [''])).toBe('en');
    expect(resolveLocale('auto', undefined as unknown as string[])).toBe('en');
    expect(resolveLocale('auto', [null as unknown as string, 'tr'])).toBe('tr');
  });
});
