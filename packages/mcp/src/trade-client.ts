// Signed client for the write tools: HMAC-SHA256 over the same payload shape the
// read-only client uses (timestamp + recvWindow, signature last), with POST for
// orders and DELETE for cancellations.
//
// The public reads are delegated to createReadOnlyClient, so the clock offset is
// synchronized once and shared by both halves: a signed write with a stale
// timestamp is rejected by the exchange with -1021 before anything is placed.

import { createHmac, randomUUID } from "node:crypto";

import { createReadOnlyClient, RECV_WINDOW } from "./binance.js";
import type { ReadOnlyClient } from "./binance.js";
import { BinanceError, httpError } from "./errors.js";
import { errorMessage, isRecord, redactSecrets } from "./types.js";
import { ORDER_NOT_FOUND_CODE } from "./errors.js";
import type { FetchLike } from "./types.js";

export { BinanceError, isAmbiguousError, isRejectedError, newClientOrderId } from "./errors.js";

/** Binance error code for "no need to change margin type", which is not a failure. */
export const MARGIN_TYPE_ALREADY_SET = -4048;

/** Error codes that mean "this post-only order cannot rest": reprice and retry. */
const REPRICE_CODES = new Set([-5022]);
const REPRICE_MSG = /post only|would immediately match|would match|expired/i;

export function isRepriceable(err: unknown): boolean {
  if (!(err instanceof BinanceError)) return false;
  if (err.code != null && REPRICE_CODES.has(err.code)) return true;
  return REPRICE_MSG.test(err.msg) || REPRICE_MSG.test(err.message);
}

export function statusOf(order: unknown): string | null {
  if (!isRecord(order) || typeof order.status !== "string") return null;
  return order.status;
}

export type WriteParams = Record<string, string | number | boolean>;

export interface TradingClient {
  syncTime: () => Promise<number>;
  get: (path: string, params?: Record<string, string | number>) => Promise<unknown>;
  post: (path: string, params?: WriteParams) => Promise<unknown>;
  del: (path: string, params?: Record<string, string | number>) => Promise<unknown>;
  account: () => Promise<unknown>;
  positionRisk: () => Promise<unknown>;
  openAlgoOrders: () => Promise<unknown>;
  incomeSince: (start: number) => Promise<unknown[]>;
  openOrders: (symbol: string) => Promise<unknown>;
  setLeverage: (symbol: string, leverage: number) => Promise<unknown>;
  setMarginType: (symbol: string, marginType: string) => Promise<unknown>;
  placeOrder: (params: WriteParams) => Promise<unknown>;
  placeAlgoOrder: (params: WriteParams) => Promise<unknown>;
  queryOrder: (symbol: string, origClientOrderId: string) => Promise<unknown>;
  cancelOrder: (symbol: string, origClientOrderId: string) => Promise<unknown>;
  leverageBracket: (symbol: string) => Promise<unknown>;
  cancelAllOpenOrders: (symbol: string) => Promise<unknown>;
  cancelAlgoOrders: (symbol: string) => Promise<unknown>;
}

export interface TradingClientOptions {
  apiKey: string;
  apiSecret: string;
  fetchFn: FetchLike;
  base: string;
  now?: () => number;
}

function binanceError(status: number, path: string, body: string, secrets: readonly string[]): BinanceError {
  const parsed = httpError(status, path, body);
  return new BinanceError(redactSecrets(parsed.message, secrets), parsed.code, redactSecrets(parsed.msg, secrets), status);
}

export function createTradingClient(options: TradingClientOptions): TradingClient {
  const now = options.now ?? Date.now;
  const base = options.base.replace(/\/$/, "");
  const secrets = [options.apiKey, options.apiSecret];
  const reader: ReadOnlyClient = createReadOnlyClient({
    apiKey: options.apiKey,
    apiSecret: options.apiSecret,
    fetchFn: options.fetchFn,
    now,
    base,
  });

  function sign(params: Record<string, string | number>, timestamp: number): { payload: string; signed: string } {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) query.set(key, String(value));
    query.set("timestamp", String(timestamp));
    query.set("recvWindow", RECV_WINDOW);
    const payload = query.toString();
    const signature = createHmac("sha256", options.apiSecret).update(payload).digest("hex");
    return { payload, signed: `${payload}&signature=${signature}` };
  }

  async function request(method: "POST" | "DELETE", path: string, params: WriteParams, inQuery: boolean): Promise<unknown> {
    const timestamp = now() + reader.timeOffset;
    const { payload, signed } = sign(params as Record<string, string | number>, timestamp);
    const url = inQuery ? `${base}${path}?${signed}` : `${base}${path}`;
    const init: RequestInit = {
      method,
      redirect: "error",
      headers: { "X-MBX-APIKEY": options.apiKey },
    };
    if (!inQuery) {
      init.headers = { ...(init.headers as Record<string, string>), "Content-Type": "application/x-www-form-urlencoded" };
      init.body = signed;
    }
    let response: Response;
    try {
      response = await options.fetchFn(url, init);
    } catch (err) {
      throw new Error(redactSecrets(`network error ${path}: ${errorMessage(err)}`, secrets));
    }
    const body = await response.text();
    if (!response.ok) throw binanceError(response.status, path, body, secrets);
    if (!body.trim()) return {};
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error(`HTTP ${response.status} ${path} response is not JSON`);
    }
  }

  const post = (path: string, params: WriteParams = {}): Promise<unknown> => request("POST", path, params, false);
  const del = (path: string, params: Record<string, string | number> = {}): Promise<unknown> =>
    request("DELETE", path, params, true);

  return {
    syncTime: async () => reader.syncTime(),
    get: (path, params) => reader.get(path, params),
    post,
    del,
    account: () => reader.account(),
    positionRisk: () => reader.positionRisk(),
    openAlgoOrders: () => reader.openAlgoOrders(),
    incomeSince: (start) => reader.incomeSince(start),
    openOrders: (symbol) => reader.get("/fapi/v1/openOrders", { symbol }),
    setLeverage: (symbol, leverage) => post("/fapi/v1/leverage", { symbol, leverage }),
    setMarginType: (symbol, marginType) => post("/fapi/v1/marginType", { symbol, marginType }),
    placeOrder: (params) => post("/fapi/v1/order", params),
    placeAlgoOrder: (params) => post("/fapi/v1/algoOrder", params),
    queryOrder: (symbol, origClientOrderId) => reader.get("/fapi/v1/order", { symbol, origClientOrderId }),
    cancelOrder: (symbol, origClientOrderId) => del("/fapi/v1/order", { symbol, origClientOrderId }),
    leverageBracket: (symbol) => reader.get("/fapi/v1/leverageBracket", { symbol }),
    cancelAllOpenOrders: (symbol) => del("/fapi/v1/allOpenOrders", { symbol }),
    cancelAlgoOrders: (symbol) => del("/fapi/v1/algoOpenOrders", { symbol }),
  };
}
