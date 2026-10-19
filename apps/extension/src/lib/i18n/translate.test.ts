import { describe, expect, it } from 'vitest';
import { formatDateTime, formatNumber, translate, translatePlural } from './translate';

const catalogs = {
  es: { a: 'es-a', only_es: 'solo es', hi: 'Hola {name}', 'n.one': '{count} cosa', 'n.other': '{count} cosas' },
  en: { a: 'en-a', b: 'en-b', 'n.one': '{count} thing', 'n.other': '{count} things' },
  de: { a: 'de-a' },
  ar: {
    'n.zero': 'صفر {count}', 'n.one': 'واحد {count}', 'n.two': 'اثنان {count}',
    'n.few': 'قليل {count}', 'n.many': 'كثير {count}', 'n.other': 'آخر {count}',
  },
  ru: { 'n.one': 'one {count}', 'n.few': 'few {count}', 'n.many': 'many {count}', 'n.other': 'other {count}' },
  ja: { 'n.other': '{count}個', 'n.one': 'NO' },
};

describe('translate', () => {
  it('cadena locale -> en -> es -> clave', () => {
    expect(translate(catalogs, 'de', 'a')).toBe('de-a');
    expect(translate(catalogs, 'de', 'b')).toBe('en-b');
    expect(translate(catalogs, 'de', 'only_es')).toBe('solo es');
    expect(translate(catalogs, 'de', 'nope.key')).toBe('nope.key');
    expect(translate({}, 'fr', 'x.y')).toBe('x.y');
  });
  it('interpola, deja desconocidos y convierte a texto', () => {
    expect(translate(catalogs, 'es', 'hi', { name: 'Ana' })).toBe('Hola Ana');
    expect(translate(catalogs, 'es', 'hi')).toBe('Hola {name}');
    expect(translate(catalogs, 'es', 'hi', { other: 1 })).toBe('Hola {name}');
    expect(translate(catalogs, 'es', 'hi', { name: 5 })).toBe('Hola 5');
    expect(translate(catalogs, 'es', 'hi', { name: '<b>x</b>' })).toBe('Hola <b>x</b>');
  });
  it('no se deja engañar por claves heredadas del prototipo', () => {
    expect(translate(catalogs, 'es', 'hi', { constructor: 'x' } as never)).toBe('Hola {name}');
    expect(translate(catalogs, 'es', 'toString')).toBe('toString');
  });
});

describe('translatePlural', () => {
  it('en', () => {
    expect(translatePlural(catalogs, 'en', 'n', 1)).toBe('1 thing');
    expect(translatePlural(catalogs, 'en', 'n', 3)).toBe('3 things');
  });
  it('ar tiene 6 formas', () => {
    const f = (n: number) => translatePlural(catalogs, 'ar', 'n', n);
    expect(f(0)).toBe('صفر 0');
    expect(f(1)).toBe('واحد 1');
    expect(f(2)).toBe('اثنان 2');
    expect(f(3)).toBe('قليل 3');
    expect(f(11)).toBe('كثير 11');
    expect(f(100)).toBe('آخر 100');
  });
  it('ru', () => {
    const f = (n: number) => translatePlural(catalogs, 'ru', 'n', n);
    expect(f(1)).toBe('one 1');
    expect(f(2)).toBe('few 2');
    expect(f(5)).toBe('many 5');
    expect(f(1.5)).toBe('other 1.5');
  });
  it('ja solo other', () => {
    expect(translatePlural(catalogs, 'ja', 'n', 1)).toBe('1個');
    expect(translatePlural(catalogs, 'ja', 'n', 7)).toBe('7個');
  });
  it('cae a other, luego one, luego la clave', () => {
    expect(translatePlural(catalogs, 'de', 'n', 5)).toBe('5 things');
    expect(translatePlural({ en: { 'k.one': 'uno {count}' } }, 'en', 'k', 5)).toBe('uno 5');
    expect(translatePlural({}, 'en', 'k', 5)).toBe('k');
  });
  it('params extra y count explícito', () => {
    const c = { en: { 'k.other': '{who}: {count}' } };
    expect(translatePlural(c, 'en', 'k', 2, { who: 'x' })).toBe('x: 2');
  });
});

describe('formatters', () => {
  it('formatNumber por locale', () => {
    expect(formatNumber('en', 1234.5)).toBe('1,234.5');
    expect(formatNumber('de', 1234.5)).toBe('1.234,5');
  });
  it('locale inválido cae a en', () => {
    expect(formatNumber('not a locale!!', 1234.5)).toBe('1,234.5');
    expect(formatDateTime('not a locale!!', 0, { timeZone: 'UTC', year: 'numeric' })).toBe('1970');
  });
  it('formatDateTime', () => {
    expect(formatDateTime('en', Date.UTC(2026, 0, 2), { timeZone: 'UTC', dateStyle: 'short' })).toBe('1/2/26');
  });
});
