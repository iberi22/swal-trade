import { describe, expect, it } from 'vitest';
import {
  detectMarketContext,
  intervalFromFreeText,
  normalizeSymbol,
  parseBinanceFuturesUrl,
  parseIntervalLabel,
  parseTradingViewTitle,
  parseTradingViewUrl,
} from './market-context';

describe('normalizeSymbol', () => {
  it('quita el prefijo del exchange y el sufijo perpetuo', () => {
    expect(normalizeSymbol('BINANCE:BTCUSDT.P')).toBe('BTCUSDT');
    expect(normalizeSymbol('BINANCE:BTCUSDTPERP')).toBe('BTCUSDT');
    expect(normalizeSymbol('btcusdt')).toBe('BTCUSDT');
    expect(normalizeSymbol('1000PEPEUSDT')).toBe('1000PEPEUSDT');
  });

  it('rechaza texto que no es un par', () => {
    expect(normalizeSymbol('MY_API_KEY')).toBeNull();
    expect(normalizeSymbol('account')).toBeNull();
    expect(normalizeSymbol('abc123')).toBeNull();
    expect(normalizeSymbol('1,234.50 USDT')).toBeNull();
  });
});

describe('parseIntervalLabel', () => {
  it('acepta las seis temporalidades y los códigos de TradingView', () => {
    expect(parseIntervalLabel('15m')).toBe('15m');
    expect(parseIntervalLabel('1H')).toBe('1h');
    expect(parseIntervalLabel('4h')).toBe('4h');
    expect(parseIntervalLabel('1D')).toBe('1d');
    expect(parseIntervalLabel('60', { bare: true })).toBe('1h');
    expect(parseIntervalLabel('240', { bare: true })).toBe('4h');
    expect(parseIntervalLabel('5', { bare: true })).toBe('5m');
  });

  it('no trata un número pelado como temporalidad si no se pide', () => {
    expect(parseIntervalLabel('5')).toBeNull();
    expect(parseIntervalLabel('20x')).toBeNull();
    expect(parseIntervalLabel('1,234.50 USDT')).toBeNull();
    expect(parseIntervalLabel('30m')).toBeNull();
  });
});

describe('URLs de Binance Futures', () => {
  it('lee el símbolo de la ruta', () => {
    expect(parseBinanceFuturesUrl('https://www.binance.com/en/futures/BTCUSDT')).toEqual({
      symbol: 'BTCUSDT',
      timeframe: null,
    });
    expect(parseBinanceFuturesUrl('https://www.binance.com/en/futures/ETHUSDT/')).toEqual({
      symbol: 'ETHUSDT',
      timeframe: null,
    });
    expect(parseBinanceFuturesUrl('https://www.binance.com/zh-CN/futures/1000PEPEUSDT')).toEqual({
      symbol: '1000PEPEUSDT',
      timeframe: null,
    });
    expect(parseBinanceFuturesUrl('https://www.binance.com/en/futures/btcusdt')).toEqual({
      symbol: 'BTCUSDT',
      timeframe: null,
    });
  });

  it('lee la temporalidad si viene en la query', () => {
    expect(parseBinanceFuturesUrl('https://www.binance.com/en/futures/BTCUSDT?interval=15m')).toEqual({
      symbol: 'BTCUSDT',
      timeframe: '15m',
    });
    expect(
      parseBinanceFuturesUrl('https://www.binance.com/en/futures/SOLUSDT?timeframe=4h'),
    ).toEqual({ symbol: 'SOLUSDT', timeframe: '4h' });
    expect(parseBinanceFuturesUrl('https://www.binance.com/en/futures/BTCUSDT?interval=60')).toEqual({
      symbol: 'BTCUSDT',
      timeframe: '1h',
    });
  });

  it('ignora spot, cuentas y rutas que no son el símbolo', () => {
    expect(parseBinanceFuturesUrl('https://www.binance.com/en/spot/BTCUSDT')).toBeNull();
    expect(parseBinanceFuturesUrl('https://www.binance.com/en/my/orders')).toBeNull();
    expect(parseBinanceFuturesUrl('https://www.binance.com/en/futures/account')).toBeNull();
    expect(parseBinanceFuturesUrl('https://www.binance.com/en/futures/BTCUSDT/info')).toBeNull();
  });
});

describe('URLs y títulos de TradingView', () => {
  it('decodifica el símbolo perpetuo y el intervalo corto', () => {
    expect(
      parseTradingViewUrl(
        'https://www.tradingview.com/chart/abc123/?symbol=BINANCE%3ABTCUSDT.P&interval=5',
      ),
    ).toEqual({ symbol: 'BTCUSDT', timeframe: '5m' });
  });

  it('mapea 60, 240, 15 y 1D', () => {
    expect(
      parseTradingViewUrl('https://www.tradingview.com/chart/abc123/?symbol=BINANCE:ETHUSDT&interval=60'),
    ).toEqual({ symbol: 'ETHUSDT', timeframe: '1h' });
    expect(
      parseTradingViewUrl(
        'https://www.tradingview.com/chart/xyz/?symbol=BINANCE:SOLUSDT.P&interval=240',
      ),
    ).toEqual({ symbol: 'SOLUSDT', timeframe: '4h' });
    expect(
      parseTradingViewUrl(
        'https://www.tradingview.com/chart/xyz/?symbol=BINANCE:BTCUSDT.P&interval=15',
      ),
    ).toEqual({ symbol: 'BTCUSDT', timeframe: '15m' });
    expect(
      parseTradingViewUrl(
        'https://www.tradingview.com/chart/xyz/?symbol=BINANCE:BTCUSDT.P&interval=1D',
      ),
    ).toEqual({ symbol: 'BTCUSDT', timeframe: '1d' });
  });

  it('no usa el id del layout como símbolo', () => {
    expect(parseTradingViewUrl('https://www.tradingview.com/chart/abc123/')).toEqual({
      symbol: null,
      timeframe: null,
    });
    expect(parseTradingViewUrl('https://www.tradingview.com/symbols/BTCUSDT/')).toBeNull();
  });

  it('lee símbolo y temporalidad del título', () => {
    expect(parseTradingViewTitle('BTCUSDT.P 5 BINANCE')).toEqual({
      symbol: 'BTCUSDT',
      timeframe: '5m',
    });
    expect(parseTradingViewTitle('ETHUSDT, 1h')).toEqual({
      symbol: 'ETHUSDT',
      timeframe: '1h',
    });
    expect(parseTradingViewTitle('SOLUSDT.P, 4h · Binance')).toEqual({
      symbol: 'SOLUSDT',
      timeframe: '4h',
    });
    expect(parseTradingViewTitle('Bitcoin / TetherUS PERPETUAL CONTRACT · 15 · BINANCE')).toEqual({
      symbol: null,
      timeframe: '15m',
    });
    expect(intervalFromFreeText('1000PEPEUSDT')).toBeNull();
  });
});

describe('detectMarketContext', () => {
  it('arma el mensaje de Binance e infiere 5m si no hay temporalidad', () => {
    expect(detectMarketContext({ href: 'https://www.binance.com/en/futures/BTCUSDT' })).toEqual({
      symbol: 'BTCUSDT',
      timeframe: '5m',
      source: 'binance',
      timeframeInferred: true,
    });
  });

  it('en Binance acepta el intervalo del DOM solo si trae sufijo', () => {
    expect(
      detectMarketContext({
        href: 'https://www.binance.com/en/futures/ETHUSDT',
        domInterval: '1h',
      }),
    ).toMatchObject({ symbol: 'ETHUSDT', timeframe: '1h', timeframeInferred: false });
    expect(
      detectMarketContext({
        href: 'https://www.binance.com/en/futures/ETHUSDT',
        domInterval: '20x',
      }),
    ).toMatchObject({ timeframe: '5m', timeframeInferred: true });
  });

  it('en TradingView completa con el título y el control de intervalo', () => {
    expect(
      detectMarketContext({
        href: 'https://www.tradingview.com/chart/abc123/?symbol=BINANCE%3ABTCUSDT.P&interval=5',
        title: 'otra cosa',
      }),
    ).toEqual({
      symbol: 'BTCUSDT',
      timeframe: '5m',
      source: 'tradingview',
      timeframeInferred: false,
    });
    expect(
      detectMarketContext({
        href: 'https://www.tradingview.com/chart/abc123/',
        title: 'ETHUSDT, 1h',
      }),
    ).toMatchObject({ symbol: 'ETHUSDT', timeframe: '1h', source: 'tradingview' });
    expect(
      detectMarketContext({
        href: 'https://www.tradingview.com/chart/abc123/?symbol=BINANCE:BTCUSDT.P',
        title: 'Bitcoin / TetherUS PERPETUAL CONTRACT · 15 · BINANCE',
        domInterval: '15',
      }),
    ).toMatchObject({ symbol: 'BTCUSDT', timeframe: '15m', timeframeInferred: false });
  });
});
