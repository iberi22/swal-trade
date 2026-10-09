import type { Candle, FetchLike } from "./types.js";
import { errorMessage, isRecord, stripUrls } from "./types.js";

export const ANALYZE_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type AnalyzeTimeframe = (typeof ANALYZE_TIMEFRAMES)[number];

export const MARKET_TIMEFRAMES = ["1m", "5m", "1h", "4h"] as const;
export type MarketTimeframe = (typeof MARKET_TIMEFRAMES)[number];

export const DEFAULT_KLINE_LIMIT = 200;
export const MAX_KLINE_LIMIT = 1500;
export const MARKET_KLINE_LIMIT = 120;

export const FNG_URL = "https://api.alternative.me/fng/";
export const FNG_TTL_MS = 60 * 60 * 1000;
export const NEWS_NOTE = "requires local backend news source or Socio SWAL";

export interface FearGreed {
  value: number;
  classification: string;
  timestamp: number;
  source: string;
}

export interface FearGreedCache {
  get: (fetchFn: FetchLike, now: () => number) => Promise<FearGreed>;
}

interface KlineFetch {
  base: string;
  symbol: string;
  timeframe: string;
  limit: number;
  fetchFn: FetchLike;
}

function endpoint(base: string, path: string): URL {
  const root = base.endsWith("/") ? base : `${base}/`;
  return new URL(path.replace(/^\//, ""), root);
}

async function getJson(fetchFn: FetchLike, url: URL, label: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, { method: "GET", redirect: "error" });
  } catch (err) {
    throw new Error(`network error ${label}: ${stripUrls(errorMessage(err))}`);
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(`HTTP ${response.status} ${label} ${body}`);
  }
  return response.json() as Promise<unknown>;
}

export function candleFromKline(row: unknown): Candle {
  if (!Array.isArray(row) || row.length < 6) throw new Error("kline row is too short");
  const timeMs = Number(row[0]);
  const candle: Candle = {
    time: Math.floor(timeMs / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
  if (!Number.isFinite(candle.time) || !Number.isFinite(candle.close)) throw new Error("kline row is not numeric");
  return candle;
}

export async function fetchCandles(input: KlineFetch): Promise<Candle[]> {
  const url = endpoint(input.base, "/fapi/v1/klines");
  url.searchParams.set("symbol", input.symbol);
  url.searchParams.set("interval", input.timeframe);
  url.searchParams.set("limit", String(input.limit));
  const body = await getJson(input.fetchFn, url, "/fapi/v1/klines");
  if (!Array.isArray(body)) throw new Error("klines response is not an array");
  return body.map((row) => candleFromKline(row));
}

export async function fetchMarkPrice(base: string, symbol: string, fetchFn: FetchLike): Promise<number> {
  const url = endpoint(base, "/fapi/v1/premiumIndex");
  url.searchParams.set("symbol", symbol);
  const body = await getJson(fetchFn, url, "/fapi/v1/premiumIndex");
  const mark = isRecord(body) ? Number(body.markPrice) : Number.NaN;
  if (!(mark > 0) || !Number.isFinite(mark)) throw new Error("mark price missing");
  return mark;
}

export function createFearGreedCache(): FearGreedCache {
  let entry: { at: number; data: FearGreed } | null = null;
  return {
    async get(fetchFn, now) {
      const at = now();
      if (entry && at - entry.at < FNG_TTL_MS) return entry.data;
      const body = await getJson(fetchFn, new URL(FNG_URL), "/fng/");
      const row = isRecord(body) && Array.isArray(body.data) ? body.data[0] : undefined;
      if (!isRecord(row)) throw new Error("fear and greed response missing data");
      const value = Number(row.value);
      if (!Number.isFinite(value)) throw new Error("fear and greed value is not numeric");
      const data: FearGreed = {
        value,
        classification: typeof row.value_classification === "string" ? row.value_classification : "",
        timestamp: Number(row.timestamp),
        source: FNG_URL,
      };
      entry = { at, data };
      return data;
    },
  };
}
