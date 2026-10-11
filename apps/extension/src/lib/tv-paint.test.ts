import { describe, expect, it } from 'vitest';
import { probeTvChart } from './tv-chart-state';
import { PAINTABLE_URL, tvStateHint } from './tv-paint';

/** Documento de mentira: solo hace falta querySelectorAll('iframe'). */
function docWith(windows: Array<Record<string, unknown> | null>) {
  return {
    querySelectorAll: (selector: string) =>
      selector === 'iframe'
        ? windows.map((win) => ({ contentWindow: win }))
        : [],
  };
}

const chartWindow = () => {
  const chart = {
    getVisibleRange: () => ({ from: 1_700_000_000, to: 1_700_100_000 }),
    createShape: () => 'id',
    removeEntity: () => {},
  };
  return { tradingViewApi: { activeChart: () => chart } };
};

describe('probeTvChart', () => {
  it('con el iframe de Trading View y datos se puede pintar', () => {
    expect(probeTvChart(docWith([null, chartWindow()]))).toEqual({ present: true, drawable: true });
  });

  it('con el iframe recién montado todavía no', () => {
    const booting = {
      tradingViewApi: {
        activeChart: () => ({ getVisibleRange: () => ({ from: 0, to: 0 }), createShape: () => 'id' }),
      },
    };
    expect(probeTvChart(docWith([booting]))).toEqual({ present: true, drawable: false });
  });

  it('la pestaña Original no tiene iframe con API', () => {
    const accounts = { login: () => {} };
    expect(probeTvChart(docWith([accounts]))).toEqual({ present: false, drawable: false });
    expect(probeTvChart(docWith([]))).toEqual({ present: false, drawable: false });
  });

  it('un iframe de otro origen no rompe la prueba', () => {
    const crossOrigin = {
      get contentWindow(): never {
        throw new Error('Blocked a frame with origin');
      },
    };
    expect(probeTvChart(docWith([crossOrigin]))).toEqual({ present: false, drawable: false });
  });
});

describe('tvStateHint', () => {
  it('en la pestaña Original dice dónde hay que ir', () => {
    expect(tvStateHint('original')).toContain('cambia a la pestaña Trading View');
  });

  it('sin gráfico invita a abrir un futuro', () => {
    expect(tvStateHint('none')).toContain('Abre un futuro');
  });

  it('mientras carga lo dice, y cuando está listo no estorba', () => {
    expect(tvStateHint('tradingview')).toContain('cargando');
    expect(tvStateHint('ready')).toBeNull();
    expect(tvStateHint(null)).toBeNull();
  });
});

describe('PAINTABLE_URL', () => {
  it('acepta las páginas de futuros de Binance', () => {
    expect(PAINTABLE_URL.test('https://www.binance.com/en/futures/BTCUSDT')).toBe(true);
    expect(PAINTABLE_URL.test('https://www.binance.com/es/futures/ETHUSDT')).toBe(true);
    expect(PAINTABLE_URL.test('https://www.binance.com/futures/BTCUSDT')).toBe(true);
  });

  it('no acepta nada más', () => {
    expect(PAINTABLE_URL.test('https://www.tradingview.com/chart/')).toBe(false);
    expect(PAINTABLE_URL.test('https://www.binance.com/en/trade/BTC_USDT')).toBe(false);
    expect(PAINTABLE_URL.test('https://www.binance.com/en/my/orders')).toBe(false);
    expect(PAINTABLE_URL.test('http://www.binance.com/en/futures/BTCUSDT')).toBe(false);
    expect(PAINTABLE_URL.test('https://evil.example/binance.com/en/futures/BTCUSDT')).toBe(false);
  });
});
