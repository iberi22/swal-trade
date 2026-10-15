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
