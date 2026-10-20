// Adaptador de Binance Futures: el unico `supported` hoy.
//
// No reimplementa nada: envuelve los parsers de `page-account` que ya se
// validaron contra capturas reales (posiciones, historial y caja de cuenta).

import { parseBalance, type PageBalance } from '../page-account/parse-balance';
import { parsePositionHistory, type ClosedPosition } from '../page-account/parse-history';
import { parseOpenPositions, type PagePosition } from '../page-account/parse-positions';
import type { TextNode } from '../page-account/tree';
import type { ExchangeAdapter, ExchangeHistoryOptions } from './types';
import { hostMatches, normalizeSymbolToken, urlHost, urlPath } from './urls';

const HOSTS = ['binance.com'];

/** `https://www.binance.com/es/futures/BTCUSDC` -> `BTCUSDC`. */
function binanceSymbolFromUrl(url: string): string | null {
  const path = urlPath(url);
  if (!path) return null;
  const match = /\/futures\/([^/?#]+)/i.exec(path);
  if (!match) return null;
  const token = (match[1] ?? '').split(/[?&#]/)[0] ?? '';
  return normalizeSymbolToken(decodeURIComponent(token));
}

export const binanceAdapter: ExchangeAdapter = {
  id: 'binance',
  name: 'Binance Futures',
  status: 'supported',
  hostPatterns: ['https://www.binance.com/*/futures/*'],
  matchesUrl(url: string): boolean {
    const path = urlPath(url);
    if (!hostMatches(HOSTS, urlHost(url)) || !path) return false;
    return /\/futures\//i.test(path);
  },
  quoteAssets: ['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'USDE'],
  symbolFromUrl: binanceSymbolFromUrl,
  readers: {
    balance(root: TextNode | null | undefined): PageBalance | null {
      return parseBalance(root);
    },
    positions(root: TextNode | null | undefined): PagePosition[] {
      return parseOpenPositions(root);
    },
    history(
      root: TextNode | null | undefined,
      opts: ExchangeHistoryOptions = {},
    ): ClosedPosition[] {
      return parsePositionHistory(root, { tzOffsetMinutes: opts.tzOffsetMinutes ?? 0 });
    },
  },
  chart: 'tradingview-iframe',
};
