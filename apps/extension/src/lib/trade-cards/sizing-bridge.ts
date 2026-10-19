import type { SizingDirection } from '../sizing';

/** Puente mínimo tarjeta -> dimensionador: la tarjeta publica, SizingCard escucha. */
export interface SizingLoad {
  direction: SizingDirection;
  entry: number;
  stop: number;
  /** Solo si la tarjeta dimensiona por riesgo. */
  riskPct?: number;
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
