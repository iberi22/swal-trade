// Offline Binance double for the write-tool tests.
//
// One router answers every endpoint the write path touches, records what it was
// asked, and can be told to fail a specific call. Nothing leaves the process.

import crypto from "node:crypto";

const DEFAULT_FILTERS = {
  BTCUSDT: { stepSize: "0.001", minQty: "0.001", tickSize: "0.1", minNotional: "5" },
  ETHUSDT: { stepSize: "0.001", minQty: "0.001", tickSize: "0.1", minNotional: "5" },
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
    orderExecutedQty = "0",
    orderFailures = [],
    algoFailures = [],
    marginTypeFailures = [],
    closeFailures = [],
    /** Answer an algo order with no algoId: the exchange has no order. */
    algoNoId = false,
    /** Answer an algo order with no triggerPrice: nothing for it to fire on. */
    algoNoTrigger = false,
    /** Per-attempt overrides of the algo answer body, keyed by 1-based attempt. */
    algoAnswers = {},
    /** Working orders of the symbol, for the notional cap (item 8). */
    openOrders = [],
    /** Maintenance margin ratio the leverage bracket reports. */
    maintenanceMarginRatio = "0.004",
    /** Amounts each reduceOnly close leaves behind, in order; past the end it is zero. */
    closeReducesTo = {},
    /** Attempt numbers (1-based) whose POST /fapi/v1/order times out instead of answering. */
    networkErrorOnOrder = [],
    /** What the MARKET entry fills at and for how much, when it differs from the request. */
    marketFill = null,
    /** Answer for GET /fapi/v1/order (the lookup by origClientOrderId). */
    queryOrder = null,
  } = options;

  const calls = [];
  const orderCounts = new Map();
  /** Symbols whose position a reduceOnly order has already reduced to zero. */
  const reducedSymbols = new Set();
  /** Symbol -> how many reduceOnly closes it has already taken. */
  const closeCounts = new Map();
  /** Symbol -> the amounts its reduceOnly closes leave behind, in order. */
  const remainderQueue = new Map();
  /** Symbol -> the positionAmt the reader currently sees, once a close left a remainder. */
  const closeRemainder = new Map();
  for (const [symbol, remainders] of Object.entries(closeReducesTo)) {
    remainderQueue.set(symbol, Array.isArray(remainders) ? remainders : [remainders]);
  }
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
      const opened = calls.some((call) => call.method === "POST" && call.path === "/fapi/v1/order");
      const after = opened ? positionsAfterOrder : [];
      const rows = [...positions, ...after]
        .filter((row) => !reducedSymbols.has(row.symbol))
        .map((row) => (closeRemainder.has(row.symbol) ? { ...row, positionAmt: closeRemainder.get(row.symbol) } : row));
      return json(rows);
    }
    if (path === "/fapi/v1/openAlgoOrders") return json(algoOrders);
    if (path === "/fapi/v1/income") return json(income);
    if (path === "/fapi/v1/leverageBracket") {
      return json([
        { symbol: params.get("symbol"), brackets: [{ bracket: 1, initialMarginRate: "0.2", maintMarginRatio: maintenanceMarginRatio, cum: "0" }] },
      ]);
    }
    if (path === "/fapi/v1/openOrders") return json(openOrders);

    if (path === "/fapi/v1/leverage") return json({ leverage: Number(params.get("leverage")), symbol: params.get("symbol") });
    if (path === "/fapi/v1/marginType") {
      const failure = failFor(marginTypeFailures, "marginType");
      if (failure) return json({ code: failure.code, msg: failure.msg }, 400);
      return json({ code: 200, msg: "success" });
    }
    if (path === "/fapi/v1/order" && method === "GET") {
      // The lookup by origClientOrderId: the only way to resolve an ambiguous
      // entry answer, and the thing a timeout could never tell us.
      const answer = queryOrder ?? { code: -2013, msg: "Order does not exist." };
      return json(answer, typeof answer.code === "number" && answer.code < 0 ? 400 : 200);
    }
    if (path === "/fapi/v1/order" && method === "POST") {
      const failure = failFor(orderFailures, "order");
      const attempt = orderCounts.get("order") ?? 0;
      if (networkErrorOnOrder.includes(attempt)) {
        // What a timeout looks like to the client: no status, no body, no answer.
        throw new Error("the request was aborted after 10000ms");
      }
      if (failure && params.get("reduceOnly") !== "true") return json({ code: failure.code, msg: failure.msg }, 400);
      const type = params.get("type");
      if (type === "MARKET") {
        if (params.get("reduceOnly") === "true") {
          // A close that leaves a remainder is the exchange saying "the fill was
          // partial": the reader has to see the smaller position, not zero.
          const key = String(params.get("symbol"));
          const queue = remainderQueue.get(key) ?? [];
          const index = closeCounts.get(key) ?? 0;
          closeCounts.set(key, index + 1);
          const left = String(queue[index] ?? "0");
          if (Number(left) === 0) {
            reducedSymbols.add(key);
            closeRemainder.delete(key);
          } else {
            closeRemainder.set(key, left);
          }
          // A rejected close stays rejected: the exchange does not start
          // accepting a reduceOnly order just because it is asked again.
          if (closeFailures.length > 0) {
            const rejected = closeFailures[0];
            return json({ code: rejected.code, msg: rejected.msg }, 400);
          }
        }
      }
      // Binance defaults newOrderRespType to ACK: symbol, orderId and
      // clientOrderId only, with no status, executedQty or avgPrice. A caller that
      // forgets newOrderRespType=RESULT gets that thin answer, and the decisions
      // made against it (is it filled? for how much?) silently become zero. That
      // is the regression the ACK-shaped default guards against.
      const ack = params.get("newOrderRespType") !== "RESULT";
      return json({
        symbol: params.get("symbol"),
        side: params.get("side"),
        type,
        status: ack ? undefined : type === "MARKET" ? "FILLED" : orderStatus,
        // The exchange echoes back what it was given: a fill on a LIMIT that
        // expired in the same instant is visible here and nowhere else.
        executedQty: ack
          ? undefined
          : type === "MARKET"
            ? (marketFill?.executedQty ?? params.get("quantity"))
            : (params.get("executedQty") ?? orderExecutedQty),
        quantity: params.get("quantity"),
        avgPrice: ack ? undefined : type === "MARKET" ? (marketFill?.avgPrice ?? markPrice) : (params.get("price") ?? markPrice),
        price: params.get("price"),
        stopPrice: params.get("stopPrice") ?? params.get("price"),
        timeInForce: params.get("timeInForce"),
        reduceOnly: params.get("reduceOnly"),
        orderId: 1000 + calls.length,
        clientOrderId: params.get("clientOrderId") ?? `test-${calls.length}`,
      });
    }
    if (path === "/fapi/v1/algoOrder") {
      const attempt = (orderCounts.get("algo") ?? 0) + 1;
      const failure = failFor(algoFailures, "algo");
      if (failure) return json({ code: failure.code, msg: failure.msg }, 400);
      // The real Algo Service answer: algoId plus the trigger it accepted. A
      // protective order that comes back with no algoId, or with no trigger, is
      // not protecting anything, so both shapes are modelled explicitly.
      const trigger = params.get("triggerPrice");
      const override = algoAnswers[attempt] ?? {};
      const answer = {
        symbol: params.get("symbol"),
        side: params.get("side"),
        algoType: params.get("algoType"),
        type: params.get("type"),
        workingType: params.get("workingType"),
        priceProtect: params.get("priceProtect") === "TRUE",
        closePosition: params.get("closePosition"),
        status: "NEW",
      };
      if (!algoNoId) answer.algoId = "algoId" in override ? override.algoId : 5000 + attempt;
      if (!algoNoTrigger && trigger != null) answer.triggerPrice = trigger;
      return json({ ...answer, ...override });
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
