import { describe, expect, it } from 'vitest';
import { drawingFromTvTool, symbolFromTv, type TvDrawingTool } from './tv-read';

const btc: TvDrawingTool = {
  id: 'tv-btc',
  name: 'LineToolRiskRewardLong',
  points: [{ price: 81917.9 }],
  properties: { stopLevel: 592530, profitLevel: 592530 },
  minmov: 1,
  pricescale: 100,
  symbol: 'BTCUSDT@PRICETYPE=LAST',
};

describe('drawingFromTvTool', () => {
  it('lee el ejemplo verificado de BTCUSDT (stop 75992,6 / objetivo 87843,2)', () => {
    expect(drawingFromTvTool(btc)).toEqual({
      id: 'tv-btc',
      side: 'long',
      entry: 81917.9,
      stop: 75992.6,
      target: 87843.2,
      symbol: 'BTCUSDT',
    });
  });

  it('invierte la fórmula en un corto', () => {
    const short = drawingFromTvTool({
      id: 'tv-short',
      name: 'LineToolRiskRewardShort',
      points: [{ price: 100 }],
      properties: { stopLevel: 100, profitLevel: 200 }, // 1 y 2 ticks
      minmov: 1,
      pricescale: 100,
      symbol: 'ETHUSDT',
    });
    expect(short).toEqual({
      id: 'tv-short',
      side: 'short',
      entry: 100,
      stop: 101,
      target: 98,
      symbol: 'ETHUSDT',
    });
  });

  it('acepta el nombre long_position y el tick fino de 1000PEPEUSDC', () => {
    // El contrato da pricescale 10000000 (tick 0,0000001) y espera
    // stop 0.0040825 / target 0.004274. Esos dos precios solo son coherentes
    // con la fórmula si stopLevel=90 (900 daría 0.0040015 con el mismo tick):
    // 90 * 1e-7 = 0,000009 y 1825 * 1e-7 = 0,0001825.
    const pepe = drawingFromTvTool({
      id: 'tv-pepe',
      name: 'long_position',
      points: [{ price: 0.0040915 }],
      properties: { stopLevel: 90, profitLevel: 1825 },
      minmov: 1,
      pricescale: 10000000, // tick 0,0000001
      symbol: '1000PEPEUSDC@PRICETYPE=LAST',
    });
    expect(pepe).not.toBeNull();
    expect(pepe?.side).toBe('long');
    expect(pepe?.symbol).toBe('1000PEPEUSDC');
    expect(pepe?.entry).toBeCloseTo(0.0040915, 9);
    expect(pepe?.stop).toBeCloseTo(0.0040825, 9);
    expect(pepe?.target).toBeCloseTo(0.004274, 9);

    // Con el stopLevel literal del contrato (900) la fórmula verificada da
    // 0,00009 de distancia, no 0,000009: se deja constancia del cálculo.
    const literal = drawingFromTvTool({
      id: 'tv-pepe-900',
      name: 'long_position',
      points: [{ price: 0.0040915 }],
      properties: { stopLevel: 900, profitLevel: 1825 },
      minmov: 1,
      pricescale: 10000000,
      symbol: '1000PEPEUSDC@PRICETYPE=LAST',
    });
    expect(literal?.stop).toBeCloseTo(0.0040015, 9);
  });

  it('normaliza el símbolo y elimina el sufijo de TradingView', () => {
    expect(symbolFromTv('BTCUSDT@PRICETYPE=LAST')).toBe('BTCUSDT');
    expect(symbolFromTv(' btcusdt ')).toBe('BTCUSDT');
    expect(symbolFromTv('@PRICETYPE=LAST')).toBeNull();
    expect(symbolFromTv('')).toBeNull();
  });

  it('devuelve null con nombre, puntos, propiedades, tick o símbolo inválidos', () => {
    expect(drawingFromTvTool({ ...btc, name: 'FibRetracement' })).toBeNull();
    expect(drawingFromTvTool({ ...btc, points: [] })).toBeNull();
    expect(drawingFromTvTool({ ...btc, points: [{ price: Number.NaN }] })).toBeNull();
    expect(drawingFromTvTool({ ...btc, properties: {} })).toBeNull();
    expect(drawingFromTvTool({ ...btc, minmov: 0 })).toBeNull();
    expect(drawingFromTvTool({ ...btc, pricescale: 0 })).toBeNull();
    expect(drawingFromTvTool({ ...btc, symbol: '' })).toBeNull();
    expect(drawingFromTvTool({ ...btc, id: '' })).toBeNull();
  });

  it('devuelve null si la geometría resultante no valida (stop al lado contrario)', () => {
    expect(
      drawingFromTvTool({
        ...btc,
        properties: { stopLevel: -100, profitLevel: 100 }, // largo con stop por encima
      }),
    ).toBeNull();
  });

  it('nunca lanza con una entrada nula', () => {
    expect(() => drawingFromTvTool(null as never)).not.toThrow();
    expect(drawingFromTvTool(null as never)).toBeNull();
  });
});
