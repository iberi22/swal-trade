import test from "node:test";
import assert from "node:assert/strict";
import * as risk from "../dist/risk.js";
import { parseAccountRiskConfig, parseProposalLimits } from "../dist/config.js";

const pos = (symbol = "BTCUSDC", amt = "0.01", positionSide = "BOTH") => ({
  symbol,
  amt,
  notional: 500,
  unrealized: 0,
  positionSide,
});
const algo = (symbol = "BTCUSDC", side = "SELL", orderType = "STOP_MARKET", kw = {}) => ({
  symbol,
  side,
  orderType,
  ...kw,
});

test("dayStartMs respects TZ offset", () => {
  const now = Date.UTC(2026, 9, 9, 3, 0);
  assert.equal(risk.dayStartMs(now, -5), Date.UTC(2026, 9, 8, 5, 0));
  assert.equal(risk.dayStartMs(now, 0), Date.UTC(2026, 9, 9, 0, 0));
});

test("realizedUsd sums only pnl types in USD assets", () => {
  const rows = [
    { incomeType: "REALIZED_PNL", asset: "USDT", income: "10.5" },
    { incomeType: "COMMISSION", asset: "USDC", income: "-0.5" },
    { incomeType: "FUNDING_FEE", asset: "FDUSD", income: "-1" },
    { incomeType: "TRANSFER", asset: "USDT", income: "1000" },
    { incomeType: "REALIZED_PNL", asset: "BNB", income: "5" },
  ];
  assert.equal(risk.realizedUsd(rows), 9);
});

test("positionsFrom filters zero positions", () => {
  const positions = risk.positionsFrom({
    positions: [
      { symbol: "A", positionAmt: "0", notional: "0", unrealizedProfit: "0" },
      { symbol: "B", positionAmt: "-0.5", notional: "-100", unrealizedProfit: "2", positionSide: "SHORT" },
    ],
  });
  assert.deepEqual(positions, [{ symbol: "B", amt: "-0.5", notional: 100, unrealized: 2, positionSide: "SHORT" }]);
});

test("breaches: daily warn/hit, notional, leverage", () => {
  const cfg = { limit: 100, warn: 0.7, maxNotional: 400, maxLev: 5 };
  assert.deepEqual(Object.keys(risk.breaches(-50, [], {}, cfg)), []);
  assert.deepEqual(Object.keys(risk.breaches(-70, [], {}, cfg)), ["daily_warn"]);
  assert.deepEqual(Object.keys(risk.breaches(-100, [], {}, cfg)), ["daily_hit"]);
  const found = risk.breaches(0, [pos()], { BTCUSDC: 10 }, cfg);
  assert.ok(found["notional:BTCUSDC"].includes("500"));
  assert.ok(found["lev:BTCUSDC"].includes("10x"));
  assert.ok(risk.breaches(-100, [], {}, cfg).daily_hit.includes("limite -100.00"));
});

test("hasStop cases", () => {
  assert.ok(risk.hasStop(pos(), [algo("BTCUSDC", "SELL", "STOP_MARKET", { closePosition: true })]));
  assert.ok(risk.hasStop(pos(), [algo("BTCUSDC", "SELL", "STOP_MARKET", { reduceOnly: "true" })]));
  assert.ok(!risk.hasStop(pos(), [algo("BTCUSDC", "BUY", "STOP_MARKET", { closePosition: true })]));
  assert.ok(!risk.hasStop(pos(), [algo("ETHUSDC", "SELL", "STOP_MARKET", { closePosition: true })]));
  assert.ok(!risk.hasStop(pos(), [algo("BTCUSDC", "SELL", "TAKE_PROFIT_MARKET", { closePosition: true })]));
  assert.ok(!risk.hasStop(pos(), [algo("BTCUSDC", "SELL", "STOP_MARKET", { closePosition: false, reduceOnly: false })]));
  assert.ok(risk.hasStop(pos("BTCUSDC", "-0.01"), [algo("BTCUSDC", "BUY", "STOP_MARKET", { closePosition: true })]));
  assert.ok(!risk.hasStop(pos("BTCUSDC", "-0.01"), [algo("BTCUSDC", "SELL", "STOP_MARKET", { closePosition: true })]));
  const hedge = pos("BTCUSDC", "0.01", "LONG");
  assert.ok(!risk.hasStop(hedge, [algo("BTCUSDC", "SELL", "STOP_MARKET", { closePosition: true, positionSide: "SHORT" })]));
  assert.ok(risk.hasStop(hedge, [algo("BTCUSDC", "SELL", "STOP_MARKET", { closePosition: true, positionSide: "LONG" })]));
  assert.equal(risk.unprotected([pos(), pos("ETHUSDC")], [algo("BTCUSDC", "SELL", "STOP_MARKET", { closePosition: true })]).length, 1);
});

test("stopAlertsDue text and rate limit", () => {
  const last = new Map();
  const miss = [pos("ETHUSDC", "-0.5")];
  assert.deepEqual(risk.stopAlertsDue(miss, last, 1000, 600), ["SIN STOP: ETHUSDC SHORT 0.5"]);
  assert.deepEqual(risk.stopAlertsDue(miss, last, 1100, 600), []);
  assert.equal(risk.stopAlertsDue(miss, last, 1700, 600).length, 1);
  risk.stopAlertsDue([], last, 1800, 600);
  assert.equal(risk.stopAlertsDue(miss, last, 1801, 600).length, 1);
});

test("newBreaches dedupes", () => {
  const alerted = new Set();
  assert.deepEqual(risk.newBreaches({ b: "1", a: "1" }, alerted), ["a", "b"]);
  assert.deepEqual(risk.newBreaches({ a: "1", c: "1" }, alerted), ["c"]);
});

test("evaluateAccount combines pnl, leverage, notional, and missing stops", () => {
  const snapshot = risk.evaluateAccount({
    account: {
      positions: [
        { symbol: "BTCUSDC", positionAmt: "0.01", notional: "500", unrealizedProfit: "0", positionSide: "BOTH" },
        { symbol: "ETHUSDC", positionAmt: "0", notional: "0", unrealizedProfit: "0" },
      ],
    },
    positionRisk: [{ symbol: "BTCUSDC", positionAmt: "0.01", leverage: "10" }],
    income: [
      { incomeType: "REALIZED_PNL", asset: "USDT", income: "-80" },
      { incomeType: "TRANSFER", asset: "USDT", income: "1000" },
    ],
    algoOrders: [algo("BTCUSDC", "SELL", "TAKE_PROFIT_MARKET", { closePosition: true })],
    cfg: { limit: 100, warn: 0.7, maxNotional: 400, maxLev: 5 },
  });
  assert.equal(snapshot.realized, -80);
  assert.equal(snapshot.dayPnl, -80);
  assert.deepEqual(Object.keys(snapshot.breaches).sort(), ["daily_warn", "lev:BTCUSDC", "notional:BTCUSDC"]);
  assert.deepEqual(snapshot.unprotected.map((position) => position.symbol), ["BTCUSDC"]);
});

test("parseAccountRiskConfig and proposal limits", () => {
  assert.equal(parseAccountRiskConfig({}).ok, false);
  assert.equal(parseAccountRiskConfig({ SWAL_DAILY_LOSS_USD: "0" }).ok, false);
  const parsed = parseAccountRiskConfig({ SWAL_DAILY_LOSS_USD: "50", SWAL_MAX_LEVERAGE: "10" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.value, { limit: 50, warn: 0.7, maxNotional: null, maxLev: 10, tz: -5 });
  }
  assert.equal(parseAccountRiskConfig({ SWAL_DAILY_LOSS_USD: "50", SWAL_TZ_OFFSET_HOURS: "30" }).ok, false);
  assert.equal(parseAccountRiskConfig({ SWAL_DAILY_LOSS_USD: "50", SWAL_MAX_NOTIONAL_USD: "nope" }).ok, false);
  const proposal = parseProposalLimits({ SWAL_MAX_LEVERAGE: "3", SWAL_DAILY_LOSS_USD: "25" });
  assert.equal(proposal.ok, true);
  if (proposal.ok) assert.equal(proposal.value.dailyLossUsd, 25);
  assert.equal(parseProposalLimits({ SWAL_MAX_LEVERAGE: "-1" }).ok, false);
});
