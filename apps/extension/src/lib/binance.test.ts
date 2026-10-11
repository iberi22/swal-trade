import { describe, expect, it } from 'vitest';
import { klineSocketUrls, klinesUrl, parseKlineMessage, parseKlineRows } from './binance';

describe('URLs públicas de Binance Futures', () => {
  it('pide klines al REST de futuros', () => {
    expect(klinesUrl('btcusdt', '5m', 500)).toBe(
      'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=500',
    );
  });

  it('arma el websocket primario y el de respaldo', () => {
    expect(klineSocketUrls('BTCUSDT', '5m')).toEqual({
      primary: 'wss://fstream.binance.com/market/ws/btcusdt@kline_5m',
      fallback: 'wss://fstream.binance.com/ws/btcusdt@kline_5m',
    });
  });

  it('rechaza un símbolo que no es un par', () => {
    expect(() => klinesUrl('not a symbol', '1m')).toThrow(/símbolo/);
  });
});

describe('parseo de velas', () => {
  it('convierte una fila de klines a segundos', () => {
    const rows = parseKlineRows([
      [1499040000000, '0.01634790', '0.80000000', '0.01575800', '0.01577100', '148976.11427815', 0],
    ]);
    expect(rows).toEqual([
      {
        time: 1499040000,
        open: 0.0163479,
        high: 0.8,
        low: 0.015758,
        close: 0.015771,
        volume: 148976.11427815,
      },
    ]);
  });

  it('lee trades y takerBuyVolume cuando la fila los trae (índices 8 y 9)', () => {
    const rows = parseKlineRows([
      [
        1499040000000,
        '0.01634790',
        '0.80000000',
        '0.01575800',
        '0.01577100',
        '148976.11427815',
        1499044799999,
        '2434.19055334',
        308,
        '1756.87402397',
        '28.46694368',
      ],
    ]);
    expect(rows[0]).toMatchObject({ time: 1499040000, trades: 308, takerBuyVolume: 1756.87402397 });
  });

  it('ignora un error JSON de la API', () => {
    expect(parseKlineRows({ code: -1121, msg: 'Invalid symbol' })).toEqual([]);
  });

  it('lee un evento de kline y el sobre {data}', () => {
    const raw = JSON.stringify({
      e: 'kline',
      s: 'BTCUSDT',
      k: {
        t: 1_699_000_000_000,
        s: 'BTCUSDT',
        i: '5m',
        o: '100',
        h: '110',
        l: '90',
        c: '105',
        v: '12',
        n: 42,
        V: '7.5',
        x: false,
      },
    });
    expect(parseKlineMessage(raw)).toMatchObject({
      symbol: 'BTCUSDT',
      interval: '5m',
      closed: false,
      candle: { time: 1_699_000_000, open: 100, close: 105, volume: 12, trades: 42, takerBuyVolume: 7.5 },
    });
    expect(parseKlineMessage('no-json')).toBeNull();
  });
});
