// Posición abierta leída de la página, para el modo posición del panel.
//
// Regla de precedencia, en este orden: la cuenta por API manda siempre; si no
// hay instantánea de API, la posición de la página; y solo si tampoco hay, la
// posición escrita a mano.

import { nextMode } from '../account/panel-mode';
import type { PanelState } from '../account/panel-controller';
import type { AccountSnapshot, PositionView } from '../account/types';
import { toPositionView, type PagePosition } from './parse-positions';

/** Etiqueta visible de la fuente en la tarjeta de posición. */
export const PAGE_SOURCE_LABEL = 'página de Binance';

/** A partir de aquí el dato de la página se considera viejo. */
export const PAGE_STALE_MS = 60_000;

/** Posición de la página para ese símbolo, o null. */
export function pagePositionFor(
  positions: readonly PagePosition[] | null | undefined,
  symbol: string,
): PagePosition | null {
  for (const position of positions ?? []) {
    if (position && position.symbol === symbol) return position;
  }
  return null;
}

/** `PositionView` de la página; null si le faltan datos imprescindibles. */
export function pagePositionToView(position: PagePosition | null | undefined): PositionView | null {
  if (!position) return null;
  return toPositionView(position);
}

/**
 * Texto de caducidad del dato leído de la página: null mientras tenga menos de
 * `PAGE_STALE_MS`, y si no `datos de la página de hace X s`.
 */
export function pageStaleLabel(
  capturedAtMs: number | null | undefined,
  nowMs: number,
  staleMs = PAGE_STALE_MS,
): string | null {
  if (typeof capturedAtMs !== 'number' || !Number.isFinite(capturedAtMs)) return null;
  if (!Number.isFinite(nowMs)) return null;
  const age = nowMs - capturedAtMs;
  if (!(age > staleMs)) return null;
  const seconds = Math.max(0, Math.floor(age / 1000));
  return `datos de la página de hace ${seconds} s`;
}

/**
 * Si el panel no sabe si hay posición (`unknown`) y la página mostraba una, se
 * usa como una instantánea con fuente `dom`. Con instantánea de API delante no
 * se toca nada: la cuenta manda.
 */
export function withPagePosition(
  panel: PanelState,
  view: PositionView | null,
  symbol: string,
  capturedAtMs: number | null | undefined,
  now: number,
): PanelState {
  if (!view) return panel;
  if (panel.snapshot !== null || panel.mode !== 'unknown') return panel;
  const captured =
    typeof capturedAtMs === 'number' && Number.isFinite(capturedAtMs) && capturedAtMs > 0
      ? capturedAtMs
      : now;
  const snapshot: AccountSnapshot = {
    fetchedAt: captured,
    equity: null,
    dailyPnl: null,
    positions: [view],
    fundingRate: null,
    nextFundingMs: null,
  };
  const result = nextMode({
    symbol,
    klinesOk: true,
    source: 'dom',
    snapshot,
    lastMode: panel.mode,
    now,
    sinceSymbolChangeMs: Number.MAX_SAFE_INTEGER,
  });
  return { mode: result.mode, stale: result.stale, snapshot, error: null };
}
