import test from "node:test";
import assert from "node:assert/strict";
import { BinanceError, isAmbiguousError, isRejectedError, httpError, ORDER_NOT_FOUND_CODE, CANCEL_UNKNOWN_ORDER_CODE, newClientOrderId } from "../dist/errors.js";

test("httpError maps status and code correctly for 400 with valid JSON", () => {
  const err = httpError(400, "/api/v3/order", JSON.stringify({ code: -1121, msg: "Invalid symbol." }));
  assert.ok(err instanceof BinanceError);
  assert.equal(err.status, 400);
  assert.equal(err.code, -1121);
  assert.equal(err.msg, "Invalid symbol.");
  assert.ok(err.message.includes("HTTP 400 /api/v3/order code -1121 Invalid symbol."));
});

test("httpError handles invalid JSON by truncating body as msg", () => {
  const err = httpError(400, "/api/v3/order", "Not JSON body");
  assert.equal(err.status, 400);
  assert.equal(err.code, null);
  assert.equal(err.msg, "Not JSON body");
});

test("httpError handles JSON that is not an object", () => {
  const err = httpError(400, "/api/v3/order", "[]");
  assert.equal(err.status, 400);
  assert.equal(err.code, null);
  assert.equal(err.msg, "[]");
});

test("httpError maps statuses 401, 403, 418, 429, 500, 502, 503, 504", () => {
  const statuses = [401, 403, 418, 429, 500, 502, 503, 504];
  for (const s of statuses) {
    const err = httpError(s, "/path", "Gateway Timeout");
    assert.equal(err.status, s);
    assert.equal(err.code, null);
    assert.equal(err.msg, "Gateway Timeout");
  }
});

test("isAmbiguousError is true for network failures or non-Binance errors", () => {
  assert.equal(isAmbiguousError(new Error("socket hang up")), true);
  assert.equal(isAmbiguousError({ code: -1000 }), true);
});

test("isAmbiguousError is true for missing status but null code", () => {
  const err = new BinanceError("msg", null, "msg", null);
  assert.equal(isAmbiguousError(err), true);
});

test("isAmbiguousError is false for missing status but explicit code", () => {
  const err = new BinanceError("msg", -1121, "msg", null);
  assert.equal(isAmbiguousError(err), false);
});

test("isAmbiguousError is true for timeouts / 5xx / 429", () => {
  const err500 = new BinanceError("500", null, "err", 500);
  assert.equal(isAmbiguousError(err500), true);

  const err502 = new BinanceError("502", null, "err", 502);
  assert.equal(isAmbiguousError(err502), true);

  const err408 = new BinanceError("408", null, "timeout", 408);
  assert.equal(isAmbiguousError(err408), true);

  const err429 = new BinanceError("429", null, "too many requests", 429);
  assert.equal(isAmbiguousError(err429), true);
});

test("isAmbiguousError is false for explicit rejections", () => {
  const err400 = new BinanceError("400", -1121, "Invalid", 400);
  assert.equal(isAmbiguousError(err400), false);

  const err401 = new BinanceError("401", null, "Unauthorized", 401);
  // Wait: status = 401. status >= 500 is false. status === 408 is false. status === 429 is false.
  // So it returns false.
  assert.equal(isAmbiguousError(err401), false);
});

test("isRejectedError is the inverse of isAmbiguousError where defined", () => {
  const err400 = new BinanceError("400", -1121, "Invalid", 400);
  assert.equal(isRejectedError(err400), true);

  const err500 = new BinanceError("500", null, "err", 500);
  assert.equal(isRejectedError(err500), false);
});

test("isRejectedError is false for generic errors", () => {
  assert.equal(isRejectedError(new Error("fail")), false);
});

test("isRejectedError is false if code is null even if not ambiguous", () => {
  const err400NoCode = new BinanceError("400", null, "Invalid", 400);
  assert.equal(isAmbiguousError(err400NoCode), false);
  assert.equal(isRejectedError(err400NoCode), false); // code is null
});

test("newClientOrderId returns strings with prefix and URL-safe characters", () => {
  const id = newClientOrderId();
  assert.ok(id.startsWith("swal"));
  assert.ok(/^[a-zA-Z0-9]+$/.test(id));
});

test("newClientOrderId returns unique, length-bounded (<= 36) strings over 1000 calls", () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) {
    const id = newClientOrderId();
    assert.ok(id.length <= 36);
    ids.add(id);
  }
  assert.equal(ids.size, 1000);
});

test("constants exist with correct values", () => {
  assert.equal(ORDER_NOT_FOUND_CODE, -2013);
  assert.equal(CANCEL_UNKNOWN_ORDER_CODE, -2011);
});
