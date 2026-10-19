/** Traducción pura: sin DOM ni APIs del navegador. */
import type { Catalog } from './catalog';

export type Params = Readonly<Record<string, string | number | boolean | null | undefined>>;
export type Catalogs = Readonly<Record<string, Catalog | undefined>>;

function lookup(catalogs: Catalogs, locale: string, key: string): string | null {
  for (const code of [locale, 'en', 'es']) {
    const value = catalogs[code]?.[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) && params[name] !== undefined
      ? String(params[name])
      : whole,
  );
}

export function translate(catalogs: Catalogs, locale: string, key: string, params?: Params): string {
  return interpolate(lookup(catalogs, locale, key) ?? key, params);
}

function pluralCategory(locale: string, count: number): string {
  try {
    return new Intl.PluralRules(locale).select(count);
  } catch {
    return new Intl.PluralRules('en').select(count);
  }
}

export function translatePlural(
  catalogs: Catalogs,
  locale: string,
  key: string,
  count: number,
  params?: Params,
): string {
  const merged: Params = { ...params, count };
  const category = pluralCategory(locale, count);
  for (const suffix of [category, 'other', 'one']) {
    const found = lookup(catalogs, locale, `${key}.${suffix}`);
    if (found !== null) return interpolate(found, merged);
  }
  return interpolate(key, merged);
}

export function formatNumber(locale: string, value: number, opts?: Intl.NumberFormatOptions): string {
  try {
    return new Intl.NumberFormat(locale, opts).format(value);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    return new Intl.NumberFormat('en', opts).format(value);
  }
}

export function formatDateTime(locale: string, ms: number, opts?: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(locale, opts).format(new Date(ms));
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    return new Intl.DateTimeFormat('en', opts).format(new Date(ms));
  }
}
