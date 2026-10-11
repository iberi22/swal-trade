import test from "node:test";
import assert from "node:assert/strict";
import {
  checkOrder,
  dailyLockReason,
  leverageReason,
  notionalReason,
  openPositionsReason,
  stopReason,
  symbolReason,
  takeProfitReason,
  unprotectedReasons,
} from "../dist/order-guard.js";

const limits = {
  symbols: ["BTCUSDT", "ETHUSDT"],
  maxNotionalUsd: 1000,
  maxLeverage: 5,
  maxOpenPositions: 1,
  dailyLossUsd: 100,
};

const account = { dayPnl: 0, openPositions: 0, unprotectedSymbols: [] };

const base = {
  symbol: "BTCUSDT",
  side: "BUY",
  notionalUsd: 200,
  stopLossPct: 1,
  takeProfitPct: null,
  leverage: 1,
  orderType: "market",
};

const reasonsOf = (decision) => (decision.allow ? [] : decision.reasons);
const first = (decision) => reasonsOf(decision)[0] ?? "";
const has = (decision, pattern) => reasonsOf(decision).some((reason) => pattern.test(reason));

test("allows a compliant order", () => {
  assert.deepEqual(checkOrder(base, limits, account), { allow: true, reasons: [] });
});

test("rejects a symbol outside the whitelist", () => {
  const decision = checkOrder({ ...base, symbol: "DOGEUSDT" }, limits, account);
  assert.equal(decision.allow, false);
  assert.match(first(decision), /not in the SWAL_MCP_SYMBOLS whitelist/);
});

test("an empty whitelist allows nothing", () => {
  const decision = checkOrder(base, { ...limits, symbols: [] }, account);
  assert.match(first(decision), /SWAL_MCP_SYMBOLS is empty/);
});

test("the stop is mandatory and must be inside the safe liquidation distance", () => {
  const highLeverage = { ...limits, maxLeverage: 50 };
  assert.match(first(checkOrder({ ...base, stopLossPct: Number.NaN }, limits, account)), /stop_loss_pct must be a finite percent/);
  assert.match(first(checkOrder({ ...base, stopLossPct: 0 }, limits, account)), /stop_loss_pct must be a finite percent/);
  assert.match(first(checkOrder({ ...base, stopLossPct: 100 }, limits, account)), /stop_loss_pct must be a finite percent/);
  // 100 / 50 = 2% liquidation; a 2% stop is already at it.
  assert.ok(has(checkOrder({ ...base, stopLossPct: 2, leverage: 50 }, highLeverage, account), /at or beyond the simplified liquidation distance/));
  // 80% of 2% is 1.6%.
  assert.ok(has(checkOrder({ ...base, stopLossPct: 1.8, leverage: 50 }, highLeverage, account), /1\.6% is 80% of 2%/));
  // Exactly at the safe distance is allowed.
  assert.equal(checkOrder({ ...base, stopLossPct: 1.6, leverage: 50 }, highLeverage, account).allow, true);
});

test("the notional cap refuses anything above SWAL_MAX_NOTIONAL_USD", () => {
  const decision = checkOrder({ ...base, notionalUsd: 1001 }, limits, account);
  assert.match(first(decision), /notional 1001 USD exceeds SWAL_MAX_NOTIONAL_USD 1000 USD/);
  assert.match(first(checkOrder({ ...base, notionalUsd: Number.NaN }, limits, account)), /notional_usd must be a finite number/);
  assert.match(first(checkOrder({ ...base, notionalUsd: 0 }, limits, account)), /notional_usd must be a finite number/);
  // An unusable cap is not "no cap".
  assert.match(notionalReason(10, Number.NaN) ?? "", /not a usable positive limit/);
  assert.equal(notionalReason(200, 1000), null);
});

test("the leverage cap and the integer rule", () => {
  assert.match(first(checkOrder({ ...base, leverage: 6 }, limits, account)), /leverage 6x exceeds SWAL_MAX_LEVERAGE 5x/);
  assert.match(first(checkOrder({ ...base, leverage: 1.5 }, limits, account)), /leverage must be an integer/);
  assert.match(first(checkOrder({ ...base, leverage: 0.5 }, limits, account)), /leverage must be an integer/);
  assert.match(first(checkOrder({ ...base, leverage: Number.NaN }, limits, account)), /leverage must be an integer/);
  assert.equal(checkOrder({ ...base, leverage: 5 }, limits, account).allow, true);
  assert.match(leverageReason(2, 1.5), /SWAL_MAX_LEVERAGE is not a usable positive integer/);
  assert.equal(leverageReason(5, 5), null);
});

test("the daily loss lock refuses new orders and cannot be skipped", () => {
  assert.match(first(checkOrder(base, limits, { ...account, dayPnl: -100 })), /daily-loss lock/);
  assert.match(first(checkOrder(base, limits, { ...account, dayPnl: -340 })), /daily-loss lock/);
  // Just above the limit still allows the order.
  assert.equal(checkOrder(base, limits, { ...account, dayPnl: -99.99 }).allow, true);
  // A PnL that cannot be read is a rejection, not a pass.
  assert.match(first(checkOrder(base, limits, { ...account, dayPnl: Number.NaN })), /could not be read as a finite number/);
  assert.match(dailyLockReason(0, 0), /not a usable positive limit/);
  assert.equal(dailyLockReason(-10, 100), null);
});

test("the open position cap counts the positions already open", () => {
  assert.match(first(checkOrder(base, limits, { ...account, openPositions: 1 })), /max open positions reached: 1 open, SWAL_MCP_MAX_POSITIONS is 1/);
  assert.match(first(checkOrder(base, { ...limits, maxOpenPositions: 0 }, account)), /SWAL_MCP_MAX_POSITIONS is not a usable positive integer/);
  assert.match(openPositionsReason(-1, 1), /not usable/);
  assert.equal(openPositionsReason(0, 1), null);
});

test("an unprotected position refuses new exposure", () => {
  const decision = checkOrder(base, limits, { ...account, unprotectedSymbols: ["ETHUSDT"] });
  assert.match(first(decision), /open position ETHUSDT has no STOP_MARKET algo order/);
  assert.deepEqual(unprotectedReasons([]), []);
});

test("the take profit, when given, has to be a sane percent", () => {
  assert.equal(takeProfitReason(null), null);
  assert.equal(takeProfitReason(2), null);
  assert.match(takeProfitReason(0) ?? "", /take_profit_pct must be a finite percent/);
  assert.match(takeProfitReason(Number.NaN) ?? "", /take_profit_pct must be a finite percent/);
  assert.match(first(checkOrder({ ...base, takeProfitPct: -1 }, limits, account)), /take_profit_pct/);
  assert.equal(checkOrder({ ...base, takeProfitPct: 3 }, limits, account).allow, true);
});

test("every broken rule is reported at once, in rule order", () => {
  const decision = checkOrder(
    { ...base, symbol: "DOGEUSDT", notionalUsd: 5000, leverage: 9, stopLossPct: 40 },
    limits,
    { dayPnl: -250, openPositions: 1, unprotectedSymbols: ["ETHUSDT"] },
  );
  assert.equal(decision.allow, false);
  if (decision.allow) return;
  assert.equal(decision.reasons.length, 7, decision.reasons.join(" | "));
  assert.ok(has(decision, /ETHUSDT has no STOP_MARKET/));
  assert.equal(
    decision.reasons.some((reason) => /ETHUSDT has no STOP_MARKET/.test(reason)),
    true,
  );
  assert.match(decision.reasons[0], /not in the SWAL_MCP_SYMBOLS whitelist/);
  assert.match(decision.reasons[1], /notional 5000 USD exceeds/);
  assert.match(decision.reasons[2], /leverage 9x exceeds/);
  assert.match(decision.reasons[3], /liquidation distance/);
  assert.match(decision.reasons[4], /daily-loss lock/);
  assert.match(decision.reasons[5], /max open positions reached/);
});

test("a post_only order is checked by the same rules", () => {
  assert.equal(checkOrder({ ...base, orderType: "post_only" }, limits, account).allow, true);
  assert.equal(checkOrder({ ...base, orderType: "post_only", notionalUsd: 5000 }, limits, account).allow, false);
});

test("symbolReason rejects an unnormalized symbol", () => {
  assert.match(symbolReason("btcusdt", ["BTCUSDT"]) ?? "", /not in the SWAL_MCP_SYMBOLS whitelist/);
  assert.equal(symbolReason("BTCUSDT", ["BTCUSDT"]), null);
  assert.equal(stopReason(1, 1), null);
  // At 1x the liquidation distance is 100% and the safe distance 80%.
  assert.equal(stopReason(50, 1), null);
  assert.match(stopReason(90, 1) ?? "", /exceeds the safe liquidation distance \(80% is 80% of 100% at 1x\)/);
  assert.match(stopReason(60, 2) ?? "", /at or beyond the simplified liquidation distance \(50% at 2x\)/);
  assert.match(stopReason(45, 2) ?? "", /exceeds the safe liquidation distance \(40% is 80% of 50% at 2x\)/);
  assert.equal(stopReason(40, 2), null);
});
