// Registro de exchanges.
//
// Binance es el unico `supported`: tiene lectores verificados. El resto son
// `detected`: se reconoce su URL y se saca el par, y nada mas. Un `detected`
// NO puede enseñar datos ni decir «soportado» en la UI (`adapterStatusLabel`).
//
// IMPORTANTE: esto no concede permisos. Ver `README.md` para lo que hace falta
// antes de leer la pagina de otro exchange.

import { binanceAdapter } from './binance';
import { isSupported, type ExchangeAdapter } from './types';
import { hostMatches, normalizeSymbolToken, urlHost, urlPath } from './urls';

/** Ultimo segmento del path, sin query (`/trade/usdt/BTCUSDT` -> `BTCUSDT`). */
function lastSegment(path: string): string | null {
  const parts = path.split('/').filter((part) => part !== '');
  return parts.length > 0 ? (parts[parts.length - 1] as string) : null;
}

/** Segmento de simbolo de OKX: `btc-usdt-swap` -> `BTCUSDT`. */
function okxSymbolFromUrl(url: string): string | null {
  const path = urlPath(url);
  if (!path) return null;
  const match = /\/trade-swap\/([^/?#]+)/i.exec(path);
  if (!match) return null;
  const raw = (match[1] ?? '').toLowerCase().replace(/-swap$/, '');
  return normalizeSymbolToken(raw.replace(/[-_]/g, ''));
}

/** Segmento final con separadores (`BTC-USDT`, `BTC_USDT`) -> `BTCUSDT`. */
function joinedSymbol(raw: string | null): string | null {
  return raw ? normalizeSymbolToken(raw.replace(/[-_]/g, '')) : null;
}

function hostAndPathMatcher(hosts: readonly string[], pathRe: RegExp) {
  return (url: string): boolean => {
    const path = urlPath(url);
    if (!hostMatches(hosts, urlHost(url)) || !path) return false;
    return pathRe.test(path);
  };
}

const bybitAdapter: ExchangeAdapter = {
  id: 'bybit',
  name: 'Bybit',
  status: 'detected',
  hostPatterns: ['https://www.bybit.com/trade/*'],
  matchesUrl: hostAndPathMatcher(['bybit.com'], /\/trade\//i),
  quoteAssets: ['USDT', 'USDC', 'USD'],
  symbolFromUrl(url: string): string | null {
    const path = urlPath(url);
    return path ? joinedSymbol(lastSegment(path)) : null;
  },
  chart: 'unknown',
};

const okxAdapter: ExchangeAdapter = {
  id: 'okx',
  name: 'OKX',
  status: 'detected',
  hostPatterns: ['https://www.okx.com/trade-swap/*'],
  matchesUrl: hostAndPathMatcher(['okx.com'], /\/trade-swap\//i),
  quoteAssets: ['USDT', 'USDC', 'USD'],
  symbolFromUrl: okxSymbolFromUrl,
  chart: 'unknown',
};

const bitgetAdapter: ExchangeAdapter = {
  id: 'bitget',
  name: 'Bitget',
  status: 'detected',
  hostPatterns: ['https://www.bitget.com/futures/*'],
  matchesUrl: hostAndPathMatcher(['bitget.com'], /\/futures\//i),
  quoteAssets: ['USDT', 'USDC'],
  symbolFromUrl(url: string): string | null {
    const path = urlPath(url);
    return path ? joinedSymbol(lastSegment(path)) : null;
  },
  chart: 'unknown',
};

const bingxAdapter: ExchangeAdapter = {
  id: 'bingx',
  name: 'BingX',
  status: 'detected',
  hostPatterns: ['https://bingx.com/*/perpetual/*'],
  matchesUrl: hostAndPathMatcher(['bingx.com'], /\/perpetual\//i),
  quoteAssets: ['USDT', 'USDC'],
  symbolFromUrl(url: string): string | null {
    const path = urlPath(url);
    if (!path) return null;
    const match = /\/perpetual\/([^/?#]+)/i.exec(path);
    return joinedSymbol(match ? (match[1] ?? '') : null);
  },
  chart: 'unknown',
};

const mexcAdapter: ExchangeAdapter = {
  id: 'mexc',
  name: 'MEXC Futures',
  status: 'detected',
  hostPatterns: ['https://futures.mexc.com/exchange/*'],
  matchesUrl: hostAndPathMatcher(['mexc.com'], /\/exchange\//i),
  quoteAssets: ['USDT', 'USDC'],
  symbolFromUrl(url: string): string | null {
    const path = urlPath(url);
    return path ? joinedSymbol(lastSegment(path)) : null;
  },
  chart: 'unknown',
};

const gateAdapter: ExchangeAdapter = {
  id: 'gate',
  name: 'Gate.io Futures',
  status: 'detected',
  hostPatterns: ['https://www.gate.io/futures/*'],
  matchesUrl: hostAndPathMatcher(['gate.io'], /\/futures\//i),
  quoteAssets: ['USDT', 'USDC', 'BTC', 'ETH'],
  symbolFromUrl(url: string): string | null {
    const path = urlPath(url);
    // `/futures/USDT/BTC_USDT`: el par es el ultimo segmento.
    return path ? joinedSymbol(lastSegment(path)) : null;
  },
  chart: 'unknown',
};

const kucoinAdapter: ExchangeAdapter = {
  id: 'kucoin',
  name: 'KuCoin Futures',
  status: 'detected',
  hostPatterns: ['https://www.kucoin.com/futures/trade/*'],
  matchesUrl: hostAndPathMatcher(['kucoin.com'], /\/futures\/trade\//i),
  quoteAssets: ['USDT', 'USDC'],
  // KuCoin usa su propio simbolo (`XBTUSDTM`): se conserva y se mapea despues.
  symbolFromUrl(url: string): string | null {
    const path = urlPath(url);
    return path ? normalizeSymbolToken(lastSegment(path)) : null;
  },
  chart: 'unknown',
};

const hyperliquidAdapter: ExchangeAdapter = {
  id: 'hyperliquid',
  name: 'Hyperliquid',
  status: 'detected',
  hostPatterns: ['https://app.hyperliquid.xyz/trade/*'],
  matchesUrl: hostAndPathMatcher(['hyperliquid.xyz'], /\/trade\//i),
  quoteAssets: ['USDC'],
  // La URL solo trae el activo base (`BTC`), no el par: hay que añadir el quote.
  symbolFromUrl(url: string): string | null {
    const path = urlPath(url);
    if (!path) return null;
    const match = /\/trade\/([^/?#]+)/i.exec(path);
    return match ? normalizeSymbolToken(match[1]) : null;
  },
  chart: 'unknown',
};

/** Todos los adaptadores conocidos, con Binance primero. */
export const ADAPTERS: readonly ExchangeAdapter[] = [
  binanceAdapter,
  bybitAdapter,
  okxAdapter,
  bitgetAdapter,
  bingxAdapter,
  mexcAdapter,
  gateAdapter,
  kucoinAdapter,
  hyperliquidAdapter,
];

/** Adaptador que reconoce esa URL, o null. */
export function adapterForUrl(url: string): ExchangeAdapter | null {
  for (const adapter of ADAPTERS) {
    try {
      if (adapter.matchesUrl(url)) return adapter;
    } catch {
      // Una URL rara no puede romper el panel.
    }
  }
  return null;
}

/** Solo devuelve el adaptador si ademas esta soportado (tiene lectores). */
export function supportedAdapterForUrl(url: string): ExchangeAdapter | null {
  const adapter = adapterForUrl(url);
  return isSupported(adapter) ? adapter : null;
}

/** Exchanges reconocidos pero sin lectores: la UI no debe llamarlos soportados. */
export function detectedAdapters(): ExchangeAdapter[] {
  return ADAPTERS.filter((adapter) => adapter.status === 'detected');
}

/** Texto para la UI: nunca dice «soportado» de un `detected`. */
export function adapterStatusLabel(adapter: ExchangeAdapter | null | undefined): string {
  if (isSupported(adapter)) return 'soportado';
  if (adapter?.status === 'detected') return 'detectado (sin soporte todavía)';
  return 'exchange no reconocido';
}
