import { nextMode } from './panel-mode';
import type { PanelState } from './panel-controller';
import type { AccountSnapshot, PositionSide, PositionView } from './types';

/** Posición escrita a mano (sin credenciales). Vive en `storage.session`. */
export interface ManualPosition {
  symbol: string;
  side: PositionSide;
  entry: number;
  size: number;
  stop: number | null;
  leverage: number;
  /** Marca de guardado: separa dos entradas manuales distintas. */
  savedMs: number;
}

export const manualStorageKey = (symbol: string): string => `manualPosition:${symbol}`;

export type ManualResult = { ok: true; value: ManualPosition } | { ok: false; error: string };

function parseNum(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(',', '.');
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Valida el formulario; los mensajes son una frase corta en español. */
export function validateManual(symbol: string, input: Record<string, unknown>, now: number): ManualResult {
  const side = input.side;
  if (side !== 'long' && side !== 'short') return { ok: false, error: 'Elige largo o corto.' };
  const entry = parseNum(input.entry);
  if (entry === null || entry <= 0) return { ok: false, error: 'La entrada debe ser un número mayor que 0.' };
  const size = parseNum(input.size);
  if (size === null || size <= 0) return { ok: false, error: 'El tamaño debe ser un número mayor que 0.' };
  const leverage = parseNum(input.leverage);
  if (leverage === null || !Number.isInteger(leverage) || leverage < 1 || leverage > 125) {
    return { ok: false, error: 'El apalancamiento debe ser un entero de 1 a 125.' };
  }
  let stop: number | null = null;
  const rawStop = input.stop;
  if (rawStop !== undefined && rawStop !== null && String(rawStop).trim() !== '') {
    stop = parseNum(rawStop);
    if (stop === null || stop <= 0) return { ok: false, error: 'El stop debe ser un número mayor que 0 o quedar vacío.' };
  }
  return { ok: true, value: { symbol, side, entry, size, stop, leverage, savedMs: now } };
}

/** Lee lo guardado en disco sin confiar en ello; null si no sirve o es de otro símbolo. */
export function parseStoredManual(raw: unknown, symbol: string): ManualPosition | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.symbol !== symbol) return null;
  const saved = typeof r.savedMs === 'number' && Number.isFinite(r.savedMs) ? r.savedMs : 0;
  const res = validateManual(symbol, r, saved);
  return res.ok ? res.value : null;
}

/** Convierte a PositionView con marca = último precio. null sin precio válido. */
export function manualToPositionView(m: ManualPosition, lastPrice: number | null): PositionView | null {
  if (lastPrice === null || !Number.isFinite(lastPrice) || lastPrice <= 0) return null;
  const s = m.side === 'long' ? 1 : -1;
  return {
    symbol: m.symbol,
    side: m.side,
    size: m.size,
    entry: m.entry,
    mark: lastPrice,
    liq: null,
    leverage: m.leverage,
    marginType: 'cross',
    uPnl: s * (lastPrice - m.entry) * m.size,
    breakEven: null,
    notional: m.size * lastPrice,
    stop: m.stop === null ? null : { price: m.stop, kind: 'order' },
    firstFillMs: null,
  };
}

/**
 * Si el panel no sabe si hay posición (`unknown`) y hay una manual, la trata como
 * una posición de snapshot con fuente `manual`. En cualquier otro modo manda la cuenta.
 */
export function withManualPosition(
  panel: PanelState,
  view: PositionView | null,
  symbol: string,
  now: number,
): PanelState {
  if (!view || panel.mode !== 'unknown') return panel;
  const snapshot: AccountSnapshot = {
    fetchedAt: now,
    equity: null,
    dailyPnl: null,
    positions: [view],
    fundingRate: null,
    nextFundingMs: null,
  };
  const result = nextMode({
    symbol,
    klinesOk: true,
    source: 'manual',
    snapshot,
    lastMode: panel.mode,
    now,
    sinceSymbolChangeMs: Number.MAX_SAFE_INTEGER,
  });
  return { mode: result.mode, stale: result.stale, snapshot, error: null };
}
