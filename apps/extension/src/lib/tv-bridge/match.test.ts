import { describe, expect, it } from 'vitest';
import { analysisFromKey, chartIdentity, chartMatchesAnalysis, describeChart } from './match';
import type { TvChartLike } from './tv-chart';

/** Chart de mentira con símbolo y resolución configurables. */
function chart(symbol: string, resolution: string): TvChartLike {
  return {
    getVisibleRange: () => ({ from: 1_700_000_000, to: 1_700_100_000 }),
    symbol: () => symbol,
    resolution: () => resolution,
    createShape: () => 'id',
    createMultipointShape: () => 'id',
    removeEntity: () => {},
  };
}

describe('analysisFromKey', () => {
  it('parte símbolo y temporalidad', () => {
    expect(analysisFromKey('BTCUSDT@1h')).toEqual({ symbol: 'BTCUSDT', tf: '1h' });
    expect(analysisFromKey('ETHUSDT@4h')).toEqual({ symbol: 'ETHUSDT', tf: '4h' });
  });

  it('rechaza claves raras', () => {
    expect(analysisFromKey('')).toBeNull();
    expect(analysisFromKey('sin-arroba')).toBeNull();
    expect(analysisFromKey('@1h')).toBeNull();
    expect(analysisFromKey('NOEUROS@1h')).toBeNull(); // no es un par
  });
});

describe('chartIdentity', () => {
  it('normaliza el símbolo de Binance y la resolución de TradingView', () => {
    const { identity } = chartIdentity(chart('BTCUSDT@PRICETYPE=LAST', '1D'));
    expect(identity.symbol).toBe('BTCUSDT');
    expect(identity.tf).toBe('1d');
  });

  it('mapea resoluciones numéricas a nuestras seis temporalidades', () => {
    expect(chartIdentity(chart('BTCUSDT@PRICETYPE=LAST', '1')).identity.tf).toBe('1m');
    expect(chartIdentity(chart('BTCUSDT@PRICETYPE=LAST', '15')).identity.tf).toBe('15m');
    expect(chartIdentity(chart('BTCUSDT@PRICETYPE=LAST', '60')).identity.tf).toBe('1h');
    expect(chartIdentity(chart('BTCUSDT@PRICETYPE=LAST', '240')).identity.tf).toBe('4h');
  });

  it('una resolución que no controlamos queda sin tf', () => {
    expect(chartIdentity(chart('BTCUSDT@PRICETYPE=LAST', '30')).identity.tf).toBeNull();
  });
});

describe('chartMatchesAnalysis (F2)', () => {
  it('casa mismo símbolo y misma temporalidad', () => {
    expect(chartMatchesAnalysis(chart('BTCUSDT@PRICETYPE=LAST', '1D'), 'BTCUSDT@1d')).toBe(true);
    expect(chartMatchesAnalysis(chart('BTCUSDT@PRICETYPE=LAST', '60'), 'BTCUSDT@1h')).toBe(true);
  });

  it('no casa si cambia el símbolo: BTC sobre ETH no pinta', () => {
    expect(chartMatchesAnalysis(chart('ETHUSDT@PRICETYPE=LAST', '1D'), 'BTCUSDT@1d')).toBe(false);
  });

  it('no casa si cambia la temporalidad', () => {
    // Gráfico en 4h, análisis de 1h: no dibuja.
    expect(chartMatchesAnalysis(chart('BTCUSDT@PRICETYPE=LAST', '240'), 'BTCUSDT@1h')).toBe(false);
    // Gráfico en 1h expresado como "60", análisis 1h: sí casa.
    expect(chartMatchesAnalysis(chart('BTCUSDT@PRICETYPE=LAST', '60'), 'BTCUSDT@1h')).toBe(true);
  });

  it('no casa si la resolución no es ninguna de las nuestras', () => {
    expect(chartMatchesAnalysis(chart('BTCUSDT@PRICETYPE=LAST', '30'), 'BTCUSDT@15m')).toBe(false);
  });
});

describe('describeChart', () => {
  it('da el símbolo legible y la tf normalizada', () => {
    expect(describeChart(chart('BTCUSDT@PRICETYPE=LAST', '1D'))).toEqual({ symbol: 'BTCUSDT', tf: '1d' });
  });

  it('si no normaliza la tf, enseña la resolución cruda', () => {
    expect(describeChart(chart('BTCUSDT@PRICETYPE=LAST', '30')).tf).toBe('30');
  });
});
