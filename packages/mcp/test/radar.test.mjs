import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseRadarUrl, readRadarToken, compactAlert, RADAR_DOWN_ERROR } from "../dist/radar.js";
import { callOrCatch, errorText, textOf, withClient } from "./helpers.mjs";

test("radar URL parser refuses non-local URLs and malformed strings", () => {
  assert.equal(parseRadarUrl("").url, "http://127.0.0.1:47322");
  assert.equal(parseRadarUrl(undefined).url, "http://127.0.0.1:47322");
  assert.equal(parseRadarUrl("http://127.0.0.1:47322/").url, "http://127.0.0.1:47322");
  assert.equal(parseRadarUrl("http://localhost:47322").url, "http://localhost:47322");
  assert.equal(parseRadarUrl("https://127.0.0.1:47322").ok, false);
  assert.equal(parseRadarUrl("http://192.168.1.50:47322").ok, false);
  assert.equal(parseRadarUrl("http://attacker.com:47322").ok, false);
  assert.equal(parseRadarUrl("not-a-url").ok, false);
});

test("radar token reader reads token and never leaks it in error paths", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swal-radar-tok-"));
  const tokFile = path.join(tmp, "radar-token");
  try {
    const missing = readRadarToken(tokFile);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /radar token no encontrado/);
    fs.writeFileSync(tokFile, "test-secret-token-12345", { mode: 0o600 });
    const read = readRadarToken(tokFile);
    assert.equal(read.ok, true);
    assert.equal(read.token, "test-secret-token-12345");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("compactAlert sanitizes hostile or incomplete alert payloads safely", () => {
  const hostile = {
    id: "42",
    __proto__: { injected: true },
    symbol: "BTCUSDC",
    tf: "1h",
    entry: "82000.5",
    stop: "80000.0",
    target_1r: "84000.0",
    target_2r: "86000.0",
    strength: "0.85",
    status: "triggered",
    outcome_r: "2.0",
    mfe_r: "2.5",
    mae_r: "0.1",
    taken_by_user: 1,
    malicious: "<script>alert(1)</script>",
  };
  const safe = compactAlert(hostile);
  assert.equal(safe.id, 42);
  assert.equal(safe.symbol, "BTCUSDC");
  assert.equal(safe.entry, 82000.5);
  assert.equal(safe.outcomes.outcome_r, 2.0);
  assert.equal(safe.taken_by_user, true);
  assert.equal(safe.malicious, undefined);

  const empty = compactAlert(null);
  assert.equal(empty.id, 0);
  assert.equal(empty.symbol, "");
  assert.deepEqual(empty.outcomes, { outcome_r: null, mfe_r: null, mae_r: null });
});

test("radar tools refuse non-local URLs before attempting connection", async () => {
  const env = { SWAL_RADAR_URL: "http://evil.com:47322" };
  await withClient({ env }, async (client) => {
    assert.match(errorText(await callOrCatch(client, "radar_alerts", {})), /radar URL must be/);
    assert.match(errorText(await callOrCatch(client, "radar_stats", {})), /radar URL must be/);
    assert.match(errorText(await callOrCatch(client, "radar_mark_taken", { alert_id: 1, taken: true })), /radar URL must be/);
  });
});

test("radar tools return clear error when local radar is down", async () => {
  const env = { SWAL_RADAR_URL: "http://127.0.0.1:49999" };
  await withClient({ env }, async (client) => {
    assert.equal(errorText(await callOrCatch(client, "radar_alerts", {})), RADAR_DOWN_ERROR);
    assert.equal(errorText(await callOrCatch(client, "radar_stats", {})), RADAR_DOWN_ERROR);
    assert.equal(errorText(await callOrCatch(client, "radar_mark_taken", { alert_id: 1, taken: true })), RADAR_DOWN_ERROR);
  });
});

test("radar tools against fake local radar fixture", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swal-radar-fixture-"));
  const tokenFile = path.join(tmp, "radar-token");
  const testToken = "valid-radar-token-xyz";
  fs.writeFileSync(tokenFile, testToken, { mode: 0o600 });

  const fakeAlerts = [
    { id: 19, symbol: "ETHUSDC", tf: "1h", title: "Barrido", direction: "long", entry: 2400, stop: 2390, target_1r: 2410, target_2r: 2420, strength: 0.8, status: "win_2r", outcome_r: 2.0, mfe_r: 2.5, mae_r: 0, taken_by_user: false },
    { id: 10, symbol: "BTCUSDC", tf: "1h", title: "Rango", direction: "long", entry: 82000, stop: 80000, target_1r: 84000, target_2r: 86000, strength: 0.7, status: "pending", outcome_r: null, mfe_r: 0, mae_r: 0, taken_by_user: false },
  ];

  let lastHeaders = null;
  let lastBody = null;

  const fakeServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/alerts") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ alerts: fakeAlerts }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ overall: { n_resolved: 8, win_rate_1r: 1.0 }, by_kind: [], taken: { n_resolved: 0 }, note: "Un alerta es un experimento." }));
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/v1/alerts/")) {
      lastHeaders = req.headers;
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        lastBody = JSON.parse(body || "{}");
        if (req.headers["x-radar-token"] !== testToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, alert: { ...fakeAlerts[0], taken_by_user: lastBody.taken, user_note: lastBody.note } }));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });

  await new Promise((resolve) => fakeServer.listen(0, "127.0.0.1", resolve));
  const port = fakeServer.address().port;

  try {
    const env = { SWAL_RADAR_URL: `http://127.0.0.1:${port}`, SWAL_RADAR_TOKEN_PATH: tokenFile };
    await withClient({ env }, async (client) => {
      // 1. radar_alerts without filter
      const all = JSON.parse(textOf(await client.callTool({ name: "radar_alerts", arguments: {} })));
      assert.equal(all.length, 2);
      assert.equal(all[0].id, 19);
      assert.deepEqual(all[0].outcomes, { outcome_r: 2.0, mfe_r: 2.5, mae_r: 0 });

      // 2. radar_alerts with symbol filter
      const btc = JSON.parse(textOf(await client.callTool({ name: "radar_alerts", arguments: { symbol: "btcusdc" } })));
      assert.equal(btc.length, 1);
      assert.equal(btc[0].symbol, "BTCUSDC");

      // 3. radar_stats contains honesty note and "sin evidencia (n<30)"
      const stats = textOf(await client.callTool({ name: "radar_stats", arguments: {} }));
      assert.match(stats, /sin evidencia \(n<30\)/);
      assert.match(stats, /Un alerta es un experimento/);

      // 4. radar_mark_taken updates alert with taken and note
      const mark = JSON.parse(textOf(await client.callTool({ name: "radar_mark_taken", arguments: { alert_id: 19, taken: true, note: "ok" } })));
      assert.equal(mark.taken_by_user, true);
      assert.equal(lastHeaders["x-radar-token"], testToken);
      assert.equal(lastBody.taken, true);

      // 5. radar_mark_taken rejects note > 200 chars
      assert.equal((await callOrCatch(client, "radar_mark_taken", { alert_id: 19, taken: true, note: "a".repeat(201) })).isError, true);
    });
  } finally {
    await new Promise((resolve) => fakeServer.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
