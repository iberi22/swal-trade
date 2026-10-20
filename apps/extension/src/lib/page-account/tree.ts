// Arbol de texto serializable de una porcion del DOM de Binance.
//
// Binance ofusca las clases y las cambia a menudo, asi que la fase 2 solo
// necesitara este arbol (no el DOM) para extraer datos. Aqui no se toca el DOM
// al cargar el modulo: `toTextTree` recibe una interfaz estructural minima para
// poder probarse sin `lib.dom` y sin jsdom.

/** Atributos que conservamos: son estables y utiles para diagnosticar. */
export interface TextNodeAttrs {
  role?: string;
  ariaLabel?: string;
  type?: string;
  value?: string;
  /** El elemento acepta texto del usuario (`contenteditable`). */
  editable?: true;
}

/** Nodo serializable. Solo guarda texto DIRECTO, nunca el de sus descendientes. */
export interface TextNode {
  tag: string;
  text?: string;
  children?: TextNode[];
  attrs?: TextNodeAttrs;
}

/**
 * Interfaz estructural minima de un nodo del DOM. `Element`, `Node` y los
 * objetos de linkedom encajan sin necesidad de importar tipos de `lib.dom`.
 */
export interface DomNodeLike {
  nodeType?: number;
  tagName?: string;
  nodeName?: string;
  textContent?: string | null;
  nodeValue?: string | null;
  value?: unknown;
  childNodes?: ArrayLike<DomNodeLike>;
  children?: ArrayLike<DomNodeLike>;
  getAttribute?: (name: string) => string | null;
}

export interface TreeOptions {
  /** Profundidad maxima (por defecto 40). */
  maxDepth?: number;
  /** Numero maximo de nodos serializados (por defecto 5000). */
  maxNodes?: number;
}

export interface TextOptions {
  /** Incluye el `value` de los inputs al leer texto (por defecto false). */
  includeInputValues?: boolean;
}

const DEFAULT_MAX_DEPTH = 40;
const DEFAULT_MAX_NODES = 5000;

/** Etiquetas que nunca aportan datos y sí mucho ruido. */
const SKIPPED_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'canvas',
  'iframe',
  'meta',
  'link',
  'head',
  'title',
]);

const INPUT_TAGS = new Set(['input', 'textarea', 'select']);

interface BuildState {
  count: number;
  maxNodes: number;
}

function collapse(value: string): string {
  return value.replace(/[\s\u00a0\u202f]+/g, ' ').trim();
}

function childList(el: DomNodeLike): ArrayLike<DomNodeLike> | null {
  if (el.childNodes && typeof el.childNodes.length === 'number') return el.childNodes;
  if (el.children && typeof el.children.length === 'number') return el.children;
  return null;
}

function nodeText(node: DomNodeLike): string {
  if (typeof node.nodeValue === 'string') return node.nodeValue;
  if (typeof node.textContent === 'string') return node.textContent;
  return '';
}

/** Texto de los nodos de texto hijos directos, ya colapsado. */
function directText(el: DomNodeLike, kids: ArrayLike<DomNodeLike> | null): string {
  if (!kids) {
    return typeof el.textContent === 'string' ? collapse(el.textContent) : '';
  }
  const parts: string[] = [];
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i];
    if (!kid || kid.nodeType !== 3) continue;
    const text = collapse(nodeText(kid));
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

function attr(el: DomNodeLike, name: string): string | null {
  if (typeof el.getAttribute !== 'function') return null;
  try {
    return el.getAttribute(name);
  } catch {
    return null;
  }
}

function buildNode(el: DomNodeLike, depth: number, state: BuildState, maxDepth: number): TextNode | null {
  if (state.count >= state.maxNodes) return null;
  const tag = String(el.tagName ?? el.nodeName ?? '').toLowerCase();
  if (!tag || SKIPPED_TAGS.has(tag)) return null;
  state.count += 1;

  const node: TextNode = { tag };
  const kids = childList(el);
  const text = directText(el, kids);
  if (text) node.text = text;

  const attrs: TextNodeAttrs = {};
  const role = attr(el, 'role');
  if (role && role.trim()) attrs.role = role.trim();
  const ariaLabel = attr(el, 'aria-label') ?? attr(el, 'ariaLabel');
  if (ariaLabel && ariaLabel.trim()) attrs.ariaLabel = ariaLabel.trim();
  if (INPUT_TAGS.has(tag)) {
    const type = attr(el, 'type');
    if (type && type.trim()) attrs.type = type.trim();
    const rawValue = typeof el.value === 'string' ? el.value : attr(el, 'value');
    if (rawValue && rawValue.trim()) attrs.value = rawValue.trim();
  }
  // `contenteditable` no se guarda como atributo: solo se marca para que el
  // diagnóstico sepa que su texto es del usuario y no de la página.
  const editable = attr(el, 'contenteditable');
  if (editable === 'true' || editable === '' || editable === 'plaintext-only') attrs.editable = true;
  if (Object.keys(attrs).length > 0) node.attrs = attrs;

  if (kids && depth < maxDepth) {
    const children: TextNode[] = [];
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i];
      if (!kid) continue;
      // Los nodos de texto ya se guardaron en `node.text`.
      if (kid.nodeType === 3) continue;
      const built = buildNode(kid, depth + 1, state, maxDepth);
      if (built) children.push(built);
      if (state.count >= state.maxNodes) break;
    }
    if (children.length > 0) node.children = children;
  }

  return node;
}

/**
 * Convierte un elemento en `TextNode`. Nunca lanza: si la entrada no es
 * usable devuelve un nodo vacio con tag `unknown`.
 */
export function toTextTree(el: DomNodeLike | null | undefined, opts: TreeOptions = {}): TextNode {
  try {
    if (!el || typeof el !== 'object') return { tag: 'unknown' };
    const maxDepth = Number.isFinite(opts.maxDepth) ? Math.max(0, opts.maxDepth as number) : DEFAULT_MAX_DEPTH;
    const maxNodes = Number.isFinite(opts.maxNodes) ? Math.max(1, opts.maxNodes as number) : DEFAULT_MAX_NODES;
    const built = buildNode(el, 0, { count: 0, maxNodes }, maxDepth);
    return built ?? { tag: 'unknown' };
  } catch {
    return { tag: 'unknown' };
  }
}

/** Recorre el arbol en orden de documento. Devolver `false` poda los hijos. */
export function walkTextTree(
  node: TextNode | null | undefined,
  visit: (node: TextNode, depth: number) => void | false,
  depth = 0,
): void {
  if (!node || typeof node !== 'object') return;
  const result = visit(node, depth);
  if (result === false) return;
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) walkTextTree(child, visit, depth + 1);
}

/** Todos los nodos que cumplen el predicado, en orden de documento. */
export function findTextNodes(
  root: TextNode | null | undefined,
  predicate: (node: TextNode) => boolean,
): TextNode[] {
  const out: TextNode[] = [];
  walkTextTree(root, (node) => {
    if (predicate(node)) out.push(node);
  });
  return out;
}

/** Texto directo de un nodo (vacio si no tiene). */
export function nodeTextOf(node: TextNode | null | undefined): string {
  if (!node || typeof node.text !== 'string') return '';
  return collapse(node.text);
}

/**
 * Texto de todos los nodos, en orden de documento. Los valores de inputs se
 * omiten por defecto: son ordenes de cierre y no datos de la posicion.
 */
export function collectTexts(node: TextNode | null | undefined, opts: TextOptions = {}): string[] {
  const out: string[] = [];
  walkTextTree(node, (current) => {
    const text = nodeTextOf(current);
    if (text) out.push(text);
    const value = opts.includeInputValues ? current.attrs?.value : undefined;
    if (value) {
      const collapsed = collapse(value);
      if (collapsed) out.push(collapsed);
    }
  });
  return out;
}

/** Todo el texto del subarbol en una sola linea, colapsado. */
export function flattenText(node: TextNode | null | undefined, opts: TextOptions = {}): string {
  return collapse(collectTexts(node, opts).join(' '));
}

/** Numero de nodos del subarbol, respetando el limite pedido. */
export function countTextNodes(node: TextNode | null | undefined, limit = DEFAULT_MAX_NODES): number {
  let count = 0;
  walkTextTree(node, () => {
    count += 1;
    if (count >= limit) return false;
    return undefined;
  });
  return count;
}
