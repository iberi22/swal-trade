import type { SizingDirection } from '../sizing';
import { TAKER_FEE_RATE } from '../sizing';
import type { TradeTicket } from './types';

/**
 * Puente mínimo tarjeta -> dimensionador: la tarjeta publica, SizingCard
 * escucha. El payload lleva el riesgo EXACTO del ticket (pérdida con
 * comisiones, en USD y sin redondear), su capital y su cantidad exacta, para
 * que el dimensionador enseñe el mismo tamaño en vez de recomputarlo desde un
 * porcentaje redondeado (que daba otra cantidad: 3 -> 3,0014).
 */
export interface SizingLoad {
  direction: SizingDirection;
  entry: number;
  stop: number;
  /** Pérdida en el stop, comisiones incluidas, como % del capital SIN redondear. */
  riskPct: number;
  /** Pérdida en el stop, comisiones incluidas, en USD exactos (sin redondear). */
  riskUsd: number;
  /** Cantidad exacta del ticket, en unidades base. El panel la enseña tal cual. */
  quantity: number;
  /** Capital con el que se calculó el ticket. */
  capital: number;
  /** Nota de procedencia que muestra el dimensionador. */
  note: string;
  /** Tarifa de entrada usada por el ticket (maker si reposa, taker si no). */
  entryFeeRate: number;
  /** Tarifa de salida usada por el ticket (taker). */
  exitFeeRate: number;
  /** Precios de los tramos cuando la tarjeta promedia; ausente si hay una sola entrada. */
  tranches?: number[];
}

export const FROM_CARD_NOTE = 'desde tarjeta: pérdida con comisiones incluidas';
export const FROM_DRAWING_NOTE = 'desde tu dibujo: pérdida con comisiones incluidas';
export const TRANCHES_NOTE = 'tramos: ver ticket';

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Valida lo que publica un productor (tarjeta o dibujo) ANTES de tocar el
 * dimensionador. Es la misma puerta que usa `SizingCard`: si una tarjeta emite
 * un payload sin tarifas o sin riesgo, el panel no muestra «La comisión no es
 * válida», simplemente lo ignora.
 */
export function parseSizingLoad(raw: unknown): SizingLoad | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const direction = record.direction;
  if (direction !== 'long' && direction !== 'short') return null;
  const entry = record.entry;
  const stop = record.stop;
  const riskPct = record.riskPct;
  const riskUsd = record.riskUsd;
  const quantity = record.quantity;
  const capital = record.capital;
  if (![entry, stop, capital].every((value) => isFiniteNumber(value) && value > 0)) return null;
  if (![riskPct, riskUsd, quantity].every((value) => isFiniteNumber(value) && value >= 0)) return null;
  const entryFeeRate = record.entryFeeRate;
  const exitFeeRate = record.exitFeeRate;
  if (!isFiniteNumber(entryFeeRate) || entryFeeRate < 0) return null;
  if (!isFiniteNumber(exitFeeRate) || exitFeeRate < 0) return null;
  // El stop tiene que estar del lado correcto: un payload incoherente no se pinta.
  if (direction === 'long' ? (stop as number) >= (entry as number) : (stop as number) <= (entry as number)) return null;
  const note = typeof record.note === 'string' && record.note.trim() !== '' ? record.note : '';
  if (!note) return null;
  const out: SizingLoad = {
    direction,
    entry: entry as number,
    stop: stop as number,
    riskPct: riskPct as number,
    riskUsd: riskUsd as number,
    quantity: quantity as number,
    capital: capital as number,
    note,
    entryFeeRate,
    exitFeeRate,
  };
  const tranches = record.tranches;
  if (Array.isArray(tranches) && tranches.length > 0) {
    if (tranches.length > 4 || !tranches.every((price) => isFiniteNumber(price) && price > 0)) return null;
    out.tranches = [...(tranches as number[])];
  }
  return out;
}

export interface SizingDisplayState {
  entryStr: string;
  stopStr: string;
  direction: SizingDirection;
  capital: number;
}

/**
 * Cifras exactas que el dimensionador debe ENSEÑAR cuando sus campos siguen
 * siendo los del payload. Devuelve null en cuanto el usuario cambia entrada,
 * stop, dirección o capital: entonces manda el cálculo con las tarifas del
 * payload (a toda precisión), no una cifra vieja.
 */
export function exactSizingFromLoad(
  load: SizingLoad,
  current: SizingDisplayState,
): { quantity: number; lossUsd: number } | null {
  if (!load) return null;
  if (current.direction !== load.direction) return null;
  if (current.entryStr !== String(load.entry) || current.stopStr !== String(load.stop)) return null;
  if (current.capital !== load.capital) return null;
  return { quantity: load.quantity, lossUsd: load.riskUsd };
}

/** Deriva el payload del puente desde un ticket ya calculado. */
export function sizingLoadFromTicket(ticket: TradeTicket): SizingLoad {
  const tranches = ticket.entries.length > 1 ? ticket.entries.map((e) => e.price) : undefined;
  const entryFeeRate = Number.isFinite(ticket.fees.entryRate) ? ticket.fees.entryRate : TAKER_FEE_RATE;
  const exitFeeRate = Number.isFinite(ticket.fees.exitRate) ? ticket.fees.exitRate : TAKER_FEE_RATE;
  // Riesgo EXACTO: se recalcula desde las entradas sin redondear, porque el
  // ticket guarda `lossAtStopUsd`/`lossAtStopPctOfCapital` ya redondeados.
  const quantity = ticket.entries.reduce((sum, e) => sum + e.qty, 0);
  const riskUsd = ticket.entries.reduce(
    (sum, e) => sum + e.qty * Math.abs(e.price - ticket.stop) + e.qty * e.price * entryFeeRate + e.qty * ticket.stop * exitFeeRate,
    0,
  );
  const riskPct = ticket.capital > 0 ? (riskUsd / ticket.capital) * 100 : 0;
  return {
    direction: ticket.side,
    entry: ticket.entries[0]?.price ?? ticket.avgEntry,
    stop: ticket.stop,
    riskPct,
    riskUsd,
    quantity,
    capital: ticket.capital,
    note: FROM_CARD_NOTE,
    entryFeeRate,
    exitFeeRate,
    ...(tranches ? { tranches } : {}),
  };
}

type Listener = (load: SizingLoad) => void;
const listeners = new Set<Listener>();

export function publishSizingLoad(load: SizingLoad): void {
  for (const fn of [...listeners]) fn(load);
}

export function subscribeSizingLoad(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Riesgo con comisiones de un tamaño y unos precios dados (sin redondear). */
export function feeInclusiveRiskUsd(input: {
  quantity: number;
  entry: number;
  stop: number;
  entryFeeRate: number;
  exitFeeRate: number;
}): number {
  const { quantity, entry, stop, entryFeeRate, exitFeeRate } = input;
  return quantity * Math.abs(entry - stop) + quantity * entry * entryFeeRate + quantity * stop * exitFeeRate;
}
