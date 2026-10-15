import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";


/** Largest client frame accepted (bytes). */
export const MAX_FRAME_BYTES = 64 * 1024;
export const WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const DEFAULT_CHART_BRIDGE_PORT = 47321;
export const DEFAULT_AUTH_TIMEOUT_MS = 5000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

export const SHAPE_KINDS = ["level", "trend", "label", "arrow", "zone"] as const;
export type BridgeShapeKind = (typeof SHAPE_KINDS)[number];

export const SHAPE_STYLES = ["solid", "dashed"] as const;
export type BridgeShapeStyle = (typeof SHAPE_STYLES)[number];

export const ARROW_DIRECTIONS = ["up", "down"] as const;
export type BridgeArrowDirection = (typeof ARROW_DIRECTIONS)[number];

export interface BridgePoint {
  time: number;
  price: number;
}

export interface BridgeShape {
  id?: string;
  kind: BridgeShapeKind;
  style?: BridgeShapeStyle;
  text?: string;
  direction?: BridgeArrowDirection;
  points: BridgePoint[];
}

export interface ChartStateResult {
  connected: boolean;
  symbol: string | null;
  timeframe: string | null;
  paintEnabled: boolean;
  tabUrlHost: string | null;
}

export interface ChartBridge {
  getChartState(): Promise<ChartStateResult>;
  paint(shapes: BridgeShape[]): Promise<unknown>;
  clear(): Promise<unknown>;
  setTimeframe(timeframe: string): Promise<unknown>;
  close?(): Promise<void>;
}

export const TIMEFRAME_TO_RESOLUTION: Record<string, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "1h": "60",
  "4h": "240",
  "1d": "1D",
};

/**
 * Ensures pairing token exists at tokenPath with mode 0600.
 * Created on first start (32 random bytes, base64url).
 */
export function ensureBridgeToken(explicitPath?: string): { token: string; tokenPath: string } {
  const tokenPath =
    explicitPath ??
    path.join(process.env.HOME || os.homedir(), ".config", "swal-trade", "chart-bridge-token");

  try {
    if (fs.existsSync(tokenPath)) {
      try {
        fs.chmodSync(tokenPath, 0o600);
      } catch {
        // Ignored if chmod not supported on current filesystem
      }
      const existing = fs.readFileSync(tokenPath, "utf8").trim();
      if (existing) {
        return { token: existing, tokenPath };
      }
    }
  } catch {
    // Re-create if unreadable
  }

  const dir = path.dirname(tokenPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(tokenPath, token, { mode: 0o600, encoding: "utf8" });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    // Ignored if chmod not supported
  }
  return { token, tokenPath };
}

/**
 * Validates shapes against the extension limits (kinds, max 30, text <= 60, points, finite numbers)
 * and guarantees visual distinction (IA: prefix).
 */
export function validateShapes(raw: unknown): { ok: true; shapes: BridgeShape[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "shapes must be an array" };
  }
  if (raw.length === 0) {
    return { ok: false, error: "shapes list cannot be empty" };
  }
  if (raw.length > 30) {
    return { ok: false, error: `too many shapes (${raw.length}); max is 30` };
  }

  const validated: BridgeShape[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object") {
      return { ok: false, error: `shape[${i}] is not an object` };
    }
    const kind = (item as { kind?: unknown }).kind;
    if (typeof kind !== "string" || !SHAPE_KINDS.includes(kind as BridgeShapeKind)) {
      return { ok: false, error: `shape[${i}].kind "${String(kind)}" is invalid; must be one of ${SHAPE_KINDS.join(", ")}` };
    }
    const typedKind = kind as BridgeShapeKind;

    const rawPoints = (item as { points?: unknown }).points;
    if (!Array.isArray(rawPoints)) {
      return { ok: false, error: `shape[${i}].points must be an array` };
    }

    const expectedPoints = typedKind === "trend" || typedKind === "zone" ? 2 : 1;
    if (rawPoints.length !== expectedPoints) {
      return { ok: false, error: `shape[${i}] (${typedKind}) requires exactly ${expectedPoints} point(s), got ${rawPoints.length}` };
    }

    const points: BridgePoint[] = [];
    for (let p = 0; p < rawPoints.length; p++) {
      const pt = rawPoints[p];
      if (!pt || typeof pt !== "object") {
        return { ok: false, error: `shape[${i}].points[${p}] is invalid` };
      }
      const time = (pt as { time?: unknown }).time;
      const price = (pt as { price?: unknown }).price;
      if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > 4102444800) {
        return { ok: false, error: `shape[${i}].points[${p}].time must be a valid positive unix timestamp in seconds` };
      }
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
        return { ok: false, error: `shape[${i}].points[${p}].price must be a positive finite number` };
      }
      points.push({ time, price });
    }

    let direction: BridgeArrowDirection | undefined;
    if (typedKind === "arrow") {
      const dir = (item as { direction?: unknown }).direction;
      if (dir !== "up" && dir !== "down") {
        return { ok: false, error: `shape[${i}] (arrow) requires direction "up" or "down"` };
      }
      direction = dir;
    }

    let style: BridgeShapeStyle = "solid";
    const rawStyle = (item as { style?: unknown }).style;
    if (rawStyle !== undefined) {
      if (rawStyle !== "solid" && rawStyle !== "dashed") {
        return { ok: false, error: `shape[${i}].style must be "solid" or "dashed"` };
      }
      style = rawStyle;
    }

    const rawText = (item as { text?: unknown }).text;
    let text = "";
    if (rawText !== undefined) {
      if (typeof rawText !== "string") {
        return { ok: false, error: `shape[${i}].text must be a string` };
      }
      if (rawText.length > 60) {
        return { ok: false, error: `shape[${i}].text exceeds 60 characters` };
      }
      text = rawText.trim();
    }

    // Visually distinguish shapes from Claude: prefix with "IA:"
    const prefixedText = text.startsWith("IA:") ? text : text ? `IA: ${text}` : "IA";

    const rawId = (item as { id?: unknown }).id;
    const id = typeof rawId === "string" && rawId.length > 0 ? rawId.slice(0, 64) : `ia-${i + 1}-${Date.now()}`;

    validated.push({
      id,
      kind: typedKind,
      style,
      text: prefixedText,
      points,
      ...(direction ? { direction } : {}),
    });
  }

  return { ok: true, shapes: validated };
}

interface ActiveClient {
  socket: Duplex;
  authenticated: boolean;
  closed: boolean;
  authTimer: NodeJS.Timeout | null;
  buffer: Buffer;
  sendJson(obj: unknown): void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer: NodeJS.Timeout;
}

export interface ChartBridgeServerOptions {
  port?: number;
  tokenPath?: string;
  authTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export class ChartBridgeServer implements ChartBridge {
  port: number;
  readonly token: string;
  readonly tokenPath: string;
  readonly authTimeoutMs: number;
  readonly requestTimeoutMs: number;

  private server: http.Server | null = null;
  /** Why the server is not listening (e.g. another Claude session already owns the port). */
  public startError: string | null = null;
  private activeClient: ActiveClient | null = null;
  private sockets = new Set<Duplex>();
  private pendingRequests = new Map<string, PendingRequest>();

  constructor(options: ChartBridgeServerOptions = {}) {
    this.port = options.port ?? DEFAULT_CHART_BRIDGE_PORT;
    const tokenInfo = ensureBridgeToken(options.tokenPath);
    this.token = tokenInfo.token;
    this.tokenPath = tokenInfo.tokenPath;
    this.authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  isConnected(): boolean {
    return (
      this.activeClient !== null &&
      this.activeClient.authenticated &&
      !this.activeClient.closed &&
      !this.activeClient.socket.destroyed
    );
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((_req, res) => {
      res.writeHead(426, { "Content-Type": "text/plain" });
      res.end("Upgrade Required");
    });

    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });

    this.server.on("upgrade", (req, socket, _head) => {
      const upgrade = req.headers.upgrade;
      if (!upgrade || upgrade.toLowerCase() !== "websocket") {
        socket.destroy();
        return;
      }

      const origin = req.headers.origin;
      if (!origin || (!origin.startsWith("chrome-extension://") && !origin.startsWith("moz-extension://"))) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.end();
        return;
      }

      if (this.activeClient && !this.activeClient.closed) {
        socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.end();
        return;
      }

      const key = req.headers["sec-websocket-key"];
      if (!key) {
        socket.destroy();
        return;
      }

      const accept = crypto
        .createHash("sha1")
        .update(key + WS_MAGIC_GUID)
        .digest("base64");

      const responseHeaders = [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n");

      socket.write(responseHeaders);
      this.setupClient(socket);
    });

    await new Promise<void>((resolve, reject) => {
      // Bound ONLY to 127.0.0.1
      this.server!.listen(this.port, "127.0.0.1", () => {
        const address = this.server!.address();
        if (address && typeof address === "object") {
          this.port = address.port;
        }
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  private setupClient(socket: Duplex): void {
    const client: ActiveClient = {
      socket,
      authenticated: false,
      closed: false,
      authTimer: null,
      buffer: Buffer.alloc(0),
      sendJson: (obj: unknown) => {
        if (client.closed) return;
        const payload = Buffer.from(JSON.stringify(obj), "utf8");
        const len = payload.length;
        let header: Buffer;
        if (len < 126) {
          header = Buffer.from([0x81, len]);
        } else if (len <= 0xffff) {
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 126;
          header.writeUInt16BE(len, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x81;
          header[1] = 127;
          header.writeBigUInt64BE(BigInt(len), 2);
        }
        socket.write(Buffer.concat([header, payload]));
      },
    };

    this.activeClient = client;

    client.authTimer = setTimeout(() => {
      if (!client.authenticated) {
        this.dropClient(client, "auth timeout");
      }
    }, this.authTimeoutMs);

    socket.on("data", (chunk: Buffer) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      this.processIncoming(client);
    });

    socket.on("end", () => {
      this.onClientClosed(client);
    });
    socket.on("close", () => {
      this.onClientClosed(client);
    });

    socket.on("error", () => {
      this.onClientClosed(client);
    });
  }

  private processIncoming(client: ActiveClient): void {
    while (client.buffer.length >= 2) {
      const first = client.buffer[0]!;
      const second = client.buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLen = second & 0x7f;
      let offset = 2;

      // RFC 6455 5.1: Client MUST mask frames
      if (!masked) {
        this.dropClient(client, "unmasked frame from client");
        return;
      }

      if (payloadLen === 126) {
        if (client.buffer.length < 4) return;
        payloadLen = client.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (client.buffer.length < 10) return;
        payloadLen = Number(client.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      // Cap before buffering: the Origin check does not stop a local non-browser
      // process, so an unauthenticated peer must not be able to make us hold an
      // arbitrarily large frame in memory. 30 shapes fit in a few KB.
      if (payloadLen > MAX_FRAME_BYTES) {
        this.dropClient(client, "frame too large");
        return;
      }

      if (client.buffer.length < offset + 4 + payloadLen) {
        return; // Need more data
      }

      const maskKey = client.buffer.subarray(offset, offset + 4);
      offset += 4;
      const rawPayload = client.buffer.subarray(offset, offset + payloadLen);
      client.buffer = client.buffer.subarray(offset + payloadLen);

      const unmasked = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = (rawPayload[i]!) ^ (maskKey[i % 4]!);
      }

      if (opcode === 0x8) {
        // Close frame
        client.socket.write(Buffer.from([0x88, 0x00]));
        this.dropClient(client, "close frame");
        return;
      }

      if (opcode === 0x9) {
        // Ping frame -> respond with pong
        const pongHeader = Buffer.from([0x8a, unmasked.length]);
        client.socket.write(Buffer.concat([pongHeader, unmasked]));
        continue;
      }

      if (opcode === 0xa) {
        // Pong frame -> ignore
        continue;
      }

      if (opcode === 0x1) {
        // Text frame
        const text = unmasked.toString("utf8");
        this.handleTextMessage(client, text);
      }
    }
  }

  private handleTextMessage(client: ActiveClient, text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (!client.authenticated) {
      if (msg.type !== "hello" || typeof msg.token !== "string") {
        this.dropClient(client, "expected hello message");
        return;
      }

      const expectedBuf = Buffer.from(this.token, "utf8");
      const actualBuf = Buffer.from(msg.token, "utf8");
      const valid = expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

      if (!valid) {
        this.dropClient(client, "invalid pairing token");
        return;
      }

      client.authenticated = true;
      if (client.authTimer) {
        clearTimeout(client.authTimer);
        client.authTimer = null;
      }
      client.sendJson({ type: "hello_ack", ok: true });
      return;
    }

    // Authenticated message: check if matching a pending request
    const id = typeof msg.id === "string" ? msg.id : null;
    if (id && this.pendingRequests.has(id)) {
      const pending = this.pendingRequests.get(id)!;
      this.pendingRequests.delete(id);
      clearTimeout(pending.timer);

      if (msg.ok === false) {
        pending.reject(new Error(typeof msg.error === "string" ? msg.error : "extension error"));
      } else {
        pending.resolve(msg.state ?? msg.result ?? msg);
      }
    }
  }

  private dropClient(client: ActiveClient, _reason: string): void {
    if (client.closed) return;
    client.closed = true;
    if (client.authTimer) {
      clearTimeout(client.authTimer);
      client.authTimer = null;
    }
    client.socket.destroy();
    this.onClientClosed(client);
  }

  private onClientClosed(client: ActiveClient): void {
    client.closed = true;
    if (this.activeClient === client) {
      this.activeClient = null;
      for (const [id, pending] of this.pendingRequests.entries()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("extension disconnected"));
      }
      this.pendingRequests.clear();
    }
  }

  private async request(type: string, payload: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    if (this.startError) throw new Error(this.startError);
    if (!this.activeClient || !this.activeClient.authenticated || this.activeClient.closed) {
      throw new Error(
        "extension not connected: open Binance futures and enable \"Permitir que Claude use el gráfico\" in Ajustes"
      );
    }

    const id = crypto.randomUUID();
    const timeout = timeoutMs ?? this.requestTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`request timed out waiting for extension response (${type})`));
      }, timeout);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.activeClient!.sendJson({ id, type, ...payload });
    });
  }

  async getChartState(): Promise<ChartStateResult> {
    const res = (await this.request("chart_state")) as Partial<ChartStateResult>;
    return {
      connected: res.connected === true,
      symbol: typeof res.symbol === "string" ? res.symbol : null,
      timeframe: typeof res.timeframe === "string" ? res.timeframe : null,
      paintEnabled: res.paintEnabled === true,
      tabUrlHost: typeof res.tabUrlHost === "string" ? res.tabUrlHost : null,
    };
  }

  async paint(shapes: BridgeShape[]): Promise<unknown> {
    return this.request("chart_paint", { shapes });
  }

  async clear(): Promise<unknown> {
    return this.request("chart_clear");
  }

  async setTimeframe(timeframe: string): Promise<unknown> {
    const resolution = TIMEFRAME_TO_RESOLUTION[timeframe];
    if (!resolution) {
      throw new Error(`invalid timeframe: ${timeframe}`);
    }
    return this.request("set_resolution", { resolution });
  }

  async close(): Promise<void> {
    if (this.activeClient) {
      this.dropClient(this.activeClient, "server closing");
    }
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }
}

let sharedBridge: ChartBridgeServer | null = null;

export function getOrCreateBridge(env: NodeJS.ProcessEnv): ChartBridgeServer {
  if (!sharedBridge) {
    const port = env.SWAL_MCP_CHART_PORT ? parseInt(env.SWAL_MCP_CHART_PORT, 10) : DEFAULT_CHART_BRIDGE_PORT;
    sharedBridge = new ChartBridgeServer({ port });
    const bridge = sharedBridge;
    void bridge.start().catch((err: NodeJS.ErrnoException) => {
      bridge.startError =
        err?.code === "EADDRINUSE"
          ? `chart bridge port ${port} is already in use (another Claude Code session owns the chart): use that session or close it`
          : `chart bridge failed to start: ${err?.message ?? String(err)}`;
      console.error(bridge.startError);
    });
  }
  return sharedBridge;
}
