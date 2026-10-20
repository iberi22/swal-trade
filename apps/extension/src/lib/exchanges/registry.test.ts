import { describe, expect, it } from 'vitest';
import { binanceAdapter } from './binance';
import {
  ADAPTERS,
  adapterForUrl,
  adapterStatusLabel,
  detectedAdapters,
  supportedAdapterForUrl,
} from './registry';
import { isSupported } from './types';

describe('adapterForUrl (reconocer la pagina)', () => {
  const cases: Array<{ url: string; id: string; symbol: string }> = [
    { url: 'https://www.binance.com/es/futures/BTCUSDC', id: 'binance', symbol: 'BTCUSDC' },
    { url: 'https://www.bybit.com/trade/usdt/BTCUSDT', id: 'bybit', symbol: 'BTCUSDT' },
    { url: 'https://www.okx.com/trade-swap/btc-usdt-swap', id: 'okx', symbol: 'BTCUSDT' },
    { url: 'https://www.bitget.com/futures/usdt/BTCUSDT', id: 'bitget', symbol: 'BTCUSDT' },
    { url: 'https://bingx.com/en/perpetual/BTC-USDT/', id: 'bingx', symbol: 'BTCUSDT' },
    { url: 'https://futures.mexc.com/exchange/BTC_USDT', id: 'mexc', symbol: 'BTCUSDT' },
    { url: 'https://www.gate.io/futures/USDT/BTC_USDT', id: 'gate', symbol: 'BTCUSDT' },
    { url: 'https://www.kucoin.com/futures/trade/XBTUSDTM', id: 'kucoin', symbol: 'XBTUSDTM' },
    // Hyperliquid solo pone el activo base en la URL: el quote se añade despues.
    { url: 'https://app.hyperliquid.xyz/trade/BTC', id: 'hyperliquid', symbol: 'BTC' },
  ];

  for (const { url, id, symbol } of cases) {
    it(`reconoce ${url} como ${id}`, () => {
      const adapter = adapterForUrl(url);
      expect(adapter).not.toBeNull();
      expect(adapter?.id).toBe(id);
      expect(adapter?.symbolFromUrl(url)).toBe(symbol);
    });
  }

  it('no reconoce una pagina que no es de exchange', () => {
    expect(adapterForUrl('https://example.com/futures/BTCUSDT')).toBeNull();
    expect(adapterForUrl('https://www.binance.com/es/markets')).toBeNull();
    expect(adapterForUrl('no es una url')).toBeNull();
    expect(adapterForUrl('')).toBeNull();
  });

  it('no confunde un subdominio ajeno con el exchange', () => {
    expect(adapterForUrl('https://bybit.com.evil.test/trade/usdt/BTCUSDT')).toBeNull();
    expect(adapterForUrl('https://www.binance.com.evil.test/es/futures/BTCUSDC')).toBeNull();
  });

  it('tolera URLs raras sin lanzar', () => {
    expect(() => adapterForUrl('https://[::1')).not.toThrow();
    expect(adapterForUrl('https://[::1')).toBeNull();
  });
});

describe('estado de los adaptadores', () => {
  it('solo Binance esta soportado y tiene lectores', () => {
    const supported = ADAPTERS.filter((adapter) => adapter.status === 'supported');
    expect(supported.map((adapter) => adapter.id)).toEqual(['binance']);
    expect(binanceAdapter.readers).toBeDefined();
    expect(isSupported(binanceAdapter)).toBe(true);
  });

  it('un adaptador detectado nunca tiene lectores', () => {
    for (const adapter of detectedAdapters()) {
      expect(adapter.readers).toBeUndefined();
      expect(isSupported(adapter)).toBe(false);
    }
    // Los detectados son todos menos Binance.
    expect(detectedAdapters()).toHaveLength(ADAPTERS.length - 1);
  });

  it('supportedAdapterForUrl solo devuelve el de Binance', () => {
    expect(supportedAdapterForUrl('https://www.binance.com/es/futures/BTCUSDC')?.id).toBe('binance');
    // Reconocido pero sin lectores: no se puede tratar como soportado.
    expect(supportedAdapterForUrl('https://www.bybit.com/trade/usdt/BTCUSDT')).toBeNull();
    expect(supportedAdapterForUrl('https://example.com')).toBeNull();
  });

  it('adapterStatusLabel nunca dice soportado de un detectado', () => {
    const bybit = adapterForUrl('https://www.bybit.com/trade/usdt/BTCUSDT');
    expect(bybit).not.toBeNull();
    const label = adapterStatusLabel(bybit);
    expect(label).not.toContain('soportado');
    expect(label).toContain('detectado');
    expect(adapterStatusLabel(binanceAdapter)).toBe('soportado');
    expect(adapterStatusLabel(null)).toBe('exchange no reconocido');
    expect(adapterStatusLabel(undefined)).toBe('exchange no reconocido');
  });

  it('cada adaptador declara los activos de cotizacion que usa', () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.quoteAssets.length).toBeGreaterThan(0);
      for (const asset of adapter.quoteAssets) expect(asset).toMatch(/^[A-Z]{3,6}$/);
    }
    // Hyperliquid liquida en USDC.
    expect(adapterForUrl('https://app.hyperliquid.xyz/trade/BTC')?.quoteAssets).toContain('USDC');
  });
});
