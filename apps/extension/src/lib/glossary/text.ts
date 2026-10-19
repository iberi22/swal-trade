/**
 * Prosa del glosario. `glossary.es.json` es la fuente en español, todavía fuera
 * de los catálogos de `src/lib/i18n` (esos cargan por idioma en el background).
 * Aquí se envuelve con los ayudantes puros de `translate` para poder añadir
 * idiomas más adelante sin tocar las plantillas ni los componentes.
 */
import es from './glossary.es.json';
import type { Catalog } from '../i18n/catalog';
import { translate, type Params } from '../i18n/translate';
import type { GlossaryCategory } from './entries';

/** Idioma de los textos actuales: el glosario solo está escrito en español. */
export const GLOSSARY_SOURCE_LOCALE = 'es';

const catalogs: Record<string, Catalog> = { es: es as Catalog };

/**
 * Añade (o sustituye) el catálogo de un idioma. Los idiomas sin catálogo caen a
 * español; cuando exista `glossary.en.json` basta llamar aquí desde el arranque.
 */
export function registerGlossaryCatalog(locale: string, catalog: Catalog): void {
  if (!locale) return;
  catalogs[locale] = catalog;
}

/** Idiomas con catálogo propio (para depurar; la fuente siempre es `es`). */
export function glossaryLocales(): string[] {
  return Object.keys(catalogs);
}

/** Traduce una clave del glosario. Interpolación `{nombre}` como en i18n. */
export function glossaryText(key: string, params?: Params, locale = GLOSSARY_SOURCE_LOCALE): string {
  return translate(catalogs, locale, key, params);
}

export type ProseField = 'title' | 'short' | 'what' | 'read' | 'up' | 'down' | 'range' | 'watch';

/** Un campo de prosa de una entrada (`glossary.<id>.<campo>`). */
export function entryText(
  id: string,
  field: ProseField,
  params?: Params,
  locale = GLOSSARY_SOURCE_LOCALE,
): string {
  return glossaryText(`glossary.${id}.${field}`, params, locale);
}

/** Texto corto de interfaz del glosario (`glossary.ui.<nombre>`). */
export function uiText(name: string, params?: Params, locale = GLOSSARY_SOURCE_LOCALE): string {
  return glossaryText(`glossary.ui.${name}`, params, locale);
}

/** Nombre visible de una categoría (`glossary.category.<id>`). */
export function categoryText(category: GlossaryCategory, locale = GLOSSARY_SOURCE_LOCALE): string {
  return glossaryText(`glossary.category.${category}`, undefined, locale);
}
