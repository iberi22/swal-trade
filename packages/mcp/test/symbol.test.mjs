import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSymbol, SYMBOL_RE } from "../dist/symbol.js";

test("normalizeSymbol accepts BTCUSDT", () => {
  assert.equal(normalizeSymbol("BTCUSDT"), "BTCUSDT");
});

test("normalizeSymbol accepts 1000PEPEUSDC", () => {
  assert.equal(normalizeSymbol("1000PEPEUSDC"), "1000PEPEUSDC");
});

test("normalizeSymbol lowercases normalized to upper-case", () => {
  assert.equal(normalizeSymbol("btcusdt"), "BTCUSDT");
  assert.equal(normalizeSymbol("  ethusdt  "), "ETHUSDT");
});

test("normalizeSymbol rejects empty and whitespace", () => {
  assert.equal(normalizeSymbol(""), null);
  assert.equal(normalizeSymbol("   "), null);
});

test("normalizeSymbol rejects path traversal injection tests", () => {
  assert.equal(normalizeSymbol("../etc"), null);
  assert.equal(normalizeSymbol("BTC/USDT"), null);
});

test("normalizeSymbol rejects other invalid characters", () => {
  assert.equal(normalizeSymbol("BTCUSDT;DROP"), null);
  assert.equal(normalizeSymbol("BTC-USDT"), null);
});

test("normalizeSymbol rejects overlong (> 30) inputs", () => {
  const longSymbol = "A".repeat(31);
  assert.equal(normalizeSymbol(longSymbol), null);
  const okSymbol = "A".repeat(30);
  assert.equal(normalizeSymbol(okSymbol), okSymbol);
});

test.todo("normalizeSymbol rejects non-string inputs without throwing", () => {
  // Current behavior throws TypeError when calling .trim() on non-strings.
  // We document it as a bug via test.todo, per requirements.
  assert.equal(normalizeSymbol(null), null);
  assert.equal(normalizeSymbol({}), null);
});

test("SYMBOL_RE anchors strictly", () => {
  assert.ok(SYMBOL_RE.test("BTCUSDT"));
  assert.equal(SYMBOL_RE.test(" BTCUSDT"), false); // ^ anchor
  assert.equal(SYMBOL_RE.test("BTCUSDT "), false); // $ anchor
});
