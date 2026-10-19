import type { LevelKind } from '../context/levels';

/**
 * Tarjetas de operación: plantillas que calculan un TICKET (nunca una orden).
 * La extensión no tiene permiso para operar y no toca el formulario de Binance.
 * (Un futuro "rellenar el formulario" sería opt-in y queda fuera de esta pieza.)
 */

export type TradeSide = 'long' | 'short';

/** Todos los tipos de nivel (lista canónica en context/levels.ts), para validar storage. */
export { LEVEL_KINDS } from '../context/levels';

export type TradeCardEntry =
  /**
   * Límite en un nivel de la escalera, del lado donde reposa la orden: un largo busca el
   * nivel más cercano por debajo del precio y un corto el más cercano por encima.
   * `nearest_support` y `nearest_resistance` eligen ese mismo nivel (el nombre es solo la
   * etiqueta que ve el usuario); `level_kind` exige un tipo concreto de nivel.
   */
  | { kind: 'limit_level'; pick: 'nearest_support' | 'nearest_resistance' | 'level_kind'; levelKind?: LevelKind; offsetAtr?: number }
  | { kind: 'market' };

export interface TradeCardStop {
  /** invalidation = nivel/patrón que invalida si existe; si no, 1,5 ATR(1h). */
  kind: 'invalidation' | 'atr' | 'pct';
  atrMult?: number;
  pct?: number;
}

export interface TradeCardPreset {
  id: string;
  name: string;
  side: 'auto' | 'long' | 'short';
  entry: TradeCardEntry;
  stop: TradeCardStop;
  tp: { rMultiples: number[]; useNextLevel: boolean };
  /** risk: % de la cuenta que se pierde en el stop. margin: % de la cuenta como margen. */
  size: { basis: 'risk' | 'margin'; pct: number };
  /** 'min' = el valor que mejor encaja con tu regla de riesgo (ver ticket.ts). */
  leverage: 'min' | number;
  scaleIn?: { tranches: 2 | 3 | 4 };
}

export interface TicketEntry {
  price: number;
  qty: number;
  weightPct: number;
}

export interface TicketTp {
  price: number;
  rMultiple: number;
  source: 'r' | 'level';
  label?: string;
}

export interface TicketWarning {
  code: string;
  text: string;
}

export interface TradeTicket {
  presetName: string;
  symbol: string;
  side: TradeSide;
  orderType: 'LIMIT' | 'MARKET';
  entries: TicketEntry[];
  entryLabel: string;
  avgEntry: number;
  stop: number;
  stopSource: 'invalidation' | 'atr' | 'pct';
  tps: TicketTp[];
  leverage: number;
  marginUsd: number;
  notionalUsd: number;
  /** Pérdida si salta el stop, SIEMPRE con comisiones incluidas. */
  lossAtStopUsd: number;
  lossIncludesFees: boolean;
  lossAtStopPctOfCapital: number;
  /** Más del 2 % de la cuenta: la tarjeta lo muestra en estilo invertido. */
  highRisk: boolean;
  feeUsd: number;
  /** Tarifas usadas en este ticket: entrada real (maker o taker) y salida taker. */
  fees: { makerRate: number; takerRate: number; entryRate: number; exitRate: number; note: string };
  rrToFirstTp: number | null;
  warnings: TicketWarning[];
  basis: { basis: 'risk' | 'margin'; pct: number };
  capital: number;
  scaleInNote?: string;
}

export type TicketResult = { ok: true; ticket: TradeTicket } | { ok: false; reason: string };
