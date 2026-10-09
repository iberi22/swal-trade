import {
  klineSocketUrls,
  klinesUrl,
  parseKlineMessage,
  parseKlineRows,
} from './binance';
import type { Candle, Timeframe } from './types';

const SOCKET_OPEN_TIMEOUT_MS = 4000;

export async function fetchKlines(
  symbol: string,
  timeframe: Timeframe,
  limit = 500,
  fetchImpl: typeof fetch = fetch,
): Promise<Candle[]> {
  const response = await fetchImpl(klinesUrl(symbol, timeframe, limit));
  const payload: unknown = await response.json();
  if (!response.ok || !Array.isArray(payload)) {
    throw new Error('klines');
  }
  return parseKlineRows(payload);
}

export interface LiveSocket {
  close(): void;
}

export function openKlineStream(
  symbol: string,
  timeframe: Timeframe,
  handlers: {
    onCandle: (candle: Candle, closed: boolean) => void;
    onLive: (live: boolean) => void;
  },
  wsFactory: (url: string) => WebSocket = (url) => new WebSocket(url),
): LiveSocket {
  const urls = klineSocketUrls(symbol, timeframe);
  let socket: WebSocket | null = null;
  let closed = false;
  let usingFallback = false;
  let openTimer: ReturnType<typeof setTimeout> | null = null;

  const clearOpenTimer = () => {
    if (openTimer !== null) {
      clearTimeout(openTimer);
      openTimer = null;
    }
  };

  const connect = (url: string) => {
    if (closed) return;
    const ws = wsFactory(url);
    socket = ws;
    openTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) ws.close();
    }, SOCKET_OPEN_TIMEOUT_MS);

    ws.onopen = () => {
      clearOpenTimer();
      handlers.onLive(true);
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const parsed = parseKlineMessage(event.data);
      if (!parsed) return;
      if (parsed.symbol !== symbol.toUpperCase() || parsed.interval !== timeframe) return;
      handlers.onCandle(parsed.candle, parsed.closed);
    };
    ws.onerror = () => {
      /* onclose hace el respaldo una sola vez */
    };
    ws.onclose = () => {
      clearOpenTimer();
      if (closed) return;
      handlers.onLive(false);
      if (!usingFallback) {
        usingFallback = true;
        connect(urls.fallback);
      }
    };
  };

  connect(urls.primary);

  return {
    close() {
      closed = true;
      clearOpenTimer();
      socket?.close();
    },
  };
}
