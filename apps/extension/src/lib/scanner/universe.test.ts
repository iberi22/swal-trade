import { describe, it, expect } from 'vitest';
import { btcSymbolFor, filterByVolume, scanSymbols, selectUniverse, validSymbol, volTierOf } from './universe';

const sym = (symbol: string, over: Record<string, unknown> = {}) => ({
  symbol, status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', underlyingType: 'COIN', ...over,
});

describe('selectUniverse', () => {
  const info = {
    symbols: [
      sym('BTCUSDT'),
      sym('ETHUSDT'),
      sym('ETHUSDC', { quoteAsset: 'USDC' }),
      sym('OLDUSDT', { status: 'SETTLING' }),
      sym('BTCUSDT_261225', { contractType: 'CURRENT_QUARTER' }),
      sym('XAUUSDT', { underlyingType: 'COMMODITY' }),
      sym('BAD/USDT'),
      sym('x'),
      sym('btcusdt'),
      null,
      'junk',
    ],
  };
  it('keeps TRADING PERPETUAL COIN of the quote, valid symbols, deduped and sorted', () => {
    expect(selectUniverse(info, 'USDT')).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(selectUniverse(info, 'USDC')).toEqual(['ETHUSDC']);
  });
  it('survives garbage', () => {
    expect(selectUniverse(null, 'USDT')).toEqual([]);
    expect(selectUniverse({ symbols: 5 }, 'USDT')).toEqual([]);
  });
});

describe('symbol validation', () => {
  it('uses the shared symbol rule', () => {
    expect(validSymbol(' ethusdt ')).toBe('ETHUSDT');
    expect(validSymbol('A/B')).toBeNull();
    expect(validSymbol('A')).toBeNull();
    expect(validSymbol(5)).toBeNull();
    expect(validSymbol("BTCUSDT&x=1")).toBeNull();
  });
});

describe('filterByVolume', () => {
  it('maps symbol to quoteVolume above the minimum and drops bad rows', () => {
    const rows = [
      { symbol: 'BTCUSDT', quoteVolume: '5000000000' },
      { symbol: 'AAAUSDT', quoteVolume: '19999999' },
      { symbol: 'BBBUSDT', quoteVolume: '20000000' },
      { symbol: 'CCCUSDT', quoteVolume: 'nan' },
      { symbol: 'bad symbol', quoteVolume: '9e9' },
      null,
    ];
    expect(filterByVolume(rows, 20_000_000)).toEqual({ BTCUSDT: 5e9, BBBUSDT: 2e7 });
    expect(filterByVolume('x', 1)).toEqual({});
  });
  it('scanSymbols intersects the universe with the volume map', () => {
    expect(scanSymbols(['B', 'A', 'C'].map((s) => s + 'USDT'), { AUSDT: 1, CUSDT: 1, ZUSDT: 1 })).toEqual(['AUSDT', 'CUSDT']);
  });
});

describe('tiers', () => {
  it('uses the spec tiers', () => {
    expect(volTierOf(1e8)).toBe('hi');
    expect(volTierOf(9.99e7)).toBe('mid');
    expect(volTierOf(2e7)).toBe('mid');
    expect(volTierOf(1.9e7)).toBe('lo');
  });
  it('btc reference', () => {
    expect(btcSymbolFor('USDT')).toBe('BTCUSDT');
    expect(btcSymbolFor('USDC')).toBe('BTCUSDC');
  });
});
