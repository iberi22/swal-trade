// READ-ONLY Binance USD-M client. HMAC-SHA256 signed GETs only.
// There is no order, cancel, transfer, or withdrawal call in this module.

import { createHmac } from "node:crypto";

import type { FetchLike } from "./types.js";
import { errorMessage, redactSecrets } from "./types.js";

export const RECV_WINDOW = "5000";

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

async function failHttp(response: Response, path: string, secrets: readonly string[]): Promise<never> {
  const body = redactSecrets((await response.text()).slice(0, 200), secrets);
  throw new Error(`HTTP ${response.status} ${path} ${body}`);
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
    let cursor = start;
    for (let page = 0; page < 10; page += 1) {
      const batch = await get("/fapi/v1/income", { startTime: cursor, limit: 1000 });
      if (!Array.isArray(batch)) throw new Error("income response is not an array");
      rows.push(...batch);
      if (batch.length < 1000) break;
      const last: unknown = batch[batch.length - 1];
      const time =
        typeof last === "object" && last !== null && "time" in last ? Number(last.time) : Number.NaN;
      if (!Number.isFinite(time)) throw new Error("income row missing time");
      cursor = time + 1;
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
