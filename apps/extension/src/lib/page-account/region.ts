// Localiza en el DOM de Binance la región que interesa (la tabla de posiciones
// abiertas y las tarjetas de «Historial de posiciones») usando SOLO etiquetas
// visibles de `labels.ts`. Nunca clases CSS: Binance las ofusca y las renombra.
//
// El recorrido está acotado: se miran como mucho `maxElements` elementos y no
// se desciende por cada uno con `querySelectorAll`.

import { HISTORY_VALUE_KEYS, matchLabel, matchLabelPrefix, normalizeLabel, type LabelKey } from './labels';
import { BALANCE_VALUE_KEYS } from './parse-balance';
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
  /** Tope de elementos inspeccionados (por defecto 20000). */
  maxElements?: number;
}

/**
 * La página de futuros de Binance monta miles de nodos (gráfico, libros,
 * tablas). Con 6000 el recorrido se quedaba antes de la caja de cuenta y del
 * historial, que viven al final del documento. 20000 cubre la página real sin
 * volver el escaneo caro: cada elemento se visita una sola vez.
 */
const DEFAULT_MAX_ELEMENTS = 20_000;
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
const BALANCE_KEYS = new Set<LabelKey>(BALANCE_VALUE_KEYS);

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
  /** Es una tarjeta por sí mismo (tiene las etiquetas y las dos fechas). */
  isCard: boolean;
  /** Cuántas tarjetas minimales hay en su subárbol, contando él mismo. */
  cards: number;
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

/** Cadena de padres de un elemento, de él mismo hacia arriba. */
function ancestorChain(el: DomNodeLike): DomNodeLike[] {
  const chain: DomNodeLike[] = [];
  let current: DomNodeLike | null | undefined = el;
  let guard = 0;
  while (current && guard++ < 512) {
    chain.push(current);
    current = (current as DomElementLike).parentElement ?? null;
  }
  return chain;
}

/**
 * Región de las tarjetas de «Historial de posiciones».
 *
 * Se localizan las tarjetas MINIMALES (las que cumplen las etiquetas y no
 * contienen otra tarjeta) y se devuelve su ancestro común más bajo. Así la
 * región incluye todas las tarjetas aunque Binance las reparta en varios
 * contenedores (por fecha, por lista virtual) y no solo la primera. Con una
 * sola tarjeta se devuelve esa tarjeta.
 *
 * Null si la pestaña de historial no está abierta.
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
      isCard: false,
      cards: 0,
    };
    let childCards = 0;
    for (const kid of childElements(el)) {
      const kidInfo = infos.get(kid);
      if (!kidInfo) continue;
      info.hits += kidInfo.hits;
      info.size += kidInfo.size;
      info.hasOpen = info.hasOpen || kidInfo.hasOpen;
      info.hasClosed = info.hasClosed || kidInfo.hasClosed;
      childCards += kidInfo.cards;
    }
    info.isCard = info.hits >= 3 && info.hasOpen && info.hasClosed && info.size >= 3;
    info.cards = childCards > 0 ? childCards : info.isCard ? 1 : 0;
    infos.set(el, info);
  }

  // Tarjetas minimales: cumplen la forma de tarjeta y ninguna de sus
  // descendientes lo hace.
  const cards: DomNodeLike[] = [];
  for (const [el, info] of infos) {
    if (!info.isCard) continue;
    let childIsCard = false;
    for (const kid of childElements(el)) {
      const kidInfo = infos.get(kid);
      if (kidInfo && kidInfo.cards > 0) {
        childIsCard = true;
        break;
      }
    }
    if (!childIsCard) cards.push(el);
  }
  if (cards.length === 0) return null;
  if (cards.length === 1) return cards[0]!;

  // Ancestro común más bajo: se cruzan las cadenas de padres de todas las
  // tarjetas y se queda el primero que aparece en todas.
  const [first, ...rest] = cards;
  const restChains = rest.map((card) => new Set(ancestorChain(card)));
  for (const candidate of ancestorChain(first!)) {
    if (restChains.every((chain) => chain.has(candidate))) return candidate;
  }
  return cards[0]!;
}

/**
 * Región de la caja de cuenta: el contenedor MÁS PEQUEÑO que reúne al menos
 * tres etiquetas de saldo (`Balance de margen`, `Disp.`, ...). Null si la
 * página no muestra ninguna. Se agrega de hijos a padres (post-orden) para no
 * confundir una caja con el documento entero.
 */
export function findAccountBalanceRegion(
  source: RegionSource,
  opts: RegionOptions = {},
): DomNodeLike | null {
  const elements = collectElements(source, opts.maxElements);
  if (elements.length === 0) return null;
  interface Info {
    hits: number;
    keys: Set<LabelKey>;
    size: number;
  }
  const infos = new Map<DomNodeLike, Info>();
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i]!;
    const key = labelOf(el);
    const info: Info = { hits: 0, keys: new Set<LabelKey>(), size: 1 };
    if (key && BALANCE_KEYS.has(key)) {
      info.hits += 1;
      info.keys.add(key);
    }
    for (const kid of childElements(el)) {
      const kidInfo = infos.get(kid);
      if (!kidInfo) continue;
      info.hits += kidInfo.hits;
      info.size += kidInfo.size;
      for (const kidKey of kidInfo.keys) info.keys.add(kidKey);
    }
    infos.set(el, info);
  }

  let best: { el: DomNodeLike; info: Info } | null = null;
  for (const [el, info] of infos) {
    if (info.hits < 3 || info.keys.size < 3) continue;
    if (!best || info.size < best.info.size) best = { el, info };
  }
  return best ? best.el : null;
}
