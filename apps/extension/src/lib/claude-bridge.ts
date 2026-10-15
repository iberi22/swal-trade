import type { ExtensionSettings } from './settings';
import type { PaintCommand } from './tv-paint';
import type { BridgeShape } from './tv-bridge/schema';

export interface BridgeChartState {
  connected: boolean;
  symbol: string | null;
  timeframe: string | null;
  paintEnabled: boolean;
  tabUrlHost: string | null;
}

export type BridgeStatus = 'connected' | 'connecting' | 'disconnected';

export interface ClaudeBridgeClientOptions {
  /** Cambia la temporalidad del gráfico de Binance (el mismo camino que las teclas F). */
  setResolution?: (resolution: string) => Promise<{ ok: boolean; resolution?: string; error?: string }>;
  createWebSocket?: (url: string) => WebSocket;
  getSettings: () => ExtensionSettings | Promise<ExtensionSettings>;
  getChartState: () => BridgeChartState | Promise<BridgeChartState>;
  sendPaint: (command: PaintCommand | null) => Promise<number>;
  onStatusChange?: (status: BridgeStatus) => void;
}

export class ClaudeBridgeClient {
  private options: ClaudeBridgeClientOptions;
  private ws: WebSocket | null = null;
  private status: BridgeStatus = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1000;
  private maxBackoffMs = 30000;
  private shouldRun = false;
  private currentSettings: ExtensionSettings | null = null;

  constructor(options: ClaudeBridgeClientOptions) {
    this.options = options;
  }

  getStatus(): BridgeStatus {
    return this.status;
  }

  private setStatus(status: BridgeStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.options.onStatusChange?.(status);
    }
  }

  async start(): Promise<void> {
    this.shouldRun = true;
    this.currentSettings = await this.options.getSettings();
    this.connect();
  }

  stop(): void {
    this.shouldRun = false;
    this.cleanupSocket();
    this.setStatus('disconnected');
  }

  updateSettings(settings: ExtensionSettings): void {
    const prevEnabled = this.currentSettings?.claudeBridgeEnabled;
    const prevPort = this.currentSettings?.claudeBridgePort;
    const prevToken = this.currentSettings?.claudeBridgeToken;
    this.currentSettings = settings;

    if (!settings.claudeBridgeEnabled || !settings.claudeBridgeToken) {
      this.stop();
      return;
    }

    if (!prevEnabled || prevPort !== settings.claudeBridgePort || prevToken !== settings.claudeBridgeToken) {
      this.cleanupSocket();
      this.shouldRun = true;
      this.backoffMs = 1000;
      this.connect();
    }
  }

  private cleanupSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private connect(): void {
    if (!this.shouldRun) return;
    const settings = this.currentSettings;
    if (!settings || !settings.claudeBridgeEnabled || !settings.claudeBridgeToken) {
      this.setStatus('disconnected');
      return;
    }

    this.cleanupSocket();
    this.setStatus('connecting');

    const port = settings.claudeBridgePort || 47321;
    const url = `ws://127.0.0.1:${port}/`;

    try {
      const ws = this.options.createWebSocket
        ? this.options.createWebSocket(url)
        : new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.backoffMs = 1000;
        try {
          ws.send(
            JSON.stringify({
              type: 'hello',
              token: settings.claudeBridgeToken,
              version: 1,
            })
          );
        } catch {
          // ignore
        }

        this.pingInterval = setInterval(() => {
          if (this.ws === ws && ws.readyState === 1 /* OPEN */) {
            try {
              ws.send(JSON.stringify({ type: 'ping' }));
            } catch {
              // ignore
            }
          }
        }, 20000);
      };

      ws.onmessage = (event: { data: string }) => {
        if (this.ws !== ws) return;
        void this.handleMessage(event.data);
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.cleanupSocket();
        this.setStatus('disconnected');
        this.scheduleReconnect();
      };

      ws.onerror = () => {
        // onclose will handle cleanup and reconnect
      };
    } catch {
      this.cleanupSocket();
      this.setStatus('disconnected');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun) return;
    const settings = this.currentSettings;
    if (!settings?.claudeBridgeEnabled || !settings.claudeBridgeToken) return;

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'hello_ack') {
      if (msg.ok === true) {
        this.setStatus('connected');
      } else {
        this.stop();
      }
      return;
    }

    const id = typeof msg.id === 'string' ? msg.id : null;
    if (!id) return;

    if (msg.type === 'chart_state') {
      try {
        const state = await this.options.getChartState();
        this.sendJson({ id, ok: true, state });
      } catch (err: any) {
        this.sendJson({ id, ok: false, error: err?.message || 'failed to get chart state' });
      }
      return;
    }

    if (msg.type === 'chart_paint') {
      try {
        const rawShapes = Array.isArray(msg.shapes) ? (msg.shapes as BridgeShape[]) : [];
        const shapes: BridgeShape[] = rawShapes.map((s) => ({
          ...s,
          text: s.text?.startsWith('IA:') ? s.text : s.text ? `IA: ${s.text}` : 'IA',
        }));
        const sent = await this.options.sendPaint({
          key: 'claude-bridge',
          shapes,
        });
        this.sendJson({ id, ok: true, result: { sent, count: shapes.length } });
      } catch (err: any) {
        this.sendJson({ id, ok: false, error: err?.message || 'failed to paint shapes' });
      }
      return;
    }

    if (msg.type === 'chart_clear') {
      try {
        await this.options.sendPaint(null);
        this.sendJson({ id, ok: true, result: { cleared: true } });
      } catch (err: any) {
        this.sendJson({ id, ok: false, error: err?.message || 'failed to clear chart' });
      }
      return;
    }

    if (msg.type === 'set_resolution') {
      const resolution = typeof msg.resolution === 'string' ? msg.resolution : '';
      if (!['1', '5', '15', '60', '240', '1D'].includes(resolution)) {
        this.sendJson({ id, ok: false, error: 'invalid resolution' });
        return;
      }
      if (!this.options.setResolution) {
        this.sendJson({ id, ok: false, error: 'unsupported' });
        return;
      }
      try {
        const result = await this.options.setResolution(resolution);
        this.sendJson({ id, ok: result.ok === true, result, ...(result.ok ? {} : { error: result.error || 'set_resolution failed' }) });
      } catch (err: any) {
        this.sendJson({ id, ok: false, error: err?.message || 'set_resolution failed' });
      }
      return;
    }
  }

  private sendJson(obj: unknown): void {
    if (this.ws && (this.ws as any).readyState === 1 /* OPEN */) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch {
        // ignore
      }
    }
  }
}
