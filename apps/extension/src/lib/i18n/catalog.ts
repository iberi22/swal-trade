import type { LocaleCode } from './locales';

/** Claves planas con puntos: "operation.context.title". */
export type Catalog = Readonly<Record<string, string>>;

type Loader = () => Promise<{ default: Record<string, string> }>;

// Mapa estático: Vite empaqueta cada idioma como su propio chunk.
const LOADERS: Readonly<Record<LocaleCode, Loader>> = {
  en: () => import('../../locales/en.json'),
  'zh-CN': () => import('../../locales/zh-CN.json'),
  hi: () => import('../../locales/hi.json'),
  es: () => import('../../locales/es.json'),
  fr: () => import('../../locales/fr.json'),
  ar: () => import('../../locales/ar.json'),
  bn: () => import('../../locales/bn.json'),
  'pt-BR': () => import('../../locales/pt-BR.json'),
  ru: () => import('../../locales/ru.json'),
  ur: () => import('../../locales/ur.json'),
  id: () => import('../../locales/id.json'),
  de: () => import('../../locales/de.json'),
  ja: () => import('../../locales/ja.json'),
  mr: () => import('../../locales/mr.json'),
  te: () => import('../../locales/te.json'),
  tr: () => import('../../locales/tr.json'),
  ta: () => import('../../locales/ta.json'),
  vi: () => import('../../locales/vi.json'),
  ko: () => import('../../locales/ko.json'),
  it: () => import('../../locales/it.json'),
};

function sanitize(raw: unknown): Catalog {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') out[key] = value;
    }
  }
  return out;
}

async function loadOne(locale: LocaleCode): Promise<Catalog> {
  try {
    const mod = await LOADERS[locale]();
    return sanitize(mod.default);
  } catch {
    return {};
  }
}

/**
 * Carga el catálogo pedido más la cadena de respaldo (en, es). Nunca rechaza:
 * lo que falle queda como {}.
 */
export async function loadCatalog(locale: LocaleCode): Promise<Record<string, Catalog>> {
  const wanted: LocaleCode[] = [...new Set<LocaleCode>([locale, 'en', 'es'])];
  const out: Record<string, Catalog> = {};
  try {
    const loaded = await Promise.all(wanted.map(loadOne));
    wanted.forEach((code, i) => {
      out[code] = loaded[i]!;
    });
  } catch {
    // loadOne ya no lanza; por si acaso
  }
  return out;
}
