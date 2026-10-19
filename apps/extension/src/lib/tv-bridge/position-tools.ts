/**
 * Lectura de las herramientas Long/Short Position que el usuario dibuja en la
 * pestaña "Trading View" de Binance.
 *
 * Verificado en vivo (`e2e/scripts/investigation/TV_POSITION_TOOLS.md`):
 * - `chart.getAllShapes()` devuelve `{id, name}` con nombres tipo
 *   `long_position` / `short_position` / `LineToolRiskRewardLong`;
 * - `chart.getShapeById(id).getPoints()[0].price` es la ENTRADA;
 * - `getProperties().stopLevel` y `.profitLevel` van en TICS (no en precio);
 * - `chart.symbolExt()` da `minmov` y `pricescale` (minTick = minmov/pricescale);
 * - el gráfico NO expone eventos de dibujo: hay que sondear.
 *
 * Este módulo solo LEE: nunca crea, mueve ni borra un dibujo del usuario. Todo
 * va en try/catch y lo que no se entiende se descarta.
 */

import { symbolFromTv, type TvDrawingTool } from '../drawing/tv-read';
import type { PositionDrawing } from '../drawing/types';
import { drawingFromTvTool } from '../drawing/tv-read';
import {
  buildPositionToolsMessage,
  type BridgePositionTool,
  type BridgePositionToolsMessage,
} from './schema';

/** Solo se miran las primeras formas del gráfico: más allá no hay nada que leer. */
export const MAX_SCANNED_SHAPES = 40;
/** Cada cuánto se vuelve a mirar el gráfico (no hay eventos de dibujo). */
export const POSITION_TOOLS_POLL_MS = 1500;

/** Nombres con los que TradingView publica las herramientas de posición. */
const POSITION_TOOL_NAME = /position|riskreward/i;

export function isPositionToolName(name: unknown): boolean {
  return typeof name === 'string' && POSITION_TOOL_NAME.test(name);
}

/** Lo mínimo del wrapper de forma que se usa aquí. */
export interface TvPositionShapeLike {
  getPoints?(): unknown;
  getProperties?(): unknown;
}

/** Lo mínimo del chart. Nada de cuenta ni de órdenes. */
export interface TvPositionChartLike {
  getAllShapes?(): unknown;
  getShapeById?(id: string): TvPositionShapeLike | null;
  symbolExt?(): unknown;
  symbol?(): string;
}

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

/** Entrada de `getPoints()`: solo interesa el precio del primer punto. */
function entryPriceFrom(points: unknown): number | null {
  if (!Array.isArray(points) || points.length === 0) return null;
  const first = points[0];
  if (!first || typeof first !== 'object') return null;
  return toNumber((first as { price?: unknown }).price);
}

function levelFrom(properties: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = toNumber(properties[key]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Lee las herramientas de posición del gráfico. Devuelve null si no hay chart,
 * si no publica `symbolExt`/`getAllShapes` o si el símbolo no es legible: nunca
 * inventa un dibujo. Con el gráfico sin dibujos devuelve el mensaje con `tools`
 * vacío, que es información válida (el usuario aún no ha trazado nada).
 */
export function readPositionTools(chart: TvPositionChartLike | null): BridgePositionToolsMessage | null {
  if (!chart) return null;
  try {
    const rawSymbol = typeof chart.symbol === 'function' ? chart.symbol() : '';
    const symbol = symbolFromTv(typeof rawSymbol === 'string' ? rawSymbol : '');
    if (!symbol) return null;

    const ext = typeof chart.symbolExt === 'function' ? chart.symbolExt() : null;
    const minmov = ext && typeof ext === 'object' ? toNumber((ext as { minmov?: unknown }).minmov) : null;
    const pricescale =
      ext && typeof ext === 'object' ? toNumber((ext as { pricescale?: unknown }).pricescale) : null;
    if (minmov === null || pricescale === null || minmov <= 0 || pricescale <= 0) return null;

    if (typeof chart.getAllShapes !== 'function' || typeof chart.getShapeById !== 'function') return null;

    const shapes = chart.getAllShapes();
    if (!Array.isArray(shapes)) return null;

    const tools: BridgePositionTool[] = [];
    for (const shape of shapes.slice(0, MAX_SCANNED_SHAPES)) {
      if (!shape || typeof shape !== 'object') continue;
      const record = shape as { id?: unknown; name?: unknown };
      if (typeof record.id !== 'string' || !record.id) continue;
      if (!isPositionToolName(record.name)) continue;
      const name = record.name as string;
      const tool = readTool(chart, record.id, name);
      if (!tool) continue;
      tools.push(tool);
      if (tools.length >= 10) break;
    }
    return buildPositionToolsMessage(symbol, minmov, pricescale, tools);
  } catch {
    return null;
  }
}

function readTool(
  chart: TvPositionChartLike,
  id: string,
  name: string,
): BridgePositionTool | null {
  try {
    const shape = chart.getShapeById?.(id);
    if (!shape) return null;
    const entry = entryPriceFrom(typeof shape.getPoints === 'function' ? shape.getPoints() : null);
    const propertiesRaw = typeof shape.getProperties === 'function' ? shape.getProperties() : null;
    if (!propertiesRaw || typeof propertiesRaw !== 'object') return null;
    const properties = propertiesRaw as Record<string, unknown>;
    const stopLevel = levelFrom(properties, ['stopLevel', 'stop_level']);
    const profitLevel = levelFrom(properties, ['profitLevel', 'profit_level']);
    if (entry === null || entry <= 0 || stopLevel === null || profitLevel === null) return null;
    if (stopLevel <= 0 || profitLevel <= 0) return null;
    return { id: id.slice(0, 64), name: name.slice(0, 40), entry, stopLevel, profitLevel };
  } catch {
    return null;
  }
}

/**
 * Convierte un mensaje del puente en dibujos validados. Los ticks se traducen a
 * precio con la misma fórmula verificada de `drawingFromTvTool`; si un dibujo
 * no cuadra (stop del lado equivocado, entrada 0...) se descarta.
 */
export function drawingsFromPositionTools(
  message: BridgePositionToolsMessage | null,
): PositionDrawing[] {
  if (!message) return [];
  const out: PositionDrawing[] = [];
  for (const tool of message.tools) {
    const input: TvDrawingTool = {
      id: tool.id,
      name: tool.name,
      points: [{ price: tool.entry }],
      properties: { stopLevel: tool.stopLevel, profitLevel: tool.profitLevel },
      minmov: message.minmov,
      pricescale: message.pricescale,
      symbol: message.symbol,
    };
    const drawing = drawingFromTvTool(input);
    if (drawing) out.push(drawing);
  }
  return out;
}

export interface PositionToolsPollerDeps {
  /** Lee el gráfico. Null si no hay chart o no se puede leer. */
  read(): BridgePositionToolsMessage | null;
  /** Envía por el puerto privado. Puede lanzar si el puerto se cerró. */
  send(message: BridgePositionToolsMessage): void;
}

/**
 * Sondeo del gráfico (no hay eventos de dibujo). Solo envía cuando el payload
 * cambia, y se para al apagar el interruptor o al cerrar la página. Si el
 * gráfico desaparece, se olvida el último payload para reenviarlo cuando vuelva.
 */
export class PositionToolsPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastKey = '';
  private enabled = false;

  constructor(
    private readonly deps: PositionToolsPollerDeps,
    private readonly everyMs: number = POSITION_TOOLS_POLL_MS,
    private readonly setIntervalImpl: (cb: () => void, ms: number) => ReturnType<typeof setInterval> = setInterval,
    private readonly clearIntervalImpl: (handle: ReturnType<typeof setInterval>) => void = clearInterval,
  ) {}

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** Enciende o apaga la lectura. Apagarla no toca ningún dibujo del usuario. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) this.start();
    else this.stop();
  }

  start(): void {
    if (this.timer !== null) return;
    this.tick();
    if (this.timer !== null) return;
    this.timer = this.setIntervalImpl(() => this.tick(), this.everyMs);
  }

  stop(): void {
    if (this.timer !== null) this.clearIntervalImpl(this.timer);
    this.timer = null;
    this.lastKey = '';
  }

  /** Una pasada. Devuelve el mensaje enviado, o null si no había o no cambió. */
  tick(): BridgePositionToolsMessage | null {
    if (!this.enabled) return null;
    let message: BridgePositionToolsMessage | null;
    try {
      message = this.deps.read();
    } catch {
      message = null;
    }
    if (!message) {
      this.lastKey = '';
      return null;
    }
    let key: string;
    try {
      key = JSON.stringify(message);
    } catch {
      return null;
    }
    if (key === this.lastKey) return null;
    this.lastKey = key;
    try {
      this.deps.send(message);
    } catch {
      // El puerto se cerró: se reintentará en la siguiente pasada.
    }
    return message;
  }
}
