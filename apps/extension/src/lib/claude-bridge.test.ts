import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ClaudeBridgeClient, type BridgeChartState } from "./claude-bridge";
import { DEFAULT_HOTKEY_MAP, type ExtensionSettings } from "./settings";
import type { PaintCommand } from "./tv-paint";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 0; // CONNECTING

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }

  open() {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  receive(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

describe("ClaudeBridgeClient", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const baseSettings: ExtensionSettings = {
    defaultTimeframe: "5m",
    symbols: [],
    autoSync: true,
    paintOnChart: true,
    explainWithAi: false,
    hotkeysEnabled: true,
    hotkeyMap: { ...DEFAULT_HOTKEY_MAP },
    claudeBridgeEnabled: true,
    claudeBridgePort: 47321,
    claudeBridgeToken: "secret_token_123",
  };

  const chartState: BridgeChartState = {
    connected: true,
    symbol: "BTCUSDT",
    timeframe: "15m",
    paintEnabled: true,
    tabUrlHost: "www.binance.com",
  };

  it("sends hello message on connect and updates status on hello_ack", async () => {
    const statusChanges: string[] = [];
    const client = new ClaudeBridgeClient({
      createWebSocket: (url) => new MockWebSocket(url) as any,
      getSettings: () => baseSettings,
      getChartState: () => chartState,
      sendPaint: async () => 1,
      onStatusChange: (s) => statusChanges.push(s),
    });

    await client.start();
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0]!;
    expect(ws.url).toBe("ws://127.0.0.1:47321/");

    ws.open();
    expect(ws.sent).toHaveLength(1);
    const hello = JSON.parse(ws.sent[0]!);
    expect(hello).toEqual({
      type: "hello",
      token: "secret_token_123",
      version: 1,
    });

    ws.receive({ type: "hello_ack", ok: true });
    expect(client.getStatus()).toBe("connected");
    expect(statusChanges).toContain("connected");
  });

  it("reconnects with backoff when connection closes unexpectedly", async () => {
    const client = new ClaudeBridgeClient({
      createWebSocket: (url) => new MockWebSocket(url) as any,
      getSettings: () => baseSettings,
      getChartState: () => chartState,
      sendPaint: async () => 1,
    });

    await client.start();
    const ws1 = MockWebSocket.instances[0]!;
    ws1.open();
    ws1.receive({ type: "hello_ack", ok: true });

    // Connection drops
    ws1.close();
    expect(client.getStatus()).toBe("disconnected");

    // Advance time by backoff (1000ms)
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(2);
    const ws2 = MockWebSocket.instances[1]!;
    expect(ws2.url).toBe("ws://127.0.0.1:47321/");
  });

  it("relays chart_state, chart_paint, chart_clear, and set_resolution", async () => {
    let lastPaintCommand: PaintCommand | null = null;
    const client = new ClaudeBridgeClient({
      createWebSocket: (url) => new MockWebSocket(url) as any,
      getSettings: () => baseSettings,
      getChartState: () => chartState,
      sendPaint: async (cmd) => {
        lastPaintCommand = cmd;
        return 1;
      },
    });

    await client.start();
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.receive({ type: "hello_ack", ok: true });
    ws.sent.length = 0; // clear hello

    // 1. chart_state
    ws.receive({ id: "req-1", type: "chart_state" });
    await Promise.resolve();
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      id: "req-1",
      ok: true,
      state: chartState,
    });

    // 2. chart_paint
    ws.sent.length = 0;
    ws.receive({
      id: "req-2",
      type: "chart_paint",
      shapes: [
        {
          id: "lvl-1",
          kind: "level",
          text: "support",
          points: [{ time: 1700000000, price: 50000 }],
        },
      ],
    });
    await Promise.resolve();
    expect(lastPaintCommand).not.toBeNull();
    expect(lastPaintCommand!.shapes[0]!.text).toBe("IA: support");
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      id: "req-2",
      ok: true,
      result: { sent: 1, count: 1 },
    });

    // 3. chart_clear
    ws.sent.length = 0;
    ws.receive({ id: "req-3", type: "chart_clear" });
    await Promise.resolve();
    expect(lastPaintCommand).toBeNull();
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      id: "req-3",
      ok: true,
      result: { cleared: true },
    });

    // 4. set_resolution -> unsupported clean error
    ws.sent.length = 0;
    ws.receive({ id: "req-4", type: "set_resolution", resolution: "15" });
    await Promise.resolve();
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      id: "req-4",
      ok: false,
      error: "unsupported",
    });
  });

  it("relays set_resolution to the timeframe path and rejects unknown resolutions", async () => {
    const calls: string[] = [];
    const client = new ClaudeBridgeClient({
      createWebSocket: (url) => new MockWebSocket(url) as any,
      getSettings: () => baseSettings,
      getChartState: () => chartState,
      sendPaint: async () => 1,
      setResolution: async (resolution) => {
        calls.push(resolution);
        return { ok: true, resolution };
      },
    });
    await client.start();
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.receive({ type: "hello_ack", ok: true });
    ws.sent.length = 0;

    ws.receive({ id: "r-1", type: "set_resolution", resolution: "240" });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["240"]);
    expect(JSON.parse(ws.sent[0]!)).toEqual({ id: "r-1", ok: true, result: { ok: true, resolution: "240" } });

    ws.sent.length = 0;
    ws.receive({ id: "r-2", type: "set_resolution", resolution: "7" });
    await Promise.resolve();
    expect(calls).toEqual(["240"]);
    expect(JSON.parse(ws.sent[0]!)).toEqual({ id: "r-2", ok: false, error: "invalid resolution" });
  });

  it("disconnects and stops reconnecting when disabled", async () => {
    const client = new ClaudeBridgeClient({
      createWebSocket: (url) => new MockWebSocket(url) as any,
      getSettings: () => baseSettings,
      getChartState: () => chartState,
      sendPaint: async () => 1,
    });

    await client.start();
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.receive({ type: "hello_ack", ok: true });
    expect(client.getStatus()).toBe("connected");

    // Disabled setting
    client.updateSettings({ ...baseSettings, claudeBridgeEnabled: false });
    expect(client.getStatus()).toBe("disconnected");

    // Advance time, no new connection attempted
    vi.advanceTimersByTime(5000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
