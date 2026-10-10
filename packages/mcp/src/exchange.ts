// Public, unsigned reads used by the write tools.
//
// exchangeInfo and the book ticker carry no account data, so they are fetched
// without a key: the key is only used for the signed calls in trade-client.ts.

import { isRecord } from "./types.js";
import type { FetchLike } from "./types.js";
import { errorMessage, stripUrls } from "./types.js";
import type { ConfigResult } from "./config.js";
import { floorToStep } from "./decimal.js";

export interface SymbolFilters {
  symbol: string;
  /** Quantity step, decimal string, for example "0.001". */
  stepSize: string;
  /** Minimum quantity, decimal string. */
  minQty: string;
  /** Price tick, decimal string, for example "0.1". */
  tickSize: string;
  /** Minimum order notional in USD; "0" when the exchange publishes none. */
  minNotional: string;
}

export interface BookTicker {
  bidPrice: string;
  askPrice: string;
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

function endpoint(base: string, path: string): URL {
  const root = base.endsWith("/") ? base : `${base}/`;
  return new URL(path.replace(/^\//, ""), root);
}

function decimalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (floorToStep("1", value) == null) return null;
  return value;
}

/**
 * Pulls the LOT_SIZE, PRICE_FILTER and MIN_NOTIONAL filters of one symbol out of
 * exchangeInfo. Any of them missing is an error rather than a guess: the guard
 * and the rounding need them, and a made-up step would send an order the
 * exchange rejects or, worse, one of the wrong size.
 */
export function parseExchangeInfo(body: unknown, symbol: string): ConfigResult<SymbolFilters> {
  if (!isRecord(body) || !Array.isArray(body.symbols)) {
    return { ok: false, error: "exchangeInfo response is not an object with a symbols array" };
  }
  const rows = body.symbols.filter(isRecord);
  const row = rows.find((entry) => typeof entry.symbol === "string" && entry.symbol.toUpperCase() === symbol);
  if (!row) return { ok: false, error: `exchangeInfo has no entry for ${symbol}.` };
  const filters = Array.isArray(row.filters) ? row.filters.filter(isRecord) : [];
  const of = (type: string) => filters.find((entry) => entry.filterType === type);
  const lot = of("LOT_SIZE");
  const price = of("PRICE_FILTER");
  const notional = of("MIN_NOTIONAL") ?? of("NOTIONAL");
  const stepSize = decimalString(lot?.stepSize);
  const minQty = decimalString(lot?.minQty);
  const tickSize = decimalString(price?.tickSize);
  if (!stepSize || !minQty) {
    return { ok: false, error: `exchangeInfo for ${symbol} is missing a usable LOT_SIZE (stepSize/minQty).` };
  }
  if (!tickSize) return { ok: false, error: `exchangeInfo for ${symbol} is missing a usable PRICE_FILTER tickSize.` };
  const minNotional = decimalString(notional?.notional) ?? "0";
  return { ok: true, value: { symbol, stepSize, minQty, tickSize, minNotional } };
}

export async function fetchSymbolFilters(base: string, symbol: string, fetchFn: FetchLike): Promise<ConfigResult<SymbolFilters>> {
  const url = endpoint(base, "/fapi/v1/exchangeInfo");
  url.searchParams.set("symbol", symbol);
  try {
    const body = await getJson(fetchFn, url, "/fapi/v1/exchangeInfo");
    return parseExchangeInfo(body, symbol);
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function fetchBookTicker(base: string, symbol: string, fetchFn: FetchLike): Promise<ConfigResult<BookTicker>> {
  const url = endpoint(base, "/fapi/v1/ticker/bookTicker");
  url.searchParams.set("symbol", symbol);
  try {
    const body = await getJson(fetchFn, url, "/fapi/v1/ticker/bookTicker");
    if (!isRecord(body)) return { ok: false, error: "bookTicker response is not an object" };
    const bid = decimalString(body.bidPrice);
    const ask = decimalString(body.askPrice);
    if (!bid || !ask) return { ok: false, error: "bookTicker response is missing bidPrice/askPrice" };
    return { ok: true, value: { bidPrice: bid, askPrice: ask } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
