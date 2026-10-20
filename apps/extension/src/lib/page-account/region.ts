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
  /**
   * Tope de nodos que se serializan de cada región (por defecto 4000, el del
   * lector). Lo usan el lector y el diagnóstico; la localización no lo necesita.
   */
  maxNodes?: number;
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
  const container = (best.el as DomElementLike).parentElement ?? null;
  if (container && isUsableRegion(container)) return container;
  // Contenedor global o desmedido: la fila de cabecera sigue siendo una región
  // acotada; el contenedor de la página no se serializa nunca.
  return isUsableRegion(best.el) ? best.el : null;
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
 * Tope de descendientes de una región. Por encima de esto lo «reconocido» ya no
 * es una caja ni una lista: es la página entera, y serializarla no dice nada
 * útil (y llena el informe de ruido). Una lista de historial real no pasa de
 * unos cientos de nodos.
 */
export const MAX_REGION_DESCENDANTS = 8000;

const GLOBAL_ROOT_TAGS = new Set(['html', 'body', 'main']);
const GLOBAL_ROOT_IDS = new Set(['__app', '__next', 'app', 'root', 'app-root']);

function attributeOf(el: DomNodeLike, name: string): string {
  if (typeof el.getAttribute !== 'function') return '';
  try {
    return (el.getAttribute(name) ?? '').trim().toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Raíz global del documento o de la aplicación. Nunca es una región: devolverla
 * equivale a serializar la página entera.
 */
export function isGlobalRoot(el: DomNodeLike | null | undefined): boolean {
  if (!el) return false;
  const tag = String(el.tagName ?? el.nodeName ?? '').toLowerCase();
  if (GLOBAL_ROOT_TAGS.has(tag)) return true;
  const id = attributeOf(el, 'id');
  return id !== '' && GLOBAL_ROOT_IDS.has(id);
}

/** Descendientes de un elemento, contando con tope (no recorre de más). */
export function countDescendants(el: DomNodeLike, limit = MAX_REGION_DESCENDANTS + 1): number {
  const cap = Number.isFinite(limit) && limit > 0 ? limit : MAX_REGION_DESCENDANTS + 1;
  let count = 0;
  const stack: DomNodeLike[] = [el];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const kid of childElements(node)) {
      count += 1;
      if (count >= cap) return count;
      stack.push(kid);
    }
  }
  return count;
}

/** Una región utilizable no es una raíz global ni un subárbol desmedido. */
export function isUsableRegion(el: DomNodeLike | null | undefined): boolean {
  if (!el) return false;
  if (isGlobalRoot(el)) return false;
  return countDescendants(el, MAX_REGION_DESCENDANTS + 1) <= MAX_REGION_DESCENDANTS;
}

/**
 * Une varios subárboles en un nodo virtual (sin tocar el DOM): los lectores
 * reciben una sola región aunque Binance reparta las tarjetas por ramas.
 */
export function mergeRegions(roots: readonly DomNodeLike[]): DomNodeLike | null {
  if (roots.length === 0) return null;
  if (roots.length === 1) return roots[0]!;
  const children = roots.slice();
  return { tagName: 'section', nodeName: 'section', childNodes: children, children } as DomNodeLike;
}

function isAncestorOf(candidate: DomNodeLike, el: DomNodeLike): boolean {
  return ancestorChain(el).includes(candidate);
}

/**
 * Región de las tarjetas de «Historial de posiciones».
 *
 * Se localizan las tarjetas MINIMALES (las que cumplen las etiquetas y no
 * contienen otra tarjeta) y se devuelven sus subárboles. Si todas cuelgan de un
 * contenedor acotado, se devuelve ese contenedor (una sola región); si el
 * ancestro común es `body`, `main` o un subárbol desmedido, se devuelven las
 * tarjetas para que el lector las una sin serializar la página entera.
 *
 * Lista vacía si la pestaña de historial no está abierta.
 */
export function findHistoryRegions(source: RegionSource, opts: RegionOptions = {}): DomNodeLike[] {
  const elements = collectElements(source, opts.maxElements);
  if (elements.length === 0) return [];
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
  // Una tarjeta desmedida tampoco vale: se descarta antes de unir nada.
  const usable = cards.filter((card) => isUsableRegion(card));
  if (usable.length === 0) return [];
  if (usable.length === 1) return usable;

  // Ancestro común más bajo, pero solo si es acotado: se cruzan las cadenas de
  // padres de todas las tarjetas y se queda el primero que aparece en todas.
  const restChains = usable.slice(1).map((card) => new Set(ancestorChain(card)));
  for (const candidate of ancestorChain(usable[0]!)) {
    if (!isUsableRegion(candidate)) continue;
    if (restChains.every((chain) => chain.has(candidate))) return [candidate];
  }
  // Sin ancestro acotado (p. ej. dos ramas hermanas de `body`): las tarjetas.
  return usable;
}

/** La región del historial, uniendo las tarjetas si están en ramas distintas. */
export function findHistoryRegion(source: RegionSource, opts: RegionOptions = {}): DomNodeLike | null {
  return mergeRegions(findHistoryRegions(source, opts));
}

/**
 * Región de la caja de cuenta: el contenedor MÁS PEQUEÑO que reúne al menos
 * tres etiquetas de saldo (`Balance de margen`, `Disp.`, ...). Lista vacía si la
 * página no muestra ninguna. Se agrega de hijos a padres (post-orden) para no
 * confundir una caja con el documento entero.
 *
 * Si el «contenedor más pequeño» que reúne las tres etiquetas resulta ser
 * `main`/`body` o un subárbol desmedido (las etiquetas están repartidas por
 * ramas), no se devuelve eso: se devuelven las ramas que llevan las etiquetas y
 * el lector las une. Serializar `main` con 21.000 nodos no es un diagnóstico.
 */
export function findAccountBalanceRegions(
  source: RegionSource,
  opts: RegionOptions = {},
): DomNodeLike[] {
  const elements = collectElements(source, opts.maxElements);
  if (elements.length === 0) return [];
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
  if (!best) return [];
  if (isUsableRegion(best.el)) return [best.el];
  return balanceBranchRoots(elements, best.el);
}

/**
 * Ramas con etiquetas de saldo, subiendo desde cada etiqueta hasta el ancestro
 * más alto que siga siendo acotado. Se quedan solo las de fuera: una rama que
 * ya está dentro de otra no se repite.
 */
function balanceBranchRoots(
  elements: readonly DomNodeLike[],
  boundary: DomNodeLike,
): DomNodeLike[] {
  const roots: DomNodeLike[] = [];
  for (const el of elements) {
    const key = labelOf(el);
    if (!key || !BALANCE_KEYS.has(key)) continue;
    let node: DomNodeLike = el;
    let parent = (el as DomElementLike).parentElement ?? null;
    while (parent && parent !== boundary && isUsableRegion(parent)) {
      node = parent;
      parent = (parent as DomElementLike).parentElement ?? null;
    }
    roots.push(node);
  }
  const unique = [...new Set(roots)].filter((root) => isUsableRegion(root));
  return unique.filter((root) => !unique.some((other) => other !== root && isAncestorOf(other, root)));
}

/** La caja de cuenta, uniendo sus ramas si las etiquetas están repartidas. */
export function findAccountBalanceRegion(
  source: RegionSource,
  opts: RegionOptions = {},
): DomNodeLike | null {
  return mergeRegions(findAccountBalanceRegions(source, opts));
}
