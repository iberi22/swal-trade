import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callOrCatch, errorText, jsonResponse, textOf, withClient } from "./helpers.mjs";
import { makeExchange, tradeEnv, TRADE_KEY, TRADE_SECRET } from "./trading-fixtures.mjs";

const NOW = Date.UTC(2026, 9, 9, 3, 0);

/** tradeEnv pinned to this file's journal, so parallel test files never share one. */
const tradeEnvFile = (extra = {}) => tradeEnv({ SWAL_MCP_JOURNAL: JOURNAL, ...extra });

const JOURNAL = "/tmp/swal-trade-test-journal-trading.jsonl";

function journalLines(file = JOURNAL, event = null) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .filter((line) => (event == null ? true : line.event === event));
}

function cleanJournal() {
  fs.rmSync(JOURNAL, { force: true });
}

const placeArgs = {
  symbol: "BTCUSDT",
  side: "BUY",
  notional_usd: 200,
  stop_loss_pct: 0.5,
  leverage: 2,
};

test.beforeEach(() => cleanJournal());

// ---------------------------------------------------------------------------
// The flag.
// ---------------------------------------------------------------------------

test("with the flag off the write tools are not registered at all", async () => {
  const exchange = makeExchange();
  await withClient({ env: {}, fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.equal(names.includes("place_order"), false);
    assert.equal(names.includes("close_position"), false);
    assert.equal(names.includes("grid_place"), false);
    assert.equal(names.includes("grid_plan"), true);
    for (const name of ["place_order", "close_position", "grid_place"]) {
      const result = await callOrCatch(client, name, { symbol: "BTCUSDT" });
      assert.equal(result.isError, true);
    }
  });
  assert.deepEqual(exchange.calls, []);
  assert.deepEqual(journalLines(), []);
});

test("with the flag on but the configuration broken the tool refuses before any call", async () => {
  const exchange = makeExchange();
  const env = { ...tradeEnvFile() };
  delete env.SWAL_MCP_SYMBOLS;
  await withClient({ env, fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "account_risk",
      "analyze_chart",
      "close_position",
      "grid_place",
      "grid_plan",
      "market_context",
      "place_order",
      "propose_order",
    ]);
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /SWAL_MCP_SYMBOLS must list at least one symbol/);
  });
  assert.deepEqual(exchange.calls, []);
  // A refusal is still audited: the journal records the guard decision and the error.
  const lines = journalLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "place_order");
  assert.equal(lines[0].guard, null);
  assert.match(lines[0].error, /SWAL_MCP_SYMBOLS/);
});

test("mainnet needs both variables, and the default base is testnet", async () => {
  const exchange = makeExchange();
  const half = { ...tradeEnvFile(), SWAL_MCP_NETWORK: "mainnet" };
  await withClient({ env: half, fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /SWAL_MCP_NETWORK=mainnet also requires SWAL_MCP_MAINNET_CONFIRM=yes/);
  });
  assert.deepEqual(exchange.calls, []);

  exchange.calls.length = 0;
  cleanJournal();
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    await client.callTool({ name: "place_order", arguments: placeArgs });
  });
  assert.ok(exchange.calls.length > 0);
  for (const call of exchange.calls) {
    assert.equal(new URL(call.url).origin, "https://testnet.binancefuture.com");
  }

  exchange.calls.length = 0;
  cleanJournal();
  await withClient({ env: { ...tradeEnvFile(), SWAL_MCP_NETWORK: "mainnet", SWAL_MCP_MAINNET_CONFIRM: "yes" }, fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    await client.callTool({ name: "place_order", arguments: placeArgs });
  });
  assert.ok(exchange.calls.length > 0);
  for (const call of exchange.calls) {
    assert.equal(new URL(call.url).origin, "https://fapi.binance.com");
  }
});

// ---------------------------------------------------------------------------
// The happy path.
// ---------------------------------------------------------------------------

test("place_order sends leverage, isolated margin, the entry and the protective stop, in that order", async () => {
  const exchange = makeExchange();
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "place_order", arguments: placeArgs })));
    assert.equal(body.network, "testnet");
    assert.equal(body.sent, true);
    assert.equal(body.symbol, "BTCUSDT");
    assert.equal(body.side, "BUY");
    assert.equal(body.leverage, 2);
    assert.equal(body.marginMode, "ISOLATED");
    // 200 USD at a mark of 100000 with stepSize 0.001 => 0.002 BTC.
    assert.equal(body.quantity, "0.002");
    assert.equal(body.effectiveNotionalUsd, 200);
    assert.equal(body.stop.stopPrice, "99500");
    assert.equal(body.stop.side, "SELL");
    assert.equal(body.stop.workingType, "MARK_PRICE");
    assert.equal(body.stop.closePosition, true);
  });

  const steps = exchange.paths();
  const leverageAt = steps.indexOf("POST /fapi/v1/leverage");
  const marginAt = steps.indexOf("POST /fapi/v1/marginType");
  const entryAt = steps.indexOf("POST /fapi/v1/order");
  const algoAt = steps.indexOf("POST /fapi/v1/algoOrder");
  assert.ok(leverageAt >= 0 && marginAt >= 0 && entryAt >= 0 && algoAt >= 0, steps.join(", "));
  assert.ok(leverageAt < marginAt && marginAt < entryAt && entryAt < algoAt, steps.join(", "));

  const leverage = exchange.post("/fapi/v1/leverage")[0];
  assert.equal(leverage.params.symbol, "BTCUSDT");
  assert.equal(leverage.params.leverage, "2");
  const margin = exchange.post("/fapi/v1/marginType")[0];
  assert.equal(margin.params.marginType, "ISOLATED");
  const entry = exchange.post("/fapi/v1/order")[0];
  assert.equal(entry.params.type, "MARKET");
  assert.equal(entry.params.symbol, "BTCUSDT");
  assert.equal(entry.params.side, "BUY");
  assert.equal(entry.params.quantity, "0.002");
  assert.equal(entry.params.reduceOnly, undefined, "an entry must not carry reduceOnly");
  const algo = exchange.post("/fapi/v1/algoOrder")[0];
  assert.equal(algo.path, "/fapi/v1/algoOrder");
  assert.equal(algo.params.symbol, "BTCUSDT");
  assert.equal(algo.params.side, "SELL");
  assert.equal(algo.params.type, "STOP_MARKET");
  assert.equal(algo.params.closePosition, "true");
  assert.equal(algo.params.workingType, "MARK_PRICE");
  // triggerPrice, never price: `price` on a STOP_MARKET is either a 400 or an
  // accepted order with no trigger, which never fires.
  assert.equal(algo.params.triggerPrice, "99500");
  assert.equal(algo.params.price, undefined);
  assert.equal(algo.params.algoType, "CONDITIONAL");
  assert.equal(algo.params.priceProtect, "TRUE");
  assert.equal(algo.params.timeInForce, "GTC");

  for (const call of exchange.calls) {
    if (call.signed) assert.equal(call.params.X_MBX_APIKEY, undefined);
    assert.equal(call.url.includes(TRADE_SECRET), false);
  }

  const lines = journalLines(JOURNAL, "place_order");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "place_order");
  assert.equal(lines[0].network, "testnet");
  assert.deepEqual(lines[0].guard, { allow: true, reasons: [] });
  assert.equal(lines[0].request.symbol, "BTCUSDT");
  assert.equal(lines[0].error, null);
  const stepsInJournal = lines[0].exchange.map((item) => item.step);
  assert.ok(stepsInJournal.includes("leverage"));
  assert.ok(stepsInJournal.includes("marginType"));
  assert.ok(stepsInJournal.includes("entry_market"));
  assert.ok(stepsInJournal.includes("protective_stop_1"));
  const raw = fs.readFileSync(JOURNAL, "utf8");
  assert.equal(raw.includes(TRADE_SECRET), false);
  assert.equal(raw.includes(TRADE_KEY), false);
  assert.equal(raw.includes("signature="), false);
});

test("place_order with a take profit places the algo order too", async () => {
  const exchange = makeExchange();
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(
      textOf(await client.callTool({ name: "place_order", arguments: { ...placeArgs, take_profit_pct: 1 } })),
    );
    assert.equal(body.takeProfit.price, "101000");
    assert.equal(body.takeProfit.response.status, "NEW");
    assert.deepEqual(body.warnings, []);
  });
  const algos = exchange.post("/fapi/v1/algoOrder");
  assert.equal(algos.length, 2);
  assert.equal(algos[0].params.type, "STOP_MARKET");
  assert.equal(algos[1].params.type, "TAKE_PROFIT_MARKET");
  assert.equal(algos[1].params.price, undefined);
  assert.equal(algos[1].params.triggerPrice, "101000");
});

test("place_order post_only rests a LIMIT GTX at the best bid and reprices on -5022", async () => {
  const exchange = makeExchange({ orderFailures: [{ code: -5022, msg: "Order would immediately match." }] });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(
      textOf(await client.callTool({ name: "place_order", arguments: { ...placeArgs, type: "post_only" } })),
    );
    assert.equal(body.orderType, "post_only");
    assert.equal(body.entryPrice, 99999.9);
    assert.equal(body.entry.status, "NEW");
  });
  const orders = exchange.post("/fapi/v1/order");
  assert.equal(orders.length, 2, "one rejected attempt and one reprice");
  assert.equal(orders[0].params.type, "LIMIT");
  assert.equal(orders[0].params.timeInForce, "GTX");
  assert.equal(orders[0].params.price, "99999.9");
  // Repriced one tick (0.1) below the best bid.
  assert.equal(orders[1].params.price, "99999.8");
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 1);
});

test("place_order refuses a quantity below minQty or MIN_NOTIONAL", async () => {
  const coarse = makeExchange({
    symbols: {
      BTCUSDT: { stepSize: "0.001", minQty: "0.001", tickSize: "0.1", minNotional: "5" },
    },
  });
  await withClient({ env: tradeEnvFile(), fetchFn: coarse.fetchFn, now: () => NOW }, async (client) => {
    // 1 USD of notional at 100000 rounds to zero quantity.
    const text = errorText(await client.callTool({ name: "place_order", arguments: { ...placeArgs, notional_usd: 1 } }));
    assert.match(text, /below the exchange minQty/);
  });
  assert.equal(coarse.post("/fapi/v1/order").length, 0);
  assert.equal(coarse.post("/fapi/v1/leverage").length, 0);

  const expensive = makeExchange({
    symbols: {
      BTCUSDT: { stepSize: "0.001", minQty: "0.001", tickSize: "0.1", minNotional: "1000000" },
    },
  });
  await withClient({ env: tradeEnvFile(), fetchFn: expensive.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /MIN_NOTIONAL/);
  });
  assert.equal(expensive.post("/fapi/v1/order").length, 0);
});

// ---------------------------------------------------------------------------
// The guard, end to end.
// ---------------------------------------------------------------------------

const guardCases = [
  {
    name: "a symbol outside the whitelist",
    args: { ...placeArgs, symbol: "DOGEUSDT" },
    env: {},
    expect: /not in the SWAL_MCP_SYMBOLS whitelist/,
  },
  {
    name: "a notional above the cap",
    args: { ...placeArgs, notional_usd: 5000 },
    env: {},
    expect: /exceeds SWAL_MAX_NOTIONAL_USD/,
  },
  {
    name: "leverage above the cap",
    args: { ...placeArgs, leverage: 9 },
    env: {},
    expect: /leverage 9x exceeds SWAL_MAX_LEVERAGE/,
  },
  {
    name: "a stop at the liquidation distance",
    args: { ...placeArgs, stop_loss_pct: 40, leverage: 9 },
    env: {},
    expect: /liquidation distance/,
  },
  {
    name: "the daily loss lock",
    args: placeArgs,
    env: {},
    income: [{ incomeType: "REALIZED_PNL", asset: "USDT", income: "-250", time: 1 }],
    expect: /daily-loss lock/,
  },
  {
    name: "another open position",
    args: placeArgs,
    env: {},
    positions: [{ symbol: "ETHUSDT", positionAmt: "0.5", notional: "500", unrealizedProfit: "0", positionSide: "BOTH", leverage: "1" }],
    expect: /max open positions reached/,
  },
  {
    name: "an existing position without a stop",
    args: placeArgs,
    env: {},
    positions: [{ symbol: "ETHUSDT", positionAmt: "0.5", notional: "500", unrealizedProfit: "0", positionSide: "BOTH", leverage: "1" }],
    algoOrders: [],
    maxPositions: "3",
    expect: /has no STOP_MARKET algo order/,
  },
];

for (const testCase of guardCases) {
  test(`place_order refuses ${testCase.name} without sending anything`, async () => {
    const exchange = makeExchange({
      positions: testCase.positions ?? [],
      income: testCase.income ?? [],
      algoOrders: testCase.algoOrders,
    });
    const env = tradeEnvFile(testCase.env);
    if (testCase.maxPositions) env.SWAL_MCP_MAX_POSITIONS = testCase.maxPositions;
    await withClient({ env, fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
      const text = errorText(await client.callTool({ name: "place_order", arguments: testCase.args }));
      assert.match(text, testCase.expect);
      assert.match(text, /order guard rejected/);
    });
    // The account was read, but nothing was written.
    for (const call of exchange.calls) {
      assert.equal(call.method, "GET", `${call.method} ${call.path} must not run`);
    }
    const lines = journalLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].guard.allow, false);
    assert.ok(lines[0].guard.reasons.some((reason) => testCase.expect.test(reason)), JSON.stringify(lines[0].guard));
  });
}

test("place_order refuses to send when the journal cannot be written", async () => {
  const exchange = makeExchange();
  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), "swal-blocked-"));
  fs.mkdirSync(path.join(blocked, "dir"), { recursive: true });
  fs.chmodSync(path.join(blocked, "dir"), 0o500);
  const journal = path.join(blocked, "dir", "journal.jsonl");
  await withClient({ env: tradeEnvFile({ SWAL_MCP_JOURNAL: journal }), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /not writable|not a writable regular file/);
  });
  fs.chmodSync(path.join(blocked, "dir"), 0o700);
  fs.rmSync(blocked, { recursive: true, force: true });
  assert.equal(exchange.post("/fapi/v1/order").length, 0);
});

test("place_order refuses to leave a position bare when the algo order answer carries no trigger", async () => {
  // The exchanger answers 200 with an algoId but no triggerPrice. On the old
  // behaviour that counted as "placed", and the position had a stop that could
  // never fire.
  const exchange = makeExchange({ algoNoTrigger: true, positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }] });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /carries no triggerPrice/);
    assert.match(text, /the position was closed with a MARKET reduceOnly order/);
  });
  const orders = exchange.post("/fapi/v1/order");
  assert.equal(orders.length, 2);
  assert.equal(orders[1].params.reduceOnly, "true");
});

test("place_order refuses a take profit whose echoed trigger is on the wrong side", async () => {
  // The TP answer echoes the entry price instead of a price above it: accepting
  // it would arm a take profit that fires immediately on entry.
  const exchange = makeExchange({
    algoAnswers: { 2: { triggerPrice: "100000" } },
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }] },
  );
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(
      textOf(await client.callTool({ name: "place_order", arguments: { ...placeArgs, take_profit_pct: 1 } })),
    );
    assert.equal(body.takeProfit.response, null);
    assert.match(body.warnings.join(" "), /not on the profit side/);
    // The stop is still placed: the position is protected even without the TP.
    assert.equal(exchange.post("/fapi/v1/algoOrder")[0].params.type, "STOP_MARKET");
    assert.equal(exchange.post("/fapi/v1/order").length, 1);
  });
});

// ---------------------------------------------------------------------------
// Post-only: what a rejected GTX answer actually means.
// ---------------------------------------------------------------------------

test("place_order post_only protects a fill that arrives with an EXPIRED answer", async () => {
  // A GTX limit can be rejected with EXPIRED in the same instant it fills. The
  // executedQty in that answer is the only evidence of the position, so reading
  // it is the difference between a protected fill and a naked one.
  const exchange = makeExchange({ orderStatus: "EXPIRED", orderExecutedQty: "0.002" });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(
      textOf(await client.callTool({ name: "place_order", arguments: { ...placeArgs, type: "post_only" } })),
    );
    assert.equal(body.orderType, "post_only");
    assert.equal(body.filledQuantity, 0.002);
    assert.equal(body.stop.stopPrice, "99500");
  });
  // One attempt, not three: it filled, so there is nothing to reprice.
  const orders = exchange.post("/fapi/v1/order");
  assert.equal(orders.length, 1);
  assert.equal(orders[0].params.timeInForce, "GTX");
  assert.equal(orders[0].params.clientOrderId?.startsWith("swal"), true);
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 1);
});

test("place_order post_only stops after three attempts and cancels by clientOrderId", async () => {
  const exchange = makeExchange({ orderStatus: "EXPIRED", orderExecutedQty: "0" });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: { ...placeArgs, type: "post_only" } }));
    assert.match(text, /could not be rested after 3 attempts/);
  });
  const orders = exchange.post("/fapi/v1/order");
  assert.equal(orders.length, 3, "three attempts, each with its own clientOrderId");
  assert.equal(new Set(orders.map((order) => order.params.clientOrderId)).size, 3);
  // The cancel targets the last clientOrderId, never allOpenOrders: another
  // hand-placed order of the symbol is not this tool's to cancel.
  const cancels = exchange.calls.filter((call) => call.method === "DELETE" && call.path === "/fapi/v1/order");
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].params.origClientOrderId, orders[2].params.clientOrderId);
  assert.equal(exchange.calls.some((call) => call.path === "/fapi/v1/allOpenOrders"), false);
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 0);
});

// ---------------------------------------------------------------------------
// Fail closed.
// ---------------------------------------------------------------------------

test("when the protective stop fails twice the position is closed and the tool errors", async () => {
  const exchange = makeExchange({
    algoFailures: [{ code: -2013, msg: "Order does not exist." }, { code: -2013, msg: "Order does not exist." }],
    // The MARKET entry fills, so the emergency close has a position to reduce.
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /the protective stop failed after 2 attempts/);
    assert.match(text, /the position was closed with a MARKET reduceOnly order/);
  });
  const algos = exchange.post("/fapi/v1/algoOrder");
  assert.equal(algos.length, 2, "exactly two attempts");
  const orders = exchange.post("/fapi/v1/order");
  // The MARKET entry, then the MARKET reduceOnly close.
  assert.equal(orders.length, 2);
  assert.equal(orders[1].params.type, "MARKET");
  assert.equal(orders[1].params.reduceOnly, "true");
  assert.equal(orders[1].params.side, "SELL");
  assert.equal(orders[1].params.quantity, "0.002");
  assert.ok(exchange.calls.some((call) => call.method === "DELETE" && call.path === "/fapi/v1/allOpenOrders"));
  assert.ok(exchange.calls.some((call) => call.method === "DELETE" && call.path === "/fapi/v1/algoOpenOrders"));
  const lines = journalLines(JOURNAL, "place_order");
  assert.equal(lines.length, 1);
  assert.match(lines[0].error, /protective stop failed after 2 attempts/);
  const steps = lines[0].exchange.map((item) => item.step);
  assert.ok(steps.includes("protective_stop_1") && steps.includes("protective_stop_2"));
  assert.ok(steps.includes("emergency_close"));
});

test("a rejected entry order sends nothing and cancels nothing", async () => {
  const exchange = makeExchange({ orderFailures: [{ code: -2010, msg: "insufficient balance" }] });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /the entry order was rejected by the exchange/);
    assert.match(text, /insufficient balance/);
  });
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 0);
  assert.equal(exchange.post("/fapi/v1/order").length, 1);
  assert.equal(exchange.calls.some((call) => call.method === "DELETE"), false);
});

// ---------------------------------------------------------------------------
// close_position.
// ---------------------------------------------------------------------------

test("close_position closes reduceOnly and cancels the symbol's orders and algo orders", async () => {
  const exchange = makeExchange({
    positions: [{ symbol: "BTCUSDT", positionAmt: "-0.5", notional: "-50000", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "close_position", arguments: { symbol: "BTCUSDT" } })));
    assert.equal(body.symbol, "BTCUSDT");
    assert.equal(body.positionQuantity, -0.5);
    assert.equal(body.closeOrder.side, "BUY");
    assert.equal(body.closeOrder.type, "MARKET");
    assert.equal(body.closeOrder.reduceOnly, "true");
    assert.equal(body.closeOrder.quantity, "0.5");
    assert.equal(body.sent, true);
  });
  const orders = exchange.post("/fapi/v1/order");
  assert.equal(orders.length, 1);
  assert.equal(orders[0].params.quantity, "0.5");
  assert.equal(exchange.calls.filter((call) => call.method === "DELETE" && call.path === "/fapi/v1/allOpenOrders").length, 1);
  assert.equal(exchange.calls.filter((call) => call.method === "DELETE" && call.path === "/fapi/v1/algoOpenOrders").length, 1);
  const lines = journalLines(JOURNAL, "close_position");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "close_position");
});

test("close_position works with the daily loss lock tripped: closing is protective", async () => {
  const exchange = makeExchange({
    positions: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
    income: [{ incomeType: "REALIZED_PNL", asset: "USDT", income: "-900", time: 1 }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "close_position", arguments: { symbol: "BTCUSDT" } })));
    assert.equal(body.closeOrder.side, "SELL");
    assert.equal(body.closeOrder.reduceOnly, "true");
  });
  assert.equal(exchange.post("/fapi/v1/order").length, 1);
});

test("close_position with no position only cancels the symbol's orders", async () => {
  const exchange = makeExchange();
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "close_position", arguments: { symbol: "BTCUSDT" } })));
    assert.equal(body.positionQuantity, null);
    assert.equal(body.closeOrder, null);
    assert.match(body.notes.join(" "), /no row for BTCUSDT: treated as no open position/);
    assert.equal(body.sent, false);
  });
  assert.equal(exchange.post("/fapi/v1/order").length, 0);
  assert.equal(exchange.calls.filter((call) => call.method === "DELETE").length, 2);
});

test("when neither the stop nor the emergency close works the tool says so explicitly", async () => {
  cleanJournal();
  const exchange = makeExchange({
    algoFailures: [{ code: -2013, msg: "Order does not exist." }, { code: -2013, msg: "Order does not exist." }],
    // A filled MARKET entry, and then every MARKET order from the emergency close on.
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
    closeFailures: [{ code: -2010, msg: "insufficient balance" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /protective stop failed after 2 attempts/);
    assert.match(text, /MANUAL ACTION REQUIRED/);
  });
  // The entry filled, the stop failed twice, and the close was attempted once.
  assert.equal(exchange.post("/fapi/v1/order").length, 2);
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 2);
  const line = journalLines(JOURNAL, "place_order")[0];
  const emergency = line.exchange.find((item) => item.step === "emergency_close");
  assert.match(emergency.error, /insufficient balance/);
});
