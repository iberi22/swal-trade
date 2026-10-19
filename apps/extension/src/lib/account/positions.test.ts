import { describe, expect, it } from 'vitest';
import { parsePositions, safeNum } from './positions';

const row = (o: Record<string, unknown>) => ({
  symbol: 'BTCUSDT',
  positionAmt: '0.100',
  entryPrice: '100000',
  markPrice: '101000',
  unRealizedProfit: '100',
  liquidationPrice: '90000',
  leverage: '10',
  marginType: 'cross',
  positionSide: 'BOTH',
  notional: '10100',
  breakEvenPrice: '100040',
  ...o,
});

const algoStop = (o: Record<string, unknown> = {}) => ({
  symbol: 'BTCUSDT',
  orderType: 'STOP_MARKET',
  side: 'SELL',
  positionSide: 'BOTH',
  triggerPrice: '98000',
  closePosition: true,
  reduceOnly: false,
  ...o,
});

describe('safeNum', () => {
  it('rejects non-finite and empty', () => {
    expect(safeNum('NaN')).toBeNull();
    expect(safeNum(Infinity)).toBeNull();
    expect(safeNum('')).toBeNull();
    expect(safeNum('abc')).toBeNull();
    expect(safeNum(null)).toBeNull();
    expect(safeNum('1.5')).toBe(1.5);
  });
});

describe('parsePositions', () => {
  it('one-way long', () => {
    const [p] = parsePositions([row({})], [], []);
    expect(p).toMatchObject({
      symbol: 'BTCUSDT', side: 'long', size: 0.1, entry: 100000, mark: 101000, liq: 90000,
      leverage: 10, marginType: 'cross', uPnl: 100, breakEven: 100040, notional: 10100, stop: null, firstFillMs: null,
    });
  });

  it('one-way short', () => {
    const [p] = parsePositions([row({ positionAmt: '-0.5', notional: '-50500', marginType: 'isolated' })], [], []);
    expect(p.side).toBe('short');
    expect(p.size).toBe(0.5);
    expect(p.notional).toBe(50500);
    expect(p.marginType).toBe('isolated');
  });

  it('hedge mode two rows, zero rows ignored', () => {
    const out = parsePositions(
      [
        row({ positionSide: 'LONG', positionAmt: '0.1' }),
        row({ positionSide: 'SHORT', positionAmt: '-0.2' }),
        row({ symbol: 'ETHUSDT', positionAmt: '0.000' }),
      ],
      [],
      [],
    );
    expect(out.map((p) => p.side)).toEqual(['long', 'short']);
  });

  it('hedge short positionAmt sign does not matter for side', () => {
    const [p] = parsePositions([row({ positionSide: 'SHORT', positionAmt: '0.2' })], [], []);
    expect(p.side).toBe('short');
  });

  it('liq 0 or missing -> null', () => {
    expect(parsePositions([row({ liquidationPrice: '0' })], [], [])[0].liq).toBeNull();
    expect(parsePositions([row({ liquidationPrice: undefined })], [], [])[0].liq).toBeNull();
  });

  it('algo stop', () => {
    const [p] = parsePositions([row({})], [], [algoStop()]);
    expect(p.stop).toEqual({ price: 98000, kind: 'algo' });
  });

  it('legacy STOP_MARKET stop in openOrders', () => {
    const [p] = parsePositions(
      [row({})],
      [{ symbol: 'BTCUSDT', type: 'STOP_MARKET', side: 'SELL', stopPrice: '97000', reduceOnly: true, positionSide: 'BOTH' }],
      [],
    );
    expect(p.stop).toEqual({ price: 97000, kind: 'order' });
  });

  it('nearest stop on the loss side wins', () => {
    const [p] = parsePositions([row({})], [], [algoStop({ triggerPrice: '95000' }), algoStop({ triggerPrice: '99000' })]);
    expect(p.stop?.price).toBe(99000);
  });

  it('stop on the wrong side of entry is ignored', () => {
    const [p] = parsePositions([row({})], [], [algoStop({ triggerPrice: '105000' })]);
    expect(p.stop).toBeNull();
  });

  it('short stop is a BUY above entry; SELL order ignored', () => {
    const short = row({ positionAmt: '-0.1' });
    expect(parsePositions([short], [], [algoStop({ side: 'BUY', triggerPrice: '102000' })])[0].stop?.price).toBe(102000);
    expect(parsePositions([short], [], [algoStop({ side: 'SELL', triggerPrice: '102000' })])[0].stop).toBeNull();
  });

  it('non-protective orders ignored (no reduceOnly/closePosition, other symbol, take profit)', () => {
    const out = parsePositions(
      [row({})],
      [{ symbol: 'BTCUSDT', type: 'STOP_MARKET', side: 'SELL', stopPrice: '98000', reduceOnly: false, closePosition: false }],
      [algoStop({ symbol: 'ETHUSDT' }), algoStop({ orderType: 'TAKE_PROFIT_MARKET' })],
    );
    expect(out[0].stop).toBeNull();
  });

  it('hedge stop must match positionSide', () => {
    const rows = [row({ positionSide: 'LONG', positionAmt: '0.1' })];
    expect(parsePositions(rows, [], [algoStop({ positionSide: 'SHORT' })])[0].stop).toBeNull();
    expect(parsePositions(rows, [], [algoStop({ positionSide: 'LONG' })])[0].stop?.price).toBe(98000);
  });

  it('no stop', () => {
    expect(parsePositions([row({})], [], [])[0].stop).toBeNull();
  });

  it('malformed rows are skipped, never throw', () => {
    const out = parsePositions(
      [null, 5, 'x', [], {}, row({ symbol: 7 }), row({ positionAmt: 'NaN' }), row({ entryPrice: 'x' }), row({ markPrice: '0' }), row({ symbol: 'OKUSDT' })],
      [null, 3, { symbol: 1 }],
      [undefined, {}, algoStop({ triggerPrice: 'Infinity' })],
    );
    expect(out.map((p) => p.symbol)).toEqual(['OKUSDT']);
  });

  it('non-array inputs return empty', () => {
    expect(parsePositions(null as unknown as unknown[], undefined as unknown as unknown[], 1 as unknown as unknown[])).toEqual([]);
  });
});
