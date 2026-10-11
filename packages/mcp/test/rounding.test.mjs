import test from "node:test";
import assert from "node:assert/strict";
import {
  ceilToStep,
  decimalNumber,
  decimalsOf,
  floorToStep,
  nearestStep,
  roundDecimal,
} from "../dist/decimal.js";
import { parseExchangeInfo } from "../dist/exchange.js";
import { exchangeInfoBody } from "./trading-fixtures.mjs";
import { proposeFromMark } from "../dist/propose.js";

const FILTERS = { stepSize: "0.001", minQty: "0.001", tickSize: "0.1", minNotional: "5" };
const limits = { maxLeverage: null, maxNotionalUsd: null, dailyLossUsd: null };

test("floorToStep never rounds a quantity up", () => {
  assert.equal(floorToStep("2.5", "0.001"), "2.5");
  assert.equal(floorToStep(0.0025, "0.001"), "0.002");
  assert.equal(floorToStep("0.0019", "0.001"), "0.001");
  assert.equal(floorToStep("0.0009", "0.001"), "0");
  assert.equal(floorToStep("1", "1"), "1");
  assert.equal(floorToStep("0.999", "0.01"), "0.99");
  assert.equal(floorToStep(1e-7, "0.001"), "0");
  // Exact alignment survives the float noise: 0.003 * 1000 is not 3 in binary.
  assert.equal(floorToStep(0.003, 0.001), "0.003");
  assert.equal(floorToStep("123.456789", "0.01"), "123.45");
});

test("ceilToStep and nearestStep align prices the other way", () => {
  assert.equal(ceilToStep("1.11", "0.1"), "1.2");
  assert.equal(ceilToStep("1.10", "0.1"), "1.1");
  assert.equal(ceilToStep("0.101", "1"), "1");
  assert.equal(nearestStep("1.14", "0.1"), "1.1");
  assert.equal(nearestStep("1.15", "0.1"), "1.2");
  assert.equal(nearestStep("99999.94", "0.1"), "99999.9");
  assert.equal(nearestStep("100000.06", "0.1"), "100000.1");
});

test("roundDecimal rejects unusable inputs instead of guessing", () => {
  assert.equal(roundDecimal("abc", "0.1", "floor"), null);
  assert.equal(roundDecimal("1", "0", "floor"), null);
  assert.equal(roundDecimal("1", "abc", "floor"), null);
  assert.equal(roundDecimal("", "0.1", "floor"), null);
  assert.equal(floorToStep("0.5", "-0.1"), null);
});

test("decimalsOf reads the filter precision", () => {
  assert.equal(decimalsOf("0.001"), 3);
  assert.equal(decimalsOf("0.1"), 1);
  assert.equal(decimalsOf("1"), 0);
  assert.equal(decimalsOf("1e-8"), 8);
  assert.equal(decimalsOf("bad"), null);
});

test("decimalNumber converts without losing the alignment", () => {
  assert.equal(decimalNumber("0.002"), 0.002);
  assert.equal(decimalNumber(100000), 100000);
});

test("parseExchangeInfo pulls the three filters and rejects incomplete ones", () => {
  const body = exchangeInfoBody();
  const parsed = parseExchangeInfo(body, "BTCUSDT");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, { symbol: "BTCUSDT", stepSize: "0.001", minQty: "0.001", tickSize: "0.1", minNotional: "5" });

  const unknown = parseExchangeInfo(body, "DOGEUSDT");
  assert.equal(unknown.ok, false);

  const noFilters = parseExchangeInfo({ symbols: [{ symbol: "BTCUSDT", filters: [] }] }, "BTCUSDT");
  assert.equal(noFilters.ok, false);

  const brokenStep = parseExchangeInfo(
    { symbols: [{ symbol: "BTCUSDT", filters: [{ filterType: "LOT_SIZE", stepSize: "abc", minQty: "0.001" }, { filterType: "PRICE_FILTER", tickSize: "0.1" }] }] },
    "BTCUSDT",
  );
  assert.equal(brokenStep.ok, false);

  const notional = parseExchangeInfo(
    {
      symbols: [
        {
          symbol: "ETHUSDT",
          filters: [
            { filterType: "LOT_SIZE", stepSize: "0.01", minQty: "0.01" },
            { filterType: "PRICE_FILTER", tickSize: "0.01" },
            { filterType: "NOTIONAL", notional: "20" },
          ],
        },
      ],
    },
    "ETHUSDT",
  );
  assert.equal(notional.ok, true);
  if (notional.ok) assert.equal(notional.value.minNotional, "20");

  assert.equal(parseExchangeInfo({ nope: true }, "BTCUSDT").ok, false);
});

test("propose_order rounds the quantity to stepSize and checks MIN_NOTIONAL", () => {
  const notional = 200;
  const markPrice = 100000;
  // 200 / 100000 = 0.002 BTC exactly.
  const result = proposeFromMark({ symbol: "BTCUSDT", side: "BUY", notionalUsd: notional, stopLossPct: 0.5, leverage: 1, markPrice, limits, filters: FILTERS });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.proposal.quantity, 0.002);
  assert.equal(result.proposal.quantityString, "0.002");
  assert.equal(result.proposal.rounding.applied, true);
  assert.equal(result.proposal.effectiveNotionalUsd, 200);
  assert.deepEqual(result.proposal.violations, []);

  // 100 / 100000 = 0.001 BTC, a notional of 100 USD: still above MIN_NOTIONAL 5.
  const atMinimum = proposeFromMark({ symbol: "BTCUSDT", side: "BUY", notionalUsd: 100, stopLossPct: 0.5, leverage: 1, markPrice, limits, filters: FILTERS });
  assert.equal(atMinimum.ok, true);
  if (atMinimum.ok) assert.deepEqual(atMinimum.proposal.violations, []);

  // A notional that rounds below MIN_NOTIONAL is reported, not sent.
  const tooSmall = proposeFromMark({
    symbol: "BTCUSDT",
    side: "BUY",
    notionalUsd: 10,
    stopLossPct: 0.5,
    leverage: 1,
    markPrice: 100000,
    limits,
    // stepSize of 1 BTC: 10 USD of notional rounds to zero quantity.
    filters: { ...FILTERS, stepSize: "1", minQty: "1" },
  });
  assert.equal(tooSmall.ok, true);
  if (!tooSmall.ok) return;
  assert.equal(tooSmall.proposal.quantity, 0);
  assert.equal(tooSmall.proposal.violations.some((violation) => /minQty/.test(violation)), true);

  // A small notional that survives rounding but lands under MIN_NOTIONAL.
  const underNotional = proposeFromMark({
    symbol: "BTCUSDT",
    side: "SELL",
    notionalUsd: 4,
    stopLossPct: 0.5,
    leverage: 1,
    markPrice: 100,
    limits,
    filters: { ...FILTERS, stepSize: "0.001", minQty: "0.001", minNotional: "5" },
  });
  assert.equal(underNotional.ok, true);
  if (!underNotional.ok) return;
  assert.equal(underNotional.proposal.quantity, 0.04);
  assert.equal(underNotional.proposal.violations.some((violation) => /MIN_NOTIONAL/.test(violation)), true);
});

test("propose_order reports the unrounded math when the filters are missing", () => {
  const result = proposeFromMark({ symbol: "BTCUSDT", side: "BUY", notionalUsd: 250, stopLossPct: 2, leverage: 10, markPrice: 100, limits });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.proposal.quantity, 2.5);
  assert.equal(result.proposal.rounding.applied, false);
  assert.deepEqual(result.proposal.violations, []);
});

// A quotient with more than eighteen decimals is the honest number the rounding
// has to survive: 10 USD at 150000 is 0.00006666666666666667, which the decimal
// guard refuses. Truncating it with toDecimalText sizes the order instead of
// silently returning the unrounded math.
test("propose_order sizes a quantity whose quotient has more than eighteen decimals", () => {
  const fine = { ...FILTERS, stepSize: "0.000001", minQty: "0.000001" };
  const result = proposeFromMark({ symbol: "BTCUSDT", side: "BUY", notionalUsd: 10, stopLossPct: 0.5, leverage: 1, markPrice: 150000, limits, filters: fine });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.proposal.quantityString, "0.000066");
  assert.equal(result.proposal.quantity, 0.000066);
  assert.equal(result.proposal.rounding.applied, true);
  assert.deepEqual(result.proposal.violations, []);
});

test("propose_order separates \"no filters\" from \"cannot round\"", () => {
  // No filters at all: the raw math is returned and that is all the proposal says.
  const unfiltered = proposeFromMark({ symbol: "BTCUSDT", side: "BUY", notionalUsd: 250, stopLossPct: 2, leverage: 10, markPrice: 100, limits });
  assert.equal(unfiltered.ok, true);
  if (unfiltered.ok) {
    assert.deepEqual(unfiltered.proposal.violations, []);
    assert.equal(unfiltered.proposal.rounding.applied, false);
  }

  // Filters that cannot be used: a quantity that is not a multiple of stepSize is
  // an order the exchange refuses with -1111, so it is a violation and not a
  // rounding detail. Reporting the unrounded number here sells an order that
  // cannot be sent.
  const unusable = proposeFromMark({
    symbol: "BTCUSDT",
    side: "BUY",
    notionalUsd: 250,
    stopLossPct: 2,
    leverage: 10,
    markPrice: 100,
    limits,
    filters: { ...FILTERS, stepSize: "not-a-step" },
  });
  assert.equal(unusable.ok, true);
  if (!unusable.ok) return;
  assert.equal(unusable.proposal.rounding.applied, false);
  assert.equal(unusable.proposal.violations.length, 1);
  assert.match(unusable.proposal.violations[0], /cannot be aligned to stepSize not-a-step/);
});
