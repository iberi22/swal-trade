import { roundToTick } from '../sizing';
import type { DrawingSide, PositionDrawing } from './types';
import { validateDrawing } from './validate';

/**
 * Lectura PURA (sin DOM) de una herramienta Long/Short Position de
 * TradingView. Fórmula verificada contra la herramienta real:
 *
 *   minTick = minmov / pricescale
 *   entry   = points[0].price
 *   long:  stop = entry - stopLevel  * minTick
 *          target = entry + profitLevel * minTick
 *   short: stop = entry + stopLevel  * minTick
 *          target = entry - profitLevel * minTick
 *
 * El stop y el objetivo se redondean al tick. Cualquier campo ausente o
 * inválido devuelve null: nunca se inventa un dibujo.
 */

export interface TvToolPoint {
  price?: number | string;
  time?: number;
}

export interface TvDrawingTool {
  id: string;
  name: string;
  points: TvToolPoint[];
  properties: Record<string, unknown>;
  minmov: number;
  pricescale: number;
  symbol: string;
}

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const pickNumber = (properties: Record<string, unknown>, keys: readonly string[]): number | null => {
  for (const key of keys) {
    const value = toNumber(properties[key]);
    if (value !== null) return value;
  }
  return null;
};

/** 'BTCUSDT@PRICETYPE=LAST' -> 'BTCUSDT'. */
export function symbolFromTv(symbol: string): string | null {
  if (typeof symbol !== 'string') return null;
  const base = (symbol.split('@')[0] ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{2,20}$/.test(base) ? base : null;
}

function sideFromName(name: string): DrawingSide | null {
  if (typeof name !== 'string') return null;
  const normalized = name.toLowerCase().replace(/[\s_-]/g, '');
  const isTool = normalized.includes('position') || normalized.includes('riskreward');
  const isLong = normalized.includes('long');
  const isShort = normalized.includes('short');
  if (!isTool || isLong === isShort) return null;
  return isLong ? 'long' : 'short';
}

export function drawingFromTvTool(tool: TvDrawingTool): PositionDrawing | null {
  try {
    if (!tool || typeof tool !== 'object') return null;
    const id = typeof tool.id === 'string' && tool.id ? tool.id : null;
    const side = sideFromName(tool.name);
    if (!id || !side) return null;

    const symbol = symbolFromTv(tool.symbol);
    if (!symbol) return null;

    const minmov = toNumber(tool.minmov);
    const pricescale = toNumber(tool.pricescale);
    if (minmov === null || pricescale === null || minmov <= 0 || pricescale <= 0) return null;
    const minTick = minmov / pricescale;
    if (!Number.isFinite(minTick) || minTick <= 0) return null;

    const points = Array.isArray(tool.points) ? tool.points : [];
    const entryRaw = toNumber(points[0]?.price);
    if (entryRaw === null || entryRaw <= 0) return null;

    const properties =
      tool.properties && typeof tool.properties === 'object' ? tool.properties : {};
    const stopLevel = pickNumber(properties, ['stopLevel', 'stop_level']);
    const profitLevel = pickNumber(properties, ['profitLevel', 'profit_level']);
    if (stopLevel === null || profitLevel === null) return null;

    const entry = roundToTick(entryRaw, minTick);
    const stop =
      side === 'long'
        ? roundToTick(entry - stopLevel * minTick, minTick)
        : roundToTick(entry + stopLevel * minTick, minTick);
    const target =
      side === 'long'
        ? roundToTick(entry + profitLevel * minTick, minTick)
        : roundToTick(entry - profitLevel * minTick, minTick);

    const drawing: PositionDrawing = { id, side, entry, stop, target, symbol };
    if (!validateDrawing(drawing).ok) return null;
    return drawing;
  } catch {
    return null;
  }
}
