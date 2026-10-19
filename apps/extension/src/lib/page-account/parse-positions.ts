// Parser de la tabla de posiciones abiertas de Binance Futures.
//
// Se localiza la fila de cabecera por sus etiquetas visibles (>= 4 conocidas)
// y se mapean las celdas de cada fila por el ORDEN de esas etiquetas. Nada
// depende de clases CSS ni de los inputs de "Cerrar", que se ignoran.

import {
  matchLabel,
  type LabelKey,
} from './labels';
import { parseLeverage, parsePercent, parsePrice, parseSignedAmount } from './numbers';
import { flattenText, walkTextTree, type TextNode } from './tree';
import type { MarginType, PositionSide, PositionView } from '../account/types';

/** Activos de cotizacion: el tamano en ellos es nocional, no unidades base. */
const QUOTE_ASSETS = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'USDE']);

export interface PriceAmount {
  value: number;
  asset: string;
}

export interface PagePosition {
  symbol: string;
  contract: 'perp' | null;
  leverage: number | null;
  marginMode: MarginType | null;
  side: PositionSide | null;
  /** Tamano tal como se muestra en la moneda de cotizacion (`254.56 USDC`). */
  sizeQuote: PriceAmount | null;
  /** Tamano en unidades base (`0.004`), con signo original. */
  sizeBase: number | null;
  uPnl: number | null;
  roiPct: number | null;
  entry: number | null;
  breakEven: number | null;
  mark: number | null;
  liq: number | null;
}

export interface PositionViewOptions {
  /** Instante de la lectura; reservado (PositionView no guarda `now`). */
  nowMs?: number;
}

interface HeaderInfo {
  columns: Array<LabelKey | null>;
  keys: Set<LabelKey>;
}

/** Celda de simbolo estricta: evita confundir una fila entera con una celda. */
const SYMBOL_CELL = new RegExp(
  '^([0-9A-Z]{2,20}(?:USDT|USDC|BUSD))' +
    '(?:\\s+(?:Perp\\.?|Perpetual))?' +
    '(?:\\s+\\d{1,3}\\s*x)?' +
    '(?:\\s+(?:Cross|Isolated|Cruzado|Aislado))?' +
    '(?:\\s+(?:Long|Short|Largo|Corto))?$',
  'i',
);

function headerOf(node: TextNode): HeaderInfo | null {
  const children = node.children ?? [];
  if (children.length < 4) return null;
  const columns: Array<LabelKey | null> = children.map((child) => matchLabel(flattenText(child))?.key ?? null);
  const keys = new Set(columns.filter((key): key is LabelKey => key !== null));
  if (keys.size < 4 || !keys.has('symbol')) return null;
  const hasPrice = keys.has('entry') || keys.has('mark') || keys.has('liq') || keys.has('breakEven');
  if (!hasPrice) return null;
  return { columns, keys };
}

function findHeader(root: TextNode): { node: TextNode; info: HeaderInfo } | null {
  let best: { node: TextNode; info: HeaderInfo } | null = null;
  walkTextTree(root, (node) => {
    const info = headerOf(node);
    if (!info) return;
    if (!best || info.keys.size > best.info.keys.size) best = { node, info };
  });
  return best;
}

function symbolFromCell(raw: string): string | null {
  const text = raw.trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const match = SYMBOL_CELL.exec(text);
  return match ? (match[1] ?? '').toUpperCase() : null;
}

function marginModeOf(texts: string[]): MarginType | null {
  for (const text of texts) if (/\b(?:cruzado|cross)\b/i.test(text)) return 'cross';
  for (const text of texts) if (/\b(?:aislado|isolated)\b/i.test(text)) return 'isolated';
  return null;
}

function leverageOf(texts: string[]): number | null {
  for (const text of texts) {
    const value = parseLeverage(text);
    if (value !== null) return value;
  }
  return null;
}

function inferSide(
  sizeBase: number | null,
  sizeQuote: PriceAmount | null,
  entry: number | null,
  liq: number | null,
): PositionSide | null {
  if (sizeBase !== null && sizeBase !== 0) return sizeBase < 0 ? 'short' : 'long';
  // Cross margin puede alejar el precio de liquidacion, pero nunca lo cruza.
  if (entry !== null && liq !== null && entry !== liq) return liq < entry ? 'long' : 'short';
  if (sizeQuote !== null && sizeQuote.value !== 0) return sizeQuote.value < 0 ? 'short' : 'long';
  return null;
}

function countKnown(p: PagePosition): number {
  let n = 0;
  for (const value of [p.leverage, p.entry, p.breakEven, p.mark, p.liq, p.uPnl, p.roiPct]) {
    if (value !== null) n += 1;
  }
  if (p.sizeQuote !== null || p.sizeBase !== null) n += 1;
  return n;
}

function parseRow(cells: string[], columns: Array<LabelKey | null>): PagePosition | null {
  const symbolIndex = columns.indexOf('symbol');
  if (symbolIndex < 0) return null;
  const symbol = symbolFromCell(cells[symbolIndex] ?? '');
  if (!symbol) return null;

  const cell = (key: LabelKey): string => {
    const index = columns.indexOf(key);
    return index >= 0 ? (cells[index] ?? '') : '';
  };

  const sizeText = cell('size');
  const sizeAmount = parseSignedAmount(sizeText);
  let sizeQuote: PriceAmount | null = null;
  let sizeBase: number | null = null;
  if (sizeAmount && sizeAmount.asset) {
    if (QUOTE_ASSETS.has(sizeAmount.asset)) {
      sizeQuote = { value: sizeAmount.value, asset: sizeAmount.asset };
    } else {
      sizeBase = sizeAmount.value;
    }
  } else if (sizeAmount) {
    // Sin activo visible: se asume base (la UI siempre lo pinta con activo).
    sizeBase = sizeAmount.value;
  }

  const pnlText = cell('pnl');
  const pnlAmount = parseSignedAmount(pnlText);
  const entry = parsePrice(cell('entry'));
  const mark = parsePrice(cell('mark'));
  const liq = parsePrice(cell('liq'));

  const position: PagePosition = {
    symbol,
    contract: /\bperp(?:etual)?\b/i.test(cells.slice(0, 3).join(' ')) ? 'perp' : null,
    leverage: leverageOf(cells),
    marginMode: marginModeOf(cells),
    side: inferSide(sizeBase, sizeQuote, entry, liq),
    sizeQuote,
    sizeBase,
    uPnl: pnlAmount?.value ?? null,
    roiPct: parsePercent(pnlText),
    entry,
    breakEven: parsePrice(cell('breakEven')),
    mark,
    liq,
  };
  if (countKnown(position) < 3) return null;
  return position;
}

/**
 * Posiciones abiertas visibles en la pagina. Devuelve [] si no encuentra la
 * cabecera o las filas. Nunca lanza.
 */
export function parseOpenPositions(root: TextNode | null | undefined): PagePosition[] {
  try {
    if (!root || typeof root !== 'object') return [];
    const header = findHeader(root);
    if (!header) return [];
    const out: PagePosition[] = [];
    const seen = new Set<string>();

    walkTextTree(root, (node) => {
      const children = node.children ?? [];
      if (children.length < 4) return;
      const cells = children.map((child) => flattenText(child));
      const position = parseRow(cells, header.info.columns);
      if (!position) return;
      const key = `${position.symbol}|${position.side ?? ''}|${position.sizeBase ?? position.sizeQuote?.value ?? ''}|${position.entry ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(position);
      }
      // Es una fila: no seguir bajando (evita filas anidadas duplicadas).
      return false;
    });

    return out;
  } catch {
    return [];
  }
}

/**
 * Mapea a `PositionView` (el tipo que ya usa el panel). Devuelve null si
 * faltan datos imprescindibles (lado, apalancamiento, entrada o marca).
 *
 * La tabla de posiciones abiertas no muestra el modo de margen; cuando falta se
 * usa `cross` como valor neutro (la pagina solo lo pinta en el historial).
 *
 * Cuando la pagina solo muestra el tamano en la moneda de cotizacion, el tamano
 * en unidades base se deriva como `sizeQuote.value / mark` (documentado: es una
 * aproximacion, no el `positionAmt` del exchange).
 */
export function toPositionView(
  position: PagePosition,
  opts: PositionViewOptions = {},
): PositionView | null {
  void opts;
  if (!position || !position.symbol) return null;
  if (!position.side || position.leverage === null) return null;
  if (position.entry === null || position.mark === null || position.mark <= 0) return null;

  let size: number | null = null;
  if (position.sizeBase !== null) size = Math.abs(position.sizeBase);
  else if (position.sizeQuote !== null) size = Math.abs(position.sizeQuote.value) / position.mark;
  if (size === null || !Number.isFinite(size) || size <= 0) return null;

  const notional =
    position.sizeQuote !== null ? Math.abs(position.sizeQuote.value) : size * position.mark;

  return {
    symbol: position.symbol,
    side: position.side,
    size,
    entry: position.entry,
    mark: position.mark,
    liq: position.liq,
    leverage: position.leverage,
    marginType: position.marginMode ?? 'cross',
    uPnl: position.uPnl ?? 0,
    breakEven: position.breakEven,
    notional,
    stop: null,
    firstFillMs: null,
  };
}
