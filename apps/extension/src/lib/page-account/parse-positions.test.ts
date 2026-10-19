import { describe, expect, it } from 'vitest';
import { openPositionsEnQuoteShort, openPositionsEs, historyFixture, n } from './fixtures';
import { POSITION_SKIP_TEXT, parseOpenPositions, positionViewFrom, toPositionView } from './parse-positions';
import type { PagePosition } from './parse-positions';
import type { TextNode } from './tree';

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

describe('lado de la posición: texto explícito y lado desconocido', () => {
  const labels = [
    'Symbol',
    'Size',
    'PNL (ROI %)',
    'Entry Price',
    'Break Even Price',
    'Mark Price',
    'Liq. Price',
  ];

  /** Tabla mínima con la misma forma que las capturas reales. */
  function table(rows: string[][]): TextNode {
    return n('div', undefined, [
      n(
        'div',
        undefined,
        labels.map((label) => n('div', undefined, [n('span', label)])),
        { role: 'row' },
      ),
      n(
        'div',
        undefined,
        rows.map((cells) =>
          n('div', undefined, cells.map((text) => n('div', undefined, [n('span', text)]))),
        ),
      ),
    ]);
  }

  it('el texto explícito manda sobre el signo del tamaño base', () => {
    // El tamaño dice corto (-0,004 BTC), pero la fila se pinta «Cross Long».
    const [row] = parseOpenPositions(
      table([['BTCUSDC Perp. Cross Long', '-0.004 BTC', '+1.00 USDC', '82,644.1', '82,300.0', '82,100.0', '95,000.0']]),
    );
    expect(row?.sizeBase).toBe(-0.004);
    expect(row?.side).toBe('long');
  });

  it('el texto explícito manda sobre la liquidación frente a la entrada', () => {
    // Liq por debajo de la entrada sugeriría largo; la fila dice «Cruzado Short».
    const [row] = parseOpenPositions(
      table([['ETHUSDC Perp. Cruzado Short', '1,500.00 USDC', '-12.00 USDC', '3,000.0', '3,010.0', '3,050.0', '2,900.0']]),
    );
    expect(row?.liq).toBe(2900);
    expect(row?.side).toBe('short');
  });

  it('sin texto, sin tamaño base y sin desnivel de liquidación el lado es DESCONOCIDO', () => {
    // Un importe positivo en la moneda de cotización NO es una dirección.
    const [row] = parseOpenPositions(
      table([['FOOUSDC Perp. 10x', '1,500.00 USDC', '-12.00 USDC', '3,000.0', '3,010.0', '3,050.0', '3,000.0']]),
    );
    expect(row?.sizeBase).toBeNull();
    expect(row?.sizeQuote).toEqual({ value: 1500, asset: 'USDC' });
    expect(row?.side).toBeNull();
    // El panel lo dice en vez de inventar un largo, y la fila no se mapea.
    expect(positionViewFrom(row as PagePosition)).toEqual({ ok: false, reason: 'no_side' });
    expect(toPositionView(row as PagePosition)).toBeNull();
    expect(POSITION_SKIP_TEXT.no_side).toBe('lado desconocido');
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

  it('dice el motivo del descarte en vez de devolver una fila a medias', () => {
    const base = parseOpenPositions(openPositionsEs())[0] as PagePosition;
    expect(positionViewFrom({ ...base, side: null })).toEqual({ ok: false, reason: 'no_side' });
    expect(positionViewFrom({ ...base, leverage: null })).toEqual({ ok: false, reason: 'no_leverage' });
    expect(positionViewFrom({ ...base, entry: null })).toEqual({ ok: false, reason: 'no_prices' });
    expect(positionViewFrom({ ...base, sizeQuote: null, sizeBase: null })).toEqual({ ok: false, reason: 'no_size' });
    expect(positionViewFrom({ ...base, mark: 0 })).toEqual({ ok: false, reason: 'no_prices' });
    expect(positionViewFrom(null as unknown as PagePosition)).toEqual({ ok: false, reason: 'no_prices' });
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
