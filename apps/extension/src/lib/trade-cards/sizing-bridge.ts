import type { SizingDirection } from '../sizing';
import { TAKER_FEE_RATE } from '../sizing';
import type { TradeTicket } from './types';

/**
 * Puente mínimo tarjeta -> dimensionador: la tarjeta publica, SizingCard
 * escucha. El payload lleva SIEMPRE el riesgo efectivo del ticket (pérdida
 * con comisiones como % del capital) y las tarifas usadas, para que el
 * dimensionador reproduzca el mismo tamaño en vez de recalcular con el
 * riesgo guardado (que daría otra cantidad).
 */
export interface SizingLoad {
  direction: SizingDirection;
  entry: number;
  stop: number;
  /** Pérdida en el stop, comisiones incluidas, como % del capital. */
  riskPct: number;
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
export const TRANCHES_NOTE = 'tramos: ver ticket';

/** Deriva el payload del puente desde un ticket ya calculado. */
export function sizingLoadFromTicket(ticket: TradeTicket): SizingLoad {
  const tranches = ticket.entries.length > 1 ? ticket.entries.map((e) => e.price) : undefined;
  const riskPct =
    ticket.lossAtStopPctOfCapital > 0
      ? ticket.lossAtStopPctOfCapital
      : ticket.capital > 0
        ? (ticket.lossAtStopUsd / ticket.capital) * 100
        : ticket.basis.pct;
  return {
    direction: ticket.side,
    entry: ticket.entries[0]?.price ?? ticket.avgEntry,
    stop: ticket.stop,
    riskPct,
    note: FROM_CARD_NOTE,
    entryFeeRate: Number.isFinite(ticket.fees.entryRate) ? ticket.fees.entryRate : TAKER_FEE_RATE,
    exitFeeRate: Number.isFinite(ticket.fees.exitRate) ? ticket.fees.exitRate : TAKER_FEE_RATE,
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
