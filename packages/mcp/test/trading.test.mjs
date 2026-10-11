import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callOrCatch, errorText, jsonResponse, textOf, withClient } from "./helpers.mjs";
import { makeExchange, tradeEnv, TRADE_KEY, TRADE_SECRET } from "./trading-fixtures.mjs";
import { placeOrder } from "../dist/place.js";

const NOW = Date.UTC(2026, 9, 9, 3, 0);

/** tradeEnv pinned to this file's journal, so parallel test files never share one. */
const tradeEnvFile = (extra = {}) => tradeEnv({ SWAL_MCP_JOURNAL: JOURNAL, ...extra });

const JOURNAL = "/tmp/swal-trade-test-journal-trading.jsonl";
/** Coarse filters and a journal of its own, for the grid_place tests in this file. */
const GRID_SYMBOLS = { BTCUSDT: { stepSize: "0.01", minQty: "0.01", tickSize: "1", minNotional: "5" } };
const GRID_JOURNAL = "/tmp/swal-trade-test-journal-trading-grid.jsonl";

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

/** A live protective algo order, as GET /fapi/v1/openAlgoOrders reports one. */
function liveAlgoRow(symbol, kind, trigger) {
  return {
    algoId: 5001,
    algoType: "CONDITIONAL",
    orderType: kind,
    type: kind,
    symbol,
    side: "SELL",
    positionSide: "BOTH",
    quantity: "0",
    algoStatus: "NEW",
    triggerPrice: trigger,
    priceProtect: true,
    closePosition: true,
    reduceOnly: false,
  };
}

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
      "explain_analysis",
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

test("every order sends newOrderRespType=RESULT, so the answer carries status and executedQty", async () => {
  // Binance defaults newOrderRespType to ACK: no status, no executedQty, no
  // avgPrice. A fill then reads as executedQty 0 and a filled order looks empty.
  // The fixture answers a RESULT-less POST with an ACK-shaped body, so a caller
  // that forgets the param fails here instead of trading blind.
  const exchange = makeExchange();
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "place_order", arguments: placeArgs })));
    assert.equal(body.entry.status, "FILLED", "the RESULT answer carries a status");
    assert.ok(body.filledQuantity > 0, "the RESULT answer carries executedQty");
  });
  const orders = exchange.post("/fapi/v1/order");
  assert.ok(orders.length >= 1);
  for (const order of orders) assert.equal(order.params.newOrderRespType, "RESULT");
});

test("a LIMIT GTX entry also sends newOrderRespType=RESULT", async () => {
  const exchange = makeExchange({ orderStatus: "NEW" });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    await client.callTool({ name: "place_order", arguments: { ...placeArgs, type: "post_only" } });
  });
  const orders = exchange.post("/fapi/v1/order");
  assert.ok(orders.length >= 1);
  for (const order of orders) assert.equal(order.params.newOrderRespType, "RESULT");
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

test("place_order sizes a quantity whose quotient has more than eighteen decimals", async () => {
  // 10 USD at 150000 is 0.00006666666666666667: twenty decimals, which the
  // decimal guard refuses. Refusing the alignment used to stop a valid order with
  // "quantity for 10 USD cannot be aligned to stepSize".
  const fine = makeExchange({
    symbols: { BTCUSDT: { stepSize: "0.000001", minQty: "0.000001", tickSize: "0.1", minNotional: "5" } },
    markPrice: "150000",
  });
  await withClient({ env: tradeEnvFile(), fetchFn: fine.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(
      textOf(await client.callTool({ name: "place_order", arguments: { ...placeArgs, notional_usd: 10, stop_loss_pct: 0.5 } })),
    );
    assert.equal(body.quantity, "0.000066");
    assert.equal(body.entry.type, "MARKET");
  });
  const orders = fine.post("/fapi/v1/order");
  assert.equal(orders.length, 1);
  assert.equal(orders[0].params.quantity, "0.000066");
  assert.equal(orders[0].params.price, undefined);
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

test("the notional cap counts resting open orders of the symbol, not only this order", async () => {
  // A resting BUY for 900 USD on ETHUSDT is exposure of ETHUSDT, not of BTCUSDT:
  // the cap is per position, so it must not refuse a legitimate BTCUSDT order.
  // A resting ENTRY on the symbol being traded is refused one step earlier, by
  // the flat-symbol rule (see the flat-symbol tests below): it is not a cap
  // problem, it is a symbol this tool must not open on.
  const exchange = makeExchange({
    openOrders: [
      { symbol: "ETHUSDT", side: "BUY", type: "LIMIT", price: "90000", quantity: "0.01", clientOrderId: "resting-1" },
      { symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", stopPrice: "90000", quantity: "0.01", reduceOnly: true },
    ],
  });
  await withClient({ env: tradeEnvFile({ SWAL_MCP_MAX_POSITIONS: "2" }), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "place_order", arguments: placeArgs })));
    assert.equal(body.sent, true, "another symbol's resting order is not exposure of this one");
  });
  assert.equal(exchange.post("/fapi/v1/order").length, 1);
  assert.equal(exchange.calls.some((call) => call.path === "/fapi/v1/openOrders"), true);
});

test("resting protective algo orders never count as exposure", async () => {
  // A resting STOP_MARKET with closePosition closes exposure, it does not create
  // it: counting it would refuse a legitimate entry.
  const exchange = makeExchange({
    openOrders: [],
    algoOrders: [{ symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", algoId: 9, closePosition: true, quantity: "1" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "place_order", arguments: placeArgs })));
    assert.equal(body.sent, true);
  });
  assert.equal(exchange.post("/fapi/v1/order").length, 1);
});

// ---------------------------------------------------------------------------
// Round 6 (F1/F6): the flat-symbol invariant. place_order OPENS a position, so
// it only runs on a symbol that is flat.
//
// The old behaviour reasoned about a pre-existing position as if it were its
// own: an ambiguous entry answered with a confirmed cancel of zero executed was
// read as "this order's fill", the protective stop was armed with closePosition
// over the user's whole position, and when that stop failed the emergency close
// MARKET-closed the user's position and cancelled the user's orders. Refusing
// before the first order needs no reconciliation at all.
// ---------------------------------------------------------------------------

const FLAT_MESSAGE =
  /BTCUSDT already has an open position or orders; this tool only opens a position on a flat symbol\. Use close_position or manage it manually\./;

test("place_order refuses a symbol that already has an open position", async () => {
  const exchange = makeExchange({
    positions: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, FLAT_MESSAGE);
  });
  // Nothing was written: not the entry, not the stop, not even the leverage.
  assert.equal(exchange.post("/fapi/v1/order").length, 0);
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 0);
  assert.equal(exchange.post("/fapi/v1/leverage").length, 0);
  for (const call of exchange.calls) assert.equal(call.method, "GET", `${call.method} ${call.path} must not run`);
  // The refusal is audited, with the reason, so the journal explains the no.
  const lines = journalLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].guard.allow, false);
  assert.ok(lines[0].guard.reasons.some((reason) => /only opens a position on a flat symbol/.test(reason)), JSON.stringify(lines[0].guard));
  assert.ok(lines[0].exchange.some((item) => item.step === "flat_symbol_refused"), JSON.stringify(lines[0].exchange));
});

test("place_order refuses a symbol with a resting entry order or a pending algo entry", async () => {
  const restingEntry = makeExchange({
    openOrders: [{ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", price: "90000", quantity: "0.001", clientOrderId: "resting-1" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: restingEntry.fetchFn, now: () => NOW }, async (client) => {
    assert.match(errorText(await client.callTool({ name: "place_order", arguments: placeArgs })), FLAT_MESSAGE);
  });
  assert.equal(restingEntry.post("/fapi/v1/order").length, 0);
  assert.equal(restingEntry.calls.some((call) => call.method === "DELETE"), false);

  // A pending stop-entry (an algo order that OPENS exposure, without
  // reduceOnly or closePosition) is the same refusal: it is a resting entry.
  const pendingAlgo = makeExchange({
    algoOrders: [{ symbol: "BTCUSDT", side: "BUY", type: "STOP", algoId: 12, quantity: "0.001", triggerPrice: "91000" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: pendingAlgo.fetchFn, now: () => NOW }, async (client) => {
    assert.match(errorText(await client.callTool({ name: "place_order", arguments: placeArgs })), FLAT_MESSAGE);
  });
  assert.equal(pendingAlgo.post("/fapi/v1/order").length, 0);
  assert.equal(pendingAlgo.post("/fapi/v1/algoOrder").length, 0);
});

test("place_order still opens on a symbol whose rows read as zero", async () => {
  // positionRisk answers a row for the symbol with positionAmt "0": that is what
  // a closed symbol looks like on a full list, and it is flat.
  const exchange = makeExchange({
    positions: [{ symbol: "BTCUSDT", positionAmt: "0", notional: "0", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "place_order", arguments: placeArgs })));
    assert.equal(body.sent, true);
  });
  assert.equal(exchange.post("/fapi/v1/order").length, 1);
});

test("grid_place refuses a symbol that already has an open position", async () => {
  // The fail-closed exit flattens the symbol and cancels its orders: on a symbol
  // the user is holding by hand that closes THEIR position and strips THEIR
  // stops. It is not a grid problem, it is a symbol this tool must not open on.
  fs.rmSync(GRID_JOURNAL, { force: true });
  const exchange = makeExchange({
    symbols: GRID_SYMBOLS,
    positions: [{ symbol: "BTCUSDT", positionAmt: "0.3", notional: "29400", unrealizedProfit: "0", positionSide: "BOTH", leverage: "1" }],
  });
  await withClient({ env: tradeEnvFile({ SWAL_MAX_NOTIONAL_USD: "50000", SWAL_MCP_JOURNAL: GRID_JOURNAL }), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(
      await client.callTool({ name: "grid_place", arguments: { symbol: "BTCUSDT", lower: 97000, upper: 99000, levels: 3, total_notional_usd: 30000, stop_loss_price: 95000 } }),
    );
    assert.match(text, FLAT_MESSAGE);
  });
  assert.equal(exchange.post("/fapi/v1/order").length, 0, "no level is placed");
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 0, "no stop is armed");
  assert.equal(exchange.calls.filter((call) => call.method === "DELETE").length, 0, "nothing of the user's is cancelled");
  fs.rmSync(GRID_JOURNAL, { force: true });
});

test("a resting entry order on the symbol is refused by the flat-symbol rule", async () => {
  // A resting BUY on BTCUSDT is committed money AND a position about to exist.
  // The old guard answered "max open positions reached" and left the resting
  // order in place while the tool went on to reason about exposure it did not
  // own; the flat-symbol rule refuses up front instead.
  const exchange = makeExchange({
    openOrders: [{ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", price: "90000", quantity: "0.001", clientOrderId: "resting-1" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(
      text,
      /BTCUSDT already has an open position or orders; this tool only opens a position on a flat symbol\. Use close_position or manage it manually\./,
    );
  });
  assert.equal(exchange.post("/fapi/v1/order").length, 0);
  assert.equal(exchange.calls.some((call) => call.path === "/fapi/v1/openOrders"), true);
  const lines = journalLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].guard.allow, false);
  assert.ok(lines[0].guard.reasons.some((reason) => /only opens a position on a flat symbol/.test(reason)), JSON.stringify(lines[0].guard));
});

test("two write tools cannot interleave their reads and their orders", async () => {
  // The guard is not atomic: two tools reading the account at the same time both
  // see "no position" and both place. The write lock serializes them, so the
  // second one sees the position the first one opened.
  const exchange = makeExchange({
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
  });
  const deps = { env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW };
  const first = placeOrder(deps, { ...placeArgs });
  const second = placeOrder(deps, { ...placeArgs });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, false);
  // Only one entry reached the exchange: the second tool refused before sending.
  assert.equal(exchange.post("/fapi/v1/order").length, 1);
});

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

test("place_order accepts the real Algo shape (algoId, status NEW) with no echoed trigger, once openAlgoOrders confirms it", async () => {
  // The real Algo Service answers {algoId, status: NEW} WITHOUT echoing
  // triggerPrice. Refusing that shape flattened every order the exchange had
  // actually accepted, so a live algoId plus a live status is accepted now: with
  // a warning, and only after ONE read of the open algo orders proves the order
  // is live on the exchange. "Accepted, unverified, never re-read" is the state
  // that leaves a position bare.
  const exchange = makeExchange({
    algoNoTrigger: true,
    algoOrders: [liveAlgoRow("BTCUSDT", "STOP_MARKET", "99500")],
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "place_order", arguments: placeArgs })));
    assert.equal(body.sent, true, "a live algoId is not flattened");
    assert.equal(body.stop.response.algoId, 5001);
    assert.match(body.warnings.join(" "), /did not echo a triggerPrice/);
    assert.match(body.warnings.join(" "), /confirmed live in GET \/fapi\/v1\/openAlgoOrders/);
  });
  // No flatten: the entry order and nothing else.
  assert.equal(exchange.post("/fapi/v1/order").length, 1, "a live algoId sends no reduceOnly");
  const stopStep = journalLines(JOURNAL, "place_order")[0].exchange.find((item) => item.step === "protective_stop_1");
  assert.match(JSON.stringify(stopStep), /did not echo a triggerPrice/);
  // Exactly one confirmation read, after the algo order was sent.
  const confirm = journalLines(JOURNAL, "place_order")[0].exchange.find((item) => item.step === "protective_stop_confirm_1");
  assert.equal(confirm.ok, true);
  const steps = exchange.paths();
  assert.ok(
    steps.lastIndexOf("GET /fapi/v1/openAlgoOrders") > steps.lastIndexOf("POST /fapi/v1/algoOrder"),
    steps.join(", "),
  );
});

test("a stop accepted with no echoed trigger and NOT found in openAlgoOrders is a failed stop", async () => {
  // The Algo Service answered {algoId, status: NEW} with no trigger, and the open
  // algo orders that were read to verify it show nothing. The order the exchange
  // says it accepted is not there: the position is unprotected, so it is closed.
  const exchange = makeExchange({
    algoNoTrigger: true,
    algoOrders: [],
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /no live STOP_MARKET closePosition order for BTCUSDT/);
    assert.match(text, /the position was closed with a MARKET reduceOnly order/);
  });
  // One algo attempt, not two: the order IS live on the exchange, so placing a
  // second one would leave a duplicate stop behind.
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 1);
  const orders = exchange.post("/fapi/v1/order");
  assert.equal(orders.length, 2);
  assert.equal(orders[1].params.reduceOnly, "true");
});

test("a stop whose openAlgoOrders read fails is a failed stop, not a warning", async () => {
  // The confirmation read could not be made (a 500). An unverifiable stop is not
  // a stop: the position is closed instead of being reported as protected.
  const exchange = makeExchange({
    algoNoTrigger: true,
    openAlgoOrdersHttpError: 500,
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /protective stop failed after 2 attempts/);
    assert.match(text, /open algo orders could not be read/);
  });
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 1);
  // The position really was flattened: an unverifiable stop is a failed stop.
  const orders = exchange.post("/fapi/v1/order");
  assert.equal(orders.length, 2);
  assert.equal(orders[1].params.reduceOnly, "true");
  const emergency = journalLines(JOURNAL, "place_order")[0].exchange.find((item) => item.step === "emergency_close");
  assert.equal(emergency.flat, true);
});

test("place_order still flattens when the algo answer has neither an echoed trigger nor a live status", async () => {
  // An algoId alone proves nothing: no trigger and a dead status is not a stop.
  const exchange = makeExchange({ algoNoTrigger: true, algoAnswers: { 1: { status: "REJECTED" }, 2: { status: "REJECTED" } }, positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }] });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /no triggerPrice and no live status/);
    assert.match(text, /the position was closed with a MARKET reduceOnly order/);
  });
  const orders = exchange.post("/fapi/v1/order");
  assert.equal(orders.length, 2);
  assert.equal(orders[1].params.reduceOnly, "true");
});

test("place_order flattens when the echoed stop trigger differs from the one sent", async () => {
  // Echoed on the loss side but a different distance than requested (99000 vs the
  // 99500 sent): the stop that is armed is not the stop that was explained.
  const exchange = makeExchange({ algoAnswers: { 1: { triggerPrice: "99000" }, 2: { triggerPrice: "99000" } }, positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }] });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /differs from the 99500 sent/);
  });
  const orders = exchange.post("/fapi/v1/order");
  assert.equal(orders.length, 2, "a differing trigger flattens the position");
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

test("place_order refuses when the exposure cannot be read instead of trading against an unknown exposure", async () => {
  // A 429 on GET /fapi/v1/openOrders leaves symbolNotionalUsd at 0, so the cap
  // would pass. A cap decided against an exposure that could not be read is not a
  // cap: the order is refused before the guard.
  const exchange = makeExchange({ openOrdersHttpError: 429 });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /the exposure could not be read/);
    assert.match(text, /refusing the order instead of trading against an unknown exposure/);
  });
  assert.equal(exchange.post("/fapi/v1/order").length, 0, "nothing is sent when the exposure is unknown");
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 0);
});

test("place_order post_only refuses a reprice that would cross its own protective stop", async () => {
  // tickSize 1, entry at the bid 100, stop_loss_pct 1.5 -> stop rounds to 99. The
  // GTX at 100 expires (would immediately match); the reprice lands exactly ON
  // the stop. The old code kept repricing 100->99->98 and rested at 98, BEYOND
  // the stop: an entry that would fill only after the position was already
  // exited. The reprice is refused at 99 and nothing rests.
  const cross = makeExchange({
    symbols: { BTCUSDT: { stepSize: "0.01", minQty: "0.01", tickSize: "1", minNotional: "5" } },
    markPrice: "100",
    book: { bidPrice: "100", askPrice: "101" },
    orderStatus: "EXPIRED",
    orderExecutedQty: "0",
  });
  await withClient({ env: tradeEnvFile(), fetchFn: cross.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: { ...placeArgs, notional_usd: 200, stop_loss_pct: 1.5, type: "post_only" } }));
    assert.match(text, /cross the protective stop/);
  });
  const orders = cross.post("/fapi/v1/order");
  // Only the first attempt at 100 is ever sent: the reprice onto the stop is
  // refused before it is placed, so no order rests at or beyond the stop.
  assert.equal(orders.length, 1, "a reprice onto the stop is never sent");
  assert.equal(orders[0].params.price, "100");
  assert.equal(cross.post("/fapi/v1/algoOrder").length, 0, "no stop is armed when the entry never rested");
});


test("place_order post_only protects a fill found in the cancel answer after a timeout", async () => {
  const exchange = makeExchange({
    networkErrorOnOrder: [1],
    queryOrder: { code: -2011, msg: "Unknown order sent." },
    cancelOrderAnswer: { status: "CANCELED", executedQty: "0.002", origClientOrderId: "whatever", side: "BUY", type: "LIMIT" },
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const res = await client.callTool({ name: "place_order", arguments: { ...placeArgs, type: "post_only" } }); if(res.isError) throw new Error(res.content[0].text); const text = textOf(res);
    const body = JSON.parse(text);
    assert.equal(body.orderType, "post_only");
    assert.equal(body.filledQuantity, 0.002);
    assert.equal(body.stop.stopPrice, "99500");
  });
});

test("place_order post_only treats a not-found cancel with an open position as a fill", async () => {
  const exchange = makeExchange({
    networkErrorOnOrder: [1],
    queryOrder: { code: -2011, msg: "Unknown order sent." },
    cancelOrderAnswer: { code: -2011, msg: "Unknown order sent." },
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
    positionsAfterCancel: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }]
  });
  exchange.positions = [];
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const res = await client.callTool({ name: "place_order", arguments: { ...placeArgs, type: "post_only", notional_usd: 200 } }); if(res.isError) throw new Error(res.content[0].text); const body = JSON.parse(textOf(res));
    assert.equal(body.filledQuantity, 0.002);
    assert.equal(body.stop.stopPrice, "99500");
  });
});

test("place_order post_only with a 200 cancel, 0 executed, and 0 position resolves as no fill", async () => {
  // A lookup that finds nothing answers -2013. (-2011 is a cancel-only code and
  // no longer counts as "not found" on a lookup: see the F3 test.)
  const exchange = makeExchange({
    networkErrorOnOrder: [1],
    queryOrder: { code: -2013, msg: "Order does not exist." },
    cancelOrder: { status: "CANCELED", executedQty: "0", origClientOrderId: "whatever", side: "BUY", type: "LIMIT" },
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: { ...placeArgs, type: "post_only" } }));
    assert.match(text, /the resting order was cancelled by clientOrderId/);
  });
});

test("place_order post_only leaves the intent pending when both reads fail and the cancel is confirmed 0", async () => {
  const exchange = makeExchange({
    networkErrorOnOrder: [1],
    queryOrderHttpError: 500,
    positionRiskHttpError: 500,
    cancelOrder: { status: "CANCELED", executedQty: "0", origClientOrderId: "whatever", side: "BUY", type: "LIMIT" },
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: { ...placeArgs, type: "post_only" } }));
    assert.match(text, /the net position could not be read/);
  });
});

test("place_order post_only cancels the order it actually sent after an ambiguous timeout, and never calls a resting order not sent", async () => {
  // EXPIRED -> reprice -> the 2nd POST times out -> the lookup answers NEW with
  // no fill (a RESTING GTX). It must be cancelled by attempt-2's clientOrderId,
  // never the first dead id, and reported as sent-then-cancelled. The old code
  // cancelled the first dead id, reported "not sent" and resolved the intent,
  // leaving a live GTX order with no stop and no trace.
  const exchange = makeExchange({ orderStatus: "EXPIRED", orderExecutedQty: "0", networkErrorOnOrder: [2], queryOrder: { clientOrderId: "x", status: "NEW", executedQty: "0", side: "BUY", type: "LIMIT" } });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: { ...placeArgs, type: "post_only" } }));
    assert.doesNotMatch(text, /not sent/, "a resting order is never reported as not sent");
    assert.match(text, /timed out/);
    assert.match(text, /cancelled by clientOrderId/);
  });
  const orders = exchange.post("/fapi/v1/order");
  assert.equal(orders.length, 2, "one expired attempt and one timed-out attempt");
  const attempt2 = orders[1].params.clientOrderId;
  const cancels = exchange.calls.filter((call) => call.method === "DELETE" && call.path === "/fapi/v1/order");
  assert.ok(cancels.some((cancel) => cancel.params.origClientOrderId === attempt2), "the cancel targets the id actually sent");
  assert.ok(!cancels.some((cancel) => cancel.params.origClientOrderId === orders[0].params.clientOrderId), "the first dead id is never the cancel target");
  // The cancel was confirmed (200): the intent is resolved and no stop was armed
  // on a resting order.
  assert.equal(journalLines(JOURNAL, "place_order_outcome").length, 1);
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 0);
});

test("place_order post_only leaves the intent pending when the cancel of a timed-out resting order is not confirmed", async () => {
  // Same timeout and resting lookup, but the cancel itself fails (500): a GTX
  // order may still be resting. No resolving outcome is written, so the startup
  // sweep keeps the intent pending instead of being told the entry is done.
  const exchange = makeExchange({ orderStatus: "EXPIRED", orderExecutedQty: "0", networkErrorOnOrder: [2], queryOrder: { clientOrderId: "x", status: "NEW", executedQty: "0", side: "BUY", type: "LIMIT" }, cancelOrderHttpError: 500 });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: { ...placeArgs, type: "post_only" } }));
    assert.match(text, /cancel was not confirmed/);
    assert.match(text, /startup sweep will report it/);
  });
  const orders = exchange.post("/fapi/v1/order");
  assert.equal(orders.length, 2);
  const attempt2 = orders[1].params.clientOrderId;
  const cancels = exchange.calls.filter((call) => call.method === "DELETE" && call.path === "/fapi/v1/order");
  assert.ok(cancels.some((cancel) => cancel.params.origClientOrderId === attempt2), "even the unconfirmed cancel targets the id actually sent");
  // No resolving outcome: the intent stays pending for the sweep.
  assert.equal(journalLines(JOURNAL, "place_order_intent").length, 1);
  assert.equal(journalLines(JOURNAL, "place_order_outcome").length, 0);
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

test("the emergency close flattens BEFORE it cancels anything", async () => {
  // Cancelling first leaves an open position with no stop and no exit. The
  // position order in the recorded calls is the safety property.
  const exchange = makeExchange({
    algoFailures: [{ code: -2013, msg: "Order does not exist." }, { code: -2013, msg: "Order does not exist." }],
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    await client.callTool({ name: "place_order", arguments: placeArgs });
  });
  const steps = exchange.paths();
  const close = steps.indexOf("POST /fapi/v1/order");
  const deleteAt = steps.findIndex((step) => step.startsWith("DELETE"));
  assert.ok(close >= 0 && deleteAt >= 0, steps.join(", "));
  assert.ok(close < deleteAt, `the close must come before the cancels: ${steps.join(", ")}`);
  assert.ok(steps.findIndex((step) => step === "DELETE /fapi/v1/algoOpenOrders") > close);
  assert.ok(steps.findIndex((step) => step === "DELETE /fapi/v1/allOpenOrders") > close);
  const line = journalLines(JOURNAL, "place_order")[0];
  const emergency = line.exchange.find((item) => item.step === "emergency_close");
  assert.equal(emergency.flat, true);
  assert.equal(emergency.flatten.remaining, 0);
  assert.equal(emergency.flatten.orders.length, 1);
});

test("the emergency close does NOT cancel when the flatten is refused", async () => {
  // A refused reduceOnly leaves the position open: cancelling now would strip
  // its stop and its exit in the same breath.
  const exchange = makeExchange({
    algoFailures: [{ code: -2013, msg: "Order does not exist." }, { code: -2013, msg: "Order does not exist." }],
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
    closeFailures: [{ code: -2010, msg: "insufficient balance" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /MANUAL ACTION REQUIRED/);
  });
  assert.equal(exchange.calls.filter((call) => call.method === "DELETE").length, 0);
  const line = journalLines(JOURNAL, "place_order")[0];
  const emergency = line.exchange.find((item) => item.step === "emergency_close");
  assert.equal(emergency.flat, false);
  assert.equal(emergency.remaining, 0.002);
  assert.match(emergency.cancelledOrders, /not attempted/);
});

// ---------------------------------------------------------------------------
// Item 15: the stop is checked against the exchange's liquidation estimate.
// ---------------------------------------------------------------------------

test("the stop must sit inside the exchange liquidation estimate, not inside 100/leverage", async () => {
  // The bracket for this notional carries a 5% maintenance margin, so at 2x the
  // exchange puts liquidation about 47.4% away and the safe distance at 37.9%.
  // The guard's simplified check allows a 40% stop, which the exchange says is
  // beyond liquidation: a stop that never fires, and a position liquidated while
  // the operator believes it is protected.
  const exchange = makeExchange({ maintenanceMarginRatio: "0.05" });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: { ...placeArgs, stop_loss_pct: 40 } }));
    assert.match(text, /the stop would not fire before the liquidation/);
    assert.match(text, /leverageBracket/);
  });
  assert.equal(exchange.post("/fapi/v1/order").length, 0);
  assert.ok(exchange.calls.some((call) => call.path === "/fapi/v1/leverageBracket"));
  assert.match(JSON.stringify(journalLines(JOURNAL, "place_order")[0]), /"step":"liquidation"/);
});

test("a stop inside the exchange liquidation estimate is allowed", async () => {
  // 0.1% away from the entry, well inside the 0.4% liquidation distance.
  const exchange = makeExchange();
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(
      textOf(await client.callTool({ name: "place_order", arguments: { ...placeArgs, stop_loss_pct: 0.1 } })),
    );
    assert.equal(body.sent, true);
    assert.equal(body.stop.stopPrice, "99900");
  });
  assert.equal(exchange.post("/fapi/v1/order").length, 1);
});

// ---------------------------------------------------------------------------
// Item 16: the fill's own notional, not the requested one.
// ---------------------------------------------------------------------------

test("a fill above the notional cap is reduced and reported", async () => {
  // 900 USD asked for at a mark of 100000, capped at 1000 USD. The fill lands at
  // 110000, so the account really carries 990 USD: inside the cap, nothing to do.
  const small = makeExchange({ marketFill: { avgPrice: "110000", executedQty: "0.009" } });
  await withClient({ env: tradeEnvFile({ SWAL_MAX_NOTIONAL_USD: "1000" }), fetchFn: small.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(
      textOf(await client.callTool({ name: "place_order", arguments: { ...placeArgs, notional_usd: 900 } })),
    );
    assert.equal(body.filledNotionalUsd, 990);
    assert.deepEqual(body.warnings, []);
  });
  assert.equal(small.post("/fapi/v1/order").length, 1, "inside the cap: no reduction");

  // Now the fill is 130000 for the same 900 USD: 1170 USD, more than 1% over the
  // cap. The excess is reduced with a reduceOnly order and reported.
  const over = makeExchange({ marketFill: { avgPrice: "130000", executedQty: "0.009" } });
  await withClient({ env: tradeEnvFile({ SWAL_MAX_NOTIONAL_USD: "1000" }), fetchFn: over.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(
      textOf(await client.callTool({ name: "place_order", arguments: { ...placeArgs, notional_usd: 900 } })),
    );
    assert.equal(body.filledNotionalUsd, Number((130000 * 0.009).toFixed(4)));
    assert.match(body.warnings.join(" "), /exceeded SWAL_MAX_NOTIONAL_USD by 170/);
    assert.match(body.warnings.join(" "), /the excess was reduced/);
  });
  const orders = over.post("/fapi/v1/order");
  assert.equal(orders.length, 2);
  assert.equal(orders[1].params.reduceOnly, "true");
  assert.equal(orders[1].params.side, "SELL");
  // 170 USD over the cap at 130000, rounded UP to stepSize 0.001.
  assert.equal(orders[1].params.quantity, "0.002");
});

test("the reduced excess is reported for its own call, never for the next one", async () => {
  // The flag was module-level state: one fill over the cap left it set, and the
  // next call reported "the fill exceeded SWAL_MAX_NOTIONAL_USD by 170 USD" for a
  // fill that was inside the cap. The warning is per call or it is a lie.
  const over = makeExchange({ marketFill: { avgPrice: "130000", executedQty: "0.009" } });
  const inside = makeExchange({ marketFill: { avgPrice: "100000", executedQty: "0.002" } });
  await withClient({ env: tradeEnvFile({ SWAL_MAX_NOTIONAL_USD: "1000" }), fetchFn: over.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "place_order", arguments: { ...placeArgs, notional_usd: 900 } })));
    assert.match(body.warnings.join(" "), /the excess was reduced/);
  });
  assert.equal(over.post("/fapi/v1/order").length, 2);

  // A second, separate server process: the same account, a fill inside the cap.
  await withClient({ env: tradeEnvFile({ SWAL_MAX_NOTIONAL_USD: "1000" }), fetchFn: inside.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "place_order", arguments: placeArgs })));
    assert.equal(body.filledNotionalUsd, 200);
    assert.deepEqual(body.warnings, []);
  });
  assert.equal(inside.post("/fapi/v1/order").length, 1, "inside the cap: no reduction order");
});

// ---------------------------------------------------------------------------
// Item 13: the journal is a writable regular file, or there is no order.
// ---------------------------------------------------------------------------

test("a journal that is a directory, a FIFO or a device is refused before any order", async () => {
  const cases = [
    { name: "a directory", kind: "dir" },
    { name: "a FIFO", kind: "fifo" },
  ];
  for (const testCase of cases) {
    const blocked = fs.mkdtempSync(path.join(os.tmpdir(), "swal-journal-"));
    const target = path.join(blocked, testCase.name.replace(/\W/g, ""));
    if (testCase.kind === "dir") fs.mkdirSync(target);
    else {
      const { spawnSync } = await import("node:child_process");
      spawnSync("mkfifo", [target]);
    }
    const exchange = makeExchange();
    await withClient({ env: tradeEnvFile({ SWAL_MCP_JOURNAL: target }), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
      const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
      assert.match(text, /not a writable regular file/, testCase.name);
      assert.match(text, /the order was not sent/, testCase.name);
    });
    assert.equal(exchange.post("/fapi/v1/order").length, 0, testCase.name);
    fs.rmSync(blocked, { recursive: true, force: true });
  }
});

test("a missing journal file is created, with owner-only permissions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swal-journal-"));
  const journal = path.join(dir, "nested", "journal.jsonl");
  const exchange = makeExchange();
  await withClient({ env: tradeEnvFile({ SWAL_MCP_JOURNAL: journal }), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    await client.callTool({ name: "place_order", arguments: placeArgs });
  });
  assert.ok(fs.existsSync(journal));
  assert.equal(fs.statSync(journal).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an append that fails after the order was sent surfaces as a warning", async () => {
  // The journal is writable at preflight and broken by the time the record is
  // appended: the order cannot be un-sent, so the result must say so.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swal-journal-"));
  const journal = path.join(dir, "journal.jsonl");
  const exchange = makeExchange();
  const env = tradeEnvFile({ SWAL_MCP_JOURNAL: journal });
  let failingWrites = 0;
  const failing = {
    env,
    fetchFn: exchange.fetchFn,
    now: () => NOW,
    append: async (file, record, secrets) => {
      // The preflight already ran; let the intent and the outcome through and
      // then start failing, which is what a full disk or a rotated file looks
      // like. The order cannot be un-sent, so the result has to say so.
      failingWrites += 1;
      if (failingWrites > 2) throw new Error("ENOSPC: no space left on device");
      const { appendJournal } = await import("../dist/journal.js");
      return appendJournal(file, record, secrets);
    },
  };
  await withClient(failing, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "place_order", arguments: placeArgs })));
    assert.equal(body.sent, true, "the order really was sent");
    assert.match(body.journalWarning, /the order was sent but the journal/);
    assert.match(body.journalWarning, /NOT in the audit trail/);
    assert.ok(body.warnings.some((warning) => /NOT in the audit trail/.test(warning)));
    assert.ok(failingWrites > 2, `the third append should have failed, ${failingWrites} ran`);
  });
  assert.equal(exchange.post("/fapi/v1/order").length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Item 4: an ambiguous entry is resolved, never assumed.
// ---------------------------------------------------------------------------

test("a timed-out entry is resolved by clientOrderId and the position, then protected", async () => {
  // A timeout is not a rejection: the order may have been accepted. The old
  // behaviour reported "the entry order was rejected" and returned, leaving a
  // filled position with no stop.
  const exchange = makeExchange({
    networkErrorOnOrder: [1],
    queryOrder: { clientOrderId: "whatever", status: "FILLED", executedQty: "0.002", avgPrice: "100000", side: "BUY", type: "MARKET" },
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "place_order", arguments: placeArgs })));
    assert.equal(body.ambiguousOutcome, true);
    assert.equal(body.stop.stopPrice, "99500");
    assert.match(body.warnings.join(" "), /was ambiguous/);
  });
  const orders = exchange.post("/fapi/v1/order");
  assert.equal(orders.length, 1, "the entry is never retried blind: retrying doubles the position");
  const queried = exchange.calls.find((call) => call.method === "GET" && call.path === "/fapi/v1/order");
  assert.ok(queried, "the entry must be looked up by origClientOrderId");
  assert.match(queried.params.origClientOrderId, /^swal/);
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 1);
  assert.match(JSON.stringify(journalLines(JOURNAL, "place_order")[0]), /query_by_client_order_id/);
});

test("a lookup answering -2011 does not resolve as not-found", async () => {
  // -2011 "Unknown order sent." is a cancel-only answer. Reading it as a
  // definitive "the order is gone" in the LOOKUP resolves an intent the exchange
  // never ruled on: the order may have filled, and the position read that would
  // have said so is what actually failed here. No resolving outcome is written.
  const exchange = makeExchange({
    networkErrorOnOrder: [1],
    queryOrder: { code: -2011, msg: "Unknown order sent." },
    positionRiskHttpError: 500,
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /the result is unknown/);
    assert.match(text, /startup sweep will report it/);
  });
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 0, "no stop is armed on an unknown result");
  assert.equal(journalLines(JOURNAL, "place_order_intent").length, 1);
  assert.equal(journalLines(JOURNAL, "place_order_outcome").length, 0, "no resolving outcome: the intent stays pending for the sweep");
});

test("a timed-out entry with no fill anywhere sends no stop and says so", async () => {
  const exchange = makeExchange({
    networkErrorOnOrder: [1],
    queryOrder: { code: -2013, msg: "Order does not exist." },
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /could not be confirmed/);
    assert.match(text, /no fill/);
  });
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 0);
  assert.equal(exchange.post("/fapi/v1/order").length, 1);
  // The intent line was written before the entry and the outcome line after it,
  // so a crash in between is still visible to the startup sweep.
  const lines = journalLines();
  assert.equal(lines.filter((line) => line.event === "place_order_intent").length, 1);
  assert.equal(lines.filter((line) => line.event === "place_order_outcome").length, 1);
  assert.equal(lines[0].network, "testnet");
  assert.equal(lines[0].clientOrderId, lines[1].clientOrderId);
});

test("a timed-out MARKET entry whose lookup AND position reads both fail leaves the intent pending for the sweep", async () => {
  // The entry timed out AND neither the clientOrderId lookup nor the position
  // read could answer (both 500). The result is genuinely unknown, so writing a
  // resolving outcome would tell the startup sweep the entry is done when a
  // position may be open. The intent is left pending and no outcome is written.
  const exchange = makeExchange({ networkErrorOnOrder: [1], queryOrderHttpError: 500, positionRiskHttpError: 500 });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /the result is unknown/);
    assert.match(text, /startup sweep will report it/);
  });
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 0, "no stop is armed on an unknown result");
  assert.equal(journalLines(JOURNAL, "place_order_intent").length, 1);
  assert.equal(journalLines(JOURNAL, "place_order_outcome").length, 0, "no resolving outcome: the intent stays pending for the sweep");
});

test("an ambiguous MARKET entry resolved by clientOrderId is capped like an immediate fill", async () => {
  // A timed-out MARKET entry the lookup resolves to a 1170 USD fill over a 1000
  // USD cap: the excess must be reduced exactly as for a fill answered at once.
  // The ambiguous success path used to return before the reduction block and
  // over-order silently.
  const exchange = makeExchange({
    networkErrorOnOrder: [1],
    queryOrder: { clientOrderId: "x", status: "FILLED", executedQty: "0.009", avgPrice: "130000", side: "BUY", type: "MARKET" },
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.009", notional: "1170", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
  });
  await withClient({ env: tradeEnvFile({ SWAL_MAX_NOTIONAL_USD: "1000" }), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "place_order", arguments: { ...placeArgs, notional_usd: 900 } })));
    assert.equal(body.ambiguousOutcome, true);
    assert.equal(body.filledQuantity, 0.009);
    assert.match(body.warnings.join(" "), /the fill exceeded SWAL_MAX_NOTIONAL_USD by 170/);
    assert.match(body.warnings.join(" "), /the excess was reduced/);
  });
  const reduce = exchange.post("/fapi/v1/order").find((order) => order.params.reduceOnly === "true");
  assert.ok(reduce, "the excess of an ambiguous fill is reduced");
  // 170 USD over the cap at 130000, rounded UP to stepSize 0.001.
  assert.equal(reduce.params.quantity, "0.002");
});

test("a timed-out entry that filled but cannot be protected is flattened", async () => {
  const exchange = makeExchange({
    networkErrorOnOrder: [1],
    queryOrder: { clientOrderId: "whatever", status: "FILLED", executedQty: "0.002" },
    algoFailures: [{ code: -2013, msg: "Order does not exist." }, { code: -2013, msg: "Order does not exist." }],
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /was ambiguous/);
    assert.match(text, /the position was closed with a MARKET reduceOnly order/);
  });
  const orders = exchange.post("/fapi/v1/order");
  assert.equal(orders.length, 2);
  assert.equal(orders[1].params.reduceOnly, "true");
});

// ---------------------------------------------------------------------------
// Item 4: the startup sweep.
// ---------------------------------------------------------------------------

test("the startup sweep reports an unprotected position from an intent with no outcome", async () => {
  // The previous process died after the entry was accepted but before the
  // outcome was journaled. The sweep has to find it and say so.
  const exchange = makeExchange({
    positions: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
    algoOrders: [],
  });
  const orphan = {
    ts: new Date(NOW).toISOString(),
    event: "place_order_intent",
    network: "testnet",
    symbol: "BTCUSDT",
    side: "BUY",
    clientOrderId: "swaldeadbeefdeadbeefdeadbeef",
    quantity: "0.002",
    notionalUsd: 200,
    leverage: 2,
  };
  fs.appendFileSync(JOURNAL, `${JSON.stringify(orphan)}\n`);
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = textOf(await client.callTool({ name: "close_position", arguments: { symbol: "ETHUSDT" } }));
    const body = JSON.parse(text);
    assert.equal(body.startupSweep.findings.length, 1);
    assert.equal(body.startupSweep.findings[0].symbol, "BTCUSDT");
    assert.equal(body.startupSweep.findings[0].action, "reported");
    assert.match(body.notes.join(" "), /STARTUP SWEEP/);
  });
  // Reporting only: an unprotected position is not closed without the opt-in.
  assert.equal(exchange.post("/fapi/v1/order").length, 0);
});


test("the startup sweep reports an unprotected position from a refused emergency close without a resolving outcome", async () => {
  const exchange = makeExchange({
    orderStatus: "FILLED",
    algoFailures: [{ code: -1001, msg: "stop failure" }, { code: -1001, msg: "stop failure" }],
    positions: [], // Initially flat so guard passes
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }]
  });

  const originalFetch = exchange.fetchFn;
  let orderCount = 0;
  exchange.fetchFn = async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes("/fapi/v1/order") && init && init.method === "POST") {
      orderCount++;
      if (orderCount === 2) {
        return new Response(JSON.stringify({ code: -2010, msg: "margin is insufficient" }), { status: 400 });
      }
    }
    return originalFetch(url, init);
  };

  let error = null;
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
     error = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
  });
  assert.match(error, /The protective stop failed after|the protective stop failed after/);

  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "close_position", arguments: { symbol: "ETHUSDT" } })));
    assert.equal(body.startupSweep.findings.length, 1);
    assert.equal(body.startupSweep.findings[0].symbol, "BTCUSDT");
    assert.match(body.notes.join(" "), /STARTUP SWEEP/);
  });
});

test("the startup sweep flattens only when SWAL_MCP_STARTUP_FLATTEN=yes", async () => {
  const exchange = makeExchange({
    positions: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
  });
  const orphan = {
    ts: new Date(NOW).toISOString(),
    event: "place_order_intent",
    network: "testnet",
    symbol: "BTCUSDT",
    side: "BUY",
    clientOrderId: "swaldeadbeefdeadbeefdeadbeef",
    quantity: "0.002",
    notionalUsd: 200,
    leverage: 2,
  };
  fs.appendFileSync(JOURNAL, `${JSON.stringify(orphan)}\n`);
  await withClient(
    { env: tradeEnvFile({ SWAL_MCP_STARTUP_FLATTEN: "yes" }), fetchFn: exchange.fetchFn, now: () => NOW },
    async (client) => {
      const body = JSON.parse(textOf(await client.callTool({ name: "close_position", arguments: { symbol: "ETHUSDT" } })));
      assert.equal(body.startupSweep.findings[0].action, "flattened");
      assert.match(body.notes.join(" "), /flattened|closed/);
    },
  );
  const orders = exchange.post("/fapi/v1/order");
  assert.equal(orders.length, 1);
  assert.equal(orders[0].params.reduceOnly, "true");
  assert.equal(orders[0].params.quantity, "0.002");
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

test("close_position nets hedge rows and closes the net, not one leg", async () => {
  // A 0.4 long and a 0.1 short is a net 0.3 long. Closing the LONG row alone
  // sends a 0.4 SELL reduceOnly that the exchange refuses (or closes 0.4 of a
  // 0.4/0.1 hedge and leaves a 0.1 short open on the other side).
  const exchange = makeExchange({
    positions: [
      { symbol: "BTCUSDT", positionAmt: "0.4", notional: "40000", unrealizedProfit: "0", positionSide: "LONG", leverage: "2" },
      { symbol: "BTCUSDT", positionAmt: "-0.1", notional: "-10000", unrealizedProfit: "0", positionSide: "SHORT", leverage: "2" },
    ],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "close_position", arguments: { symbol: "BTCUSDT" } })));
    assert.equal(body.positionQuantity, 0.3);
    assert.equal(body.flat, true);
    assert.equal(body.closeOrder.side, "SELL");
    assert.equal(body.closeOrder.quantity, "0.3");
    assert.match(body.notes.join(" "), /0.3 of BTCUSDT was closed/);
  });
  const orders = exchange.post("/fapi/v1/order");
  assert.equal(orders.length, 1, "one order for the net, not one per row");
  assert.equal(orders[0].params.quantity, "0.3");
});

test("close_position keeps closing until the remainder is zero", async () => {
  // The exchange fills the first close partially, so the position is still open
  // after it. A single-shot close reports success and leaves 0.2 running.
  const exchange = makeExchange({
    positions: [{ symbol: "BTCUSDT", positionAmt: "0.5", notional: "50000", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
    closeReducesTo: { BTCUSDT: ["0.2"] },
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "close_position", arguments: { symbol: "BTCUSDT" } })));
    assert.equal(body.positionQuantity, 0.5);
    assert.equal(body.remaining, 0);
    assert.equal(body.flat, true);
    assert.equal(body.closeOrders.length, 2);
    assert.equal(body.closeOrder.quantity, "0.2");
  });
  const orders = exchange.post("/fapi/v1/order");
  assert.equal(orders.length, 2);
  assert.deepEqual(orders.map((order) => order.params.quantity), ["0.5", "0.2"]);
  assert.ok(orders.every((order) => order.params.reduceOnly === "true"));
});

test("close_position rounds the remainder UP to stepSize, never down", async () => {
  // A remainder of 0.0019 at stepSize 0.001 must be closed with 0.002: rounding
  // down leaves 0.0009 open that the order guard no longer sees.
  const exchange = makeExchange({
    positions: [{ symbol: "BTCUSDT", positionAmt: "0.0019", notional: "190", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "close_position", arguments: { symbol: "BTCUSDT" } })));
    assert.equal(body.closeOrder.quantity, "0.002");
  });
});

test("close_position does NOT cancel the orders while the position is still open", async () => {
  const exchange = makeExchange({
    positions: [{ symbol: "BTCUSDT", positionAmt: "0.5", notional: "50000", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
    closeFailures: [{ code: -2010, msg: "insufficient balance" }, { code: -2010, msg: "insufficient balance" }, { code: -2010, msg: "insufficient balance" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "close_position", arguments: { symbol: "BTCUSDT" } })));
    assert.equal(body.flat, false);
    assert.equal(body.cancelledOrders, null);
    assert.equal(body.cancelledAlgoOrders, null);
    assert.match(body.note, /could NOT be closed/);
    assert.match(body.notes.join(" "), /were NOT cancelled/);
  });
  assert.equal(exchange.calls.filter((call) => call.method === "DELETE").length, 0);
  // One attempt: a reduceOnly rejected for insufficient balance is not accepted
  // by asking again, so the remainder is reported instead of hammered.
  assert.equal(exchange.post("/fapi/v1/order").length, 1);
});

test("close_position works when the notional cap and the whitelist are broken", async () => {
  // Closing is protective: a missing SWAL_MAX_NOTIONAL_USD or a bad whitelist
  // must not be able to trap a position open.
  const exchange = makeExchange({
    positions: [{ symbol: "BTCUSDT", positionAmt: "0.002", notional: "200", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
  });
  const broken = { ...tradeEnvFile() };
  delete broken.SWAL_MCP_SYMBOLS;
  delete broken.SWAL_MAX_NOTIONAL_USD;
  await withClient({ env: broken, fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "close_position", arguments: { symbol: "BTCUSDT" } })));
    assert.equal(body.closeOrder.reduceOnly, "true");
    assert.equal(body.flat, true);
  });
  assert.equal(exchange.post("/fapi/v1/order").length, 1);
  // place_order still refuses the same configuration: the caps are entry-side.
  await withClient({ env: broken, fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /SWAL_MCP_SYMBOLS must list at least one symbol/);
  });
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

test("place_order post_only reprices only a repriceable status and stops on any other", async () => {
  // A REJECTED 200 answer is the exchange refusing THIS order (filters, balance,
  // a symbol it will not take): repricing it one tick away sends two more orders
  // that fail the same way. Only an EXPIRED post-only answer (-5022, "would
  // immediately match") says the order cannot REST and a tick would fix it.
  const rejected = makeExchange({ orderStatus: "REJECTED", orderExecutedQty: "0" });
  await withClient({ env: tradeEnvFile(), fetchFn: rejected.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: { ...placeArgs, type: "post_only" } }));
    assert.match(text, /the order was not sent/);
    assert.match(text, /was answered REJECTED with no fill/);
    assert.match(text, /only an EXPIRED post-only answer/);
  });
  assert.equal(rejected.post("/fapi/v1/order").length, 1, "a REJECTED post-only order is not repriced");
  const cancels = rejected.calls.filter((call) => call.method === "DELETE" && call.path === "/fapi/v1/order");
  assert.equal(cancels.length, 1, "the one order that was sent is cancelled by clientOrderId");
  assert.equal(rejected.post("/fapi/v1/algoOrder").length, 0);
});

test("a read-only journal FILE stops the order, even though its directory is writable", async () => {
  // The preflight used to accept a read-only file whenever the directory was
  // writable, so the order was sent and the audit trail failed afterwards with
  // EACCES. There is no un-sending an order.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swal-journal-ro-"));
  const journal = path.join(dir, "journal.jsonl");
  fs.writeFileSync(journal, "");
  fs.chmodSync(journal, 0o444);
  const exchange = makeExchange();
  await withClient({ env: tradeEnvFile({ SWAL_MCP_JOURNAL: journal }), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "place_order", arguments: placeArgs }));
    assert.match(text, /not a writable regular file/);
    assert.match(text, /the order was not sent/);
  });
  assert.equal(exchange.calls.length, 0, "nothing is read and nothing is written");
  fs.chmodSync(journal, 0o644);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("close_position journals an intent before the close and an outcome after it", async () => {
  const exchange = makeExchange({
    positions: [{ symbol: "BTCUSDT", positionAmt: "-0.5", notional: "-50000", unrealizedProfit: "0", positionSide: "BOTH", leverage: "2" }],
  });
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    await client.callTool({ name: "close_position", arguments: { symbol: "BTCUSDT" } });
  });
  const intents = journalLines(JOURNAL, "close_position_intent");
  const outcomes = journalLines(JOURNAL, "close_position_outcome");
  assert.equal(intents.length, 1);
  assert.equal(outcomes.length, 1);
  assert.equal(intents[0].symbol, "BTCUSDT");
  assert.equal(outcomes[0].intentId, intents[0].intentId);
  assert.equal(outcomes[0].flat, true);
  // The intent is written before the order is sent: it is the line that proves a
  // close that died half-way left a position behind.
  const raw = journalLines();
  assert.ok(raw.findIndex((line) => line.event === "close_position_intent") < raw.findIndex((line) => line.event === "close_position_outcome"));
  assert.equal(exchange.post("/fapi/v1/order").length, 1);
});

test("the liquidation estimate is read after the leverage is set, not before", async () => {
  // positionRisk only reports a liquidationPrice for the leverage that is live, so
  // the estimate read BEFORE setLeverage belongs to whatever leverage the symbol
  // had: a stop is then approved or refused against a liquidation that is not the
  // one this order will trade at.
  const exchange = makeExchange();
  await withClient({ env: tradeEnvFile(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    await client.callTool({ name: "place_order", arguments: placeArgs });
  });
  const steps = exchange.paths();
  const leverage = steps.indexOf("POST /fapi/v1/leverage");
  const margin = steps.indexOf("POST /fapi/v1/marginType");
  const bracket = steps.lastIndexOf("GET /fapi/v1/leverageBracket");
  const risk = steps.lastIndexOf("GET /fapi/v2/positionRisk");
  assert.ok(leverage >= 0 && margin >= 0, steps.join(", "));
  assert.ok(bracket > leverage, `leverageBracket at ${bracket} must come after setLeverage at ${leverage}: ${steps.join(", ")}`);
  assert.ok(bracket > margin, steps.join(", "));
  // The positionRisk read the estimate uses is the one AFTER the leverage: the
  // earlier one is the account snapshot the guard ran against.
  assert.ok(risk > leverage, `positionRisk at ${risk} must come after setLeverage at ${leverage}: ${steps.join(", ")}`);
});
