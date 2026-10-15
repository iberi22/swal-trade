import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildGridPlan, checkGridPlan, createGridPlanStore, gridChecks, MAX_GRID_LEVELS, repriceAway } from "../dist/grid.js";
import { callOrCatch, errorText, textOf, withClient } from "./helpers.mjs";
import { makeExchange, tradeEnv, TRADE_KEY, TRADE_SECRET } from "./trading-fixtures.mjs";
import { readGridLimits } from "../dist/trading-config.js";
import { decimalNumber, decimalsOf, floorToStep, toDecimalText } from "../dist/decimal.js";
import { proposeFromMark } from "../dist/propose.js";

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
  // Measured from the WORST level (97000), not from the average entry (98000):
  // the closest level is the one that loses the most when price runs to the stop.
  assert.equal(plan.stopDistancePct, 2.061856);
  assert.equal(plan.worstLevel.price, "97000");
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

test("the stop distance comes from the worst level, never from the average entry", () => {
  // Three levels 1000 apart, stop 5000 below the lowest. From the average entry
  // the distance is 3.06%; from the worst level it is 2.06%. The level closest
  // to the stop is the one that is still open when price gets there, so the
  // average is the number that hides the risk.
  const built = buildGridPlan({
    args: { symbol: "BTCUSDT", lower: 97000, upper: 104000, levels: 8, total_notional_usd: 80000, stop_loss_price: 92000 },
    filters: FILTERS,
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const plan = built.value;
  assert.equal(plan.worstLevel.price, "97000");
  assert.equal(plan.stopPrice, "92000");
  assert.equal(plan.stopDistancePct, 5.154639);
  // The same distance measured from the average entry, for contrast: it is the
  // larger, more comfortable number, which is exactly why it must not be used.
  const fromAverage = (Math.abs(plan.averageEntryUsd - 92000) / plan.averageEntryUsd) * 100;
  assert.ok(fromAverage > plan.stopDistancePct);
  // The total quantity is the sum of the levels, aligned to stepSize: summing the
  // doubles directly gives 0.7599999999999999, which floors to 0.75 and reports a
  // grid one step smaller than the one that was placed.
  assert.equal(plan.totalQuantity, "0.76");
  assert.equal(plan.averageEntryUsd, 100394.736842);
  assert.equal(plan.worstCaseLossUsd, 6380);
});

test("a grid whose levels collapse on one tick is refused, not merged", () => {
  // 20 levels across a 10-point range at tickSize 1: several of them round to the
  // same integer, which silently becomes one order for double the size.
  const collapse = buildGridPlan({
    args: { symbol: "BTCUSDT", lower: 97000, upper: 97010, levels: 20, total_notional_usd: 100000, stop_loss_price: 96000 },
    filters: { ...FILTERS, tickSize: "1" },
  });
  assert.equal(collapse.ok, false);
  if (!collapse.ok) assert.match(collapse.error, /both round to .* at tickSize 1/);
  // A range that survives the rounding is still fine.
  const fine = buildGridPlan({
    args: { symbol: "BTCUSDT", lower: 97000, upper: 99000, levels: 3, total_notional_usd: 3000, stop_loss_price: 96000 },
    filters: FILTERS,
  });
  assert.equal(fine.ok, true);
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
  if (!tiny.ok) assert.match(tiny.error, /level 1 at 97000 rounds to a quantity of zero at stepSize 1/);
  // A level that cannot be sized fails the WHOLE plan: the grid is never placed
  // with fewer levels than the plan says.
  assert.equal(tiny.warnings, undefined);
});

test("a level that cannot be sized fails the plan, it is never dropped", () => {
  // The top level is 100000 with stepSize 1: 1000 USD there is a quantity of
  // 0.01, which floors to zero. Dropping it used to leave a ONE-level grid sold
  // as a two-level one, with the stop, the worst case and the notional computed
  // from a ladder the account does not have.
  const built = buildGridPlan({
    args: { symbol: "BTCUSDT", lower: 1000, upper: 100000000, levels: 2, total_notional_usd: 500000, stop_loss_price: 900 },
    filters: { ...FILTERS, stepSize: "1", minQty: "1" },
  });
  assert.equal(built.ok, false);
  if (!built.ok) {
    assert.match(built.error, /level 2 at 100000000 rounds to a quantity of zero at stepSize 1/);
    assert.match(built.error, /250000 USD per level over 2 levels/);
    assert.equal(/dropped/.test(built.error), false);
  }

  // The same range with a notional that sizes both levels plans normally.
  const sized = buildGridPlan({
    args: { symbol: "BTCUSDT", lower: 1000, upper: 100000000, levels: 2, total_notional_usd: 500000000000, stop_loss_price: 900 },
    filters: { ...FILTERS, stepSize: "1", minQty: "1" },
  });
  assert.equal(sized.ok, true);
  if (sized.ok) assert.deepEqual(sized.value.levels.map((level) => level.quantity), ["250000000", "2500"]);
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
  // triggerPrice, never price: the algo service ignores a price on a STOP_MARKET,
  // which either 400s or rests an order with no trigger at all.
  assert.equal(algo.params.price, undefined);
  assert.equal(algo.params.triggerPrice, "95000");
  assert.equal(algo.params.algoType, "CONDITIONAL");
  assert.equal(algo.params.priceProtect, "TRUE");
  assert.equal(algo.params.timeInForce, "GTC");
  assert.ok(steps.indexOf("POST /fapi/v1/leverage") < levels[0][0]);
  assert.ok(steps.indexOf("POST /fapi/v1/marginType") < levels[0][0]);

  const lines = journalLines().filter((line) => line.event === "grid_place");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "grid_place");
  assert.equal(lines[0].guard.allow, true);
  assert.equal(lines[0].result.levelCount, 3);
  const raw = fs.readFileSync(JOURNAL, "utf8");
  assert.equal(raw.includes(TRADE_SECRET), false);
  assert.equal(raw.includes(TRADE_KEY), false);
});

test("the grid liquidation estimate is read from the worst level, not from the average entry", async () => {
  // The stop is measured from the worst level, so the liquidation estimate has to
  // be too: at the average entry the estimate is further away, and a grid stop
  // that fails against the closest level is approved.
  fs.rmSync(JOURNAL, { force: true });
  const exchange = makeExchange({ symbols: GRID_SYMBOLS });
  await withClient({ env: gridPlaceEnv(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    await client.callTool({ name: "grid_place", arguments: { symbol: "BTCUSDT", ...gridArgs } });
  });
  const line = journalLines().find((entry) => entry.event === "grid_place");
  const liquidation = line.exchange.find((item) => item.step === "liquidation");
  assert.equal(liquidation.source, "leverageBracket");
  assert.equal(liquidation.maintenanceMarginRatio, 0.004);
  // 1/5 leverage with a 0.004 maintenance margin ratio.
  const fraction = (1 / 5 - 0.004) / (1 - 0.004);
  const fromWorstLevel = 97000 * (1 - fraction);
  const fromAverageEntry = 98000 * (1 - fraction);
  assert.ok(Math.abs(liquidation.price - fromWorstLevel) < 0.01, `${liquidation.price} vs ${fromWorstLevel}`);
  assert.ok(Math.abs(liquidation.price - fromAverageEntry) > 10, `${liquidation.price} must not be measured from the average entry`);
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

test("grid_place treats an EXPIRED answer with a fill as a fill, not as a reprice", async () => {
  // A GTX level can be rejected with EXPIRED in the same instant it fills. The
  // executedQty in that answer is the only evidence of the exposure, so repricing
  // it away reports a grid that never happened while the account holds a position.
  fs.rmSync(JOURNAL, { force: true });
  const exchange = makeExchange({
    symbols: GRID_SYMBOLS,
    orderStatus: "EXPIRED",
    orderExecutedQty: "0.1",
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.1", notional: "9700", unrealizedProfit: "0", positionSide: "BOTH", leverage: "1" }],
  });
  await withClient({ env: gridPlaceEnv(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "grid_place", arguments: { symbol: "BTCUSDT", ...gridArgs } })));
    assert.equal(body.levelCount, 3);
    assert.equal(body.filledQuantity, 0.3);
  });
  // One attempt per level: a fill is not retried.
  assert.equal(exchange.post("/fapi/v1/order").length, 3);
  const orders = exchange.post("/fapi/v1/order");
  assert.deepEqual(orders.map((order) => order.params.price), ["97000", "98000", "99000"]);
  assert.equal(orders.every((order) => String(order.params.clientOrderId).startsWith("swal")), true);
});

test("grid_place does not reprice across the protective stop", async () => {
  // Level 1 sits one tick above the stop at 95000 with tickSize 1: repricing down
  // would move the entry to 94999, on the far side of the exit.
  fs.rmSync(JOURNAL, { force: true });
  const exchange = makeExchange({
    symbols: { BTCUSDT: { stepSize: "0.01", minQty: "0.01", tickSize: "1", minNotional: "5" } },
    orderFailures: [
      { code: -5022, msg: "Order would immediately match." },
      { code: -5022, msg: "Order would immediately match." },
      { code: -5022, msg: "Order would immediately match." },
    ],
  });
  await withClient({ env: gridPlaceEnv(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(
      await client.callTool({
        name: "grid_place",
        arguments: { symbol: "BTCUSDT", lower: 95001, upper: 96002, levels: 2, total_notional_usd: 19000, stop_loss_price: 95000 },
      }),
    );
    assert.match(text, /would cross the protective stop/);
  });
  for (const order of exchange.post("/fapi/v1/order")) {
    assert.ok(Number(order.params.price) > 95000, `${order.params.price} must stay above the stop`);
  }
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 0);
});

test("grid_place only reprices on a repriceable answer, and resolves a timeout first", async () => {
  fs.rmSync(JOURNAL, { force: true });
  const exchange = makeExchange({
    symbols: GRID_SYMBOLS,
    orderFailures: [{ code: -2010, msg: "insufficient balance" }],
  });
  await withClient({ env: gridPlaceEnv(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "grid_place", arguments: { symbol: "BTCUSDT", ...gridArgs } }));
    assert.match(text, /could not be rested as a post-only order/);
    assert.match(text, /insufficient balance/);
  });
  // A balance error is not a reprice: one attempt, then the fail-closed exit.
  assert.equal(exchange.post("/fapi/v1/order").length, 1);

  fs.rmSync(JOURNAL, { force: true });
  const timedOut = makeExchange({ symbols: GRID_SYMBOLS, networkErrorOnOrder: [1] });
  await withClient({ env: gridPlaceEnv(), fetchFn: timedOut.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "grid_place", arguments: { symbol: "BTCUSDT", ...gridArgs } }));
    assert.match(text, /the lookup by clientOrderId did not settle/);
  });
  assert.equal(timedOut.post("/fapi/v1/order").length, 1, "a timeout is never retried blind");
  assert.ok(timedOut.calls.some((call) => call.method === "GET" && call.path === "/fapi/v1/order"));
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
  const line = journalLines().find((entry) => entry.event === "grid_place");
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
    assert.match(text, /The grid was not placed/);
  });
  // Level 1 repriced once and then stopped; no stop was ever armed.
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 0);
  const closed = exchange.post("/fapi/v1/order").filter((order) => order.params.reduceOnly === "true");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].params.quantity, "0.1");
});

// ---------------------------------------------------------------------------
// F11: a FAILED flatten leaves the intent pending (no grid_place_outcome), and a
// successful one writes it. M1 is applied at both emergencyClose sites.
// ---------------------------------------------------------------------------

test("a failed flatten after a LEVEL failure writes NO grid_place_outcome (F11)", async () => {
  // The grid died on a level and the emergency close was refused: the position
  // is still open, so writing a resolving outcome would tell the startup sweep
  // the grid is done. The intent must stay pending.
  fs.rmSync(JOURNAL, { force: true });
  const exchange = makeExchange({
    symbols: GRID_SYMBOLS,
    orderFailures: [
      { code: -5022, msg: "Order would immediately match." },
      { code: -2013, msg: "Order does not exist." },
    ],
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.1", notional: "9700", unrealizedProfit: "0", positionSide: "BOTH", leverage: "1" }],
    closeFailures: [{ code: -2010, msg: "insufficient balance" }],
  });
  await withClient({ env: gridPlaceEnv(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "grid_place", arguments: { symbol: "BTCUSDT", ...gridArgs } }));
    assert.match(text, /could not be rested as a post-only order/);
    assert.match(text, /could NOT be closed/);
    assert.match(text, /MANUAL ACTION REQUIRED/);
  });
  assert.equal(journalLines().filter((line) => line.event === "grid_place_intent").length, 1);
  assert.equal(journalLines().filter((line) => line.event === "grid_place_outcome").length, 0, "the intent stays pending for the sweep");
});

test("a failed flatten after a STOP failure writes NO grid_place_outcome (F11)", async () => {
  fs.rmSync(JOURNAL, { force: true });
  const exchange = makeExchange({
    symbols: GRID_SYMBOLS,
    algoFailures: [{ code: -2013, msg: "Order does not exist." }, { code: -2013, msg: "Order does not exist." }],
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.3", notional: "29400", unrealizedProfit: "0", positionSide: "BOTH", leverage: "1" }],
    closeFailures: [{ code: -2010, msg: "insufficient balance" }],
  });
  await withClient({ env: gridPlaceEnv(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "grid_place", arguments: { symbol: "BTCUSDT", ...gridArgs } }));
    assert.match(text, /protective stop below the grid failed after 2 attempts/);
    assert.match(text, /could NOT be closed/);
    assert.match(text, /MANUAL ACTION REQUIRED/);
  });
  assert.equal(journalLines().filter((line) => line.event === "grid_place_intent").length, 1);
  assert.equal(journalLines().filter((line) => line.event === "grid_place_outcome").length, 0, "the intent stays pending for the sweep");
});

test("a level failure whose flatten succeeds DOES write the outcome (F11 control)", async () => {
  // The control case for the two tests above: when the flatten proves the
  // position is closed, the grid IS resolved and the outcome is written.
  fs.rmSync(JOURNAL, { force: true });
  const exchange = makeExchange({
    symbols: GRID_SYMBOLS,
    orderFailures: [
      { code: -5022, msg: "Order would immediately match." },
      { code: -2013, msg: "Order does not exist." },
    ],
    positionsAfterOrder: [{ symbol: "BTCUSDT", positionAmt: "0.1", notional: "9700", unrealizedProfit: "0", positionSide: "BOTH", leverage: "1" }],
  });
  await withClient({ env: gridPlaceEnv(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "grid_place", arguments: { symbol: "BTCUSDT", ...gridArgs } }));
    assert.match(text, /could not be rested as a post-only order/);
    assert.match(text, /the position was closed/);
  });
  const outcomes = journalLines().filter((line) => line.event === "grid_place_outcome");
  assert.equal(outcomes.length, 1, "a confirmed flat position resolves the grid");
  assert.equal(outcomes[0].placed, 0);
});

// ---------------------------------------------------------------------------
// Item N1: sizing a level never depends on how many decimals the double carries.
//
// notional / price is an IEEE754 division: at 5 USD over 150000 it is
// 0.00006666666666666667, twenty decimals, and roundDecimal refuses more than
// eighteen on purpose. When that refusal reached the planner, the level was
// dropped with a warning and the grid was placed one level (or every level)
// smaller than the plan said. The quotient is truncated with toDecimalText
// before it is aligned, which is the honest version of that number.
// ---------------------------------------------------------------------------

/** (stepSize, tickSize) pairs real USD-M symbols publish, with a price of each. */
const FILTER_COMBOS = [
  { name: "BTCUSDT", price: 112000, step: "0.001", tick: "0.1" },
  { name: "ETHUSDT", price: 3800, step: "0.001", tick: "0.01" },
  { name: "SOLUSDT", price: 190, step: "0.01", tick: "0.01" },
  { name: "DOGEUSDT", price: 0.19, step: "1", tick: "0.00001" },
  { name: "XRPUSDT", price: 2.4, step: "1", tick: "0.0001" },
  { name: "1000PEPEUSDT", price: 0.011, step: "1", tick: "0.00000001" },
  { name: "SUIUSDT", price: 3.3, step: "0.1", tick: "0.0001" },
  { name: "LINKUSDT", price: 22, step: "0.01", tick: "0.001" },
  { name: "PAXGUSDT", price: 4700, step: "0.001", tick: "0.01" },
  // A high price against a small notional: the quotients here are the ones with
  // more than eighteen decimals, the case that used to drop the level.
  { name: "BTCUSDT", price: 150000, step: "0.000001", tick: "0.1" },
  { name: "PAXGUSDT", price: 300000, step: "0.00001", tick: "1" },
  { name: "CRVUSDT", price: 75000, step: "0.01", tick: "0.001" },
];

/** Per-level notionals chosen because they divide badly against these prices. */
const PER_LEVEL_NOTIONALS = [5, 7, 10, 25, 33.33, 100, 137.5, 1000];
/** Multiples of exactly one step, the smallest notional that sizes a level. */
const STEP_MULTIPLES = [1.05, 1.5, 2, 3, 7.5, 33, 137, 1200];
const LEVEL_COUNTS = [2, 3, 5, 8, 13, 20];

const aligned = (value, step) => floorToStep(value, step) === value;

test("every level of every realistic combination is sized and step aligned", () => {
  let plans = 0;
  let refusedQuotients = 0;
  for (const combo of FILTER_COMBOS) {
    const unit = decimalNumber(combo.step) * combo.price; // notional of exactly one step
    for (const perLevel of [...PER_LEVEL_NOTIONALS.filter((value) => value >= unit), ...STEP_MULTIPLES.map((k) => unit * k)]) {
      if (decimalsOf(perLevel / combo.price) === null) refusedQuotients += 1;
      for (const levels of LEVEL_COUNTS) {
        const total = perLevel * levels;
        const lower = combo.price * 0.98;
        const upper = combo.price * 1.02;
        const stop = combo.price * 0.95;
        const built = buildGridPlan(
          {
            args: { symbol: combo.name, lower, upper, levels, total_notional_usd: total, stop_loss_price: stop },
            filters: { stepSize: combo.step, minQty: combo.step, tickSize: combo.tick, minNotional: "5" },
          },
        );
        const where = `${combo.name} price=${combo.price} step=${combo.step} tick=${combo.tick} notional=${total} levels=${levels}`;
        assert.equal(built.ok, true, `${where}: ${built.ok ? "" : built.error}`);
        if (!built.ok) continue;
        const plan = built.value;
        plans += 1;
        // No level is dropped: the ladder placed is the ladder asked for.
        assert.equal(plan.levels.length, levels, `${where}: ${plan.levels.length} levels planned`);
        assert.deepEqual(
          plan.levels.map((level) => level.index),
          Array.from({ length: levels }, (_, index) => index + 1),
          where,
        );
        for (const level of plan.levels) {
          assert.ok(aligned(level.quantity, combo.step), `${where}: quantity ${level.quantity} is not a multiple of ${combo.step}`);
          assert.ok(decimalNumber(level.quantity) > 0, `${where}: quantity ${level.quantity} is zero`);
          assert.ok(aligned(level.price, combo.tick), `${where}: price ${level.price} is not a multiple of ${combo.tick}`);
          assert.ok(level.notionalUsd > 0, `${where}: notional ${level.notionalUsd}`);
        }
        // Rounding can only lose, never gain: the ladder never exceeds the ask.
        assert.ok(plan.totalNotionalUsd <= total + 1e-9, `${where}: total ${plan.totalNotionalUsd} exceeds ${total}`);
      }
    }
  }
  assert.ok(plans > 500, `the property test should cover hundreds of combinations, it covered ${plans}`);
  // The regression this test exists for: quotients the decimal guard refuses
  // (more than eighteen decimals), which used to drop the level.
  assert.ok(refusedQuotients > 20, `expected many more-than-eighteen-decimal quotients, found ${refusedQuotients}`);
});

test("the same quotient sizes an order and a proposal, not only a grid", () => {
  const filters = { stepSize: "0.000001", minQty: "0.000001", tickSize: "0.1", minNotional: "5" };
  const notional = 10;
  const price = 150000;
  // 10 / 150000 = 0.00006666666666666667: twenty decimals, refused by the guard
  // that used to make this a "cannot be aligned to stepSize" rejection.
  assert.equal(decimalsOf(notional / price), null);

  const proposed = proposeFromMark({ symbol: "BTCUSDT", side: "BUY", notionalUsd: notional, stopLossPct: 0.5, leverage: 1, markPrice: price, limits: { maxLeverage: null, maxNotionalUsd: null, dailyLossUsd: null }, filters });
  assert.equal(proposed.ok, true);
  if (!proposed.ok) return;
  assert.equal(proposed.proposal.quantityString, "0.000066");
  assert.equal(proposed.proposal.rounding.applied, true);
  assert.deepEqual(proposed.proposal.violations, []);

  // The same numbers through the writer's own formula: floorToStep over the
  // truncated quotient, which is what place_order sends.
  assert.equal(floorToStep(toDecimalText(notional / price), filters.stepSize), "0.000066");
});

// ---------------------------------------------------------------------------
// Item N3: the grid is checked against the exposure cap, like every order.
//
// A ladder is not one order: it commits the whole totalNotionalUsd, on top of
// what the account already has on that symbol (positions plus resting entries
// plus pending algo entries). place_order has always compared that total;
// checkGridPlan only compared the grid against the cap, so a second grid on a
// symbol that already had a resting entry passed the cap twice.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Item N3: the grid is checked against the exposure cap, like every order.
//---------------------------------------------------------------------------

test("grid_place refuses when the exposure cannot be read instead of placing against an unknown exposure", async () => {
  // A 429 on GET /fapi/v1/openOrders leaves the exposure at 0 and the cap passes.
  // Fail closed before the guard: no level is placed over an unknown exposure.
  fs.rmSync(JOURNAL, { force: true });
  const exchange = makeExchange({ symbols: GRID_SYMBOLS, openOrdersHttpError: 429 });
  await withClient({ env: gridPlaceEnv(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "grid_place", arguments: { symbol: "BTCUSDT", ...gridArgs } }));
    assert.match(text, /the exposure could not be read/);
    assert.match(text, /refusing the grid instead of placing it against an unknown exposure/);
  });
  assert.equal(exchange.post("/fapi/v1/order").length, 0, "no level is placed over an unknown exposure");
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 0);
});

test("checkGridPlan refuses a grid that would take the account past the exposure cap", () => {
  const plan = buildGridPlan({
    args: { symbol: "BTCUSDT", lower: 100, upper: 102, levels: 3, total_notional_usd: 300, stop_loss_price: 95 },
    filters: FILTERS,
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const limits = { symbols: ["BTCUSDT"], maxNotionalUsd: 400, maxLeverage: 5, maxOpenPositions: 3, dailyLossUsd: 100 };
  const account = { dayPnl: 0, openPositions: 1, unprotectedSymbols: [], openNotionalUsd: 200, pendingSymbols: ["BTCUSDT"] };

  const clean = checkGridPlan(plan.value, limits, { dayPnl: 0, openPositions: 0, unprotectedSymbols: [] }, 5, 5);
  assert.deepEqual(clean, { allow: true, reasons: [] });

  const over = checkGridPlan(plan.value, limits, account, 5, 5);
  assert.equal(over.allow, false);
  assert.equal(over.reasons.length, 1, over.reasons.join(" | "));
  assert.match(over.reasons[0], /already has 200 USD committed/);
  assert.match(over.reasons[0], /adds 299.95 USD/);
  assert.match(over.reasons[0], /exceeds SWAL_MAX_NOTIONAL_USD 400 USD/);
});

test("grid_place refuses a grid that sits on top of a resting entry order", async () => {
  // The resting BUY of 200 USD is committed money, and the ladder adds 300 USD:
  // 500 USD of exposure against a 400 USD cap. Neither order breaks the cap alone.
  //
  // Round 6: that resting entry is now refused one step earlier, by the
  // flat-symbol rule. A grid OPENS a position, so it is not placed on a symbol
  // that already has a resting entry: the fail-closed exit flattens the symbol
  // and cancels its orders, which on a symbol the user is holding by hand would
  // close THEIR position and strip THEIR stops. The cap arithmetic itself stays
  // covered by checkGridPlan's own test below, which is pure.
  fs.rmSync(JOURNAL, { force: true });
  const exchange = makeExchange({
    symbols: GRID_SYMBOLS,
    openOrders: [{ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", price: "100", quantity: "2", clientOrderId: "resting-1" }],
  });
  await withClient(
    {
      env: gridPlaceEnv({ SWAL_MAX_NOTIONAL_USD: "400", SWAL_MCP_MAX_POSITIONS: "3" }),
      fetchFn: exchange.fetchFn,
      now: () => NOW,
    },
    async (client) => {
      const text = errorText(
        await client.callTool({
          name: "grid_place",
          arguments: { symbol: "BTCUSDT", lower: 100, upper: 102, levels: 3, total_notional_usd: 300, stop_loss_price: 95 },
        }),
      );
      assert.match(text, /BTCUSDT already has an open position or orders; this tool only opens a position on a flat symbol/);
    },
  );
  assert.equal(exchange.post("/fapi/v1/order").length, 0, "no level may be placed over the cap");
  assert.equal(exchange.post("/fapi/v1/algoOrder").length, 0);
  const line = journalLines(JOURNAL, "grid_place")[0];
  assert.equal(line.guard.allow, false);
  assert.ok(line.guard.reasons.some((reason) => /only opens a position on a flat symbol/.test(reason)), JSON.stringify(line.guard));
});

// ---------------------------------------------------------------------------
// Item 6: a 200 answer is not permission to reprice.
//
// The grid used to reprice on ANY status that was not NEW and carried no fill: a
// REJECTED level sent two more orders, each rejected the same way, before the
// ladder failed. Only an EXPIRED post-only answer (the exchange's "would
// immediately match", -5022) means the order cannot rest and a tick away would
// fix it.
// ---------------------------------------------------------------------------

test("grid_place reprices only a repriceable status and stops on any other", async () => {
  // REJECTED with no fill: one attempt, then the ladder fails closed.
  fs.rmSync(JOURNAL, { force: true });
  const rejected = makeExchange({ symbols: GRID_SYMBOLS, orderStatus: "REJECTED", orderExecutedQty: "0" });
  await withClient({ env: gridPlaceEnv(), fetchFn: rejected.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "grid_place", arguments: { symbol: "BTCUSDT", ...gridArgs } }));
    assert.match(text, /could not be rested as a post-only order/);
    assert.match(text, /was answered REJECTED with no fill/);
    assert.match(text, /only an EXPIRED post-only answer/);
  });
  assert.equal(rejected.post("/fapi/v1/order").length, 1, "a REJECTED level is never repriced");
  assert.equal(rejected.post("/fapi/v1/algoOrder").length, 0);

  // An unlabelled status (no status field at all) is the same refusal.
  fs.rmSync(JOURNAL, { force: true });
  const unlabelled = makeExchange({ symbols: GRID_SYMBOLS, orderStatus: "", orderExecutedQty: "0" });
  await withClient({ env: gridPlaceEnv(), fetchFn: unlabelled.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "grid_place", arguments: { symbol: "BTCUSDT", ...gridArgs } }));
    assert.match(text, /with an unlabelled status/);
  });
  assert.equal(unlabelled.post("/fapi/v1/order").length, 1);

  // EXPIRED with no fill is the repriceable one: three attempts, one tick apart.
  fs.rmSync(JOURNAL, { force: true });
  const expired = makeExchange({ symbols: { BTCUSDT: { stepSize: "0.01", minQty: "0.01", tickSize: "1", minNotional: "5" } }, orderStatus: "EXPIRED", orderExecutedQty: "0" });
  await withClient({ env: gridPlaceEnv(), fetchFn: expired.fetchFn, now: () => NOW }, async (client) => {
    const text = errorText(await client.callTool({ name: "grid_place", arguments: { symbol: "BTCUSDT", ...gridArgs } }));
    assert.match(text, /could not be rested after 3 attempts/);
  });
  const orders = expired.post("/fapi/v1/order");
  assert.equal(orders.length, 3, "an EXPIRED post-only level is repriced");
  assert.deepEqual(orders.map((order) => order.params.price), ["97000", "96999", "96998"]);
});

test("grid_place journals the whole ladder as an intent before the first level", async () => {
  // The record withJournal writes only exists at the end of the call, so a process
  // that dies between two levels leaves no trace of what was sent. The intent line
  // carries the ladder, and the sweep can find it.
  fs.rmSync(JOURNAL, { force: true });
  const exchange = makeExchange({ symbols: GRID_SYMBOLS });
  await withClient({ env: gridPlaceEnv(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    await client.callTool({ name: "grid_place", arguments: { symbol: "BTCUSDT", ...gridArgs } });
  });
  const intents = journalLines().filter((line) => line.event === "grid_place_intent");
  const outcomes = journalLines().filter((line) => line.event === "grid_place_outcome");
  assert.equal(intents.length, 1);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].intentId, intents[0].intentId);
  assert.equal(outcomes[0].placed, 3);
  assert.deepEqual(intents[0].levels, [
    { index: 1, side: "BUY", price: "97000", quantity: "0.1" },
    { index: 2, side: "BUY", price: "98000", quantity: "0.1" },
    { index: 3, side: "BUY", price: "99000", quantity: "0.1" },
  ]);
  assert.equal(intents[0].quantity, "0.3");
  assert.equal(intents[0].stopPrice, "95000");
  assert.equal(journalLines().findIndex((line) => line.event === "grid_place_intent") < 3, true);
});

test("the startup sweep reports a grid whose outcome was never journaled", async () => {
  // A grid that died between two levels: resting entries, maybe a fill, and no
  // outcome line. The sweep asks the exchange and says so.
  const exchange = makeExchange({
    positions: [{ symbol: "BTCUSDT", positionAmt: "0.1", notional: "9700", unrealizedProfit: "0", positionSide: "BOTH", leverage: "1" }],
  });
  const orphan = {
    ts: new Date(NOW).toISOString(),
    event: "grid_place_intent",
    network: "testnet",
    symbol: "BTCUSDT",
    intentId: "swalgriddeadbeefdeadbeefdeadbeef",
    side: "BUY",
    quantity: "0.3",
    notionalUsd: 29400,
    leverage: 5,
    levels: [],
  };
  fs.appendFileSync(JOURNAL, `${JSON.stringify(orphan)}\n`);
  await withClient({ env: gridPlaceEnv(), fetchFn: exchange.fetchFn, now: () => NOW }, async (client) => {
    const body = JSON.parse(textOf(await client.callTool({ name: "close_position", arguments: { symbol: "ETHUSDT" } })));
    assert.equal(body.startupSweep.findings.length, 1);
    assert.equal(body.startupSweep.findings[0].symbol, "BTCUSDT");
    assert.equal(body.startupSweep.findings[0].tool, "grid_place");
    assert.match(body.notes.join(" "), /from a grid placement \(grid_place:/);
  });
  assert.equal(exchange.post("/fapi/v1/order").length, 0, "reporting only");
});

test("grid_plan reads from the base the write tools would use, never a re-derived one", async () => {
  // mainnet without SWAL_MCP_MAINNET_CONFIRM is not mainnet: grid_place refuses
  // and stays on testnet, so the plan must be priced against testnet. Reading
  // mainnet here is how a plan is explained with one price and placed with another.
  const exchange = makeExchange({ symbols: GRID_SYMBOLS });
  await withClient(
    { env: { SWAL_MCP_NETWORK: "mainnet" }, fetchFn: exchange.fetchFn, now: () => NOW },
    async (client) => {
      const body = JSON.parse(
        textOf(await client.callTool({ name: "grid_plan", arguments: { symbol: "BTCUSDT", ...gridArgs } })),
      );
      assert.equal(body.network, "testnet");
    },
  );
  for (const call of exchange.calls) {
    assert.equal(new URL(call.url).origin, "https://testnet.binancefuture.com");
  }

  exchange.calls.length = 0;
  await withClient(
    { env: { SWAL_MCP_NETWORK: "mainnet", SWAL_MCP_MAINNET_CONFIRM: "yes" }, fetchFn: exchange.fetchFn, now: () => NOW },
    async (client) => {
      const body = JSON.parse(
        textOf(await client.callTool({ name: "grid_plan", arguments: { symbol: "BTCUSDT", ...gridArgs } })),
      );
      assert.equal(body.network, "mainnet");
    },
  );
  for (const call of exchange.calls) {
    assert.equal(new URL(call.url).origin, "https://fapi.binance.com");
  }
});
