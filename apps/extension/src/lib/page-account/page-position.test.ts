import { describe, expect, it } from 'vitest';
import {
  PAGE_SOURCE_LABEL,
  PAGE_STALE_MS,
  pagePositionFor,
  pagePositionToView,
  pageStaleLabel,
  withPagePosition,
} from './page-position';
import type { PagePosition } from './parse-positions';
import type { PanelState } from '../account/panel-controller';
import type { AccountSnapshot, PositionView } from '../account/types';

const pagePosition = (over: Partial<PagePosition> = {}): PagePosition => ({
  symbol: 'BTCUSDC',
  contract: 'perp',
  leverage: 30,
  marginMode: 'cross',
  side: 'long',
  sizeQuote: null,
  sizeBase: 0.004,
  uPnl: 2.1,
  roiPct: 19,
  entry: 82644.1,
  breakEven: 82300,
  mark: 82500,
  liq: 70000,
  ...over,
});

const apiView: PositionView = {
  symbol: 'BTCUSDC',
  side: 'short',
  size: 1,
  entry: 100,
  mark: 101,
  liq: 120,
  leverage: 5,
  marginType: 'cross',
  uPnl: -1,
  breakEven: null,
  notional: 101,
  stop: null,
  firstFillMs: null,
};

const apiSnapshot: AccountSnapshot = {
  fetchedAt: 1_000,
  equity: 500,
  dailyPnl: null,
  positions: [apiView],
  fundingRate: null,
  nextFundingMs: null,
};

const unknownPanel: PanelState = { mode: 'unknown', stale: false, snapshot: null, error: null };

describe('pagePositionFor', () => {
  it('busca por símbolo exacto', () => {
    expect(pagePositionFor([pagePosition()], 'BTCUSDC')?.symbol).toBe('BTCUSDC');
    expect(pagePositionFor([pagePosition()], 'ETHUSDC')).toBeNull();
    expect(pagePositionFor(null, 'BTCUSDC')).toBeNull();
  });
});

describe('pagePositionToView', () => {
  it('convierte la fila de la página al tipo del panel', () => {
    const view = pagePositionToView(pagePosition());
    expect(view?.symbol).toBe('BTCUSDC');
    expect(view?.side).toBe('long');
    expect(view?.size).toBeCloseTo(0.004);
    expect(view?.leverage).toBe(30);
  });

  it('sin marca o sin lado no inventa una posición', () => {
    expect(pagePositionToView(pagePosition({ mark: null }))).toBeNull();
    expect(pagePositionToView(pagePosition({ side: null }))).toBeNull();
    expect(pagePositionToView(pagePosition({ leverage: null }))).toBeNull();
    expect(pagePositionToView(null)).toBeNull();
  });
});

describe('pageStaleLabel', () => {
  it('mientras el dato es reciente no dice nada', () => {
    expect(pageStaleLabel(1_000_000, 1_000_000 + 5_000)).toBeNull();
    expect(pageStaleLabel(1_000_000, 1_000_000 + PAGE_STALE_MS)).toBeNull();
  });

  it('a partir de 60 s dice cuánto ha pasado', () => {
    expect(pageStaleLabel(1_000_000, 1_000_000 + 75_000)).toBe('datos de la página de hace 75 s');
    expect(pageStaleLabel(1_000_000, 1_000_000 + 600_000)).toBe('datos de la página de hace 600 s');
  });

  it('sin sello o con reloj raro no hay etiqueta', () => {
    expect(pageStaleLabel(null, 1_000)).toBeNull();
    expect(pageStaleLabel(Number.NaN, 1_000)).toBeNull();
    expect(pageStaleLabel(1_000, Number.NaN)).toBeNull();
    expect(pageStaleLabel(2_000, 1_000)).toBeNull();
  });
});

describe('withPagePosition', () => {
  const now = 5_000_000;
  const view = pagePositionToView(pagePosition());

  it('sin instantánea de API usa la posición de la página', () => {
    const result = withPagePosition(unknownPanel, view, 'BTCUSDC', now - 1_000, now);
    expect(result.mode).toBe('position');
    expect(result.stale).toBe(false);
    expect(result.snapshot?.positions).toHaveLength(1);
    expect(result.snapshot?.fetchedAt).toBe(now - 1_000);
  });

  it('la cuenta por API manda siempre', () => {
    const apiPanel: PanelState = { mode: 'position', stale: false, snapshot: apiSnapshot, error: null };
    expect(withPagePosition(apiPanel, view, 'BTCUSDC', now, now)).toBe(apiPanel);

    const flatPanel: PanelState = { ...apiPanel, mode: 'flat', snapshot: { ...apiSnapshot, positions: [] } };
    expect(withPagePosition(flatPanel, view, 'BTCUSDC', now, now)).toBe(flatPanel);
  });

  it('un dato de la página de hace más de 60 s sale caducado', () => {
    const result = withPagePosition(unknownPanel, view, 'BTCUSDC', now - 120_000, now);
    expect(result.mode).toBe('position');
    expect(result.stale).toBe(true);
  });

  it('sin posición de la página no toca el panel', () => {
    expect(withPagePosition(unknownPanel, null, 'BTCUSDC', now, now)).toBe(unknownPanel);
  });

  it('sin sello usa el reloj actual', () => {
    const result = withPagePosition(unknownPanel, view, 'BTCUSDC', null, now);
    expect(result.snapshot?.fetchedAt).toBe(now);
    expect(result.stale).toBe(false);
  });

  it('la etiqueta de fuente es la que se pinta en la tarjeta', () => {
    expect(PAGE_SOURCE_LABEL).toBe('página de Binance');
  });
});
