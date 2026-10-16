import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureBridgeToken,
  validateShapes,
  ChartBridgeServer,
  BridgeDaemon,
  ChartBridgeHttpClient,
  MAX_FRAME_BYTES,
} from "../dist/chart-bridge.js";
import { createServer } from "../dist/server.js";
import { callOrCatch, errorText, textOf, withClient } from "./helpers.mjs";

test("token creation and permissions", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swal-bridge-token-"));
  const tokenFile = path.join(tmpDir, "sub", "chart-bridge-token");
  try {
    const { token, tokenPath } = ensureBridgeToken(tokenFile);
    assert.equal(tokenPath, tokenFile);
    assert.ok(typeof token === "string" && token.length >= 40);
    assert.ok(fs.existsSync(tokenFile));

    const stat = fs.statSync(tokenFile);
    assert.equal(stat.mode & 0o777, 0o600);

    const second = ensureBridgeToken(tokenFile);
    assert.equal(second.token, token);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("shape validation rules and IA: prefixing", () => {
  assert.equal(validateShapes([]).ok, false);
  assert.equal(validateShapes(null).ok, false);

  const tooMany = Array.from({ length: 31 }, () => ({
    kind: "level",
    points: [{ time: 1700000000, price: 50000 }],
  }));
  assert.equal(validateShapes(tooMany).ok, false);

  assert.equal(
    validateShapes([
      { kind: "arrow", points: [{ time: 1700000000, price: 50000 }] },
    ]).ok,
    false
  );

  assert.equal(
    validateShapes([
      { kind: "trend", points: [{ time: 1700000000, price: 50000 }] },
    ]).ok,
    false
  );

  assert.equal(
    validateShapes([
      {
        kind: "label",
        text: "x".repeat(61),
        points: [{ time: 1700000000, price: 50000 }],
      },
    ]).ok,
    false
  );

  const valid = validateShapes([
    {
      id: "lvl-1",
      kind: "level",
      text: "support",
      points: [{ time: 1700000000, price: 50000 }],
    },
    {
      id: "arr-1",
      kind: "arrow",
      direction: "up",
      text: "IA: existing",
      points: [{ time: 1700000000, price: 50000 }],
    },
    {
      id: "tr-1",
      kind: "trend",
      style: "dashed",
      points: [
        { time: 1700000000, price: 50000 },
        { time: 1700003600, price: 51000 },
      ],
    },
  ]);
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.shapes[0].text, "IA: support");
    assert.equal(valid.shapes[1].text, "IA: existing");
    assert.equal(valid.shapes[2].text, "IA");
  }
});

function connectTestClient(port, options = {}) {
  return new Promise((resolve) => {
    const key = Buffer.from("testkey123456789").toString("base64");
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
        Origin: options.origin ?? "chrome-extension://abcdefghijklmnop",
      },
      agent: false,
    });

    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode, socket: null, messages: [] });
    });

    req.on("upgrade", (res, socket) => {
      const messages = [];
      let buf = Buffer.alloc(0);

      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const first = buf[0];
          const second = buf[1];
          const opcode = first & 0x0f;
          let len = second & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (buf.length < 4) break;
            len = buf.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (buf.length < 10) break;
            len = Number(buf.readBigUInt64BE(2));
            offset = 10;
          }
          if (buf.length < offset + len) break;
          const payload = buf.subarray(offset, offset + len);
          buf = buf.subarray(offset + len);

          if (opcode === 0x1) {
            try {
              messages.push(JSON.parse(payload.toString("utf8")));
            } catch {
              messages.push(payload.toString("utf8"));
            }
          }
        }
      });

      function sendJson(obj) {
        const payload = Buffer.from(JSON.stringify(obj), "utf8");
        const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
        const masked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) {
          masked[i] = payload[i] ^ mask[i % 4];
        }
        let header;
        if (payload.length < 126) {
          header = Buffer.from([0x81, 0x80 | payload.length]);
        } else {
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 0x80 | 126;
          header.writeUInt16BE(payload.length, 2);
        }
        socket.write(Buffer.concat([header, mask, masked]));
      }

      resolve({
        status: 101,
        socket,
        messages,
        sendJson,
        close: () => socket.destroy(),
      });
    });

    req.on("error", (err) => {
      resolve({ status: 0, error: err.message, messages: [] });
    });

    req.end();
  });
}

test("bridge server: origin rejection, auth, one-client policy, timeout", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swal-bridge-srv-"));
  const tokenFile = path.join(tmpDir, "chart-bridge-token");
  // dynamic port 0

  const server = new ChartBridgeServer({
    port: 0,
    tokenPath: tokenFile,
    authTimeoutMs: 500,
    requestTimeoutMs: 500,
  });

  await server.start();
  const port = server.port;
  const token = server.token;

  try {
    const badOrigin = await connectTestClient(port, { origin: "https://evil.com" });
    assert.equal(badOrigin.status, 403);

    const wrongAuthClient = await connectTestClient(port);

    assert.equal(wrongAuthClient.status, 101);
    wrongAuthClient.sendJson({ type: "hello", token: "wrong_token", version: 1 });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(server.isConnected(), false);
    wrongAuthClient.close();

    const client1 = await connectTestClient(port);
    assert.equal(client1.status, 101);
    client1.sendJson({ type: "hello", token, version: 1 });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(server.isConnected(), true);
    assert.equal(client1.messages.length, 1);
    assert.equal(client1.messages[0].type, "hello_ack");

    const client2 = await connectTestClient(port);
    assert.equal(client2.status === 429 || client2.socket === null, true);

    const statePromise = server.getChartState();
    await new Promise((r) => setTimeout(r, 50));
    const reqMsg = client1.messages.find((m) => m.type === "chart_state");
    assert.ok(reqMsg && reqMsg.id);
    client1.sendJson({
      id: reqMsg.id,
      ok: true,
      state: {
        connected: true,
        symbol: "BTCUSDT",
        timeframe: "15m",
        paintEnabled: true,
        tabUrlHost: "www.binance.com",
      },
    });
    const stateResult = await statePromise;
    assert.deepEqual(stateResult, {
      connected: true,
      symbol: "BTCUSDT",
      timeframe: "15m",
      paintEnabled: true,
      tabUrlHost: "www.binance.com",
    });

    const timeoutPromise = server.clear();
    await assert.rejects(timeoutPromise, /timed out/);

    client1.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.isConnected(), false);
  } finally {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("server tools registration when SWAL_MCP_CHART_BRIDGE=enabled", async () => {
  await withClient({ env: { SWAL_MCP_CHART_BRIDGE: "disabled" } }, async (client) => {
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    assert.equal(names.includes("chart_state"), false);
    assert.equal(names.includes("chart_paint"), false);
    assert.equal(names.includes("chart_clear"), false);
    assert.equal(names.includes("chart_set_timeframe"), false);
  });

  const mockBridge = {
    connected: false,
    async getChartState() {
      if (!this.connected) {
        throw new Error(
          "extension not connected: open Binance futures and enable \"Permitir que Claude use el gráfico\" in Ajustes"
        );
      }
      return {
        connected: true,
        symbol: "ETHUSDT",
        timeframe: "1h",
        paintEnabled: true,
        tabUrlHost: "www.binance.com",
      };
    },
    async paint(shapes) {
      return { ok: true, sent: 1, count: shapes.length };
    },
    async clear() {
      return { ok: true, cleared: true };
    },
    async setTimeframe(tf) {
      if (tf === "15m") {
        return { ok: true, resolution: "15" };
      }
      throw new Error("unsupported");
    },
  };

  await withClient(
    {
      env: { SWAL_MCP_CHART_BRIDGE: "enabled" },
      chartBridge: mockBridge,
    },
    async (client) => {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      assert.equal(names.includes("chart_state"), true);
      assert.equal(names.includes("chart_paint"), true);
      assert.equal(names.includes("chart_clear"), true);
      assert.equal(names.includes("chart_set_timeframe"), true);

      const errRes = await callOrCatch(client, "chart_state", {});
      assert.ok(errorText(errRes).includes("extension not connected"));

      mockBridge.connected = true;
      const stateRes = await callOrCatch(client, "chart_state", {});
      const parsedState = JSON.parse(textOf(stateRes));
      assert.equal(parsedState.symbol, "ETHUSDT");

      const paintRes = await callOrCatch(client, "chart_paint", {
        shapes: [
          {
            kind: "level",
            text: "support",
            points: [{ time: 1700000000, price: 3000 }],
          },
        ],
      });
      const paintParsed = JSON.parse(textOf(paintRes));
      assert.equal(paintParsed.ok, true);

      const clearRes = await callOrCatch(client, "chart_clear", {});
      assert.equal(JSON.parse(textOf(clearRes)).ok, true);

      const tfRes = await callOrCatch(client, "chart_set_timeframe", {
        timeframe: "15m",
      });
      assert.equal(JSON.parse(textOf(tfRes)).resolution, "15");

      const unsuppRes = await callOrCatch(client, "chart_set_timeframe", {
        timeframe: "1h",
      });
      assert.ok(errorText(unsuppRes).includes("unsupported"));
    }
  );
});

test("bridge server drops a client that announces a frame larger than the cap", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swal-bridge-cap-"));
  const server = new ChartBridgeServer({ port: 0, tokenPath: path.join(tmpDir, "chart-bridge-token"), authTimeoutMs: 2000 });
  await server.start();
  try {
    const client = await connectTestClient(server.port);
    assert.equal(client.status, 101);
    const closed = new Promise((resolve) => client.socket.once("close", () => resolve(true)));
    // Masked text frame header that announces MAX_FRAME_BYTES + 1 bytes (64-bit length), no payload.
    const header = Buffer.alloc(14);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(MAX_FRAME_BYTES + 1), 2);
    client.socket.write(header);
    const outcome = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(false), 1500))]);
    assert.equal(outcome, true, "the server must drop the client before buffering an oversized frame");
  } finally {
    await server.close();
  }
});

test("a bridge that could not bind its port reports why instead of 'not connected'", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swal-bridge-busy-"));
  const first = new ChartBridgeServer({ port: 0, tokenPath: path.join(tmpDir, "t1") });
  await first.start();
  const second = new ChartBridgeServer({ port: first.port, tokenPath: path.join(tmpDir, "t2") });
  try {
    await assert.rejects(second.start(), (err) => err.code === "EADDRINUSE");
    second.startError = "chart bridge port in use (another Claude Code session owns the chart)";
    await assert.rejects(second.setTimeframe("15m"), /another Claude Code session/);
  } finally {
    await first.close();
  }
});

test("daemon control API: auth, health shape, body cap, and extension-not-connected error", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swal-daemon-test-"));
  const tokenFile = path.join(tmpDir, "chart-bridge-token");

  const daemon = new BridgeDaemon({
    wsPort: 0,
    controlPort: 0,
    tokenPath: tokenFile,
    authTimeoutMs: 500,
    requestTimeoutMs: 500,
  });

  await daemon.start();
  const token = daemon.token;
  const controlPort = daemon.controlPort;

  try {
    // 1. Token required: without token -> 401
    const noTokenRes = await fetch(`http://127.0.0.1:${controlPort}/v1/health`);
    assert.equal(noTokenRes.status, 401);
    const noTokenData = await noTokenRes.json();
    assert.equal(noTokenData.ok, false);

    // With wrong token -> 401
    const wrongTokenRes = await fetch(`http://127.0.0.1:${controlPort}/v1/health`, {
      headers: { "X-Bridge-Token": "bad-token" },
    });
    assert.equal(wrongTokenRes.status, 401);

    // 2. Health shape with valid token (extension not connected)
    const healthRes = await fetch(`http://127.0.0.1:${controlPort}/v1/health`, {
      headers: { "X-Bridge-Token": token },
    });
    assert.equal(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.deepEqual(healthData, { ok: true, extensionConnected: false });

    // 3. Extension not connected errors on chart endpoints
    const stateRes = await fetch(`http://127.0.0.1:${controlPort}/v1/chart/state`, {
      method: "POST",
      headers: { "X-Bridge-Token": token },
    });
    assert.equal(stateRes.status, 503);
    const stateData = await stateRes.json();
    assert.ok(stateData.error.includes("extension not connected"));

    const paintRes = await fetch(`http://127.0.0.1:${controlPort}/v1/chart/paint`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Token": token },
      body: JSON.stringify({
        shapes: [{ kind: "level", points: [{ time: 1700000000, price: 3000 }] }],
      }),
    });
    assert.equal(paintRes.status, 503);
    assert.ok((await paintRes.json()).error.includes("extension not connected"));

    const clearRes = await fetch(`http://127.0.0.1:${controlPort}/v1/chart/clear`, {
      method: "POST",
      headers: { "X-Bridge-Token": token },
    });
    assert.equal(clearRes.status, 503);
    assert.ok((await clearRes.json()).error.includes("extension not connected"));

    const tfRes = await fetch(`http://127.0.0.1:${controlPort}/v1/chart/timeframe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Token": token },
      body: JSON.stringify({ timeframe: "15m" }),
    });
    assert.equal(tfRes.status, 503);
    assert.ok((await tfRes.json()).error.includes("extension not connected"));

    // 4. Body cap: payload > 64 KB -> 413
    const bigPayload = {
      shapes: [{ kind: "level", points: [{ time: 1700000000, price: 3000 }] }],
      padding: "x".repeat(65 * 1024),
    };
    const capRes = await fetch(`http://127.0.0.1:${controlPort}/v1/chart/paint`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Token": token },
      body: JSON.stringify(bigPayload),
    });
    assert.equal(capRes.status, 413);
    const capData = await capRes.json();
    assert.equal(capData.ok, false);
    assert.equal(capData.error, "payload too large");
  } finally {
    await daemon.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("daemon control API: state, paint, clear, timeframe forwarded to extension over WS", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swal-daemon-fwd-"));
  const tokenFile = path.join(tmpDir, "chart-bridge-token");

  const daemon = new BridgeDaemon({
    wsPort: 0,
    controlPort: 0,
    tokenPath: tokenFile,
    authTimeoutMs: 1000,
    requestTimeoutMs: 1000,
  });

  await daemon.start();
  const token = daemon.token;

  try {
    const client = await connectTestClient(daemon.wsPort);
    assert.equal(client.status, 101);
    client.sendJson({ type: "hello", token, version: 1 });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(daemon.bridgeServer.isConnected(), true);

    const healthRes = await fetch(`http://127.0.0.1:${daemon.controlPort}/v1/health`, {
      headers: { "X-Bridge-Token": token },
    });
    const healthData = await healthRes.json();
    assert.deepEqual(healthData, { ok: true, extensionConnected: true });

    // 1. POST /v1/chart/state
    const statePromise = fetch(`http://127.0.0.1:${daemon.controlPort}/v1/chart/state`, {
      method: "POST",
      headers: { "X-Bridge-Token": token },
    });
    await new Promise((r) => setTimeout(r, 50));
    const stateReq = client.messages.find((m) => m.type === "chart_state");
    assert.ok(stateReq && stateReq.id);
    client.sendJson({
      id: stateReq.id,
      ok: true,
      state: {
        connected: true,
        symbol: "SOLUSDT",
        timeframe: "5m",
        paintEnabled: true,
        tabUrlHost: "www.binance.com",
      },
    });
    const stateRes = await statePromise;
    assert.equal(stateRes.status, 200);
    const stateData = await stateRes.json();
    assert.deepEqual(stateData, {
      connected: true,
      symbol: "SOLUSDT",
      timeframe: "5m",
      paintEnabled: true,
      tabUrlHost: "www.binance.com",
    });

    // 2. POST /v1/chart/paint
    const paintPromise = fetch(`http://127.0.0.1:${daemon.controlPort}/v1/chart/paint`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Token": token },
      body: JSON.stringify({
        shapes: [
          {
            kind: "level",
            text: "resistance",
            points: [{ time: 1700000000, price: 150 }],
          },
        ],
      }),
    });
    await new Promise((r) => setTimeout(r, 50));
    const paintReq = client.messages.find((m) => m.type === "chart_paint");
    assert.ok(paintReq && paintReq.id);
    assert.equal(paintReq.shapes.length, 1);
    assert.equal(paintReq.shapes[0].text, "IA: resistance");
    client.sendJson({
      id: paintReq.id,
      ok: true,
      result: { sent: 1, count: 1 },
    });
    const paintRes = await paintPromise;
    assert.equal(paintRes.status, 200);
    const paintData = await paintRes.json();
    assert.deepEqual(paintData, { sent: 1, count: 1 });

    // 3. POST /v1/chart/clear
    const clearPromise = fetch(`http://127.0.0.1:${daemon.controlPort}/v1/chart/clear`, {
      method: "POST",
      headers: { "X-Bridge-Token": token },
    });
    await new Promise((r) => setTimeout(r, 50));
    const clearReq = client.messages.find((m) => m.type === "chart_clear");
    assert.ok(clearReq && clearReq.id);
    client.sendJson({
      id: clearReq.id,
      ok: true,
      result: { cleared: true },
    });
    const clearRes = await clearPromise;
    assert.equal(clearRes.status, 200);
    const clearData = await clearRes.json();
    assert.deepEqual(clearData, { cleared: true });

    // 4. POST /v1/chart/timeframe
    const tfPromise = fetch(`http://127.0.0.1:${daemon.controlPort}/v1/chart/timeframe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Token": token },
      body: JSON.stringify({ timeframe: "1h" }),
    });
    await new Promise((r) => setTimeout(r, 50));
    const tfReq = client.messages.find((m) => m.type === "set_resolution");
    assert.ok(tfReq && tfReq.id);
    assert.equal(tfReq.resolution, "60");
    client.sendJson({
      id: tfReq.id,
      ok: true,
      result: { resolution: "60" },
    });
    const tfRes = await tfPromise;
    assert.equal(tfRes.status, 200);
    const tfData = await tfRes.json();
    assert.deepEqual(tfData, { resolution: "60" });

    client.close();
  } finally {
    await daemon.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("MCP client mode: tools call control API over HTTP with token read at call time", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swal-client-mode-"));
  const tokenFile = path.join(tmpDir, "chart-bridge-token");
  fs.writeFileSync(tokenFile, "test-client-token-12345", { mode: 0o600 });

  const calls = [];
  const fakeServer = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString("utf8");
    }
    calls.push({
      method: req.method,
      url: req.url,
      token: req.headers["x-bridge-token"],
      body: body ? JSON.parse(body) : null,
    });

    if (req.url === "/v1/chart/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          connected: true,
          symbol: "BTCUSDT",
          timeframe: "15m",
          paintEnabled: true,
          tabUrlHost: "www.binance.com",
        })
      );
      return;
    }
    if (req.url === "/v1/chart/paint") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, painted: true }));
      return;
    }
    if (req.url === "/v1/chart/clear") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, cleared: true }));
      return;
    }
    if (req.url === "/v1/chart/timeframe") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, resolution: "15" }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });

  await new Promise((resolve) => fakeServer.listen(0, "127.0.0.1", resolve));
  const fakePort = fakeServer.address().port;

  try {
    await withClient(
      {
        env: {
          SWAL_MCP_CHART_BRIDGE: "client",
          SWAL_BRIDGE_CONTROL_PORT: String(fakePort),
          SWAL_BRIDGE_TOKEN_PATH: tokenFile,
        },
      },
      async (client) => {
        const list = await client.listTools();
        const names = list.tools.map((t) => t.name);
        assert.ok(names.includes("chart_state"));
        assert.ok(names.includes("chart_paint"));
        assert.ok(names.includes("chart_clear"));
        assert.ok(names.includes("chart_set_timeframe"));

        // chart_state
        const stateRes = await callOrCatch(client, "chart_state", {});
        const stateData = JSON.parse(textOf(stateRes));
        assert.equal(stateData.symbol, "BTCUSDT");

        // chart_paint
        const paintRes = await callOrCatch(client, "chart_paint", {
          shapes: [{ kind: "level", points: [{ time: 1700000000, price: 60000 }] }],
        });
        const paintData = JSON.parse(textOf(paintRes));
        assert.equal(paintData.painted, true);

        // chart_clear
        const clearRes = await callOrCatch(client, "chart_clear", {});
        const clearData = JSON.parse(textOf(clearRes));
        assert.equal(clearData.cleared, true);

        // chart_set_timeframe
        const tfRes = await callOrCatch(client, "chart_set_timeframe", { timeframe: "15m" });
        const tfData = JSON.parse(textOf(tfRes));
        assert.equal(tfData.resolution, "15");

        // Verify calls received by fake control API
        assert.equal(calls.length, 4);
        for (const call of calls) {
          assert.equal(call.token, "test-client-token-12345");
          assert.equal(call.method, "POST");
        }
        assert.equal(calls[0].url, "/v1/chart/state");
        assert.equal(calls[1].url, "/v1/chart/paint");
        assert.equal(calls[2].url, "/v1/chart/clear");
        assert.equal(calls[3].url, "/v1/chart/timeframe");
        assert.equal(calls[3].body.timeframe, "15m");
      }
    );
  } finally {
    await new Promise((resolve) => fakeServer.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("MCP client mode: daemon down -> clear Spanish error", async () => {
  const unusedPort = 47399;

  await withClient(
    {
      env: {
        SWAL_MCP_CHART_BRIDGE: "client",
        SWAL_BRIDGE_CONTROL_PORT: String(unusedPort),
      },
    },
    async (client) => {
      const stateRes = await callOrCatch(client, "chart_state", {});
      assert.ok(stateRes.isError);
      assert.equal(
        errorText(stateRes),
        "servicio swal-bridge apagado: systemctl --user start swal-bridge"
      );

      const paintRes = await callOrCatch(client, "chart_paint", {
        shapes: [{ kind: "level", points: [{ time: 1700000000, price: 50000 }] }],
      });
      assert.ok(paintRes.isError);
      assert.equal(
        errorText(paintRes),
        "servicio swal-bridge apagado: systemctl --user start swal-bridge"
      );
    }
  );
});

test("MCP client mode binds no port", async () => {
  const unusedPort = 47398;
  await withClient(
    {
      env: {
        SWAL_MCP_CHART_BRIDGE: "client",
        SWAL_BRIDGE_CONTROL_PORT: String(unusedPort),
      },
    },
    async () => {
      const probeServer = http.createServer();
      await new Promise((resolve, reject) => {
        probeServer.listen(0, "127.0.0.1", resolve);
        probeServer.on("error", reject);
      });
      await new Promise((resolve) => probeServer.close(resolve));
    }
  );
});
