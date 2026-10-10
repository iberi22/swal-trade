// READ-ONLY Binance USD-M client. HMAC-SHA256 signed GETs only.
// There is no order, cancel, transfer, or withdrawal call in this module.

import { createHmac } from "node:crypto";

import { BinanceError, httpError } from "./errors.js";
import type { FetchLike } from "./types.js";
import { errorMessage, redactSecrets } from "./types.js";

export { BinanceError };

export const RECV_WINDOW = "5000";

/** Maximum income pages (1000 rows each) before the day cannot be summed. */
export const MAX_INCOME_PAGES = 50;

export class IncompleteIncomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteIncomeError";
  }
}

export interface ReadOnlyClientOptions {
  apiKey: string;
  apiSecret: string;
  fetchFn: FetchLike;
  now?: () => number;
  base?: string;
}

export interface ReadOnlyClient {
  syncTime: () => Promise<number>;
  get: (path: string, params?: Record<string, string | number>) => Promise<unknown>;
  incomeSince: (start: number) => Promise<unknown[]>;
  account: () => Promise<unknown>;
  positionRisk: () => Promise<unknown>;
  openAlgoOrders: () => Promise<unknown>;
  readonly timeOffset: number;
}

/** Income rows carry a tranId on the futures API: the only safe dedupe key. */
function tranIdOf(row: unknown): number | null {
  if (typeof row !== "object" || row === null) return null;
  const value = (row as Record<string, unknown>).tranId;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

async function failHttp(response: Response, path: string, secrets: readonly string[]): Promise<never> {
  const body = (await response.text()).slice(0, 200);
  const parsed = httpError(response.status, path, body);
  throw new BinanceError(redactSecrets(parsed.message, secrets), parsed.code, redactSecrets(parsed.msg, secrets), response.status);
}

export function createReadOnlyClient(options: ReadOnlyClientOptions): ReadOnlyClient {
  const fetchFn = options.fetchFn;
  const now = options.now ?? Date.now;
  const base = (options.base ?? "https://fapi.binance.com").replace(/\/$/, "");
  const secrets = [options.apiKey, options.apiSecret];
  let offset = 0;

  async function request(urlPath: string, errorPath: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchFn(`${base}${urlPath}`, init);
    } catch (err) {
      throw new Error(redactSecrets(`network error ${errorPath}: ${errorMessage(err)}`, secrets));
    }
  }

  async function syncTime(): Promise<number> {
    const t0 = now();
    const response = await request("/fapi/v1/time", "/fapi/v1/time", { method: "GET", redirect: "error" });
    if (!response.ok) await failHttp(response, "/fapi/v1/time", secrets);
    const body: unknown = await response.json();
    const serverTime =
      typeof body === "object" && body !== null && "serverTime" in body ? Number(body.serverTime) : Number.NaN;
    if (!Number.isFinite(serverTime)) throw new Error("server time missing");
    offset = serverTime - Math.round((t0 + now()) / 2);
    return offset;
  }

  async function get(path: string, params: Record<string, string | number> = {}): Promise<unknown> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) query.set(key, String(value));
    query.set("timestamp", String(now() + offset));
    query.set("recvWindow", RECV_WINDOW);
    const payload = query.toString();
    const signature = createHmac("sha256", options.apiSecret).update(payload).digest("hex");
    const response = await request(`${path}?${payload}&signature=${signature}`, path, {
      method: "GET",
      redirect: "error",
      headers: { "X-MBX-APIKEY": options.apiKey },
    });
    if (!response.ok) await failHttp(response, path, secrets);
    return response.json() as Promise<unknown>;
  }

  async function incomeSince(start: number): Promise<unknown[]> {
    const rows: unknown[] = [];
    const seen = new Set<string>();
    let cursor = start;
    let fromId: number | null = null;
    for (let page = 0; page < MAX_INCOME_PAGES; page += 1) {
      const params: Record<string, string | number> = { startTime: cursor, limit: 1000 };
      if (fromId != null) params.fromId = fromId;
      const batch = await get("/fapi/v1/income", params);
      if (!Array.isArray(batch)) throw new Error("income response is not an array");
      let added = 0;
      for (const row of batch) {
        const key = tranIdOf(row);
        if (key != null) {
          if (seen.has(key)) continue; // the cursor is inclusive: same row twice, counted once
          seen.add(key);
        }
        rows.push(row);
        added += 1;
      }
      // A short page is the exchange saying "that was the last one": completeness
      // is proven, not assumed.
      if (batch.length < 1000) break;
      const last: unknown = batch[batch.length - 1];
      const time = isRecord(last) ? Number(last.time) : Number.NaN;
      const lastId = tranIdOf(last);
      if (!Number.isFinite(time)) {
        throw new IncompleteIncomeError("the income page is full and its last row has no time: the day cannot be summed exactly");
      }
      if (added === 0) {
        throw new IncompleteIncomeError("the income pagination cannot advance past the same rows: the day cannot be summed exactly");
      }
      if (lastId == null) {
        throw new IncompleteIncomeError(
          "the income page is full and its rows have no tranId, so a timestamp cursor could skip rows with the same time: the day cannot be summed exactly",
        );
      }
      cursor = time;
      fromId = lastId + 1;
    }
    return rows;
  }

  return {
    syncTime,
    get,
    incomeSince,
    account: () => get("/fapi/v3/account"),
    positionRisk: () => get("/fapi/v2/positionRisk"),
    openAlgoOrders: () => get("/fapi/v1/openAlgoOrders"),
    get timeOffset() {
      return offset;
    },
  };
}
