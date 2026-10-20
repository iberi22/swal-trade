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

/**
 * Lado escrito en la propia fila (`Long`/`Short`, `Largo`/`Corto`), muchas
 * veces pegado al modo de margen (`Cross Short`, `Cruzado Corto`). Manda sobre
 * cualquier otra pista: es lo que la pagina afirma, no una deduccion.
 */
function sideFromText(texts: string[]): PositionSide | null {
  for (const text of texts) {
    if (/\b(?:short|corto|corta)\b/i.test(text)) return 'short';
    if (/\b(?:long|largo|larga)\b/i.test(text)) return 'long';
  }
  return null;
}

/**
 * Prioridad del lado, de mas fiable a menos:
 * 1. texto explicito de la fila (Long/Short, Largo/Corto);
 * 2. tamano base con signo (el `positionAmt` que pinta Binance);
 * 3. liquidacion frente a entrada (en cross puede alejarse, pero nunca cruza);
 * 4. null: lado DESCONOCIDO.
 *
 * NO se usa el signo del tamano en la moneda de cotizacion: es un importe, no
 * una direccion (un saldo positivo no implica largo), y deducir el lado de ahi
 * inventaba una posicion. Antes de inventarla, el panel dice «lado desconocido».
 */
function inferSide(
  texts: string[],
  sizeBase: number | null,
  entry: number | null,
  liq: number | null,
): PositionSide | null {
  const explicit = sideFromText(texts);
  if (explicit !== null) return explicit;
  if (sizeBase !== null && sizeBase !== 0) return sizeBase < 0 ? 'short' : 'long';
  if (entry !== null && liq !== null && entry !== liq) return liq < entry ? 'long' : 'short';
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
    side: inferSide(cells, sizeBase, entry, liq),
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
 * Por que una fila no se puede enseñar como `PositionView`. El panel lo usa
 * para decir «lado desconocido» en vez de inventar una direccion.
 */
export type PositionViewSkip =
  | 'no_side'
  | 'no_leverage'
  | 'no_prices'
  | 'no_size';

export type PositionViewResult =
  | { ok: true; view: PositionView }
  | { ok: false; reason: PositionViewSkip };

/** Texto corto para el panel cuando una fila se descarta. */
export const POSITION_SKIP_TEXT: Record<PositionViewSkip, string> = {
  no_side: 'lado desconocido',
  no_leverage: 'apalancamiento desconocido',
  no_prices: 'faltan entrada o marca',
  no_size: 'tamaño desconocido',
};

/**
 * Mapea a `PositionView` (el tipo que ya usa el panel). Devuelve `ok: false`
 * con el motivo si falta algo imprescindible. Nunca inventa el lado: si la
 * fila no lo dice (ni texto, ni signo, ni liquidacion) se descarta.
 *
 * La tabla de posiciones abiertas no muestra el modo de margen; cuando falta se
 * usa `cross` como valor neutro (la pagina solo lo pinta en el historial).
 *
 * Cuando la pagina solo muestra el tamano en la moneda de cotizacion, el tamano
 * en unidades base se deriva como `sizeQuote.value / mark` (documentado: es una
 * aproximacion, no el `positionAmt` del exchange).
 */
export function positionViewFrom(
  position: PagePosition,
  opts: PositionViewOptions = {},
): PositionViewResult {
  void opts;
  if (!position || !position.symbol) return { ok: false, reason: 'no_prices' };
  if (!position.side) return { ok: false, reason: 'no_side' };
  if (position.leverage === null) return { ok: false, reason: 'no_leverage' };
  if (position.entry === null || position.mark === null || position.mark <= 0) {
    return { ok: false, reason: 'no_prices' };
  }

  let size: number | null = null;
  if (position.sizeBase !== null) size = Math.abs(position.sizeBase);
  else if (position.sizeQuote !== null) size = Math.abs(position.sizeQuote.value) / position.mark;
  if (size === null || !Number.isFinite(size) || size <= 0) return { ok: false, reason: 'no_size' };

  const notional =
    position.sizeQuote !== null ? Math.abs(position.sizeQuote.value) : size * position.mark;

  return {
    ok: true,
    view: {
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
    },
  };
}

/** Compatibilidad: la vista o null (descarta la fila si falta el lado). */
export function toPositionView(
  position: PagePosition,
  opts: PositionViewOptions = {},
): PositionView | null {
  const result = positionViewFrom(position, opts);
  return result.ok ? result.view : null;
}
