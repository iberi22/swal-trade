import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createReadOnlyClient, IncompleteIncomeError } from "../dist/binance.js";

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
      const page = n === 1 ? Array.from({ length: 1000 }, (_, i) => ({ time: 1000 + i, tranId: i })) : [{ time: 5000, tranId: 5000 }];
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
  // The second page advances by tranId, not by timestamp: two rows can share a
  // millisecond and a timestamp cursor would skip the ones in between.
  const second = calls.filter((call) => call.url.includes("/income"))[1];
  assert.ok(second.url.includes("fromId=1000"));
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

// ---------------------------------------------------------------------------
// Item 9: the day's income is summed completely, or the day is not summed at all.
// ---------------------------------------------------------------------------

function incomeExchange(pages) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/fapi/v1/time")) return { ok: true, status: 200, json: async () => ({ serverTime: 1_000_500 }), text: async () => "" };
    if (String(url).includes("/fapi/v1/income")) {
      const n = calls.filter((call) => call.includes("/income")).length;
      const page = pages[Math.min(n, pages.length) - 1] ?? [];
      return { ok: true, status: 200, json: async () => page, text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => [], text: async () => "" };
  };
  return { fetchFn, calls };
}

function client(fetchFn) {
  return createReadOnlyClient({ apiKey: "AK-test-key", apiSecret: SECRET, fetchFn, now: () => 1_000_000 });
}

const fullPage = (count, timeFrom, tranFrom) =>
  Array.from({ length: count }, (_, i) => ({ time: timeFrom + i, tranId: tranFrom + i, incomeType: "REALIZED_PNL", asset: "USDT", income: "-1" }));

test("income pagination walks every page and dedupes by tranId", async () => {
  const { fetchFn, calls } = incomeExchange([fullPage(1000, 1000, 1), fullPage(500, 5000, 1001)]);
  const rows = await client(fetchFn).incomeSince(0);
  assert.equal(rows.length, 1500);
  // The cursor advances by tranId, so two rows sharing a millisecond are both read.
  assert.equal(calls.filter((call) => call.includes("/income")).length, 2);
  assert.ok(calls[1].includes("fromId=1001"));
  // The same tranId twice is counted once: the cursor is inclusive.
  const duplicated = await client(incomeExchange([[...fullPage(1000, 1000, 1), { time: 1000, tranId: 1 }], fullPage(10, 5000, 1001)]).fetchFn).incomeSince(0);
  assert.equal(duplicated.length, 1010);
});

test("income pagination fails closed on a full page whose rows cannot be advanced past", async () => {
  // A full page with no tranId: a timestamp cursor would skip every row that
  // shares the millisecond of the last one.
  await assert.rejects(
    client(incomeExchange([Array.from({ length: 1000 }, (_, i) => ({ time: 1000 })), fullPage(5, 5000, 5000)]).fetchFn).incomeSince(0),
    /rows have no tranId/,
  );
  // A full page whose last row has no time: there is no cursor at all.
  await assert.rejects(
    client(
      incomeExchange([
        [...fullPage(999, 1000, 1), { tranId: 9999, income: "0" }],
        fullPage(5, 5000, 5000),
      ]).fetchFn,
    ).incomeSince(0),
    /last row has no time/,
  );
  // A page that repeats itself: the cursor cannot advance, so the day would be
  // summed forever or not at all.
  const stuck = fullPage(1000, 1000, 1);
  await assert.rejects(client(incomeExchange([stuck, stuck, fullPage(5, 9000, 9000)]).fetchFn).incomeSince(0), /cannot advance/);
  // More full pages than the cap: the day is not summed.
  const forever = Array.from({ length: 60 }, () => fullPage(1000, 1000, 1));
  await assert.rejects(client(incomeExchange(forever).fetchFn).incomeSince(0), IncompleteIncomeError);
});

test("a short income page is the exchange saying that was the last one", async () => {
  const rows = await client(incomeExchange([fullPage(999, 1000, 1)]).fetchFn).incomeSince(0);
  assert.equal(rows.length, 999);
});
