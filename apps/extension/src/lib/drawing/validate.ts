import type { PositionDrawing } from './types';

/**
 * Validación estructural de un dibujo Long/Short Position. Pura y sin lanzar:
 * devuelve {ok:false, reason} para cualquier entrada rota (NaN, orden mal,
 * stop absurdo) en lugar de propagar un error.
 */

export type DrawingValidation = { ok: true } | { ok: false; reason: string };

/** Stop más allá del 50 % del precio de entrada se considera absurdo y se rechaza. */
export const MAX_STOP_DISTANCE_PCT = 50;

const isPositiveNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export function validateDrawing(d: PositionDrawing): DrawingValidation {
  try {
    if (!d || typeof d !== 'object') return { ok: false, reason: 'invalid_input' };
    const { entry, stop, target, side } = d;
    if (![entry, stop, target].every(isPositiveNumber)) {
      return { ok: false, reason: 'non_positive_numbers' };
    }
    if (side !== 'long' && side !== 'short') {
      return { ok: false, reason: 'invalid_side' };
    }
    const stopDistancePct = (Math.abs(entry - stop) / entry) * 100;
    if (stopDistancePct > MAX_STOP_DISTANCE_PCT) {
      return { ok: false, reason: 'stop_too_far' };
    }
    if (side === 'long') {
      if (!(stop < entry && entry < target)) return { ok: false, reason: 'wrong_order' };
    } else {
      if (!(stop > entry && entry > target)) return { ok: false, reason: 'wrong_order' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'invalid_input' };
  }
}
