import type { Finding } from './types';

export type SizingDirection = 'long' | 'short';

export interface SizingInput {
  capital: number;
  riskPct: number;
  direction: SizingDirection;
  entry: number;
  stop: number;
}

export interface SizingSuccess {
  valid: true;
  distancePct: number;
  lossUsd: number;
  quantity: number;
  notionalUsd: number;
  minLeverage: number;
  feeUsd: number;
  summary: string;
}

export interface SizingError {
  valid: false;
  error: string;
  reason: 'wrong_side' | 'invalid_input';
}

export type SizingResult = SizingSuccess | SizingError;

export interface SizingPreferences {
  capital: number;
  riskPct: number;
  direction: SizingDirection;
}

export const SIZING_STORAGE_KEY = 'sizing_prefs';

export const DEFAULT_SIZING_PREFERENCES: SizingPreferences = {
  capital: 1000,
  riskPct: 1,
  direction: 'long',
};

/** Tasa estimada taker ida y vuelta (0.05% de nocional). */
export const TAKER_ROUND_TRIP_FEE_RATE = 0.0005;

/** Redondeo numérico seguro a N decimales sin errores de coma flotante. */
export function roundToDecimals(value: number, decimals = 4): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Calcula el tamaño de la posición dimensionando desde el riesgo y el stop loss
 * en lugar de usar apalancamiento a ciegas.
 */
export function calculatePositionSize(input: SizingInput): SizingResult {
  const { capital, riskPct, direction, entry, stop } = input;

  if (
    !Number.isFinite(capital) ||
    !Number.isFinite(riskPct) ||
    !Number.isFinite(entry) ||
    !Number.isFinite(stop) ||
    capital <= 0 ||
    riskPct <= 0 ||
    entry <= 0 ||
    stop <= 0
  ) {
    return {
      valid: false,
      error: 'Introduce valores numéricos positivos mayores que cero.',
      reason: 'invalid_input',
    };
  }

  if (direction === 'long' && stop >= entry) {
    return {
      valid: false,
      error: 'En posiciones largas el stop loss debe ser menor que el precio de entrada (por debajo).',
      reason: 'wrong_side',
    };
  }

  if (direction === 'short' && stop <= entry) {
    return {
      valid: false,
      error: 'En posiciones cortas el stop loss debe ser mayor que el precio de entrada (por encima).',
      reason: 'wrong_side',
    };
  }

  const priceDiff = Math.abs(entry - stop);
  const distancePct = roundToDecimals((priceDiff / entry) * 100, 4);
  const lossUsd = roundToDecimals(capital * (riskPct / 100), 2);
  const rawQuantity = lossUsd / priceDiff;
  const quantity = roundToDecimals(rawQuantity, 4);
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

/** Extrae el nivel de invalidación de un hallazgo si lo tiene definido. */
export function invalidationPriceFromFinding(
  finding: Finding | null | undefined,
): number | null {
  if (!finding || !Array.isArray(finding.levels)) return null;
  for (const entry of finding.levels) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof entry.invalidate === 'number' &&
      Number.isFinite(entry.invalidate)
    ) {
      return entry.invalidate;
    }
  }
  return null;
}

/** Normaliza las preferencias guardadas en storage.local. */
export function normalizeSizingPreferences(raw: unknown): SizingPreferences {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_SIZING_PREFERENCES };
  }
  const record = raw as Record<string, unknown>;

  const rawCapital = Number(record.capital);
  const capital =
    Number.isFinite(rawCapital) && rawCapital > 0
      ? rawCapital
      : DEFAULT_SIZING_PREFERENCES.capital;

  const rawRisk = Number(record.riskPct);
  let riskPct =
    Number.isFinite(rawRisk) && rawRisk > 0 ? rawRisk : DEFAULT_SIZING_PREFERENCES.riskPct;
  // Limita riesgo entre 0.1 y 5
  if (riskPct < 0.1) riskPct = 0.1;
  if (riskPct > 5) riskPct = 5;

  const direction: SizingDirection =
    record.direction === 'short' ? 'short' : 'long';

  return {
    capital,
    riskPct,
    direction,
  };
}
