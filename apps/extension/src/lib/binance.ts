import type { Candle, Timeframe } from './types';

const REST_ORIGIN = 'https://fapi.binance.com';
const WS_PRIMARY = 'wss://fstream.binance.com/market/ws';
const WS_FALLBACK = 'wss://fstream.binance.com/ws';

export function assertSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,30}$/.test(normalized)) {
    throw new Error('símbolo no válido');
  }
  return normalized;
}

export function klinesUrl(symbol: string, timeframe: Timeframe, limit = 500): string {
  const safe = assertSymbol(symbol);
  const capped = Math.min(1500, Math.max(1, Math.floor(limit)));
  const params = new URLSearchParams({
    symbol: safe,
    interval: timeframe,
    limit: String(capped),
  });
  return `${REST_ORIGIN}/fapi/v1/klines?${params.toString()}`;
}

export function klineSocketUrls(
  symbol: string,
  timeframe: Timeframe,
): { primary: string; fallback: string } {
  const stream = `${assertSymbol(symbol).toLowerCase()}@kline_${timeframe}`;
  return {
    primary: `${WS_PRIMARY}/${stream}`,
    fallback: `${WS_FALLBACK}/${stream}`,
  };
}

function numberAt(row: unknown[], index: number): number | null {
  const value = Number(row[index]);
  return Number.isFinite(value) ? value : null;
}

export function parseKlineRows(payload: unknown): Candle[] {
  if (!Array.isArray(payload)) return [];
  const byTime = new Map<number, Candle>();
  for (const item of payload) {
    if (!Array.isArray(item)) continue;
    const openTime = numberAt(item, 0);
    const open = numberAt(item, 1);
    const high = numberAt(item, 2);
    const low = numberAt(item, 3);
    const close = numberAt(item, 4);
    const volume = numberAt(item, 5);
    if (
      openTime === null ||
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      volume === null
    ) {
      continue;
    }
    const time = Math.floor(openTime / 1000);
    byTime.set(time, { time, open, high, low, close, volume });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export interface KlineEvent {
  symbol: string;
  interval: string;
  closed: boolean;
  candle: Candle;
}

export function parseKlineMessage(data: string): KlineEvent | null {
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const record = msg as { stream?: unknown; data?: unknown; e?: unknown; k?: unknown; s?: unknown };
  const body =
    record.data && typeof record.data === 'object'
      ? (record.data as { e?: unknown; k?: unknown; s?: unknown })
      : record;
  if (body.e !== 'kline' || !body.k || typeof body.k !== 'object') return null;
  const k = body.k as Record<string, unknown>;
  const openTime = Number(k.t);
  const open = Number(k.o);
  const high = Number(k.h);
  const low = Number(k.l);
  const close = Number(k.c);
  const volume = Number(k.v);
  if (![openTime, open, high, low, close, volume].every(Number.isFinite)) return null;
  const symbol = String(k.s ?? body.s ?? '').toUpperCase();
  if (!/^[A-Z0-9]{2,30}$/.test(symbol)) return null;
  return {
    symbol,
    interval: String(k.i ?? ''),
    closed: k.x === true,
    candle: {
      time: Math.floor(openTime / 1000),
      open,
      high,
      low,
      close,
      volume,
    },
  };
}
