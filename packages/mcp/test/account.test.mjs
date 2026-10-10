import test from "node:test";
import assert from "node:assert/strict";
import { netPosition, readExposure } from "../dist/account.js";
import { dailyPnl, evaluateAccount } from "../dist/risk.js";

const NOW = Date.UTC(2026, 9, 9, 3, 0);

const row = (symbol, positionAmt, positionSide = "BOTH") => ({ symbol, positionAmt, positionSide });

// ---------------------------------------------------------------------------
// Item 2: every row of the symbol is netted.
// ---------------------------------------------------------------------------

test("netPosition nets one-way BOTH rows, never the last one it happens to see", () => {
  const risk = [row("ETHUSDT", "0.5", "BOTH"), row("BTCUSDT", "0.002", "BOTH")];
  assert.deepEqual(netPosition(risk, "BTCUSDT"), {
    amount: 0.002,
    rows: [{ positionAmt: 0.002, positionSide: "BOTH" }],
    error: null,
  });
});

test("netPosition adds hedge LONG and SHORT into one signed quantity", () => {
  // A 0.4 long and a 0.1 short is a net 0.3 long. Closing the first row would
  // close 0.4 and leave the short leg open on the other side of the market.
  const risk = [row("BTCUSDT", "0.4", "LONG"), row("BTCUSDT", "-0.1", "SHORT")];
  const net = netPosition(risk, "BTCUSDT");
  assert.equal(net.amount, 0.3);
  assert.equal(net.rows.length, 2);
});

test("netPosition keeps the sign of a net short", () => {
  const risk = [row("BTCUSDT", "0.1", "LONG"), row("BTCUSDT", "-0.5", "SHORT")];
  assert.equal(netPosition(risk, "BTCUSDT").amount, -0.4);
});

test("netPosition reads zero as a real zero and a missing row as no answer", () => {
  const flat = [row("BTCUSDT", "0", "BOTH")];
  assert.equal(netPosition(flat, "BTCUSDT").amount, 0);
  const none = netPosition([row("ETHUSDT", "1", "BOTH")], "BTCUSDT");
  assert.equal(none.amount, null);
  assert.equal(none.rows.length, 0);
});

test("netPosition reports a row whose quantity cannot be read instead of guessing zero", () => {
  const broken = [row("BTCUSDT", "not-a-number", "BOTH")];
  const net = netPosition(broken, "BTCUSDT");
  assert.equal(net.amount, null);
  assert.match(net.error ?? "", /positionAmt is not a number/);
});

test("netPosition refuses a positionRisk that is not an array", () => {
  assert.match(netPosition({ nope: true }, "BTCUSDT").error ?? "", /not an array/);
});

// ---------------------------------------------------------------------------
// Item 11: the daily lock counts realized plus only the NEGATIVE unrealized.
// ---------------------------------------------------------------------------

test("the daily PnL counts an unrealized loss but not an unrealized profit", () => {
  // +500 unrealized on a -100 realized day is not a day that can take new risk.
  assert.equal(dailyPnl(-100, -50), -150);
  assert.equal(dailyPnl(-100, 500), -100);
  assert.equal(dailyPnl(-100, 0), -100);
  assert.equal(dailyPnl(200, -50), 150);
});

test("evaluateAccount refuses new exposure when a paper loss offsets a realized one the wrong way", () => {
  const snapshot = evaluateAccount({
    account: {
      positions: [
        { symbol: "BTCUSDT", positionAmt: "1", notional: "1000", unrealizedProfit: "-120", positionSide: "BOTH" },
        { symbol: "ETHUSDT", positionAmt: "1", notional: "1000", unrealizedProfit: "400", positionSide: "BOTH" },
      ],
    },
    positionRisk: [],
    income: [{ incomeType: "REALIZED_PNL", asset: "USDT", income: "-30", time: 1 }],
    algoOrders: [],
    cfg: { limit: 100, maxNotional: null, maxLev: null },
  });
  // -30 realized, -120 unrealized from BTCUSDT; the +400 of ETHUSDT does not
  // buy headroom.
  assert.equal(snapshot.dayPnl, -150);
  assert.equal(snapshot.unrealized, 280);
  assert.match(snapshot.breaches.daily_hit ?? "", /limite diario alcanzado/);
});

// ---------------------------------------------------------------------------
// Item 8: the exposure the guard sees includes resting orders.
// ---------------------------------------------------------------------------

const clientStub = (answers) => ({
  account: async () => answers.account,
  positionRisk: async () => answers.positionRisk,
  openOrders: async () => answers.openOrders,
  openAlgoOrders: async () => answers.algoOrders,
});

test("readExposure counts resting open orders and protective orders separately", async () => {
  const exposure = await readExposure({
    client: clientStub({
      account: { positions: [{ symbol: "BTCUSDT", positionAmt: "0.01", notional: "-500", unrealizedProfit: "0", positionSide: "BOTH" }] },
      positionRisk: [row("BTCUSDT", "-0.01")],
      openOrders: [
        { symbol: "BTCUSDT", side: "BUY", type: "LIMIT", price: "40000", quantity: "0.05", clientOrderId: "x-1" },
        { symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", stopPrice: "38000", quantity: "0.01", reduceOnly: true },
      ],
      algoOrders: [{ symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", algoId: 7, closePosition: true }],
    }),
    symbol: "BTCUSDT",
    markPrice: 40000,
  });
  assert.deepEqual(exposure.errors, []);
  assert.deepEqual(exposure.positionSymbols, ["BTCUSDT"]);
  assert.deepEqual(exposure.pendingSymbols, ["BTCUSDT"]);
  // The position's 500 USD plus the 2000 USD of the resting entry.
  assert.equal(exposure.openNotionalUsd, 2500);
  assert.equal(exposure.restingOrders.length, 1, "a reduceOnly stop never counts as exposure");
  assert.equal(exposure.openPositions, 1);
});

test("readExposure fails closed when a source cannot be read", async () => {
  const exposure = await readExposure({
    client: {
      account: async () => {
        throw new Error("boom");
      },
      positionRisk: async () => [],
      openOrders: async () => {
        throw new Error("nope");
      },
      openAlgoOrders: async () => [],
    },
    symbol: "BTCUSDT",
    markPrice: 40000,
  });
  assert.equal(exposure.errors.length, 2);
  assert.match(exposure.errors.join(" "), /account: boom/);
  assert.match(exposure.errors.join(" "), /openOrders: nope/);
});

test("readExposure nets hedge rows before deciding the symbol has a position", async () => {
  const exposure = await readExposure({
    client: clientStub({
      account: { positions: [] },
      positionRisk: [row("BTCUSDT", "0.4", "LONG"), row("BTCUSDT", "-0.4", "SHORT")],
      openOrders: [],
      algoOrders: [],
    }),
    symbol: "BTCUSDT",
    markPrice: 40000,
  });
  // A net of zero is no position at all.
  assert.deepEqual(exposure.positionSymbols, []);
  assert.equal(exposure.openPositions, 0);
  void NOW;
});
