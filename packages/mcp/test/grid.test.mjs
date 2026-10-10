import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildGridPlan, createGridPlanStore, gridChecks, MAX_GRID_LEVELS, repriceAway } from "../dist/grid.js";
import { callOrCatch, errorText, textOf, withClient } from "./helpers.mjs";
import { makeExchange, tradeEnv, TRADE_KEY, TRADE_SECRET } from "./trading-fixtures.mjs";
import { readGridLimits } from "../dist/trading-config.js";

const NOW = Date.UTC(2026, 9, 9, 3, 0);

/** Coarse filters so the expected quantities are exact. */
const GRID_SYMBOLS = {
  BTCUSDT: { stepSize: "0.01", minQty: "0.01", tickSize: "1", minNotional: "5" },
};

const FILTERS = { symbol: "BTCUSDT", stepSize: "0.01", minQty: "0.01", tickSize: "1", minNotional: "5" };

const gridArgs = { lower: 97000, upper: 99000, levels: 3, total_notional_usd: 30000, stop_loss_price: 95000 };

/** tradeEnv pinned to this file's journal, so parallel test files never share one. */
const tradeEnvFile = (extra = {}) => tradeEnv({ SWAL_MCP_JOURNAL: JOURNAL, ...extra });

const JOURNAL = `/tmp/swal-trade-test-journal-grid.jsonl`;

function journalLines(file = JOURNAL) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// The math.
// ---------------------------------------------------------------------------

test("buildGridPlan prices a long grid, sizes every level and computes the worst case", () => {
  const built = buildGridPlan({ args: { ...gridArgs, symbol: "BTCUSDT" }, filters: FILTERS });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const plan = built.value;
  assert.equal(plan.direction, "long");
  assert.equal(plan.entrySide, "BUY");
  assert.equal(plan.stopSide, "SELL");
  assert.deepEqual(plan.levels.map((level) => level.price), ["97000", "98000", "99000"]);
  assert.deepEqual(plan.levels.map((level) => level.quantity), ["0.1", "0.1", "0.1"]);
  assert.deepEqual(plan.levels.map((level) => level.notionalUsd), [9700, 9800, 9900]);
  assert.equal(plan.totalQuantity, "0.3");
  assert.equal(plan.totalNotionalUsd, 29400);
  assert.equal(plan.averageEntryUsd, 98000);
  assert.equal(plan.worstCaseLossUsd, 900);
  assert.equal(plan.stopPrice, "95000");
  assert.equal(plan.stopDistancePct, 3.061224);
  assert.deepEqual(plan.warnings, []);
  assert.equal(plan.planId.startsWith("g"), true);
  assert.equal(plan.planId.length, 13);
});

test("buildGridPlan reads the direction from the stop and prices a short grid", () => {
  const built = buildGridPlan({
    args: { symbol: "BTCUSDT", lower: 101000, upper: 103000, levels: 2, total_notional_usd: 20000, stop_loss_price: 105000 },
    filters: FILTERS,
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.value.direction, "short");
  assert.equal(built.value.entrySide, "SELL");
  assert.equal(built.value.stopSide, "BUY");
  assert.deepEqual(built.value.levels.map((level) => level.price), ["101000", "103000"]);
  // 10000 / 101000 = 0.099 -> 0.09; 10000 / 103000 = 0.097 -> 0.09.
  assert.deepEqual(built.value.levels.map((level) => level.quantity), ["0.09", "0.09"]);
  assert.equal(built.value.worstCaseLossUsd, 540);
  assert.equal(built.value.stopPrice, "105000");
});

test("buildGridPlan rejects a stop inside the range and unusable parameters", () => {
  const inside = buildGridPlan({ args: { ...gridArgs, symbol: "BTCUSDT", stop_loss_price: 98000 }, filters: FILTERS });
  assert.equal(inside.ok, false);
  if (!inside.ok) assert.match(inside.error, /is inside the \[97000, 99000\] range/);

  const flat = buildGridPlan({ args: { ...gridArgs, symbol: "BTCUSDT", lower: 99000, upper: 99000 }, filters: FILTERS });
  assert.equal(flat.ok, false);
  if (!flat.ok) assert.match(flat.error, /upper must be greater than lower/);

  const tooMany = buildGridPlan({ args: { ...gridArgs, symbol: "BTCUSDT", levels: MAX_GRID_LEVELS + 1 }, filters: FILTERS });
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.match(tooMany.error, /from 2 to 20/);

  const one = buildGridPlan({ args: { ...gridArgs, symbol: "BTCUSDT", levels: 1 }, filters: FILTERS });
  assert.equal(one.ok, false);

  const noNotional = buildGridPlan({ args: { ...gridArgs, symbol: "BTCUSDT", total_notional_usd: 0 }, filters: FILTERS });
  assert.equal(noNotional.ok, false);

  const tiny = buildGridPlan({
    args: { symbol: "BTCUSDT", lower: 97000, upper: 97010, levels: 20, total_notional_usd: 10, stop_loss_price: 96000 },
    filters: { ...FILTERS, stepSize: "1", minQty: "1" },
  });
  assert.equal(tiny.ok, false);
  if (!tiny.ok) assert.match(tiny.error, /no level survives rounding/);
});

test("a level that would cross the book is reported, not silently placed", () => {
  const built = buildGridPlan({
    args: { symbol: "BTCUSDT", lower: 97000, upper: 101000, levels: 3, total_notional_usd: 30000, stop_loss_price: 95000 },
    filters: FILTERS,
    markPrice: 100000,
    bestBid: "99999",
    bestAsk: "100000.1",
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  // Only the top level crosses: the others stay below the best ask.
  const crossing = built.value.warnings.filter((warning) => /cross the book/.test(warning));
  assert.equal(crossing.length, 1, built.value.warnings.join(" | "));
  assert.equal(gridChecks(built.value, readGridLimits({ SWAL_MAX_NOTIONAL_USD: "100000" })).placeable, false);
});

test("repriceAway moves a post-only price one tick away from the book", () => {
  assert.equal(repriceAway("97000", "1", "BUY"), "96999");
  assert.equal(repriceAway("97000", "1", "SELL"), "97001");
  assert.equal(repriceAway("0.5", "1", "BUY"), null);
});

test("the plan store keeps ids for one hour and caps its size", () => {
  let now = 1000;
  const store = createGridPlanStore(() => now);
  const plan = { planId: "gabc" };
  store.save(plan);
  assert.equal(store.get("gabc"), plan);
  now += 60 * 60 * 1000 + 1;
  assert.equal(store.get("gabc"), null);
  now = 0;
  const small = createGridPlanStore(() => now, 60_000, 2);
  small.save({ planId: "a" });
  small.save({ planId: "b" });
  small.save({ planId: "c" });
  assert.deepEqual([...new Set(["a", "b", "c"].map((id) => (small.get(id) ? id : null)))].filter(Boolean).sort(), ["b", "c"]);
});

// ---------------------------------------------------------------------------
// grid_plan through the tool: read-only.
// ---------------------------------------------------------------------------

test("grid_plan is read-only, needs no keys and writes no journal", async () => {
  fs.rmSync(JOURNAL, { force: true });
  const exchange = makeExchange({ symbols: GRID_SYMBOLS });
  await withClient({ env: {}, fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(
      textOf(
        await client.callTool({
          name: "grid_plan",
          arguments: { symbol: "BTCUSDT", ...gridArgs },
        }),
      ),
    );
    assert.equal(body.readOnly, true);
    assert.equal(body.direction, "long");
    assert.equal(body.symbol, "BTCUSDT");
    assert.equal(body.totalQuantity, "0.3");
    assert.equal(body.worstCaseLossUsd, 900);
    assert.equal(body.tradingEnabled, false);
    assert.match(body.note, /grid_place is disabled/);
    assert.equal(body.planId.startsWith("g"), true);
    // The grid_plan description must carry the flag note and the no-strategy note.
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "grid_plan");
    assert.match(tool.description, /SWAL_MCP_TRADING=enabled/);
    assert.match(tool.description, /no strategy, no signal and no recommendation/);
  });
  // Only public GETs: exchangeInfo, premiumIndex, bookTicker. No signature, no key.
  assert.deepEqual(exchange.paths().sort(), ["GET /fapi/v1/exchangeInfo", "GET /fapi/v1/premiumIndex", "GET /fapi/v1/ticker/bookTicker"]);
  for (const call of exchange.calls) assert.equal(call.signed, false);
  assert.deepEqual(journalLines(), []);
});

test("grid_plan reports the notional cap and refuses nothing on its own", async () => {
  const exchange = makeExchange({ symbols: GRID_SYMBOLS });
  await withClient(
    { env: { SWAL_MCP_TRADING: "enabled", SWAL_MAX_NOTIONAL_USD: "1000" }, fetchFn: exchange.fetchFn, now: () => NOW },
    async (client) => {
      const body = JSON.parse(
        textOf(await client.callTool({ name: "grid_plan", arguments: { symbol: "BTCUSDT", ...gridArgs } })),
      );
      assert.equal(body.checks.placeable, false);
      assert.match(body.checks.failures.join(" "), /exceeds SWAL_MAX_NOTIONAL_USD 1000/);
    },
  );
});

// ---------------------------------------------------------------------------
// grid_place: write tool.
// ---------------------------------------------------------------------------

const gridPlaceEnv = (extra = {}) => tradeEnvFile({ SWAL_MCP_JOURNAL: JOURNAL, SWAL_MAX_NOTIONAL_USD: "50000", ...extra });

test("grid_place places the plan as post-only limits with one protective stop", async () => {
  fs.rmSync(JOURNAL, { force: true });
  const exchange = makeExchange({ symbols: GRID_SYMBOLS });
  await withClient({ env: gridPlaceEnv(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const plan = JSON.parse(textOf(await client.callTool({ name: "grid_plan", arguments: { symbol: "BTCUSDT", ...gridArgs } })));
    const body = JSON.parse(textOf(await client.callTool({ name: "grid_place", arguments: { plan_id: plan.planId } })));
    assert.equal(body.network, "testnet");
    assert.equal(body.symbol, "BTCUSDT");
    assert.equal(body.direction, "long");
    assert.equal(body.sent, true);
    assert.equal(body.levelCount, 3);
    assert.equal(body.totalQuantity, "0.3");
    assert.equal(body.worstCaseLossUsd, 900);
    assert.equal(body.stop.type, "STOP_MARKET");
  });

  const steps = exchange.paths();
  const levels = [...steps.entries()].filter(([, value]) => /^POST \/fapi\/v1\/order$/.test(value));
  assert.equal(levels.length, 3);
  const algoIndex = steps.indexOf("POST /fapi/v1/algoOrder");
  assert.ok(algoIndex > levels[levels.length - 1][0], steps.join(", "));

  const orders = exchange.post("/fapi/v1/order");
  assert.deepEqual(orders.map((order) => order.params.price), ["97000", "98000", "99000"]);
  for (const order of orders) {
    assert.equal(order.params.type, "LIMIT");
    assert.equal(order.params.timeInForce, "GTX");
    assert.equal(order.params.side, "BUY");
    assert.equal(order.params.quantity, "0.1");
  }
  const algo = exchange.post("/fapi/v1/algoOrder")[0];
  assert.equal(algo.params.type, "STOP_MARKET");
  assert.equal(algo.params.side, "SELL");
  assert.equal(algo.params.closePosition, "true");
  assert.equal(algo.params.workingType, "MARK_PRICE");
  assert.equal(algo.params.price, "95000");
  assert.ok(steps.indexOf("POST /fapi/v1/leverage") < levels[0][0]);
  assert.ok(steps.indexOf("POST /fapi/v1/marginType") < levels[0][0]);

  const lines = journalLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "grid_place");
  assert.equal(lines[0].guard.allow, true);
  assert.equal(lines[0].result.levelCount, 3);
  const raw = fs.readFileSync(JOURNAL, "utf8");
  assert.equal(raw.includes(TRADE_SECRET), false);
  assert.equal(raw.includes(TRADE_KEY), false);
});

test("grid_place accepts the parameters instead of a plan id", async () => {
  fs.rmSync(JOURNAL, { force: true });
  const exchange = makeExchange({ symbols: GRID_SYMBOLS });
  await withClient({ env: gridPlaceEnv(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "grid_place", arguments: { symbol: "BTCUSDT", ...gridArgs } })));
    assert.equal(body.levelCount, 3);
  });
  assert.equal(exchange.post("/fapi/v1/order").length, 3);
});

test("grid_place refuses a level that crosses the book, an unknown plan and mismatched parameters", async () => {
  const crossing = { symbol: "BTCUSDT", lower: 97000, upper: 101000, levels: 3, total_notional_usd: 30000, stop_loss_price: 95000 };
  const exchange = makeExchange({ symbols: GRID_SYMBOLS });
  await withClient({ env: gridPlaceEnv(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "grid_place", arguments: crossing }));
    assert.match(text, /would cross the book/);
    assert.equal(exchange.post("/fapi/v1/order").length, 0);

    const unknown = errorText(await client.callTool({ name: "grid_place", arguments: { plan_id: "gnope" } }));
    assert.match(unknown, /unknown or expired/);

    const plan = JSON.parse(textOf(await client.callTool({ name: "grid_plan", arguments: { symbol: "BTCUSDT", ...gridArgs } })));
    const mismatched = errorText(
      await client.callTool({ name: "grid_place", arguments: { plan_id: plan.planId, total_notional_usd: 31000 } }),
    );
    assert.match(mismatched, /do not match the stored plan/);
    assert.equal(exchange.post("/fapi/v1/order").length, 0);
  });
});

test("grid_place refuses the daily loss lock, an open position and a notional over the cap", async () => {
  const cases = [
    {
      name: "the daily loss lock",
      env: {},
      income: [{ incomeType: "REALIZED_PNL", asset: "USDT", income: "-250", time: 1 }],
      expect: /daily-loss lock/,
      guard: true,
    },
    {
      name: "an open position",
      env: { SWAL_MCP_MAX_POSITIONS: "1" },
      positions: [{ symbol: "ETHUSDT", positionAmt: "0.5", notional: "50000", unrealizedProfit: "0", positionSide: "BOTH", leverage: "1" }],
      expect: /max open positions reached/,
      guard: true,
    },
    {
      name: "the notional cap",
      env: { SWAL_MAX_NOTIONAL_USD: "1000" },
      expect: /exceeds SWAL_MAX_NOTIONAL_USD/,
      guard: false,
    },
  ];
  for (const testCase of cases) {
    fs.rmSync(JOURNAL, { force: true });
    const exchange = makeExchange({ symbols: GRID_SYMBOLS, income: testCase.income, positions: testCase.positions ?? [] });
    await withClient({ env: gridPlaceEnv(testCase.env), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
      const text = errorText(await client.callTool({ name: "grid_place", arguments: { symbol: "BTCUSDT", ...gridArgs } }));
      assert.match(text, testCase.expect, testCase.name);
    });
    assert.equal(exchange.post("/fapi/v1/order").length, 0, testCase.name);
    const lines = journalLines();
    assert.equal(lines.length, 1);
    if (testCase.guard) {
      assert.equal(lines[0].guard.allow, false, testCase.name);
      assert.ok(lines[0].guard.reasons.some((reason) => testCase.expect.test(reason)), JSON.stringify(lines[0].guard));
    } else {
      // The cap is checked before the account is even read, so there is no guard decision yet.
      assert.equal(lines[0].guard, null, testCase.name);
      assert.match(lines[0].error, testCase.expect);
    }
    fs.rmSync(JOURNAL, { force: true });
  }
});

test("grid_place is fail-closed: a stop that fails twice cancels the grid and closes the position", async () => {
  fs.rmSync(JOURNAL, { force: true });
  const exchange = makeExchange({
    symbols: GRID_SYMBOLS,
    algoFailures: [{ code: -2013, msg: "Order does not exist." }, { code: -2013, msg: "Order does not exist." }],
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.3", notional: "29400", unrealizedProfit: "0", positionSide: "BOTH", leverage: "1" }],
  });
  await withClient({ env: gridPlaceEnv(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "grid_place", arguments: { symbol: "BTCUSDT", ...gridArgs } }));
    assert.match(text, /protective stop below the grid failed after 2 attempts/);
    assert.match(text, /closed/);
  });
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 2);
  // Three grid levels, plus the MARKET reduceOnly close.
  const orders = exchange.post("/fapi/v1/order");
  assert.equal(orders.length, 4);
  assert.equal(orders[3].params.type, "MARKET");
  assert.equal(orders[3].params.reduceOnly, "true");
  assert.equal(orders[3].params.quantity, "0.3");
  assert.ok(exchange.calls.some((call) => call.method === "DELETE" && call.path === "/fapi/v1/allOpenOrders"));
  const line = journalLines()[0];
  assert.match(line.error, /protective stop below the grid failed/);
  assert.ok(line.exchange.some((item) => item.step === "emergency_close"));
});

test("grid_place is fail-closed when a level cannot be rested", async () => {
  fs.rmSync(JOURNAL, { force: true });
  const exchange = makeExchange({
    symbols: GRID_SYMBOLS,
    orderFailures: [
      { code: -5022, msg: "Order would immediately match." },
      { code: -5022, msg: "Order would immediately match." },
      { code: -2013, msg: "Order does not exist." },
      { code: -2013, msg: "Order does not exist." },
    ],
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.1", notional: "9700", unrealizedProfit: "0", positionSide: "BOTH", leverage: "1" }],
  });
  await withClient({ env: gridPlaceEnv(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "grid_place", arguments: { symbol: "BTCUSDT", ...gridArgs } }));
    assert.match(text, /could not be rested as a post-only order/);
    assert.match(text, /The grid was cancelled/);
  });
  // Level 1 repriced once and then stopped; no stop was ever armed.
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 0);
  const closed = exchange.post("/fapi/v1/order").filter((order) => order.params.reduceOnly === "true");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].params.quantity, "0.1");
});
