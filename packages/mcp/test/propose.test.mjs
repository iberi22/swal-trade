import test from "node:test";
import assert from "node:assert/strict";
import { proposeFromMark } from "../dist/propose.js";

const limits = { maxLeverage: null, maxNotionalUsd: null, dailyLossUsd: null };

test("proposeFromMark sizes quantity and a long stop from the mark price", () => {
  const result = proposeFromMark({
    symbol: "btcusdt",
    side: "LONG",
    notionalUsd: 250,
    stopLossPct: 2,
    leverage: 10,
    markPrice: 100,
    limits,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.proposal.symbol, "BTCUSDT");
  assert.equal(result.proposal.side, "BUY");
  assert.equal(result.proposal.quantity, 2.5);
  assert.equal(result.proposal.stopPrice, 98);
  assert.equal(result.proposal.stopSide, "SELL");
  assert.equal(result.proposal.marginUsd, 25);
  assert.equal(result.proposal.liquidationPct, 10);
  assert.equal(result.proposal.safeStopLossPct, 8);
  assert.equal(result.proposal.withinSafeDistance, true);
  assert.deepEqual(result.proposal.violations, []);
  assert.equal(result.proposal.sent, false);
  assert.match(result.proposal.note, /Order placement tools are disabled in this build/);
  assert.equal(result.proposal.limits.dailyLossEvaluated, false);
});

test("proposeFromMark prices a short stop above the mark", () => {
  const result = proposeFromMark({
    symbol: "ETHUSDT",
    side: "SELL",
    notionalUsd: 100,
    stopLossPct: 2,
    leverage: 5,
    markPrice: 100,
    limits,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.proposal.quantity, 1);
  assert.equal(result.proposal.stopPrice, 102);
  assert.equal(result.proposal.stopSide, "BUY");
});

test("proposeFromMark reports liquidation distance and limit violations", () => {
  const atLiquidation = proposeFromMark({
    symbol: "BTCUSDT",
    side: "BUY",
    notionalUsd: 50,
    stopLossPct: 2,
    leverage: 50,
    markPrice: 100,
    limits,
  });
  assert.equal(atLiquidation.ok, true);
  if (!atLiquidation.ok) return;
  assert.equal(atLiquidation.proposal.withinSafeDistance, false);
  assert.match(atLiquidation.proposal.violations[0], /at or beyond the simplified liquidation distance/);

  const pastSafe = proposeFromMark({
    symbol: "BTCUSDT",
    side: "BUY",
    notionalUsd: 50,
    stopLossPct: 1.8,
    leverage: 50,
    markPrice: 100,
    limits,
  });
  assert.equal(pastSafe.ok, true);
  if (!pastSafe.ok) return;
  assert.match(pastSafe.proposal.violations[0], /1\.6% is 80% of 2%/);

  const capped = proposeFromMark({
    symbol: "BTCUSDT",
    side: "BUY",
    notionalUsd: 250,
    stopLossPct: 2,
    leverage: 10,
    markPrice: 100,
    limits: { maxLeverage: 5, maxNotionalUsd: 100, dailyLossUsd: 40 },
  });
  assert.equal(capped.ok, true);
  if (!capped.ok) return;
  assert.equal(capped.proposal.withinSafeDistance, true);
  assert.deepEqual(capped.proposal.violations, [
    "leverage 10x exceeds SWAL_MAX_LEVERAGE 5x",
    "notional 250 USD exceeds SWAL_MAX_NOTIONAL_USD 100",
  ]);
  assert.equal(capped.proposal.limits.dailyLossUsd, 40);
  assert.equal(capped.proposal.limits.dailyLossEvaluated, false);
  assert.equal(capped.proposal.sent, false);
});

test("proposeFromMark rejects bad inputs", () => {
  assert.equal(proposeFromMark({ symbol: "BTCUSDT", side: "HOLD", notionalUsd: 1, stopLossPct: 1, leverage: 1, markPrice: 1, limits }).ok, false);
  assert.equal(proposeFromMark({ symbol: "BTCUSDT", side: "BUY", notionalUsd: 0, stopLossPct: 1, leverage: 1, markPrice: 1, limits }).ok, false);
  assert.equal(proposeFromMark({ symbol: "BTCUSDT", side: "BUY", notionalUsd: 1, stopLossPct: 100, leverage: 1, markPrice: 1, limits }).ok, false);
  assert.equal(proposeFromMark({ symbol: "BTCUSDT", side: "BUY", notionalUsd: 1, stopLossPct: 1, leverage: 1, markPrice: 0, limits }).ok, false);
});
