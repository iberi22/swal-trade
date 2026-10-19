import { assertSymbol, parseKlineRows } from '../binance';
import {
  documentVisibility,
  fetchFearGreed,
  type PulseCache,
  type PulseVisibility,
} from '../market-pulse';
import type { Candle, FearGreed } from '../types';

/**
 * Datos públicos para la banda de contexto: funding/basis (premiumIndex),
 * cambio 24h (ticker) y velas 1d/1w/1h/4h para el mapa de niveles. Todo de
 * solo lectura y sin clave. Ningún fallo lanza hacia el panel: se devuelve null.
 */

const REST_ORIGIN = 'https://fapi.binance.com';

export const MARKET_REFRESH_MS = 30_000;
export const CANDLES_REFRESH_MS = 5 * 60_000;

export type ContextInterval = '1h' | '4h' | '1d' | '1w';

export interface Premium {
  lastFundingRate: number;
  nextFundingTime: number;
  markPrice: number;
  indexPrice: number;
}

export interface Ticker24h {
  priceChangePercent: number;
}

export interface LevelCandles {
  d1: Candle[];
  w1: Candle[];
  h1: Candle[];
  h4: Candle[];
}

export function premiumUrl(symbol: string): string {
  return `${REST_ORIGIN}/fapi/v1/premiumIndex?symbol=${assertSymbol(symbol)}`;
}

export function ticker24hUrl(symbol: string): string {
  return `${REST_ORIGIN}/fapi/v1/ticker/24hr?symbol=${assertSymbol(symbol)}`;
}

export function contextKlinesUrl(symbol: string, interval: ContextInterval, limit: number): string {
  const params = new URLSearchParams({
    symbol: assertSymbol(symbol),
    interval,
    limit: String(Math.min(1500, Math.max(1, Math.floor(limit)))),
  });
  return `${REST_ORIGIN}/fapi/v1/klines?${params.toString()}`;
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) return null;
  return response.json();
}

const num = (value: unknown): number => (value === null || value === '' ? Number.NaN : Number(value));

export function parsePremium(payload: unknown): Premium | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  const lastFundingRate = num(row.lastFundingRate);
  const markPrice = num(row.markPrice);
  const indexPrice = num(row.indexPrice);
  const nextFundingTime = num(row.nextFundingTime);
  if (!Number.isFinite(lastFundingRate) || !Number.isFinite(markPrice) || !Number.isFinite(indexPrice)) {
    return null;
  }
  return {
    lastFundingRate,
    markPrice,
    indexPrice,
    nextFundingTime: Number.isFinite(nextFundingTime) ? nextFundingTime : 0,
  };
}

export async function fetchPremium(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Premium | null> {
  try {
    return parsePremium(await getJson(premiumUrl(symbol), fetchImpl));
  } catch {
    return null;
  }
}

export async function fetchTicker24h(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Ticker24h | null> {
  try {
    const payload = await getJson(ticker24hUrl(symbol), fetchImpl);
    if (!payload || typeof payload !== 'object') return null;
    const priceChangePercent = num((payload as Record<string, unknown>).priceChangePercent);
    return Number.isFinite(priceChangePercent) ? { priceChangePercent } : null;
  } catch {
    return null;
  }
}

async function fetchSeries(
  symbol: string,
  interval: ContextInterval,
  limit: number,
  fetchImpl: typeof fetch,
): Promise<Candle[]> {
  try {
    const payload = await getJson(contextKlinesUrl(symbol, interval, limit), fetchImpl);
    return Array.isArray(payload) ? parseKlineRows(payload) : [];
  } catch {
    return [];
  }
}

/** 1d x 40, 1w x 8, 1h x 120, 4h x 100. null si ninguna serie llegó. */
export async function fetchLevelCandles(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LevelCandles | null> {
  try {
    assertSymbol(symbol);
  } catch {
    return null;
  }
  const [d1, w1, h1, h4] = await Promise.all([
    fetchSeries(symbol, '1d', 40, fetchImpl),
    fetchSeries(symbol, '1w', 8, fetchImpl),
    fetchSeries(symbol, '1h', 120, fetchImpl),
    fetchSeries(symbol, '4h', 100, fetchImpl),
  ]);
  if (!d1.length && !w1.length && !h1.length && !h4.length) return null;
  return { d1, w1, h1, h4 };
}

export interface ContextSnapshot {
  symbol: string;
  fearGreed: FearGreed | null;
  premium: Premium | null;
  ticker: Ticker24h | null;
  candles: LevelCandles | null;
  /** Qué partes ya terminaron su primera petición (con éxito o sin él). */
  ready: { fearGreed: boolean; market: boolean; candles: boolean };
}

export interface ContextFeedOptions {
  onChange: (snapshot: ContextSnapshot) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  cache?: PulseCache | null;
  visibility?: PulseVisibility;
  marketRefreshMs?: number;
  candlesRefreshMs?: number;
}

export interface ContextFeedHandle {
  stop(): void;
}

/**
 * Arranca la alimentación de datos para un símbolo. Con el panel oculto se
 * paran los sondeos; al volver se refresca de inmediato.
 */
export function startContextFeed(symbol: string, options: ContextFeedOptions): ContextFeedHandle {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const visibility = options.visibility ?? documentVisibility();
  const marketMs = Math.max(10_000, options.marketRefreshMs ?? MARKET_REFRESH_MS);
  const candlesMs = Math.max(60_000, options.candlesRefreshMs ?? CANDLES_REFRESH_MS);

  const state: ContextSnapshot = {
    symbol,
    fearGreed: null,
    premium: null,
    ticker: null,
    candles: null,
    ready: { fearGreed: false, market: false, candles: false },
  };
  let alive = true;
  let marketTimer: ReturnType<typeof setInterval> | null = null;
  let candlesTimer: ReturnType<typeof setInterval> | null = null;

  const emit = () => {
    if (alive) options.onChange({ ...state, ready: { ...state.ready } });
  };

  const refreshMarket = async () => {
    const [premium, ticker] = await Promise.all([
      fetchPremium(symbol, fetchImpl),
      fetchTicker24h(symbol, fetchImpl),
    ]);
    if (!alive) return;
    state.premium = premium;
    state.ticker = ticker;
    state.ready.market = true;
    emit();
  };

  const refreshCandles = async () => {
    const candles = await fetchLevelCandles(symbol, fetchImpl);
    if (!alive) return;
    state.candles = candles;
    state.ready.candles = true;
    emit();
  };

  const refreshFearGreed = async () => {
    const fearGreed = await fetchFearGreed({ fetchImpl, cache: options.cache ?? null, nowMs: now() });
    if (!alive) return;
    state.fearGreed = fearGreed;
    state.ready.fearGreed = true;
    emit();
  };

  const applyVisibility = () => {
    if (!alive) return;
    if (visibility.current()) {
      if (marketTimer !== null) return;
      void refreshMarket();
      void refreshCandles();
      void refreshFearGreed();
      marketTimer = setInterval(() => void refreshMarket(), marketMs);
      candlesTimer = setInterval(() => {
        void refreshCandles();
        void refreshFearGreed();
      }, candlesMs);
    } else {
      if (marketTimer !== null) clearInterval(marketTimer);
      if (candlesTimer !== null) clearInterval(candlesTimer);
      marketTimer = null;
      candlesTimer = null;
    }
  };

  try {
    assertSymbol(symbol);
  } catch {
    state.ready = { fearGreed: true, market: true, candles: true };
    emit();
    return { stop() { alive = false; } };
  }

  const unsubscribe = visibility.subscribe(applyVisibility);
  applyVisibility();

  return {
    stop() {
      alive = false;
      if (marketTimer !== null) clearInterval(marketTimer);
      if (candlesTimer !== null) clearInterval(candlesTimer);
      marketTimer = null;
      candlesTimer = null;
      unsubscribe();
    },
  };
}
