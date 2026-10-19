// Localiza en el DOM de Binance la región que interesa (la tabla de posiciones
// abiertas y las tarjetas de «Historial de posiciones») usando SOLO etiquetas
// visibles de `labels.ts`. Nunca clases CSS: Binance las ofusca y las renombra.
//
// El recorrido está acotado: se miran como mucho `maxElements` elementos y no
// se desciende por cada uno con `querySelectorAll`.

import { HISTORY_VALUE_KEYS, matchLabel, matchLabelPrefix, normalizeLabel, type LabelKey } from './labels';
import type { DomNodeLike } from './tree';

export interface DomElementLike extends DomNodeLike {
  parentElement?: DomNodeLike | null;
  children?: ArrayLike<DomNodeLike>;
  querySelectorAll?: (selector: string) => ArrayLike<DomNodeLike>;
}

export interface RegionSource {
  body?: DomElementLike | null;
  documentElement?: DomElementLike | null;
  querySelectorAll?: (selector: string) => ArrayLike<DomNodeLike>;
}

export interface RegionOptions {
  /** Tope de elementos inspeccionados (por defecto 6000). */
  maxElements?: number;
}

const DEFAULT_MAX_ELEMENTS = 6000;
const MAX_TEXT_FOR_LABEL = 120;

const HEADER_KEYS: readonly LabelKey[] = [
  'symbol',
  'size',
  'pnl',
  'entry',
  'breakEven',
  'mark',
  'liq',
];

const HISTORY_KEYS = new Set<LabelKey>(HISTORY_VALUE_KEYS);

function collapse(value: string): string {
  return value.replace(/[\s\u00a0\u202f]+/g, ' ').trim();
}

function ownText(el: DomNodeLike): string {
  const text = typeof el.textContent === 'string' ? el.textContent : '';
  // No hace falta el texto entero para reconocer una etiqueta.
  return collapse(text).slice(0, MAX_TEXT_FOR_LABEL);
}

function childElements(el: DomNodeLike): DomNodeLike[] {
  const source = el.children;
  if (!source || typeof source.length !== 'number') return [];
  const out: DomNodeLike[] = [];
  for (let i = 0; i < source.length; i++) {
    const kid = source[i];
    if (kid) out.push(kid);
  }
  return out;
}

/** Todos los elementos del documento, en orden de documento y acotados. */
export function collectElements(source: RegionSource, maxElements = DEFAULT_MAX_ELEMENTS): DomNodeLike[] {
  const cap = Number.isFinite(maxElements) && maxElements > 0 ? Math.floor(maxElements) : DEFAULT_MAX_ELEMENTS;
  const root = source.body ?? source.documentElement ?? null;
  const query = root?.querySelectorAll ?? source.querySelectorAll;
  if (typeof query !== 'function') return [];
  let list: ArrayLike<DomNodeLike>;
  try {
    list = query.call(root ?? source, '*');
  } catch {
    return [];
  }
  const out: DomNodeLike[] = [];
  const total = Math.min(list.length, cap);
  for (let i = 0; i < total; i++) {
    const el = list[i];
    if (el) out.push(el);
  }
  return out;
}

function labelOf(el: DomNodeLike): LabelKey | null {
  const text = ownText(el);
  if (!text) return null;
  return matchLabel(text)?.key ?? matchLabelPrefix(text)?.key ?? null;
}

/**
 * Región de la tabla de posiciones abiertas: el contenedor de la fila de
 * cabecera. Se reconoce porque una fila tiene al menos cuatro etiquetas
 * conocidas entre sus hijos y una de ellas es «Símbolo».
 */
export function findOpenPositionsRegion(
  source: RegionSource,
  opts: RegionOptions = {},
): DomNodeLike | null {
  const elements = collectElements(source, opts.maxElements);
  let best: { el: DomNodeLike; known: number } | null = null;
  for (const el of elements) {
    const kids = childElements(el);
    if (kids.length < 4 || kids.length > 40) continue;
    const keys = new Set<LabelKey>();
    for (const kid of kids) {
      const key = labelOf(kid);
      if (key && HEADER_KEYS.includes(key)) keys.add(key);
    }
    if (!keys.has('symbol') || keys.size < 4) continue;
    const hasPrice = keys.has('entry') || keys.has('mark') || keys.has('liq') || keys.has('breakEven');
    if (!hasPrice) continue;
    if (!best || keys.size > best.known) best = { el, known: keys.size };
  }
  if (!best) return null;
  // La cabecera es una fila: las filas de datos viven en su contenedor.
  return (best.el as DomElementLike).parentElement ?? best.el;
}

interface HistoryInfo {
  hits: number;
  size: number;
  hasOpen: boolean;
  hasClosed: boolean;
}

function ownHistoryInfo(el: DomNodeLike): { hit: boolean; hasOpen: boolean; hasClosed: boolean } {
  const text = ownText(el);
  if (!text) return { hit: false, hasOpen: false, hasClosed: false };
  const normalized = normalizeLabel(text);
  const label = matchLabel(text)?.key ?? matchLabelPrefix(text)?.key ?? null;
  return {
    hit: label !== null && HISTORY_KEYS.has(label),
    hasOpen: /\b(?:abierto|abierta|opened|open)\b/.test(normalized),
    hasClosed: /\b(?:cerrado|cerrada|closed|close)\b/.test(normalized),
  };
}

/**
 * Región de las tarjetas de «Historial de posiciones»: el contenedor más
 * pequeño que reúne al menos tres etiquetas de valores del historial y las dos
 * marcas de fecha («Abierto» y «Cerrado»). Null si esa pestaña no está abierta.
 */
export function findHistoryRegion(source: RegionSource, opts: RegionOptions = {}): DomNodeLike | null {
  const elements = collectElements(source, opts.maxElements);
  if (elements.length === 0) return null;
  const infos = new Map<DomNodeLike, HistoryInfo>();
  // `querySelectorAll('*')` llega en orden de documento: al revés, los hijos
  // se acumulan antes que sus padres.
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i]!;
    const own = ownHistoryInfo(el);
    const info: HistoryInfo = {
      hits: own.hit ? 1 : 0,
      size: 1,
      hasOpen: own.hasOpen,
      hasClosed: own.hasClosed,
    };
    for (const kid of childElements(el)) {
      const kidInfo = infos.get(kid);
      if (!kidInfo) continue;
      info.hits += kidInfo.hits;
      info.size += kidInfo.size;
      info.hasOpen = info.hasOpen || kidInfo.hasOpen;
      info.hasClosed = info.hasClosed || kidInfo.hasClosed;
    }
    infos.set(el, info);
  }

  const isCard = (info: HistoryInfo): boolean =>
    info.hits >= 3 && info.hasOpen && info.hasClosed && info.size >= 3;

  const candidates: Array<{ el: DomNodeLike; info: HistoryInfo }> = [];
  for (const [el, info] of infos) {
    if (isCard(info)) candidates.push({ el, info });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.info.size - b.info.size);

  // Una sola tarjeta también cumple los mínimos. Se sube mientras el padre
  // sea una lista de tarjetas (dos o más hijos que ya son tarjeta): así se coge
  // el contenedor con todas ellas y no la primera.
  let current = candidates[0]!;
  for (;;) {
    const parent = (current.el as DomElementLike).parentElement;
    if (!parent) break;
    const parentInfo = infos.get(parent);
    if (!parentInfo || !isCard(parentInfo)) break;
    const cards = childElements(parent).filter((kid) => {
      const info = infos.get(kid);
      return info ? isCard(info) : false;
    }).length;
    if (cards < 2) break;
    current = { el: parent, info: parentInfo };
  }
  return current.el;
}
