import type { PositionView } from './types';

export type Mode = 'loading' | 'position' | 'flat' | 'unknown' | 'no-data';
export type DataSource = 'api' | 'dom' | 'manual' | 'none';

export const LOADING_MAX_MS = 2000;
export const SNAPSHOT_FRESH_MS = 60_000;

export interface ModeInput {
  symbol: string;
  klinesOk: boolean;
  source: DataSource;
  snapshot?: { fetchedAt: number; positions: readonly Pick<PositionView, 'symbol' | 'size'>[] };
  lastMode: Mode;
  error?: string;
  now: number;
  sinceSymbolChangeMs: number;
}

export interface ModeResult {
  mode: Mode;
  stale: boolean;
}

export function nextMode(input: ModeInput): ModeResult {
  const { snapshot, error } = input;
  if (input.source === 'api' && !snapshot && input.sinceSymbolChangeMs < LOADING_MAX_MS) {
    return { mode: 'loading', stale: false };
  }

  const age = snapshot ? input.now - snapshot.fetchedAt : Infinity;
  const fresh = !!snapshot && age <= SNAPSHOT_FRESH_MS && !error;

  const hasPosition =
    !!snapshot && snapshot.positions.some((p) => p.symbol === input.symbol && Number.isFinite(p.size) && p.size !== 0);
  if (hasPosition) return { mode: 'position', stale: !fresh };

  if (fresh) return { mode: 'flat', stale: false };

  if (input.lastMode === 'position') return { mode: 'position', stale: true };

  if (input.source === 'none') return { mode: 'unknown', stale: false };
  if (!input.klinesOk) return { mode: 'no-data', stale: false };
  return { mode: 'unknown', stale: !!snapshot };
}
