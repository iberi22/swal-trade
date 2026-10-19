import type { Finding } from './types';

export type SizingDirection = 'long' | 'short';

export interface SizingInput {
  capital: number;
  riskPct: number;
  direction: SizingDirection;
  entry: number;
  stop: number;
}

export type SizingResult =
  | {
      valid: true;
      distancePct: number;
      lossUsd: number;
      quantity: number;
      notionalUsd: number;
      minLeverage: number;
      feeUsd: number;
      summary: string;
    }
  | { valid: false; error: string; reason: 'wrong_side' | 'invalid_input' };

export interface SizingPreferences {
  capital: number;
  riskPct: number;
  direction: SizingDirection;
}

export const SIZING_STORAGE_KEY = 'sizing_prefs';
export const DEFAULT_SIZING_PREFERENCES: SizingPreferences = { capital: 1000, riskPct: 1, direction: 'long' };
/** Taker 0,05 % al entrar y otro 0,05 % al salir (USDT; en USDC es 0,04 %): estimación prudente. */
export const TAKER_ROUND_TRIP_FEE_RATE = 0.001;
/** Comisión taker de una sola pata (0,05 %). */
export const TAKER_FEE_RATE = TAKER_ROUND_TRIP_FEE_RATE / 2;

export function roundToDecimals(value: number, decimals = 4): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function calculatePositionSize(input: SizingInput): SizingResult {
  const { capital, riskPct, direction, entry, stop } = input;
  if (![capital, riskPct, entry, stop].every((n) => Number.isFinite(n) && n > 0)) {
    return { valid: false, error: 'Introduce valores numéricos positivos mayores que cero.', reason: 'invalid_input' };
  }
  if (direction === 'long' && stop >= entry) {
    return { valid: false, error: 'En posiciones largas el stop loss debe ser menor que el precio de entrada (por debajo).', reason: 'wrong_side' };
  }
  if (direction === 'short' && stop <= entry) {
    return { valid: false, error: 'En posiciones cortas el stop loss debe ser mayor que el precio de entrada (por encima).', reason: 'wrong_side' };
  }
  const priceDiff = Math.abs(entry - stop);
  const distancePct = roundToDecimals((priceDiff / entry) * 100, 4);
  const lossUsd = roundToDecimals(capital * (riskPct / 100), 2);
  const quantity = roundToDecimals(lossUsd / priceDiff, 4);
  const notionalUsd = roundToDecimals(quantity * entry, 2);
  const minLeverage = Math.max(1, Math.ceil(notionalUsd / capital));
  const feeUsd = roundToDecimals(notionalUsd * TAKER_ROUND_TRIP_FEE_RATE, 2);
  return {
    valid: true,
    distancePct,
    lossUsd,
    quantity,
    notionalUsd,
    minLeverage,
    feeUsd,
    summary: `Si el stop salta pierdes ${lossUsd} USD (${riskPct} % de tu cuenta)`,
  };
}

export interface FeeAwareSizingInput extends SizingInput {
  /** Comisión de entrada como tasa (0,0005 = 0,05 %). */
  entryFeeRate: number;
  /** Comisión de salida como tasa, aplicada al precio del stop. */
  exitFeeRate: number;
  /** Paso de cantidad del par (stepSize). Sin paso, la cantidad va con toda la precisión. */
  stepSize?: number;
  /**
   * Presupuesto de riesgo exacto en USD (capital × riesgo, sin redondear). Si no
   * llega, se calcula con `capital` y `riskPct`. Lo usa quien ya tiene el riesgo
   * exacto de un ticket y no quiere arrastrar un porcentaje redondeado.
   */
  lossBudgetUsd?: number;
}

export type FeeAwareSizingResult =
  | {
      valid: true;
      distancePct: number;
      /** Presupuesto de riesgo: capital × riskPct (sin comisiones). */
      lossBudgetUsd: number;
      /** Pérdida real si salta el stop, comisiones incluidas (≤ presupuesto tras redondear). */
      lossUsd: number;
      quantity: number;
      notionalUsd: number;
      minLeverage: number;
      feeUsd: number;
      summary: string;
    }
  | { valid: false; error: string; reason: 'wrong_side' | 'invalid_input' };

/**
 * Tamaño al riesgo contando las comisiones de ida y vuelta. La cantidad se
 * calcula para que la pérdida EN EL STOP (precio + comisiones) no supere el
 * presupuesto: qty = riesgo / (|entrada - stop| + entrada·feeEntrada +
 * stop·feeSalida). Es un helper aparte: `calculatePositionSize` conserva su
 * contrato (tamaño por distancia de precio) para quien muestra las comisiones
 * por separado.
 *
 * La cantidad NUNCA se redondea hacia arriba: un redondeo hacia arriba gasta más
 * que el presupuesto (0,0091 unidades con un stop de 1.000 USD perdían 10,00545
 * con un presupuesto de 10). Sin `stepSize` se devuelve la cantidad con toda la
 * precisión; con `stepSize` se redondea HACIA ABAJO al paso del contrato. Así la
 * pérdida con comisiones no supera el presupuesto.
 */
export function calculatePositionSizeWithFees(input: FeeAwareSizingInput): FeeAwareSizingResult {
  const { entryFeeRate, exitFeeRate } = input;
  if (!Number.isFinite(entryFeeRate) || entryFeeRate < 0 || !Number.isFinite(exitFeeRate) || exitFeeRate < 0) {
    return { valid: false, error: 'La comisión no es válida.', reason: 'invalid_input' };
  }
  const base = calculatePositionSize(input);
  if (!base.valid) return base;
  const { capital, riskPct, entry, stop } = input;
  const priceDiff = Math.abs(entry - stop);
  const exactBudgetUsd =
    Number.isFinite(input.lossBudgetUsd) && (input.lossBudgetUsd as number) > 0
      ? (input.lossBudgetUsd as number)
      : capital * (riskPct / 100);
  const lossBudgetUsd = roundToDecimals(exactBudgetUsd, 2);
  const lossPerUnit = priceDiff + entry * entryFeeRate + stop * exitFeeRate;
  const rawQuantity = lossBudgetUsd / lossPerUnit;
  const step = input.stepSize;
  const quantity = step && Number.isFinite(step) && step > 0 ? floorToStep(rawQuantity, step) : rawQuantity;
  const notionalUsd = roundToDecimals(quantity * entry, 2);
  const minLeverage = Math.max(1, Math.ceil(notionalUsd / capital));
  const feeUsd = roundToDecimals(quantity * entry * entryFeeRate + quantity * stop * exitFeeRate, 2);
  const lossUsd = roundToDecimals(quantity * lossPerUnit, 2);
  return {
    valid: true,
    distancePct: base.distancePct,
    lossBudgetUsd,
    lossUsd,
    quantity,
    notionalUsd,
    minLeverage,
    feeUsd,
    summary: `Si el stop salta pierdes ${lossUsd} USD con comisiones (${riskPct} % de tu cuenta)`,
  };
}

export function invalidationPriceFromFinding(finding: Finding | null | undefined): number | null {
  if (!finding || !Array.isArray(finding.levels)) return null;
  for (const entry of finding.levels) {
    if (typeof entry === 'object' && entry !== null && typeof entry.invalidate === 'number' && Number.isFinite(entry.invalidate)) {
      return entry.invalidate;
    }
  }
  return null;
}

export function normalizeSizingPreferences(raw: unknown): SizingPreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SIZING_PREFERENCES };
  const r = raw as Record<string, unknown>;
  const cap = Number(r.capital);
  const capital = Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_SIZING_PREFERENCES.capital;
  const rawRisk = Number(r.riskPct);
  const risk = Number.isFinite(rawRisk) && rawRisk > 0 ? rawRisk : DEFAULT_SIZING_PREFERENCES.riskPct;
  const riskPct = Math.min(5, Math.max(0.1, risk));
  const direction: SizingDirection = r.direction === 'short' ? 'short' : 'long';
  return { capital, riskPct, direction };
}

/* ---------- Escalonar en 3 tramos ---------- */

export const SCALE_IN_WEIGHTS: readonly [number, number, number] = [0.25, 0.35, 0.4];
export const SCALE_IN_DEGRADED_WEIGHTS: readonly [number, number] = [0.35, 0.65];
export const SCALE_IN_HONEST_NOTE =
  'Escalonar sube la probabilidad de acertar pero no mejora la esperanza: es una forma de acotar el riesgo, no una ventaja. Si se llenan los tres tramos y salta el stop pierdes el riesgo máximo.';

export interface ScaleInInput {
  capital: number;
  riskPct: number;
  direction: SizingDirection;
  entry1: number;
  entry2: number;
  entry3: number;
  stop: number;
  weights?: readonly [number, number, number];
  tickSize?: number;
  stepSize?: number;
  minQty?: number;
  minNotional?: number;
  feeRate?: number;
}

export interface ScaleInTranche {
  price: number;
  qty: number;
  notional: number;
}

export type ScaleInResult =
  | {
      valid: true;
      tranches: ScaleInTranche[];
      weights: number[];
      degraded: boolean;
      /** Precio medio si solo se llena el primer tramo, los dos primeros, etc. */
      avgByFill: number[];
      /** Precio medio más la comisión de ida y vuelta, para cada caso de llenado. */
      breakEvenByFill: number[];
      riskMaxUsd: number;
      lossIfAllFillAndStop: number;
      lossIfOnlyFirstFillsAndStop: number;
      totalQty: number;
      totalNotionalUsd: number;
      minLeverage: number;
      notes: string[];
      honestNote: string;
    }
  | { valid: false; error: string; reason: 'invalid_input' | 'wrong_order' | 'too_small' };

/** Redondea hacia abajo a un múltiplo de `step` (tolerante al error de coma flotante). */
export function floorToStep(value: number, step?: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!step || !Number.isFinite(step) || step <= 0) return Math.floor(value * 1e6 + 1e-9) / 1e6;
  const n = Math.floor(value / step + 1e-9);
  const decimals = Math.min(12, Math.max(0, Math.ceil(-Math.log10(step)) + 2));
  return roundToDecimals(n * step, decimals);
}

export function roundToTick(price: number, tick?: number): number {
  if (!tick || !Number.isFinite(tick) || tick <= 0) return price;
  const decimals = Math.min(12, Math.max(0, Math.ceil(-Math.log10(tick)) + 2));
  return roundToDecimals(Math.round(price / tick) * tick, decimals);
}

function significant(value: number, digits = 6): number {
  return Number(value.toPrecision(digits));
}

/** Propone entrada 2 al 40 % y entrada 3 al 80 % de la distancia entrada-stop (profundidades medidas). */
export function defaultScaleEntries(input: {
  direction: SizingDirection;
  entry: number;
  stop: number;
  tickSize?: number;
}): { entry2: number; entry3: number } | null {
  const { direction, entry, stop, tickSize } = input;
  if (![entry, stop].every((n) => Number.isFinite(n) && n > 0)) return null;
  if (direction === 'long' ? stop >= entry : stop <= entry) return null;
  const at = (f: number) => {
    const raw = entry + f * (stop - entry);
    return tickSize ? roundToTick(raw, tickSize) : significant(raw);
  };
  return { entry2: at(0.4), entry3: at(0.8) };
}

function scaleInOrderOk(direction: SizingDirection, e1: number, e2: number, e3: number, stop: number): boolean {
  return direction === 'long' ? stop < e3 && e3 < e2 && e2 < e1 : stop > e3 && e3 > e2 && e2 > e1;
}

export function planScaleIn(input: ScaleInInput): ScaleInResult {
  const { capital, riskPct, direction, stop } = input;
  const tick = input.tickSize;
  const feeRate = input.feeRate ?? TAKER_ROUND_TRIP_FEE_RATE;
  const weights = input.weights ?? SCALE_IN_WEIGHTS;
  const bad = (error: string, reason: 'invalid_input' | 'wrong_order' | 'too_small') => ({ valid: false as const, error, reason });

  if (![capital, riskPct, input.entry1, input.entry2, input.entry3, stop].every((n) => Number.isFinite(n) && n > 0)) {
    return bad('Introduce valores numéricos positivos mayores que cero.', 'invalid_input');
  }
  if (!Number.isFinite(feeRate) || feeRate < 0) return bad('La comisión no es válida.', 'invalid_input');
  if (weights.length !== 3 || !weights.every((w) => Number.isFinite(w) && w > 0) || Math.abs(weights[0] + weights[1] + weights[2] - 1) > 1e-9) {
    return bad('Los pesos de los tramos deben ser positivos y sumar 1.', 'invalid_input');
  }
  const e1 = roundToTick(input.entry1, tick);
  const e2 = roundToTick(input.entry2, tick);
  const e3 = roundToTick(input.entry3, tick);
  if (!scaleInOrderOk(direction, e1, e2, e3, stop)) {
    return bad(
      direction === 'long'
        ? 'En largos el orden debe ser: entrada 1 > entrada 2 > entrada 3 > stop (cada tramo más abajo).'
        : 'En cortos el orden debe ser: entrada 1 < entrada 2 < entrada 3 < stop (cada tramo más arriba).',
      'wrong_order',
    );
  }

  const riskMax = capital * (riskPct / 100);
  const minQty = input.minQty ?? 0;
  const minNotional = input.minNotional ?? 0;

  const build = (prices: number[], ws: number[]): ScaleInTranche[] | null => {
    const avg = prices.reduce((s, p, i) => s + ws[i] * p, 0);
    const qTotal = riskMax / (Math.abs(stop - avg) + feeRate * avg);
    const tranches = prices.map((price, i) => {
      const qty = floorToStep(ws[i] * qTotal, input.stepSize);
      return { price, qty, notional: qty * price };
    });
    const ok = tranches.every((t) => t.qty > 0 && t.qty >= minQty && t.notional >= minNotional);
    return ok ? tranches : null;
  };

  const notes: string[] = [];
  let ws: number[] = [...weights];
  let tranches = build([e1, e2, e3], ws);
  let degraded = false;
  if (!tranches) {
    ws = [...SCALE_IN_DEGRADED_WEIGHTS];
    tranches = build([e1, e3], ws);
    if (!tranches) {
      return bad('El riesgo es demasiado pequeño para repartirlo en tramos con el mínimo del contrato.', 'too_small');
    }
    degraded = true;
    notes.push('Algún tramo quedaba por debajo del mínimo del contrato: se usan dos tramos (35 % y 65 %) en la entrada 1 y la 3.');
  }

  const unitLoss = (p: number) => Math.abs(p - stop) + feeRate * p;
  const avgByFill: number[] = [];
  const breakEvenByFill: number[] = [];
  let cumQty = 0;
  let cumCost = 0;
  for (const t of tranches) {
    cumQty += t.qty;
    cumCost += t.qty * t.price;
    const avg = cumCost / cumQty;
    avgByFill.push(avg);
    breakEvenByFill.push(direction === 'long' ? avg * (1 + feeRate) : avg * (1 - feeRate));
  }
  const lossAll = tranches.reduce((s, t) => s + t.qty * unitLoss(t.price), 0);
  const lossFirst = tranches[0].qty * unitLoss(tranches[0].price);
  const totalNotional = cumCost;
  return {
    valid: true,
    tranches,
    weights: ws,
    degraded,
    avgByFill,
    breakEvenByFill,
    riskMaxUsd: riskMax,
    lossIfAllFillAndStop: lossAll,
    lossIfOnlyFirstFillsAndStop: lossFirst,
    totalQty: cumQty,
    totalNotionalUsd: totalNotional,
    minLeverage: Math.max(1, Math.ceil(totalNotional / capital)),
    notes,
    honestNote: SCALE_IN_HONEST_NOTE,
  };
}
