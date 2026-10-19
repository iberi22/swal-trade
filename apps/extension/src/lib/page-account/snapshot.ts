// Export de diagnostico anonimizado: el usuario nos lo envia cuando el parser
// no reconoce su pantalla. Conserva la estructura y las etiquetas conocidas,
// tapa todos los demas digitos y elimina los valores de los inputs.

import { isSymbolToken } from './parse-history';
import { matchLabel } from './labels';
import type { TextNode, TextNodeAttrs } from './tree';

export interface AnonymizeOptions {
  maxDepth?: number;
  maxNodes?: number;
  /** Longitud maxima de cada texto conservado (por defecto 300). */
  maxTextLength?: number;
}

const DEFAULT_MAX_DEPTH = 40;
const DEFAULT_MAX_NODES = 2000;
const DEFAULT_MAX_TEXT_LENGTH = 300;
const MAX_COMPACT_CHARS = 60_000;

function maskDigits(text: string): string {
  return text.replace(/\d/g, '9');
}

function maskText(raw: string, maxLength: number): string {
  const text = raw.replace(/[\s\u00a0\u202f]+/g, ' ').trim();
  if (!text) return '';
  // Etiquetas conocidas y simbolos se conservan tal cual: son justo lo que
  // necesitamos para entender por que fallo el parser.
  if (matchLabel(text) !== null) return text.slice(0, maxLength);
  if (isSymbolToken(text)) return text.slice(0, maxLength);
  let out = '';
  let last = 0;
  for (const match of text.matchAll(/[0-9A-Z]{2,20}(?:USDT|USDC|BUSD)/g)) {
    const index = match.index ?? 0;
    out += maskDigits(text.slice(last, index)) + match[0];
    last = index + match[0].length;
  }
  out += maskDigits(text.slice(last));
  return out.slice(0, maxLength);
}

function anonymizeAttrs(attrs: TextNodeAttrs | undefined, maxTextLength: number): TextNodeAttrs | undefined {
  if (!attrs) return undefined;
  const out: TextNodeAttrs = {};
  if (attrs.role) out.role = maskText(attrs.role, maxTextLength);
  if (attrs.ariaLabel) out.ariaLabel = maskText(attrs.ariaLabel, maxTextLength);
  // `type` y `value` se descartan: los inputs son ordenes de cierre.
  return Object.keys(out).length > 0 ? out : undefined;
}

interface AnonymizeState {
  count: number;
  maxNodes: number;
}

function anonymizeNode(
  node: TextNode,
  depth: number,
  state: AnonymizeState,
  opts: Required<AnonymizeOptions>,
): TextNode | null {
  if (state.count >= opts.maxNodes) return null;
  if (!node || typeof node !== 'object') return null;
  state.count += 1;
  const out: TextNode = { tag: typeof node.tag === 'string' ? node.tag : 'unknown' };
  if (typeof node.text === 'string') {
    const text = maskText(node.text, opts.maxTextLength);
    if (text) out.text = text;
  }
  const attrs = anonymizeAttrs(node.attrs, opts.maxTextLength);
  if (attrs) out.attrs = attrs;
  if (depth < opts.maxDepth && Array.isArray(node.children) && node.children.length > 0) {
    const children: TextNode[] = [];
    for (const child of node.children) {
      const built = anonymizeNode(child, depth + 1, state, opts);
      if (built) children.push(built);
      if (state.count >= opts.maxNodes) break;
    }
    if (children.length > 0) out.children = children;
  }
  return out;
}

/** Copia anonimizada del arbol, segura para enviar por chat. */
export function anonymizeTree(
  node: TextNode | null | undefined,
  opts: AnonymizeOptions = {},
): TextNode {
  const resolved: Required<AnonymizeOptions> = {
    maxDepth: Number.isFinite(opts.maxDepth) ? (opts.maxDepth as number) : DEFAULT_MAX_DEPTH,
    maxNodes: Number.isFinite(opts.maxNodes) ? (opts.maxNodes as number) : DEFAULT_MAX_NODES,
    maxTextLength: Number.isFinite(opts.maxTextLength)
      ? (opts.maxTextLength as number)
      : DEFAULT_MAX_TEXT_LENGTH,
  };
  try {
    const built = anonymizeNode(node as TextNode, 0, { count: 0, maxNodes: resolved.maxNodes }, resolved);
    return built ?? { tag: 'unknown' };
  } catch {
    return { tag: 'unknown' };
  }
}

/** Texto compacto con sangria para pegar en un informe. Maximo 60 KB. */
export function treeToCompactText(node: TextNode | null | undefined, maxChars = MAX_COMPACT_CHARS): string {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : MAX_COMPACT_CHARS;
  const lines: string[] = [];
  let length = 0;
  let truncated = false;

  const visit = (current: TextNode, depth: number, depthLimit: number): void => {
    if (truncated || !current || typeof current !== 'object') return;
    const parts = [current.tag];
    if (current.attrs?.role) parts.push(`role=${current.attrs.role}`);
    if (current.attrs?.ariaLabel) parts.push(`aria-label="${current.attrs.ariaLabel}"`);
    if (current.text) parts.push(`"${current.text}"`);
    const line = `${'  '.repeat(Math.min(depth, 40))}${parts.join(' ')}`;
    if (length + line.length + 1 > limit) {
      truncated = true;
      return;
    }
    lines.push(line);
    length += line.length + 1;
    if (depth >= depthLimit) return;
    for (const child of current.children ?? []) visit(child, depth + 1, depthLimit);
  };

  try {
    visit(node as TextNode, 0, 60);
  } catch {
    return '<unknown>';
  }
  if (truncated) {
    const marker = '… (truncated)';
    if (length + marker.length + 1 <= limit) lines.push(marker);
  }
  return lines.join('\n');
}

export { MAX_COMPACT_CHARS };
