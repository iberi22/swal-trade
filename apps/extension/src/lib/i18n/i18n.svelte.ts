import { browser } from 'wxt/browser';
import { loadCatalog, type Catalog } from './catalog';
import { DEFAULT_LOCALE, isLocaleCode, localeDir, resolveLocale, type LocaleCode } from './locales';
import { translate, translatePlural, type Params } from './translate';

let catalogs: Record<string, Catalog> = {};

const state = $state({
  locale: DEFAULT_LOCALE as LocaleCode,
  ready: false,
  /** Sube cada vez que cambian los catálogos, para que t() se reevalúe. */
  version: 0,
});

/** Estado reactivo: `i18n.locale`, `i18n.ready`. */
export const i18n = {
  get locale(): LocaleCode {
    return state.locale;
  },
  get ready(): boolean {
    return state.ready;
  },
};

function applyToDocument(locale: LocaleCode) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  document.documentElement.dir = localeDir(locale);
}

let token = 0;

export async function setLocale(code: LocaleCode): Promise<void> {
  const locale = isLocaleCode(code) ? code : DEFAULT_LOCALE;
  const mine = ++token;
  const loaded = await loadCatalog(locale);
  if (mine !== token) return;
  catalogs = { ...catalogs, ...loaded };
  state.locale = locale;
  state.version += 1;
  state.ready = true;
  applyToDocument(locale);
}

export function t(key: string, params?: Params): string {
  void state.locale;
  void state.version;
  return translate(catalogs, state.locale, key, params);
}

export function tp(key: string, count: number, params?: Params): string {
  void state.locale;
  void state.version;
  return translatePlural(catalogs, state.locale, key, count, params);
}

export async function initI18n(
  settingsLocale: 'auto' | LocaleCode,
  browserLanguages: readonly string[],
): Promise<void> {
  await setLocale(resolveLocale(settingsLocale, browserLanguages));
}

/** Idiomas del navegador, del más al menos preferido. Nunca lanza. */
export function browserLanguages(): string[] {
  const out: string[] = [];
  try {
    const ui = browser.i18n?.getUILanguage?.();
    if (ui) out.push(ui);
  } catch {
    // sin API de i18n
  }
  if (typeof navigator !== 'undefined' && Array.isArray(navigator.languages)) out.push(...navigator.languages);
  return out;
}
