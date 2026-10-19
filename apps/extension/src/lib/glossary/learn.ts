/**
 * Lista y filtros de la pestaña Aprender. Puro: la búsqueda ignora mayúsculas y
 * tildes con el mismo criterio que los alias del glosario.
 */
import { GLOSSARY, normalizeTerm, type GlossaryCategory, type GlossaryEntry } from './entries';
import { entryText } from './text';

export type CategoryFilter = GlossaryCategory | 'todas';

/** Orden de las categorías en los filtros: el mismo de la documentación. */
export const CATEGORY_ORDER: readonly GlossaryCategory[] = [
  'niveles',
  'patrones',
  'sentimiento',
  'cierres',
  'flujo',
  'riesgo',
  'escaner',
];

function haystack(entry: GlossaryEntry): string {
  return normalizeTerm(
    [...entry.aliases, entry.id, entryText(entry.id, 'title'), entryText(entry.id, 'short')].join(' '),
  );
}

/**
 * Entradas visibles para una búsqueda y una categoría. La consulta busca en
 * alias, id y título; vacía devuelve todo.
 */
export function learnEntries(
  query = '',
  category: CategoryFilter = 'todas',
  entries: readonly GlossaryEntry[] = GLOSSARY,
): GlossaryEntry[] {
  const key = normalizeTerm(query);
  return entries.filter((entry) => {
    if (category !== 'todas' && entry.category !== category) return false;
    if (!key) return true;
    return haystack(entry).includes(key);
  });
}

/** Categorías presentes en el glosario, en orden estable. */
export function learnCategories(entries: readonly GlossaryEntry[] = GLOSSARY): GlossaryCategory[] {
  const present = new Set(entries.map((entry) => entry.category));
  return CATEGORY_ORDER.filter((category) => present.has(category));
}
