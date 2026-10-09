import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createReadOnlyClient } from "../dist/binance.js";

const SECRET = "s3cretvalue";

function assertSigned(url, init) {
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "error");
  assert.equal(init.body, undefined);
  assert.equal(init.headers["X-MBX-APIKEY"], "AK-test-key");
  assert.ok(!url.includes(SECRET));
  const qs = url.split("?")[1];
  const idx = qs.lastIndexOf("&signature=");
  const payload = qs.slice(0, idx);
  assert.equal(qs.slice(idx + "&signature=".length), crypto.createHmac("sha256", SECRET).update(payload).digest("hex"));
  assert.ok(payload.includes("recvWindow=5000"));
  assert.ok(payload.includes("timestamp=1000500"));
}

test("signed read-only GETs, time offset, and income pagination", async () => {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/fapi/v1/time")) return { ok: true, status: 200, json: async () => ({ serverTime: 1_000_500 }), text: async () => "" };
    if (String(url).includes("/fapi/v1/income")) {
      const n = calls.filter((call) => call.url.includes("/income")).length;
      const page = n === 1 ? Array.from({ length: 1000 }, (_, i) => ({ time: 1000 + i })) : [{ time: 5000 }];
      return { ok: true, status: 200, json: async () => page, text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => (String(url).includes("positionRisk") ? [] : {}), text: async () => "" };
  };
  const client = createReadOnlyClient({
    apiKey: "AK-test-key",
    apiSecret: SECRET,
    fetchFn,
    now: () => 1_000_000,
  });
  assert.equal(await client.syncTime(), 500);
  const rows = await client.incomeSince(0);
  assert.equal(rows.length, 1001);
  await client.account();
  await client.positionRisk();
  await client.openAlgoOrders();

  const timeCall = calls.find((call) => call.url.includes("/fapi/v1/time"));
  assert.equal(timeCall.init.method, "GET");
  assert.equal(timeCall.init.headers, undefined);
  assert.ok(!timeCall.url.includes("signature="));

  for (const call of calls.filter((call) => !call.url.includes("/time"))) {
    assert.ok(call.url.startsWith("https://fapi.binance.com/"));
    assertSigned(call.url, call.init);
  }
  assert.ok(calls.some((call) => call.url.includes("/fapi/v3/account")));
  assert.ok(calls.some((call) => call.url.includes("/fapi/v2/positionRisk")));
  assert.ok(calls.some((call) => call.url.includes("/fapi/v1/openAlgoOrders")));
  assert.ok(calls.some((call) => call.url.includes("startTime=2000")));
  assert.ok(calls.every((call) => call.init.method === "GET"));
});

test("http and network errors do not include the secret", async () => {
  const denied = createReadOnlyClient({
    apiKey: "AK-test-key",
    apiSecret: SECRET,
    now: () => 1_000_000,
    fetchFn: async (url) => {
      if (String(url).includes("/time")) return { ok: true, status: 200, json: async () => ({ serverTime: 1_000_500 }), text: async () => "" };
      return { ok: false, status: 401, text: async () => `bad ${SECRET}`, json: async () => ({}) };
    },
  });
  await denied.syncTime();
  await assert.rejects(denied.account(), (err) => {
    assert.match(err.message, /HTTP 401/);
    assert.equal(err.message.includes(SECRET), false);
    return true;
  });

  const offline = createReadOnlyClient({
    apiKey: "AK-test-key",
    apiSecret: SECRET,
    fetchFn: async () => {
      throw new Error(`connect ${SECRET} https://fapi.binance.com/fapi/v1/time?signature=abc`);
    },
  });
  await assert.rejects(offline.syncTime(), (err) => {
    assert.match(err.message, /network error \/fapi\/v1\/time/);
    assert.equal(err.message.includes(SECRET), false);
    assert.equal(err.message.includes("signature="), false);
    return true;
  });
});
