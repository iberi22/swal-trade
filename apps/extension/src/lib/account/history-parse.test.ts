import { describe, expect, it } from 'vitest';
import { nextPage, planTradeJobs } from './history';
import { pagingRows, parseIncome, parseUserTrades, tripsFromHistory } from './history-parse';

// Filas tal como las devuelve Binance Futures: numeros como texto, ids como numero.
const T0 = 1_760_000_000_000;
const trade = (over: Record<string, unknown> = {}) => ({
  symbol: 'BTCUSDT',
  id: 698759,
  orderId: 25851813,
  side: 'BUY',
  price: '7819.01',
  qty: '0.002',
  realizedPnl: '0',
  quoteQty: '15.63802',
  commission: '0.00312760',
  commissionAsset: 'USDT',
  time: T0,
  positionSide: 'BOTH',
  maker: false,
  buyer: true,
  ...over,
});
const inc = (over: Record<string, unknown> = {}) => ({
  symbol: 'BTCUSDT',
  incomeType: 'FUNDING_FEE',
  income: '-0.37500000',
  asset: 'USDT',
  info: 'FUNDING_FEE',
  time: T0 + 1000,
  tranId: 9689322392,
  tradeId: '',
  ...over,
});

describe('parseUserTrades', () => {
  it('converts strings to numbers and keeps the trade id', () => {
    const { rows, skipped } = parseUserTrades([trade()]);
    expect(skipped).toBe(0);
    expect(rows[0]).toEqual({
      id: '698759',
      symbol: 'BTCUSDT',
      side: 'BUY',
      price: 7819.01,
      qty: 0.002,
      fee: 0.0031276,
      realizedPnl: 0,
      timeMs: T0,
      orderId: '25851813',
    });
  });
  it('takes the absolute commission', () => {
    expect(parseUserTrades([trade({ commission: '-0.5' })]).rows[0]!.fee).toBe(0.5);
  });
  it('counts a non-USD commission as 0 and reports it', () => {
    const r = parseUserTrades([trade({ commissionAsset: 'BNB', commission: '0.001' })]);
    expect(r.rows[0]!.fee).toBe(0);
    expect(r.nonStableFees).toBe(1);
  });
  it('drops broken rows and counts them', () => {
    const r = parseUserTrades([
      trade(),
      trade({ id: undefined }),
      trade({ price: 'NaN' }),
      trade({ qty: '0' }),
      trade({ side: 'HOLD' }),
      trade({ symbol: 'btc/usdt' }),
      null,
      'x',
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.skipped).toBe(7);
    expect(parseUserTrades('nope').rows).toEqual([]);
  });
});

describe('parseIncome', () => {
  it('converts strings and keeps tranId', () => {
    const { rows } = parseIncome([inc(), inc({ incomeType: 'REALIZED_PNL', income: '12.5', tranId: '9689322393' })]);
    expect(rows).toEqual([
      { tranId: '9689322392', symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE', income: -0.375, asset: 'USDT', timeMs: T0 + 1000 },
      { tranId: '9689322393', symbol: 'BTCUSDT', incomeType: 'REALIZED_PNL', income: 12.5, asset: 'USDT', timeMs: T0 + 1000 },
    ]);
  });
  it('allows an empty symbol (transfers) but skips bad rows and non-USD assets', () => {
    const r = parseIncome([
      inc({ symbol: '', incomeType: 'TRANSFER' }),
      inc({ tranId: null }),
      inc({ income: 'abc' }),
      inc({ asset: 'BNB' }),
      inc({ incomeType: 'bad type' }),
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.skipped).toBe(4);
  });
});

describe('pagingRows', () => {
  it('reads ids and time from the raw rows, including ones the parser would drop', () => {
    const rows = pagingRows([inc(), inc({ income: 'abc', tranId: 5 }), 7], 'tranId');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual({ tranId: '5', timeMs: T0 + 1000 });
    expect(rows[2]).toEqual({});
  });
  it('feeds nextPage: a full page continues, a short page is done', () => {
    const [job] = planTradeJobs({ symbols: ['BTCUSDT'], fromMs: T0, toMs: T0 + 1000 });
    const full = Array.from({ length: 1000 }, (_, i) => trade({ id: 100 + i }));
    expect(nextPage(job!, pagingRows(full, 'id'))).toMatchObject({ params: { fromId: 1100 } });
    expect(nextPage(job!, pagingRows(full.slice(0, 5), 'id'))).toBe('done');
  });
});

describe('tripsFromHistory', () => {
  it('dedupes by exchange id and builds a round trip with funding', () => {
    const fills = parseUserTrades([
      trade({ id: 1, side: 'BUY', price: '100', qty: '1', commission: '0.05', time: T0 }),
      trade({ id: 1, side: 'BUY', price: '100', qty: '1', commission: '0.05', time: T0 }),
      trade({ id: 2, side: 'SELL', price: '110', qty: '1', realizedPnl: '10', commission: '0.055', time: T0 + 3_600_000 }),
    ]).rows;
    const income = parseIncome([inc({ income: '-0.2', time: T0 + 1_800_000 }), inc({ income: '-0.2', time: T0 + 1_800_000 })]).rows;
    const trips = tripsFromHistory(fills, income);
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ side: 'long', size: 1, pnl: 10, fundingUsd: -0.2 });
    expect(trips[0]!.netUsd).toBeCloseTo(10 - 0.105 - 0.2, 6);
  });
});
