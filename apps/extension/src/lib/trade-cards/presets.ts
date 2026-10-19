import type { TradeCardPreset } from './types';

const base = {
  side: 'auto',
  stop: { kind: 'invalidation' },
  tp: { rMultiples: [1, 2], useNextLevel: true },
  leverage: 'min',
} as const;

const limitEntry = { kind: 'limit_level', pick: 'nearest_support' } as const;

function margin(pct: number): TradeCardPreset {
  return {
    ...base,
    tp: { ...base.tp, rMultiples: [...base.tp.rMultiples] },
    stop: { ...base.stop },
    id: `margen-${pct}`,
    name: `Límite · margen ${pct} %`,
    entry: { ...limitEntry },
    size: { basis: 'margin', pct },
  };
}

export function defaultPresets(): TradeCardPreset[] {
  return [
    {
      ...base,
      tp: { ...base.tp, rMultiples: [...base.tp.rMultiples] },
      stop: { ...base.stop },
      id: 'limite-riesgo-1',
      name: 'Límite en nivel · riesgo 1 %',
      entry: { ...limitEntry },
      size: { basis: 'risk', pct: 1 },
    },
    {
      ...base,
      tp: { ...base.tp, rMultiples: [...base.tp.rMultiples] },
      stop: { ...base.stop },
      id: 'promediar-3',
      name: 'Promediar en 3 tramos · riesgo 1 % total',
      entry: { ...limitEntry },
      size: { basis: 'risk', pct: 1 },
      scaleIn: { tranches: 3 },
    },
    margin(3),
    margin(5),
    margin(10),
    margin(15),
    {
      id: 'mercado-rapido',
      name: 'Mercado rápido · riesgo 0,5 %',
      side: 'auto',
      entry: { kind: 'market' },
      stop: { kind: 'atr', atrMult: 1.5 },
      tp: { rMultiples: [1, 2], useNextLevel: false },
      size: { basis: 'risk', pct: 0.5 },
      leverage: 'min',
    },
  ];
}

export const DEFAULT_PRESETS: readonly TradeCardPreset[] = Object.freeze(defaultPresets());
