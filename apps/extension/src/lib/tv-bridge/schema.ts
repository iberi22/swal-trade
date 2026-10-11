/**
 * Contrato de mensajes entre el content script aislado y el puente MAIN-world.
 *
 * El puente vive en el mundo de la página (MAIN) porque es el único que alcanza
 * el iframe de TradingView que Binance monta en la pestaña "Trading View". El
 * panel no habla con el gráfico: manda un mensaje de runtime al content script
 * aislado y este lo reenvía por `window.postMessage`. Nada de eso cruza la red.
 *
 * Reglas duras del validador:
 * - solo pasa `swal:draw`, `swal:clear` y `swal:ready`;
 * - la versión tiene que coincidir;
 * - el nonce tiene que ser el que publicó el content script en esta página;
 * - como máximo `SWAL_MAX_SHAPES` formas;
 * - cada forma valida sus puntos uno a uno: número finito o se descarta.
 *
 * Cualquier otra cosa se ignora en silencio: un mensaje rogue no dibuja.
 */

/** Versión del contrato. Subirla invalida los mensajes antiguos. */
export const SWAL_MESSAGE_VERSION = 1;

/** Tope de formas por mensaje. Más estorba al gráfico, no lo mejora. */
export const SWAL_MAX_SHAPES = 60;

export const SWAL_DRAW = 'swal:draw';
export const SWAL_CLEAR = 'swal:clear';
export const SWAL_READY = 'swal:ready';

export const SHAPE_KINDS = ['level', 'trend', 'label', 'arrow', 'zone'] as const;
export type BridgeShapeKind = (typeof SHAPE_KINDS)[number];

export const SHAPE_STYLES = ['solid', 'dashed'] as const;
export type BridgeShapeStyle = (typeof SHAPE_STYLES)[number];

export const ARROW_DIRECTIONS = ['up', 'down'] as const;
export type BridgeArrowDirection = (typeof ARROW_DIRECTIONS)[number];

/** Límite del identificador estable de la forma (hallazgo + nivel + tipo). */
export const MAX_SHAPE_ID = 64;
/** Límite del texto que se pinta en el gráfico. */
export const MAX_SHAPE_TEXT = 48;

/** Puntos que acepta cada forma. La API de TradingView es estricta aquí. */
export const SHAPE_POINT_RANGE: Record<BridgeShapeKind, { min: number; max: number }> = {
  level: { min: 1, max: 1 },
  label: { min: 1, max: 1 },
  arrow: { min: 1, max: 1 },
  trend: { min: 2, max: 2 },
  zone: { min: 2, max: 2 },
};

export interface BridgePoint {
  /** Segundos unix (UTC), el contrato del eje temporal de TradingView. */
  time: number;
  price: number;
}

export interface BridgeShape {
  /** Identificador estable: quién manda y qué nivel es. Lo usa el registro. */
  id: string;
  kind: BridgeShapeKind;
  style: BridgeShapeStyle;
  /** Texto en español que se pinta. Puede ir vacío. */
  text: string;
  points: BridgePoint[];
  /** Solo en `arrow`: ▲ compra agresiva o ▼ venta agresiva. */
  direction?: BridgeArrowDirection;
}

export interface BridgeDrawMessage {
  type: typeof SWAL_DRAW;
  version: number;
  nonce: string;
  /** Símbolo y temporalidad del análisis, para no redibujar lo mismo. */
  key: string;
  shapes: BridgeShape[];
}

export interface BridgeClearMessage {
  type: typeof SWAL_CLEAR;
  version: number;
  nonce: string;
}

export interface BridgeReadyMessage {
  type: typeof SWAL_READY;
  version: number;
  nonce: string;
  /** true cuando el puente tiene el gráfico con rango visible. */
  ready: boolean;
}

export type BridgeMessage = BridgeDrawMessage | BridgeClearMessage;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Segundos unix positivos. Los milisegundos se rechazan: el eje es en segundos. */
function isTime(value: unknown): value is number {
  if (!isFiniteNumber(value) || !Number.isInteger(value)) return false;
  return value >= 0 && value <= 410_244_480_0; // 2100, holgura de sobra
}

function isPrice(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function coercePoint(raw: unknown): BridgePoint | null {
  if (!isPlainRecord(raw)) return null;
  const { time, price } = raw;
  if (!isTime(time) || !isPrice(price)) return null;
  return { time, price };
}

/** Una forma suelta. Devuelve null si no cumple, sin lanzar. */
export function coerceShape(raw: unknown): BridgeShape | null {
  if (!isPlainRecord(raw)) return null;
  const kind = pickEnum(raw.kind, SHAPE_KINDS);
  if (!kind) return null;
  const style = pickEnum(raw.style, SHAPE_STYLES);
  if (!style) return null;
  const id = typeof raw.id === 'string' ? raw.id.slice(0, MAX_SHAPE_ID) : '';
  if (!id) return null;
  const text = typeof raw.text === 'string' ? raw.text.slice(0, MAX_SHAPE_TEXT) : '';
  if (!Array.isArray(raw.points)) return null;
  const points: BridgePoint[] = [];
  for (const entry of raw.points) {
    const point = coercePoint(entry);
    if (!point) return null;
    points.push(point);
  }
  const range = SHAPE_POINT_RANGE[kind];
  if (points.length < range.min || points.length > range.max) return null;
  const shape: BridgeShape = { id, kind, style, text, points };
  if (kind === 'arrow') {
    const direction = pickEnum(raw.direction, ARROW_DIRECTIONS);
    if (!direction) return null;
    shape.direction = direction;
  }
  return shape;
}

/**
 * Filtra una lista de formas y corta en `SWAL_MAX_SHAPES`. Las que no valen se
 * descartan en silencio; si no queda ninguna, el mensaje no se manda.
 */
export function coerceShapes(raw: unknown): BridgeShape[] {
  if (!Array.isArray(raw)) return [];
  const out: BridgeShape[] = [];
  for (const entry of raw) {
    const shape = coerceShape(entry);
    if (!shape) continue;
    out.push(shape);
    if (out.length >= SWAL_MAX_SHAPES) break;
  }
  return out;
}

/**
 * Valida un mensaje recibido por `postMessage`. `expectedNonce` es el que publicó
 * el content script aislado en esta página; si no existe todavía, se rechaza.
 */
export function parseBridgeMessage(
  raw: unknown,
  expectedNonce: string | null | undefined,
): BridgeMessage | BridgeReadyMessage | null {
  if (!isPlainRecord(raw)) return null;
  const type = raw.type;
  if (type !== SWAL_DRAW && type !== SWAL_CLEAR && type !== SWAL_READY) return null;
  if (raw.version !== SWAL_MESSAGE_VERSION) return null;
  if (typeof raw.nonce !== 'string' || raw.nonce.length === 0) return null;
  if (typeof expectedNonce !== 'string' || expectedNonce.length === 0) return null;
  if (raw.nonce !== expectedNonce) return null;
  if (type === SWAL_CLEAR) return { type: SWAL_CLEAR, version: SWAL_MESSAGE_VERSION, nonce: raw.nonce };
  if (type === SWAL_READY) {
    return { type: SWAL_READY, version: SWAL_MESSAGE_VERSION, nonce: raw.nonce, ready: raw.ready === true };
  }
  const shapes = coerceShapes(raw.shapes);
  const key = typeof raw.key === 'string' ? raw.key.slice(0, 64) : '';
  return { type: SWAL_DRAW, version: SWAL_MESSAGE_VERSION, nonce: raw.nonce, key, shapes };
}

/** Construye el mensaje de dibujo. El nonce lo pone el content script aislado. */
export function buildDrawMessage(shapes: readonly BridgeShape[], nonce: string, key = ''): BridgeDrawMessage {
  return {
    type: SWAL_DRAW,
    version: SWAL_MESSAGE_VERSION,
    nonce,
    key,
    shapes: shapes.slice(0, SWAL_MAX_SHAPES),
  };
}

export function buildClearMessage(nonce: string): BridgeClearMessage {
  return { type: SWAL_CLEAR, version: SWAL_MESSAGE_VERSION, nonce };
}

export function buildReadyMessage(nonce: string, ready: boolean): BridgeReadyMessage {
  return { type: SWAL_READY, version: SWAL_MESSAGE_VERSION, nonce, ready };
}
