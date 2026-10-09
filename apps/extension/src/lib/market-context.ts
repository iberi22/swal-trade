import { TIMEFRAMES, type MarketContext, type Timeframe } from './types';

const DEFAULT_TIMEFRAME: Timeframe = '5m';

const SUFFIXED: Record<string, Timeframe> = {
  '1m': '1m',
  '1min': '1m',
  '1minute': '1m',
  '5m': '5m',
  '5min': '5m',
  '15m': '15m',
  '15min': '15m',
  '1h': '1h',
  '1hr': '1h',
  '1hour': '1h',
  '4h': '4h',
  '4hr': '4h',
  '4hour': '4h',
  '1d': '1d',
  '1day': '1d',
  d: '1d',
};

/** Números pelados que usa TradingView en la query y en el título (`5` = 5m). */
const BARE: Record<string, Timeframe> = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '60': '1h',
  '240': '4h',
  '1440': '1d',
  d: '1d',
  '1d': '1d',
};

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === 'string' && (TIMEFRAMES as readonly string[]).includes(value);
}

/**
 * Normaliza un símbolo de futuros Binance.
 * `BINANCE:BTCUSDT.P` y `BTCUSDTPERP` quedan en `BTCUSDT`.
 * Rechaza texto que no sea un par (claves, saldos, ids de layout).
 */
export function normalizeSymbol(raw: string): string | null {
  let symbol = raw.trim().toUpperCase();
  if (!symbol || symbol.length > 80) return null;
  try {
    if (symbol.includes('%')) symbol = decodeURIComponent(symbol);
  } catch {
    return null;
  }
  if (symbol.includes(':')) {
    const parts = symbol.split(':');
    symbol = parts[parts.length - 1] ?? '';
  }
  symbol = symbol.replace(/\.P$/, '');
  if (symbol.endsWith('PERP') && symbol.length > 4) symbol = symbol.slice(0, -4);
  symbol = symbol.replace(/_/g, '');
  if (!/^[A-Z0-9]{2,30}$/.test(symbol)) return null;
  if (!/(USDT|USDC|BUSD|USD)$/.test(symbol)) return null;
  if (!/[A-Z]/.test(symbol)) return null;
  return symbol;
}

export function parseIntervalLabel(
  text: string | null | undefined,
  opts?: { bare?: boolean },
): Timeframe | null {
  if (!text) return null;
  const compact = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!compact || compact.length > 12) return null;
  if (SUFFIXED[compact]) return SUFFIXED[compact];
  if (opts?.bare && BARE[compact]) return BARE[compact];
  return null;
}

/** Primera temporalidad reconocida dentro de un título libre. */
export function intervalFromFreeText(text: string): Timeframe | null {
  const suffixed = text.match(/\b(1m|5m|15m|1h|4h|1d)\b/i);
  if (suffixed?.[1]) return parseIntervalLabel(suffixed[1]);
  const bare = text.match(/(?:^|[\s·,|/])(240|1440|60|15|5|1|1d|d)(?=$|[\s·,|/])/i);
  if (bare?.[1]) return parseIntervalLabel(bare[1], { bare: true });
  return null;
}

export function parseTradingViewTitle(title: string): {
  symbol: string | null;
  timeframe: Timeframe | null;
} {
  const match = title.toUpperCase().match(/\b([A-Z0-9]{1,24}USDT)\b/);
  return {
    symbol: match?.[1] ? normalizeSymbol(match[1]) : null,
    timeframe: intervalFromFreeText(title),
  };
}

function timeframeFromQuery(params: URLSearchParams, bare: boolean): Timeframe | null {
  for (const key of ['interval', 'timeframe', 'tf']) {
    const parsed = parseIntervalLabel(params.get(key), { bare });
    if (parsed) return parsed;
  }
  return null;
}

export function parseBinanceFuturesUrl(href: string): {
  symbol: string;
  timeframe: Timeframe | null;
} | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'www.binance.com' && host !== 'binance.com') return null;
  const match = url.pathname.match(/\/futures\/([A-Za-z0-9]{2,30})\/?$/);
  if (!match?.[1]) return null;
  const symbol = normalizeSymbol(match[1]);
  if (!symbol) return null;
  return { symbol, timeframe: timeframeFromQuery(url.searchParams, true) };
}

export function parseTradingViewUrl(href: string): {
  symbol: string | null;
  timeframe: Timeframe | null;
} | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'www.tradingview.com' && host !== 'tradingview.com') return null;
  if (!url.pathname.startsWith('/chart/')) return null;
  const symbolParam = url.searchParams.get('symbol');
  return {
    symbol: symbolParam ? normalizeSymbol(symbolParam) : null,
    timeframe: timeframeFromQuery(url.searchParams, true),
  };
}

export function detectMarketContext(input: {
  href: string;
  title?: string;
  domInterval?: string | null;
}): MarketContext | null {
  let url: URL;
  try {
    url = new URL(input.href);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === 'www.binance.com' || host === 'binance.com') {
    const parsed = parseBinanceFuturesUrl(input.href);
    if (!parsed) return null;
    // En Binance el intervalo pelado ("5") no cuenta: podría ser apalancamiento.
    const dom = parseIntervalLabel(input.domInterval, { bare: false });
    const timeframe = parsed.timeframe ?? dom;
    return {
      symbol: parsed.symbol,
      timeframe: timeframe ?? DEFAULT_TIMEFRAME,
      source: 'binance',
      timeframeInferred: timeframe === null,
    };
  }
  if (host === 'www.tradingview.com' || host === 'tradingview.com') {
    const parsed = parseTradingViewUrl(input.href);
    if (!parsed) return null;
    const title = parseTradingViewTitle(input.title ?? '');
    const dom = parseIntervalLabel(input.domInterval, { bare: true });
    const symbol = parsed.symbol ?? title.symbol;
    if (!symbol) return null;
    const timeframe = parsed.timeframe ?? dom ?? title.timeframe;
    return {
      symbol,
      timeframe: timeframe ?? DEFAULT_TIMEFRAME,
      source: 'tradingview',
      timeframeInferred: timeframe === null,
    };
  }
  return null;
}

export function isMarketContext(value: unknown): value is MarketContext {
  if (!value || typeof value !== 'object') return false;
  const ctx = value as Partial<MarketContext>;
  return (
    typeof ctx.symbol === 'string' &&
    normalizeSymbol(ctx.symbol) === ctx.symbol &&
    isTimeframe(ctx.timeframe) &&
    (ctx.source === 'binance' || ctx.source === 'tradingview') &&
    typeof ctx.timeframeInferred === 'boolean'
  );
}
