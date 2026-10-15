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
