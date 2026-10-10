import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYSIS_CORE_MISSING, resolveCorePath, packageRoot, DEFAULT_CORE_RELATIVE } from "../dist/core.js";
import { dayStartMs } from "../dist/risk.js";
import { FNG_TTL_MS, NEWS_NOTE } from "../dist/market-data.js";
import { callOrCatch, errorText, jsonResponse, textOf, withClient } from "./helpers.mjs";

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const CORE = fixture("analysis-core.js");
const SECRET = "s3cretvalue";
const NOW = Date.UTC(2026, 9, 9, 3, 0);

function kline() {
  return [1_700_000_000_000, "10", "12", "9", "11", "100", 0, "0", 0, "0", "0", "0"];
}

function fngBody() {
  return { data: [{ value: "45", value_classification: "Fear", timestamp: "1700000000" }] };
}

test("default analysis core path is relative to the package", () => {
  const resolved = resolveCorePath({});
  assert.equal(resolved, path.resolve(packageRoot(), DEFAULT_CORE_RELATIVE));
  assert.ok(resolved.endsWith(`${path.sep}workers${path.sep}public-site${path.sep}static${path.sep}analisis${path.sep}analysis-core.js`));
});

test("lists only the five read-only tools", async () => {
  await withClient({ env: {}, fetchFn: async () => jsonResponse({}) }, async (client) => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["account_risk", "analyze_chart", "explain_analysis", "market_context", "propose_order"]);
    const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool.description]));
    assert.match(byName.analyze_chart, /Strength is pattern quality, not probability/);
    assert.match(byName.explain_analysis, /Strength is pattern quality, not probability/);
    assert.match(byName.explain_analysis, /not financial advice/);
    assert.match(byName.market_context, /Strength is pattern quality, not probability/);
    assert.match(byName.propose_order, /Order placement tools are disabled in this build/);
    for (const tool of listed.tools) {
      assert.notEqual(tool.annotations?.destructiveHint, true, tool.name);
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
    }
    for (const name of names) assert.doesNotMatch(name, /place_order|grid_plan|grid_place|withdraw|cancel/);
  });
});

test("rejects invalid analyze_chart and propose_order inputs before any fetch", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    throw new Error("should not fetch");
  };
  await withClient({ env: {}, fetchFn }, async (client) => {
    assert.equal((await callOrCatch(client, "analyze_chart", { symbol: "BTCUSDT", timeframe: "2m" })).isError, true);
    assert.equal((await callOrCatch(client, "analyze_chart", { symbol: "BTCUSDT", timeframe: "1h", limit: 0 })).isError, true);
    assert.equal((await callOrCatch(client, "analyze_chart", { symbol: "BTCUSDT", timeframe: "1h", limit: 1501 })).isError, true);
    assert.equal((await callOrCatch(client, "analyze_chart", { timeframe: "1h" })).isError, true);
    assert.equal((await callOrCatch(client, "propose_order", { symbol: "BTCUSDT", side: "HOLD", notional_usd: 10, stop_loss_pct: 1 })).isError, true);
    assert.equal((await callOrCatch(client, "propose_order", { symbol: "BTCUSDT", side: "BUY", notional_usd: -1, stop_loss_pct: 1 })).isError, true);
    assert.equal((await callOrCatch(client, "propose_order", { symbol: "BTCUSDT", side: "BUY", notional_usd: 10, stop_loss_pct: 0 })).isError, true);
    assert.equal((await callOrCatch(client, "propose_order", { symbol: "BTCUSDT", side: "BUY", notional_usd: 10, stop_loss_pct: 100 })).isError, true);
  });
  assert.equal(calls, 0);
});

test("analyze_chart sorts findings and maps kline time to seconds", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    return jsonResponse([kline(), [1_700_000_060_000, "11", "13", "10", "12", "50"]]);
  };
  await withClient({ env: { SWAL_ANALYSIS_CORE: CORE }, fetchFn }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "analyze_chart", arguments: { symbol: "btcusdt", timeframe: "1h", limit: 2 } })));
    assert.deepEqual(body.findings.map((finding) => finding.id), ["high", "low"]);
    assert.equal(body.findings[0].strength, 0.9);
    assert.equal(body.trend.symbol, "BTCUSDT");
    assert.equal(body.trend.timeframe, "1h");
    assert.equal(body.trend.candles, 2);
    assert.equal(body.trend.lastClose, 12);
    assert.equal(body.findings[1].from, 1_700_000_000);
  });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]);
  assert.equal(url.pathname, "/fapi/v1/klines");
  assert.equal(url.searchParams.get("symbol"), "BTCUSDT");
  assert.equal(url.searchParams.get("interval"), "1h");
  assert.equal(url.searchParams.get("limit"), "2");
});

test("analyze_chart reports a missing core without fetching", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return jsonResponse([]);
  };
  // Explicit missing path: the default path resolves to the real core inside the repo.
  await withClient({ env: { SWAL_ANALYSIS_CORE: fixture("does-not-exist.js") }, fetchFn }, async (client) => {
    const text = errorText(await client.callTool({ name: "analyze_chart", arguments: { symbol: "BTCUSDT", timeframe: "1h" } }));
    assert.equal(text, ANALYSIS_CORE_MISSING);
  });
  await withClient({ env: { SWAL_ANALYSIS_CORE: fixture("not-a-core.js") }, fetchFn }, async (client) => {
    const text = errorText(await client.callTool({ name: "analyze_chart", arguments: { symbol: "BTCUSDT", timeframe: "15m" } }));
    assert.equal(text, ANALYSIS_CORE_MISSING);
  });
  assert.equal(calls, 0);
});

test("analyze_chart surfaces a core failure that is not a missing module", async () => {
  await withClient(
    {
      env: { SWAL_ANALYSIS_CORE: fixture("throwing-core.js") },
      fetchFn: async () => jsonResponse([kline()]),
    },
    async (client) => {
      const text = errorText(await client.callTool({ name: "analyze_chart", arguments: { symbol: "BTCUSDT", timeframe: "5m" } }));
      assert.match(text, /detector exploded/);
      assert.notEqual(text, ANALYSIS_CORE_MISSING);
    },
  );
});

test("market_context caches fear and greed and leaves news null when the core is missing", async () => {
  let t = NOW;
  let fngCalls = 0;
  const fetchFn = async (url) => {
    const href = String(url);
    if (href.startsWith("https://api.alternative.me/fng/")) {
      fngCalls += 1;
      return jsonResponse(fngBody());
    }
    throw new Error(`unexpected ${new URL(href).pathname}`);
  };
  await withClient({ env: { SWAL_ANALYSIS_CORE: fixture("does-not-exist.js") }, fetchFn, now: () => t }, async (client) => {
    const first = JSON.parse(textOf(await client.callTool({ name: "market_context", arguments: { symbol: "ETHUSDT" } })));
    const second = JSON.parse(textOf(await client.callTool({ name: "market_context", arguments: { symbol: "ETHUSDT" } })));
    assert.equal(first.news, null);
    assert.equal(first.note, NEWS_NOTE);
    assert.equal(first.analysisError, ANALYSIS_CORE_MISSING);
    assert.equal(first.trends, null);
    assert.deepEqual(first.fearGreed, second.fearGreed);
    assert.equal(first.fearGreed.value, 45);
    assert.equal(first.fearGreed.classification, "Fear");
    assert.equal(fngCalls, 1);
    t += FNG_TTL_MS;
    await client.callTool({ name: "market_context", arguments: { symbol: "ETHUSDT" } });
    assert.equal(fngCalls, 2);
  });
});

test("market_context returns a trend per timeframe from the core", async () => {
  const intervals = [];
  const fetchFn = async (url) => {
    const href = String(url);
    if (href.startsWith("https://api.alternative.me/")) return jsonResponse(fngBody());
    const parsed = new URL(href);
    assert.equal(parsed.pathname, "/fapi/v1/klines");
    intervals.push(parsed.searchParams.get("interval"));
    return jsonResponse([kline()]);
  };
  await withClient({ env: { SWAL_ANALYSIS_CORE: CORE }, fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "market_context", arguments: { symbol: "BTCUSDT" } })));
    assert.equal(body.analysisError, null);
    assert.equal(body.news, null);
    assert.deepEqual(Object.keys(body.trends).sort(), ["1h", "1m", "4h", "5m"]);
    assert.equal(body.trends["4h"].timeframe, "4h");
    assert.equal(body.trends["1m"].candles, 1);
  });
  assert.deepEqual(intervals.sort(), ["1h", "1m", "4h", "5m"]);
});

test("account_risk refuses to call the exchange without keys or a daily-loss limit", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    throw new Error("should not fetch");
  };
  await withClient({ env: { SWAL_DAILY_LOSS_USD: "100" }, fetchFn }, async (client) => {
    const text = errorText(await client.callTool({ name: "account_risk", arguments: {} }));
    assert.match(text, /BINANCE_API_KEY and BINANCE_API_SECRET/);
  });
  await withClient({ env: { BINANCE_API_KEY: "AK-test-key", BINANCE_API_SECRET: SECRET }, fetchFn }, async (client) => {
    const text = errorText(await client.callTool({ name: "account_risk", arguments: {} }));
    assert.match(text, /SWAL_DAILY_LOSS_USD/);
    assert.equal(text.includes(SECRET), false);
  });
  assert.equal(calls, 0);
});

test("account_risk signs read-only GETs and reports guardian breaches", async () => {
  const calls = [];
  const start = dayStartMs(NOW, -5);
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const href = String(url);
    if (href.includes("/fapi/v1/time")) return jsonResponse({ serverTime: NOW + 500 });
    if (href.includes("/fapi/v3/account")) {
      return jsonResponse({
        positions: [
          { symbol: "BTCUSDC", positionAmt: "0.01", notional: "500", unrealizedProfit: "0", positionSide: "BOTH" },
          { symbol: "ETHUSDC", positionAmt: "0", notional: "0", unrealizedProfit: "0" },
        ],
      });
    }
    if (href.includes("/fapi/v2/positionRisk")) return jsonResponse([{ symbol: "BTCUSDC", positionAmt: "0.01", leverage: "10" }]);
    if (href.includes("/fapi/v1/income")) return jsonResponse([{ incomeType: "REALIZED_PNL", asset: "USDT", income: "-80", time: start }]);
    if (href.includes("/fapi/v1/openAlgoOrders")) {
      return jsonResponse([{ symbol: "BTCUSDC", side: "SELL", orderType: "TAKE_PROFIT_MARKET", closePosition: true }]);
    }
    throw new Error(`unexpected ${new URL(href).pathname}`);
  };
  const env = {
    BINANCE_API_KEY: "AK-test-key",
    BINANCE_API_SECRET: SECRET,
    SWAL_DAILY_LOSS_USD: "100",
    SWAL_MAX_LEVERAGE: "5",
    SWAL_MAX_NOTIONAL_USD: "400",
  };
  await withClient({ env, fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "account_risk", arguments: {} })));
    assert.equal(body.dayPnl, -80);
    assert.equal(body.realized, -80);
    assert.equal(body.readOnly, true);
    assert.deepEqual(Object.keys(body.breaches).sort(), ["daily_warn", "lev:BTCUSDC", "notional:BTCUSDC"]);
    assert.deepEqual(body.unprotected.map((position) => position.symbol), ["BTCUSDC"]);
    assert.equal(body.limits.tzOffsetHours, -5);
  });

  const allowed = new Set(["/fapi/v1/time", "/fapi/v3/account", "/fapi/v2/positionRisk", "/fapi/v1/income", "/fapi/v1/openAlgoOrders"]);
  for (const call of calls) {
    const url = new URL(call.url);
    assert.ok(allowed.has(url.pathname), url.pathname);
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.body, undefined);
    assert.equal(call.url.includes(SECRET), false);
  }
  const income = calls.find((call) => call.url.includes("/fapi/v1/income"));
  const qs = income.url.split("?")[1];
  const idx = qs.lastIndexOf("&signature=");
  const payload = qs.slice(0, idx);
  assert.ok(payload.includes(`startTime=${start}`));
  assert.ok(payload.includes("recvWindow=5000"));
  assert.equal(qs.slice(idx + "&signature=".length), crypto.createHmac("sha256", SECRET).update(payload).digest("hex"));
  assert.equal(calls.find((call) => call.url.includes("/time")).init.headers, undefined);
});

test("account_risk redacts secrets from transport errors", async () => {
  const fetchFn = async () => {
    throw new Error(`connect ${SECRET}`);
  };
  await withClient(
    { env: { BINANCE_API_KEY: "AK-test-key", BINANCE_API_SECRET: SECRET, SWAL_DAILY_LOSS_USD: "10" }, fetchFn, now: () => NOW },
    async (client) => {
      const text = errorText(await client.callTool({ name: "account_risk", arguments: {} }));
      assert.match(text, /network error/);
      assert.equal(text.includes(SECRET), false);
    },
  );
});

test("propose_order returns math and violations and never sends an order", async () => {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ symbol: "BTCUSDT", markPrice: "100" });
  };
  const env = {
    BINANCE_API_KEY: "AK-test-key",
    BINANCE_API_SECRET: SECRET,
    SWAL_MAX_LEVERAGE: "5",
    SWAL_MAX_NOTIONAL_USD: "100",
    SWAL_DAILY_LOSS_USD: "40",
  };
  await withClient({ env, fetchFn }, async (client) => {
    const body = JSON.parse(
      textOf(
        await client.callTool({
          name: "propose_order",
          arguments: { symbol: "BTCUSDT", side: "BUY", notional_usd: 250, stop_loss_pct: 2, leverage: 10 },
        }),
      ),
    );
    assert.equal(body.quantity, 2.5);
    assert.equal(body.stopPrice, 98);
    assert.equal(body.sent, false);
    assert.equal(body.withinSafeDistance, true);
    assert.deepEqual(body.violations, [
      "leverage 10x exceeds SWAL_MAX_LEVERAGE 5x",
      "notional 250 USD exceeds SWAL_MAX_NOTIONAL_USD 100",
    ]);
    assert.match(body.note, /Nothing was sent/);
    assert.equal(body.limits.dailyLossEvaluated, false);
  });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, "https://fapi.binance.com");
  assert.equal(url.pathname, "/fapi/v1/premiumIndex");
  assert.equal(url.searchParams.get("symbol"), "BTCUSDT");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers, undefined);
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].url.includes(SECRET), false);

  await withClient({ env, fetchFn }, async (client) => {
    const body = JSON.parse(
      textOf(
        await client.callTool({
          name: "propose_order",
          arguments: { symbol: "ETHUSDT", side: "SHORT", notional_usd: 100, stop_loss_pct: 2 },
        }),
      ),
    );
    assert.equal(body.leverage, 1);
    assert.equal(body.side, "SELL");
    assert.equal(body.quantity, 1);
    assert.equal(body.stopPrice, 102);
    assert.equal(body.sent, false);
  });
});
