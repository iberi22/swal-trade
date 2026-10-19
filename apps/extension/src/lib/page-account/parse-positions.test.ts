import { describe, expect, it } from 'vitest';
import { openPositionsEnQuoteShort, openPositionsEs, historyFixture } from './fixtures';
import { parseOpenPositions, toPositionView } from './parse-positions';
import type { PagePosition } from './parse-positions';

describe('parseOpenPositions (Spanish table)', () => {
  const positions = parseOpenPositions(openPositionsEs());

  it('finds both rows and ignores the close-order inputs', () => {
    expect(positions).toHaveLength(2);
    expect(positions.map((position) => position.symbol)).toEqual([
      '1000PEPEUSDC',
      'BTCUSDC',
    ]);
  });

  it('parses the PEPE long with size quoted in USDC', () => {
    const pepe = positions[0] as PagePosition;
    expect(pepe).toEqual({
      symbol: '1000PEPEUSDC',
      contract: 'perp',
      leverage: 40,
      marginMode: null,
      side: 'long',
      sizeQuote: { value: 254.56, asset: 'USDC' },
      sizeBase: null,
      uPnl: -0.91,
      roiPct: -14.4,
      entry: 0.0041106,
      breakEven: 0.0041123,
      mark: 0.0040981,
      liq: 0.0030178,
    });
  });

  it('parses the BTC short with signed base size', () => {
    const btc = positions[1] as PagePosition;
    expect(btc.symbol).toBe('BTCUSDC');
    expect(btc.contract).toBe('perp');
    expect(btc.leverage).toBe(30);
    expect(btc.sizeQuote).toBeNull();
    expect(btc.sizeBase).toBe(-0.004);
    expect(btc.side).toBe('short');
    expect(btc.uPnl).toBe(2.1);
    expect(btc.roiPct).toBe(19);
    expect(btc.entry).toBe(82_644.1);
    expect(btc.breakEven).toBe(82_300);
    expect(btc.mark).toBe(82_100);
    expect(btc.liq).toBe(95_000);
  });
});

describe('parseOpenPositions (English header, quote size)', () => {
  it('infers a short from liq > entry when there is no signed base size', () => {
    const [row] = parseOpenPositions(openPositionsEnQuoteShort());
    expect(row?.symbol).toBe('ETHUSDC');
    expect(row?.sizeQuote).toEqual({ value: 1500, asset: 'USDC' });
    expect(row?.sizeBase).toBeNull();
    expect(row?.entry).toBe(3000);
    expect(row?.liq).toBe(3300);
    expect(row?.side).toBe('short');
  });
});

describe('toPositionView', () => {
  it('maps the PEPE row, deriving base size from notional / mark', () => {
    const [pepe] = parseOpenPositions(openPositionsEs());
    const view = toPositionView(pepe as PagePosition, { nowMs: 1_760_000_000_000 });
    expect(view).not.toBeNull();
    expect(view).toEqual({
      symbol: '1000PEPEUSDC',
      side: 'long',
      size: 254.56 / 0.0040981,
      entry: 0.0041106,
      mark: 0.0040981,
      liq: 0.0030178,
      leverage: 40,
      marginType: 'cross',
      uPnl: -0.91,
      breakEven: 0.0041123,
      notional: 254.56,
      stop: null,
      firstFillMs: null,
    });
    expect(view?.size).toBeCloseTo(254.56 / 0.0040981, 6);
  });

  it('maps the BTC short keeping base size and notional', () => {
    const [, btc] = parseOpenPositions(openPositionsEs());
    const view = toPositionView(btc as PagePosition, { nowMs: 0 });
    expect(view).toMatchObject({
      symbol: 'BTCUSDC',
      side: 'short',
      size: 0.004,
      entry: 82_644.1,
      mark: 82_100,
      liq: 95_000,
      leverage: 30,
      marginType: 'cross',
      uPnl: 2.1,
      notional: 0.004 * 82_100,
    });
  });

  it('returns null when required fields are missing', () => {
    const base = parseOpenPositions(openPositionsEs())[0] as PagePosition;
    expect(toPositionView({ ...base, side: null })).toBeNull();
    expect(toPositionView({ ...base, leverage: null })).toBeNull();
    expect(toPositionView({ ...base, entry: null })).toBeNull();
    expect(toPositionView({ ...base, mark: 0 })).toBeNull();
    expect(toPositionView({ ...base, sizeQuote: null })).toBeNull();
  });
});

describe('parser robustness', () => {
  it('returns [] with garbage, no header or no rows', () => {
    expect(parseOpenPositions(null)).toEqual([]);
    expect(parseOpenPositions({ tag: 'div' })).toEqual([]);
    expect(parseOpenPositions({ tag: 'div', text: 'nada' })).toEqual([]);
    expect(parseOpenPositions(historyFixture())).toEqual([]);
  });

  it('does not throw on a malformed row', () => {
    const root = {
      tag: 'div',
      children: [
        {
          tag: 'div',
          children: ['Símbolo', 'Tamaño', 'PnL (%ROI)', 'Precio de entrada', 'Precio de marca'].map(
            (text) => ({ tag: 'span', text }),
          ),
        },
        { tag: 'div', children: [{ tag: 'span', text: 'solo ruido' }] },
      ],
    };
    expect(parseOpenPositions(root)).toEqual([]);
  });
});
