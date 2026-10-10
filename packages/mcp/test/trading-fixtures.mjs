// Offline Binance double for the write-tool tests.
//
// One router answers every endpoint the write path touches, records what it was
// asked, and can be told to fail a specific call. Nothing leaves the process.

import crypto from "node:crypto";

const DEFAULT_FILTERS = {
  BTCUSDT: { stepSize: "0.001", minQty: "0.001", tickSize: "0.1", minNotional: "5" },
};

export function exchangeInfoBody(symbols = DEFAULT_FILTERS) {
  return {
    symbols: Object.entries(symbols).map(([symbol, filters]) => ({
      symbol,
      filters: [
        { filterType: "LOT_SIZE", stepSize: filters.stepSize, minQty: filters.minQty, maxQty: "1000" },
        { filterType: "PRICE_FILTER", tickSize: filters.tickSize },
        { filterType: "MIN_NOTIONAL", notional: filters.minNotional },
      ],
    })),
  };
}

export function makeExchange(options = {}) {
  const {
    symbols = DEFAULT_FILTERS,
    markPrice = "100000",
    book = { bidPrice: "99999.9", askPrice: "100000.1" },
    positions = [],
    positionsAfterOrder = [],
    income = [],
    algoOrders = [],
    orderStatus = "NEW",
    orderFailures = [],
    algoFailures = [],
    marginTypeFailures = [],
    closeFailures = [],
  } = options;

  const calls = [];
  const orderCounts = new Map();
  const failFor = (list, kind) => {
    const key = String(kind);
    const seen = orderCounts.get(key) ?? 0;
    orderCounts.set(key, seen + 1);
    return list[seen] ?? null;
  };

  const json = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });

  const fetchFn = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? init.body : "";
    const params = new URLSearchParams(method === "POST" ? body : url.search);
    calls.push({ method, path, url: String(input), params: Object.fromEntries(params), signed: body.length > 0 });

    if (path === "/fapi/v1/time") return json({ serverTime: 1_700_000_000_000 });
    if (path === "/fapi/v1/exchangeInfo") return json(exchangeInfoBody(symbols));
    if (path === "/fapi/v1/premiumIndex") return json({ symbol: params.get("symbol"), markPrice });
    if (path === "/fapi/v1/ticker/bookTicker") return json({ ...book, symbol: params.get("symbol") });

    if (path === "/fapi/v3/account") return json({ positions });
    if (path === "/fapi/v2/positionRisk") {
      const seen = calls.some((call) => call.method === "POST" && call.path === "/fapi/v1/order");
      return json(seen ? [...positions, ...positionsAfterOrder] : positions);
    }
    if (path === "/fapi/v1/openAlgoOrders") return json(algoOrders);
    if (path === "/fapi/v1/income") return json(income);
    if (path === "/fapi/v1/openOrders") return json([]);

    if (path === "/fapi/v1/leverage") return json({ leverage: Number(params.get("leverage")), symbol: params.get("symbol") });
    if (path === "/fapi/v1/marginType") {
      const failure = failFor(marginTypeFailures, "marginType");
      if (failure) return json({ code: failure.code, msg: failure.msg }, 400);
      return json({ code: 200, msg: "success" });
    }
    if (path === "/fapi/v1/order") {
      const failure = failFor(orderFailures, "order");
      if (failure) return json({ code: failure.code, msg: failure.msg }, 400);
      const type = params.get("type");
      // closeFailures stand for "the reduceOnly close fails", so they only apply
      // once an entry order has already been sent.
      if (type === "MARKET" && (orderCounts.get("order") ?? 0) > 1 && failFor(closeFailures, "close")) {
        return json({ code: -2010, msg: "insufficient balance" }, 400);
      }
      return json({
        symbol: params.get("symbol"),
        side: params.get("side"),
        type,
        status: type === "MARKET" ? "FILLED" : orderStatus,
        executedQty: params.get("quantity"),
        quantity: params.get("quantity"),
        avgPrice: params.get("price") ?? markPrice,
        price: params.get("price"),
        stopPrice: params.get("stopPrice") ?? params.get("price"),
        timeInForce: params.get("timeInForce"),
        reduceOnly: params.get("reduceOnly"),
        orderId: 1000 + calls.length,
        clientOrderId: `test-${calls.length}`,
      });
    }
    if (path === "/fapi/v1/algoOrder") {
      const failure = failFor(algoFailures, "algo");
      if (failure) return json({ code: failure.code, msg: failure.msg }, 400);
      return json({ algoId: 5000 + calls.length, symbol: params.get("symbol"), status: "NEW" });
    }
    if (path === "/fapi/v1/allOpenOrders" && method === "DELETE") return json({ code: 200, msg: "cancelled" });
    if (path === "/fapi/v1/algoOpenOrders" && method === "DELETE") return json({ code: 200, msg: "cancelled" });

    return json({ code: -1121, msg: `unexpected ${method} ${path}` }, 400);
  };

  return {
    fetchFn,
    calls,
    post: (path) => calls.filter((call) => call.method === "POST" && call.path === path),
    paths: () => calls.map((call) => `${call.method} ${call.path}`),
  };
}

export const TRADE_SECRET = "supersecretvalue";
export const TRADE_KEY = "AK-trade-key";
export const TEST_JOURNAL = "/tmp/swal-trade-test-journal.jsonl";

/** A configuration that passes every rule. */
export function tradeEnv(extra = {}) {
  return {
    BINANCE_API_KEY: TRADE_KEY,
    BINANCE_API_SECRET: TRADE_SECRET,
    SWAL_MCP_TRADING: "enabled",
    SWAL_MCP_SYMBOLS: "BTCUSDT,ETHUSDT",
    SWAL_MAX_NOTIONAL_USD: "1000",
    SWAL_MAX_LEVERAGE: "5",
    SWAL_MCP_MAX_POSITIONS: "1",
    SWAL_DAILY_LOSS_USD: "100",
    SWAL_TZ_OFFSET_HOURS: "0",
    SWAL_MCP_JOURNAL: TEST_JOURNAL,
    ...extra,
  };
}

/** Verifies the HMAC signature of a recorded call. */
export function signatureOf(call) {
  const raw = call.signed ? call.params : new URLSearchParams(new URL(call.url).search);
  const signature = raw.get("signature");
  const payload = [...raw.entries()]
    .filter(([key]) => key !== "signature")
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return { signature, payload };
}

export function signatureMatches(call, secret) {
  const { signature, payload } = signatureOf(call);
  return signature === crypto.createHmac("sha256", secret).update(payload).digest("hex");
}
