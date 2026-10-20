// Lectura de una página de Binance Futures ya renderizada: localiza las
// regiones (caja de cuenta, posiciones abiertas e historial), las convierte a
// `TextNode` y pasa los parsers puros del adaptador del exchange. Nunca
// escribe en la página ni pulsa nada.

import { binanceAdapter } from '../exchanges/binance';
import type { ExchangeAdapter } from '../exchanges/types';
import type { PageBalance } from './parse-balance';
import { parsePositionHistory, type ClosedPosition } from './parse-history';
import { parseOpenPositions, type PagePosition } from './parse-positions';
import {
  findAccountBalanceRegion,
  findHistoryRegion,
  findOpenPositionsRegion,
  type RegionSource,
} from './region';
import { countTextNodes, toTextTree, type DomNodeLike, type TextNode } from './tree';
import { PAGE_HISTORY_MAX, PAGE_POSITIONS_MAX } from './messages';

export interface PageReadOptions {
  /** Offset de la página en minutos (`Date#getTimezoneOffset`). */
  tzOffsetMinutes?: number;
  /** Tope de nodos de cada región (por defecto 4000). */
  maxNodes?: number;
  /**
   * Adaptador del exchange. Por defecto Binance (el único `supported`): la
   * lectura de su página no cambia. Un adaptador `detected` no tiene lectores y
   * devuelve listas vacías en vez de inventar datos.
   */
  adapter?: ExchangeAdapter;
}

export interface PageReadResult {
  balance: PageBalance | null;
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
  const adapter = opts.adapter ?? binanceAdapter;
  const readers = adapter.readers;

  try {
    const balanceTree = treeOf(findAccountBalanceRegion(source), maxNodes);
    const positionsTree = treeOf(findOpenPositionsRegion(source), maxNodes);
    const historyTree = treeOf(findHistoryRegion(source), maxNodes);

    // Un adaptador sin lectores (estado `detected`) no lee nada: devuelve vacío.
    const balance = readers ? readers.balance(balanceTree) : null;
    const positions = readers ? readers.positions(positionsTree).slice(0, PAGE_POSITIONS_MAX) : [];
    const history = readers
      ? readers.history(historyTree, { tzOffsetMinutes }).slice(0, PAGE_HISTORY_MAX)
      : [];

    // Para el diagnóstico se manda la región más rica de las tres.
    const candidates = [balanceTree, positionsTree, historyTree].filter(
      (tree): tree is TextNode => tree !== null,
    );
    let tree: TextNode | null = null;
    for (const candidate of candidates) {
      if (tree === null || countTextNodes(candidate) > countTextNodes(tree)) tree = candidate;
    }

    return {
      balance,
      positions,
      history,
      // El saldo entra en la huella: cambia sin que cambien las posiciones.
      fingerprint: fingerprintOf(JSON.stringify({ balance, positions, history })),
      tree,
    };
  } catch {
    return { balance: null, positions: [], history: [], fingerprint: fingerprintOf(''), tree: null };
  }
}
