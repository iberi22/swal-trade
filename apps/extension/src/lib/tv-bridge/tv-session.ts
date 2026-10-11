/**
 * Sesión del puente: espera al gráfico, dibuja, limpia y redibuja.
 *
 * Se instancia una por frame donde corre el content script MAIN-world. El
 * entrypoint solo se encarga de los mensajes y del nonce.
 */

import type { BridgeMessage, BridgeShape } from './schema';
import { ShapeRegistry } from './registry';
import {
  chartFromWindow,
  chartKey,
  createEntity,
  findChartWindow,
  visibleRange,
  type TvChartLike,
  type TvVisibleRange,
} from './tv-chart';

/** Estado que se le reporta al content script aislado. */
export type BridgeStatus = 'absent' | 'booting' | 'ready';

export interface SessionDeps {
  /** Dónde buscar el gráfico. */
  document: Document;
  /** Aviso de estado: el entrypoint lo manda por postMessage. */
  onStatus(status: BridgeStatus): void;
  /** Espera inyectable para los tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Espera total al primer gráfico utilizable, en milisegundos. */
const BOOT_BUDGET_MS = 20_000;
/** Reintento cuando no hay gráfico: la pestaña puede aparecer en cualquier momento. */
const RETRY_MS = 4_000;
/** Vigilancia del gráfico: ¿se fue? ¿cambió de símbolo o intervalo? */
const WATCH_MS = 3_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameShape(a: BridgeShape, b: BridgeShape): boolean {
  if (a.id !== b.id || a.kind !== b.kind || a.style !== b.style || a.text !== b.text) return false;
  if (a.direction !== b.direction) return false;
  if (a.points.length !== b.points.length) return false;
  return a.points.every(
    (point, index) => point.time === b.points[index]!.time && point.price === b.points[index]!.price,
  );
}

function sameShapes(a: readonly BridgeShape[] | null, b: readonly BridgeShape[] | null): boolean {
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  return a.every((shape, index) => sameShape(shape, b[index]!));
}

export class ChartSession {
  private readonly registry = new ShapeRegistry();
  private readonly sleep: (ms: number) => Promise<void>;
  private chart: TvChartLike | null = null;
  private range: TvVisibleRange | null = null;
  private watchedKey = '';
  private status: BridgeStatus = 'absent';
  private lastDrawKey = '';
  private lastShapes: BridgeShape[] | null = null;
  private stopped = false;
  /** Mensaje recibido antes de tener gráfico: se aplica al tenerlo. */
  private queued: BridgeMessage | null = null;

  constructor(private readonly deps: SessionDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
  }

  /** Arranca y no devuelve el hilo: vive mientras viva la pestaña. */
  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.registry.clear();
    this.chart = null;
    this.range = null;
  }

  private setStatus(status: BridgeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.deps.onStatus(status);
  }

  /** Espera con backoff al primer gráfico con rango visible. */
  private async loop(): Promise<void> {
    let delay = 250;
    let waited = 0;
    while (!this.stopped) {
      const found = this.acquire();
      if (found) {
        await this.ready();
        if (this.stopped) return;
        await this.watch();
        if (this.stopped) return;
        // El gráfico se fue: se vuelve a buscar desde el principio.
        delay = 250;
        waited = 0;
        continue;
      }
      if (waited >= BOOT_BUDGET_MS) {
        this.setStatus('absent');
        await this.sleep(RETRY_MS);
        waited = 0;
        continue;
      }
      if (this.status !== 'booting') this.setStatus('booting');
      await this.sleep(delay);
      waited += delay;
      delay = Math.min(Math.round(delay * 1.6), 2_000);
    }
  }

  /** true si hay chart con rango visible. */
  private acquire(): boolean {
    const win = findChartWindow(this.deps.document);
    const chart = win ? chartFromWindow(win) : null;
    if (!chart) {
      this.chart = null;
      this.range = null;
      return false;
    }
    const range = visibleRange(chart);
    if (!range) {
      this.chart = null;
      this.range = null;
      return false;
    }
    const changed = this.chart !== chart;
    this.chart = chart;
    this.range = range;
    this.registry.bind(chart);
    const key = chartKey(chart);
    if (changed || key !== this.watchedKey) {
      this.watchedKey = key;
      // Gráfico nuevo o recargado: lo nuestro ya no existe ahí.
      this.registry.clear();
      this.lastShapes = null;
    }
    return true;
  }

  private async ready(): Promise<void> {
    const chart = this.chart;
    if (!chart) return;
    this.setStatus('ready');
    try {
      chart.onSymbolChanged?.(() => this.invalidate());
    } catch {
      // Sin suscripción manda el sondeo de watch().
    }
    try {
      chart.onIntervalChanged?.(() => this.invalidate());
    } catch {
      // idem
    }
    if (this.queued) {
      const message = this.queued;
      this.queued = null;
      this.apply(message);
    }
  }

  /** Cambio de símbolo o intervalo: lo nuestro se vuelve a pintar. */
  private invalidate(): void {
    if (this.stopped) return;
    this.registry.clear();
    this.lastShapes = null;
    if (this.lastDrawKey) this.redraw();
  }

  private redraw(): void {
    if (!this.lastShapes || this.lastShapes.length === 0) return;
    this.paint(this.lastShapes);
  }

  private async watch(): Promise<void> {
    while (!this.stopped) {
      await this.sleep(WATCH_MS);
      if (this.stopped) return;
      const win = findChartWindow(this.deps.document);
      const chart = win ? chartFromWindow(win) : null;
      if (!chart || chart !== this.chart) {
        this.chart = null;
        this.range = null;
        this.watchedKey = '';
        this.registry.clear();
        this.lastShapes = null;
        this.setStatus('absent');
        return;
      }
      const range = visibleRange(chart);
      if (range) this.range = range;
      const key = chartKey(chart);
      if (key !== this.watchedKey) {
        this.watchedKey = key;
        this.invalidate();
      }
    }
  }

  /** Aplica un mensaje validado. Sin gráfico, se guarda para después. */
  apply(message: BridgeMessage): void {
    if (this.stopped) return;
    if (!this.chart || !this.range) {
      this.queued = message;
      return;
    }
    if (message.type === 'swal:clear') {
      this.registry.clear();
      this.lastShapes = null;
      this.lastDrawKey = '';
      return;
    }
    this.lastDrawKey = message.key;
    if (sameShapes(this.lastShapes, message.shapes)) return;
    this.lastShapes = message.shapes;
    this.paint(message.shapes);
  }

  /** Borra lo nuestro y pinta la lista nueva. */
  private paint(shapes: readonly BridgeShape[]): void {
    const chart = this.chart;
    const range = this.range;
    if (!chart || !range) return;
    const wanted = new Set(shapes.map((shape) => shape.id));
    this.registry.retain(wanted);
    for (const shape of shapes) {
      if (this.registry.has(shape.id)) continue;
      try {
        this.registry.track(shape.id, createEntity(chart, shape, range));
      } catch {
        // El gráfico se recargó a medias: se vuelve a intentar en el próximo mensaje.
      }
    }
  }

  /**
   * Para el content script aislado: ¿está el gráfico listo? Lo construye el
   * entrypoint, que es quien conoce el nonce.
   */
  get isReady(): boolean {
    return this.status === 'ready';
  }
}
