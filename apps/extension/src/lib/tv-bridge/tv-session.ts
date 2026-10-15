/**
 * Sesión del puente: espera al gráfico, dibuja, limpia y redibuja.
 *
 * Se instancia una por frame donde corre el content script MAIN-world. El
 * entrypoint solo se encarga del transporte (mensajes/nonce) y de traducir el
 * estado a avisos.
 *
 * Reglas duras que vive aquí:
 * - no pinta si el símbolo o la temporalidad del gráfico no casan con el
 *   análisis (F2): en su lugar avisa de que no coincide;
 * - conserva las últimas formas aunque el gráfico se recargue, para redibujarlas
 *   en cuanto vuelva a haber chart con la misma clave (F3);
 * - una reimpresión solo recrea las entidades cuya forma o texto cambió.
 */

import { buildResolutionAckMessage, type BridgeMessage, type BridgeResolution, type BridgeResolutionAckMessage, type BridgeShape } from './schema';
import { chartMatchesAnalysis, describeChart, type ChartDisplay } from './match';
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
export type BridgeStatus = 'absent' | 'booting' | 'ready' | 'mismatch';

/** Lo que el entrypoint necesita para avisar al panel. */
export interface BridgeReport {
  status: BridgeStatus;
  /** Presente solo en `mismatch`: qué muestra el gráfico que no casa. */
  chart?: ChartDisplay;
}

export interface SessionDeps {
  /** Dónde buscar el gráfico (para los iframes del mismo origen). */
  document: Document;
  /** Ventana propia, por si este frame ES el iframe del chart. */
  selfWindow?: unknown;
  /** Aviso de estado: el entrypoint lo manda por postMessage. */
  onStatus(report: BridgeReport): void;
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


export const RESOLUTION_TO_TIMEFRAME: Record<BridgeResolution, string> = {
  '1': '1m', '5': '5m', '15': '15m', '60': '1h', '240': '4h', '1D': '1d',
};

export class ChartSession {
  private readonly registry = new ShapeRegistry();
  private readonly sleep: (ms: number) => Promise<void>;
  private chart: TvChartLike | null = null;
  private range: TvVisibleRange | null = null;
  private watchedKey = '';
  private subscribed: TvChartLike | null = null;
  private status: BridgeStatus = 'absent';
  private lastReport: BridgeReport = { status: 'absent' };
  private lastDrawKey = '';
  /** Últimas formas del análisis: se conservan aunque el gráfico se vaya (F3). */
  private lastShapes: BridgeShape[] | null = null;
  /** id de forma → texto actualmente pintado. Detecta cambios de texto. */
  private painted = new Map<string, string>();
  private stopped = false;
  /** Mensaje recibido antes de tener gráfico: se aplica al tenerlo. */
  private queued: BridgeMessage | null = null;

  constructor(private readonly deps: SessionDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
  }

  /** Arranca y no devuelve el hilo: vive mientras viva la pestaña. */
  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.clearOwned();
    this.chart = null;
    this.range = null;
    this.subscribed = null;
  }

  /** Borra lo nuestro del gráfico y olvida qué había pintado. */
  private clearOwned(): void {
    this.registry.clear();
    this.painted.clear();
  }

  private setStatus(status: BridgeStatus, chart?: ChartDisplay): void {
    const same =
      this.status === status &&
      (status !== 'mismatch' ||
        (this.lastReport.chart?.symbol === chart?.symbol && this.lastReport.chart?.tf === chart?.tf));
    if (same) return;
    this.status = status;
    this.lastReport = { status, chart };
    this.deps.onStatus(this.lastReport);
  }

  /** Espera con backoff al primer gráfico con rango visible. */
  private async loop(): Promise<void> {
    let delay = 250;
    let waited = 0;
    while (!this.stopped) {
      const found = this.acquire();
      if (found) {
        this.ready();
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
    const win = findChartWindow(this.deps.document, this.deps.selfWindow);
    const chart = win ? chartFromWindow(win) : null;
    if (!chart || !visibleRange(chart)) {
      this.chart = null;
      this.range = null;
      return false;
    }
    const changed = this.chart !== chart;
    this.chart = chart;
    this.range = visibleRange(chart);
    this.registry.bind(chart);
    // Gráfico nuevo o recargado: lo nuestro ya no existe ahí. Se limpia el
    // registro (entidades perdidas) pero NO lastShapes (F3: se redibujará).
    if (changed) this.clearOwned();
    this.watchedKey = chartKey(chart);
    return true;
  }

  private ready(): void {
    const chart = this.chart;
    if (!chart) return;
    if (this.subscribed !== chart) {
      this.subscribed = chart;
      try {
        chart.onSymbolChanged?.(() => this.resync());
      } catch {
        // Sin suscripción manda el sondeo de watch().
      }
      try {
        chart.onIntervalChanged?.(() => this.resync());
      } catch {
        // idem
      }
      // F14: si el chart avisa de los cambios de rango, refrescamos el rango
      // (las formas nuevas se anclan al rango visible actual).
      try {
        chart.onVisibleRangeChanged?.(() => this.refreshRange());
      } catch {
        // idem
      }
    }
    // Pinta (o avisa de desajuste) según lo último que se haya pedido (F3/F2).
    this.resync();
    if (this.queued) {
      const message = this.queued;
      this.queued = null;
      this.apply(message);
    }
  }

  /** Nuevo rango visible: guárdalo para anclar formas nuevas. */
  private refreshRange(): void {
    if (this.stopped || !this.chart) return;
    const range = visibleRange(this.chart);
    if (range) this.range = range;
  }

  /**
   * Reevalúa el estado del gráfico contra lo último pedido: pinta si casa,
   * avisa de desajuste si no, o marca listo si no hay nada que pintar. (F2/F3)
   */
  private resync(): void {
    if (this.stopped) return;
    const chart = this.chart;
    if (!chart || !this.range) return;
    if (!this.lastDrawKey) {
      this.setStatus('ready');
      return;
    }
    if (chartMatchesAnalysis(chart, this.lastDrawKey)) {
      this.setStatus('ready');
      this.paint(this.lastShapes ?? []);
    } else {
      this.clearOwned();
      this.setStatus('mismatch', describeChart(chart));
    }
  }

  private async watch(): Promise<void> {
    while (!this.stopped) {
      await this.sleep(WATCH_MS);
      if (this.stopped) return;
      const win = findChartWindow(this.deps.document, this.deps.selfWindow);
      const chart = win ? chartFromWindow(win) : null;
      if (!chart || chart !== this.chart) {
        // Se fue: se pierden las entidades, pero lastShapes se conserva (F3).
        this.chart = null;
        this.range = null;
        this.subscribed = null;
        this.clearOwned();
        this.setStatus('absent');
        return;
      }
      const range = visibleRange(chart);
      if (range) this.range = range;
      const key = chartKey(chart);
      if (key !== this.watchedKey) {
        this.watchedKey = key;
        this.resync();
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
      this.clearOwned();
      this.lastShapes = null;
      this.lastDrawKey = '';
      this.setStatus('ready');
      return;
    }
    // draw
    this.lastDrawKey = message.key;
    this.lastShapes = message.shapes;
    if (!chartMatchesAnalysis(this.chart, message.key)) {
      this.clearOwned();
      this.setStatus('mismatch', describeChart(this.chart));
      return;
    }
    this.setStatus('ready');
    this.paint(message.shapes);
  }

  /**
   * Pinta exactamente las formas deseadas. Mantiene las que no han cambiado de
   * texto, retira las que sobran o cambiaron el rótulo y crea las nuevas. Así un
   * cambio de etiqueta (otro hallazgo seleccionado) sí se refleja.
   */
  private paint(shapes: readonly BridgeShape[]): void {
    const chart = this.chart;
    const range = this.range;
    if (!chart || !range) return;
    const desired = new Map<string, string>();
    for (const shape of shapes) desired.set(shape.id, shape.text);
    const keep = new Set<string>();
    for (const [id, text] of desired) {
      if (this.painted.get(id) === text) keep.add(id);
    }
    this.registry.retain(keep);
    for (const shape of shapes) {
      if (keep.has(shape.id)) continue;
      try {
        this.registry.track(shape.id, createEntity(chart, shape, range));
      } catch {
        // El gráfico se recargó a medias: se vuelve a intentar en el próximo mensaje.
      }
    }
    this.painted = desired;
  }

  /** Para el content script aislado: ¿está el gráfico listo para pintar? */
  /**
   * Cambia la temporalidad del gráfico. Intenta primero la API de TradingView
   * (activeChart().setResolution); si no está, busca el botón en el DOM; si
   * ninguno funciona, reporta unsupported.
   */
  setResolution(resolution: BridgeResolution): BridgeResolutionAckMessage {
    if (!this.chart) this.acquire();
    const chart = this.chart;
    if (chart && typeof chart.setResolution === 'function') {
      try {
        chart.setResolution(resolution);
        return buildResolutionAckMessage(true, resolution);
      } catch (err) {
        return buildResolutionAckMessage(false, resolution, String(err));
      }
    }
    if (this.clickDomInterval(RESOLUTION_TO_TIMEFRAME[resolution])) return buildResolutionAckMessage(true, resolution);
    return buildResolutionAckMessage(false, resolution, 'unsupported');
  }

  private clickDomInterval(targetTf: string): boolean {
    const doc = this.deps.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') return false;
    try {
      const candidates = doc.querySelectorAll('button, [role="button"], [role="tab"], [role="radio"], [data-interval], div, span');
      for (const el of Array.from(candidates)) {
        const text = (el.textContent ?? '').trim().toLowerCase();
        if (text === targetTf && text.length <= 6 && typeof (el as HTMLElement).click === 'function') {
          (el as HTMLElement).click();
          return true;
        }
      }
    } catch {}
    return false;
  }

  get isReady(): boolean {
    return this.status === 'ready';
  }
}
