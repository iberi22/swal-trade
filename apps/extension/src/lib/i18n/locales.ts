export interface LocaleInfo {
  code: string;
  nativeName: string;
  englishName: string;
  dir: 'ltr' | 'rtl';
}

/** Los 20 idiomas más hablados. Orden estable: es el del selector. */
export const LOCALES = [
  { code: 'en', nativeName: 'English', englishName: 'English', dir: 'ltr' },
  { code: 'zh-CN', nativeName: '简体中文', englishName: 'Chinese (Simplified)', dir: 'ltr' },
  { code: 'hi', nativeName: 'हिन्दी', englishName: 'Hindi', dir: 'ltr' },
  { code: 'es', nativeName: 'Español', englishName: 'Spanish', dir: 'ltr' },
  { code: 'fr', nativeName: 'Français', englishName: 'French', dir: 'ltr' },
  { code: 'ar', nativeName: 'العربية', englishName: 'Arabic', dir: 'rtl' },
  { code: 'bn', nativeName: 'বাংলা', englishName: 'Bengali', dir: 'ltr' },
  { code: 'pt-BR', nativeName: 'Português (Brasil)', englishName: 'Portuguese (Brazil)', dir: 'ltr' },
  { code: 'ru', nativeName: 'Русский', englishName: 'Russian', dir: 'ltr' },
  { code: 'ur', nativeName: 'اردو', englishName: 'Urdu', dir: 'rtl' },
  { code: 'id', nativeName: 'Bahasa Indonesia', englishName: 'Indonesian', dir: 'ltr' },
  { code: 'de', nativeName: 'Deutsch', englishName: 'German', dir: 'ltr' },
  { code: 'ja', nativeName: '日本語', englishName: 'Japanese', dir: 'ltr' },
  { code: 'mr', nativeName: 'मराठी', englishName: 'Marathi', dir: 'ltr' },
  { code: 'te', nativeName: 'తెలుగు', englishName: 'Telugu', dir: 'ltr' },
  { code: 'tr', nativeName: 'Türkçe', englishName: 'Turkish', dir: 'ltr' },
  { code: 'ta', nativeName: 'தமிழ்', englishName: 'Tamil', dir: 'ltr' },
  { code: 'vi', nativeName: 'Tiếng Việt', englishName: 'Vietnamese', dir: 'ltr' },
  { code: 'ko', nativeName: '한국어', englishName: 'Korean', dir: 'ltr' },
  { code: 'it', nativeName: 'Italiano', englishName: 'Italian', dir: 'ltr' },
] as const satisfies readonly LocaleInfo[];

export type LocaleCode = (typeof LOCALES)[number]['code'];

/** Idioma fuente de los textos. */
export const DEFAULT_LOCALE: LocaleCode = 'es';

const CODES: readonly string[] = LOCALES.map((l) => l.code);

export function isLocaleCode(value: unknown): value is LocaleCode {
  return typeof value === 'string' && CODES.includes(value);
}

export function localeDir(code: LocaleCode): 'ltr' | 'rtl' {
  return LOCALES.find((l) => l.code === code)?.dir ?? 'ltr';
}

/** Mapa de idioma base a locale cuando no hay coincidencia exacta. */
const PREFIX_MAP: Readonly<Record<string, LocaleCode>> = {
  en: 'en', zh: 'zh-CN', hi: 'hi', es: 'es', fr: 'fr', ar: 'ar', bn: 'bn', pt: 'pt-BR',
  ru: 'ru', ur: 'ur', id: 'id', de: 'de', ja: 'ja', mr: 'mr', te: 'te', tr: 'tr',
  ta: 'ta', vi: 'vi', ko: 'ko', it: 'it',
};

function matchTag(tag: unknown): LocaleCode | null {
  if (typeof tag !== 'string') return null;
  const clean = tag.trim().replace(/_/g, '-');
  if (!clean) return null;
  const exact = LOCALES.find((l) => l.code.toLowerCase() === clean.toLowerCase());
  if (exact) return exact.code;
  const base = clean.split('-')[0]!.toLowerCase();
  // 'in' es el código antiguo de id; 'iw' el de he (no soportado).
  return PREFIX_MAP[base === 'in' ? 'id' : base] ?? null;
}

/**
 * Elige el idioma: el pedido (si no es 'auto'), luego los del navegador en
 * orden, y por último 'en'. Nunca lanza.
 */
export function resolveLocale(
  requested: string | null | undefined,
  browserLanguages: readonly string[],
): LocaleCode {
  try {
    if (typeof requested === 'string' && requested.trim().toLowerCase() !== 'auto') {
      const direct = matchTag(requested);
      if (direct) return direct;
    }
    if (Array.isArray(browserLanguages)) {
      for (const tag of browserLanguages) {
        const hit = matchTag(tag);
        if (hit) return hit;
      }
    }
  } catch {
    // cae a 'en'
  }
  return 'en';
}
