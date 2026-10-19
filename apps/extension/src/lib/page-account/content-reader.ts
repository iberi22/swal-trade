// Lectura de una página de Binance Futures ya renderizada: localiza las dos
// regiones (posiciones abiertas e historial), las convierte a `TextNode` y
// pasa los parsers puros. Nunca escribe en la página ni pulsa nada.

import { parsePositionHistory, type ClosedPosition } from './parse-history';
import { parseOpenPositions, type PagePosition } from './parse-positions';
import { findHistoryRegion, findOpenPositionsRegion, type RegionSource } from './region';
import { countTextNodes, toTextTree, type DomNodeLike, type TextNode } from './tree';
import { PAGE_HISTORY_MAX, PAGE_POSITIONS_MAX } from './messages';

export interface PageReadOptions {
  /** Offset de la página en minutos (`Date#getTimezoneOffset`). */
  tzOffsetMinutes?: number;
  /** Tope de nodos de cada región (por defecto 4000). */
  maxNodes?: number;
}

export interface PageReadResult {
  positions: PagePosition[];
  history: ClosedPosition[];
  /** Huella del contenido leído: cambia solo si cambian los datos. */
  fingerprint: string;
  /** Árbol de la región leída, para el diagnóstico anonimizado. */
  tree: TextNode | null;
}

const DEFAULT_MAX_NODES = 4000;

/** djb2 en hexadecimal: barato y suficiente para comparar dos lecturas. */
export function fingerprintOf(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return `${hash.toString(16)}:${text.length}`;
}

function treeOf(region: DomNodeLike | null, maxNodes: number): TextNode | null {
  if (!region) return null;
  const tree = toTextTree(region, { maxNodes, maxDepth: 30 });
  return tree.tag === 'unknown' ? null : tree;
}

/** Lee lo que la página muestra ahora mismo. Nunca lanza. */
export function readPageAccount(source: RegionSource, opts: PageReadOptions = {}): PageReadResult {
  const tzOffsetMinutes = Number.isFinite(opts.tzOffsetMinutes) ? (opts.tzOffsetMinutes as number) : 0;
  const maxNodes =
    Number.isFinite(opts.maxNodes) && (opts.maxNodes as number) > 0
      ? Math.floor(opts.maxNodes as number)
      : DEFAULT_MAX_NODES;

  try {
    const positionsTree = treeOf(findOpenPositionsRegion(source), maxNodes);
    const historyTree = treeOf(findHistoryRegion(source), maxNodes);

    const positions = positionsTree ? parseOpenPositions(positionsTree).slice(0, PAGE_POSITIONS_MAX) : [];
    const history = historyTree
      ? parsePositionHistory(historyTree, { tzOffsetMinutes }).slice(0, PAGE_HISTORY_MAX)
      : [];

    // Para el diagnóstico se manda la región más rica de las dos.
    const tree =
      positionsTree && historyTree
        ? countTextNodes(historyTree) > countTextNodes(positionsTree)
          ? historyTree
          : positionsTree
        : (positionsTree ?? historyTree);

    return {
      positions,
      history,
      fingerprint: fingerprintOf(JSON.stringify({ positions, history })),
      tree,
    };
  } catch {
    return { positions: [], history: [], fingerprint: fingerprintOf(''), tree: null };
  }
}
