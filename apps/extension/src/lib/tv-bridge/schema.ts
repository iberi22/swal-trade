/**
 * Contrato de mensajes entre el content script aislado y el puente MAIN-world.
 *
 * El puente vive en el mundo de la página (MAIN) porque es el único que alcanza
 * el iframe de TradingView que Binance monta en la pestaña "Trading View". El
 * panel no habla con el gráfico: manda un mensaje de runtime al content script
 * aislado y este lo reenvía por un puerto privado de MessageChannel que el
 * puente le entrega en el saludo de `document_start` (ver `tv-bridge/handshake`).
 * Nada de eso cruza la red ni pasa por `window`, así que un script de la página
 * no puede fabricarlo.
 *
 * Reglas duras del validador:
 * - solo pasa `swal:draw`, `swal:clear`, `swal:ready`, `swal:set-read` y
 *   `swal:position-tools`;
 * - la versión tiene que coincidir;
 * - como máximo `SWAL_MAX_SHAPES` formas y `SWAL_MAX_POSITION_TOOLS` herramientas;
 * - cada forma valida sus puntos uno a uno: número finito o se descarta;
 * - cada herramienta de posición exige números finitos y textos con tope; los
 *   campos desconocidos se tiran (se reconstruye el objeto, no se copia).
 *
 * La autenticación no está aquí: la da el puerto privado. Cualquier otra cosa
 * se ignora en silencio: un mensaje rogue no dibuja.
 */

/** Versión del contrato. Subirla invalida los mensajes antiguos. */
export const SWAL_MESSAGE_VERSION = 2;

/** Tope de formas por mensaje. Más estorba al gráfico, no lo mejora. */
export const SWAL_MAX_SHAPES = 60;

export const SWAL_DRAW = 'swal:draw';
export const SWAL_CLEAR = 'swal:clear';
export const SWAL_READY = 'swal:ready';
export const SWAL_SET_RESOLUTION = 'swal:set-resolution';
export const SWAL_RESOLUTION_ACK = 'swal:resolution-ack';
/** Control: leer (solo lectura) las herramientas Long/Short Position del usuario. */
export const SWAL_SET_READ = 'swal:set-read';
/** Del puente al content script: herramientas de posición leídas del gráfico. */
export const SWAL_POSITION_TOOLS = 'swal:position-tools';

/** Tope de herramientas de posición por mensaje. Más no aporta y estorba. */
export const SWAL_MAX_POSITION_TOOLS = 10;
/** Topes de texto de una herramienta. */
export const MAX_POSITION_TOOL_ID = 64;
export const MAX_POSITION_TOOL_NAME = 40;
/** Tope del símbolo: el mismo que usa el resto del puente. */
export const MAX_POSITION_SYMBOL = 20;
/** Techo de `pricescale`: por encima no hay ninguna escala real. */
export const MAX_PRICESCALE = 1e12;
export const ALLOWED_RESOLUTIONS = ['1', '5', '15', '60', '240', '1D'] as const;
export type BridgeResolution = (typeof ALLOWED_RESOLUTIONS)[number];
export const isBridgeResolution = (v: unknown): v is BridgeResolution => typeof v === 'string' && (ALLOWED_RESOLUTIONS as readonly string[]).includes(v);

export const SHAPE_KINDS = ['level', 'trend', 'label', 'arrow', 'zone'] as const;
export type BridgeShapeKind = (typeof SHAPE_KINDS)[number];

/** Motivos válidos que el puente puede reportar como estado. */
export const READY_REASONS = ['absent', 'booting', 'ready', 'mismatch'] as const;

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
  /** Solo en `arrow`: dirección neutra del hallazgo (al alza o a la baja). */
  direction?: BridgeArrowDirection;
}

export interface BridgeDrawMessage {
  type: typeof SWAL_DRAW;
  version: number;
  /** Símbolo y temporalidad del análisis, para no redibujar lo mismo. */
  key: string;
  shapes: BridgeShape[];
}

export interface BridgeClearMessage {
  type: typeof SWAL_CLEAR;
  version: number;
}

export interface BridgeReadyMessage {
  type: typeof SWAL_READY;
  version: number;
  /** true cuando el puente tiene el gráfico con rango visible. */
  ready: boolean;
  /**
   * Por qué está (o no) listo. `mismatch` = hay gráfico, pero muestra otro
   * símbolo u otra temporalidad que el análisis: no se pinta.
   */
  reason: BridgeReadyReason;
  /** Solo cuando `reason === 'mismatch'`: qué muestra el gráfico. */
  chart?: { symbol: string; tf: string };
}

/** Motivo que reporta el puente sobre el estado del gráfico. */
export type BridgeReadyReason = 'absent' | 'booting' | 'ready' | 'mismatch';

export interface BridgeSetResolutionMessage { type: typeof SWAL_SET_RESOLUTION; version: number; resolution: BridgeResolution; }
export interface BridgeResolutionAckMessage { type: typeof SWAL_RESOLUTION_ACK; version: number; ok: boolean; resolution: BridgeResolution; error?: string; }
export type BridgeMessage = BridgeDrawMessage | BridgeClearMessage | BridgeSetResolutionMessage;

/**
 * Una herramienta Long/Short Position tal como la lee el puente.
 * `stopLevel` y `profitLevel` van en TICS (lo que devuelve la API de
 * TradingView), no en precio: el panel los convierte con `minmov/pricescale`
 * (`drawingFromTvTool`). El puente no interpreta el dibujo, solo lo lee.
 */
export interface BridgePositionTool {
  id: string;
  name: string;
  entry: number;
  stopLevel: number;
  profitLevel: number;
}

export interface BridgePositionToolsMessage {
  type: typeof SWAL_POSITION_TOOLS;
  version: number;
  symbol: string;
  minmov: number;
  pricescale: number;
  tools: BridgePositionTool[];
}

export interface BridgeSetReadMessage {
  type: typeof SWAL_SET_READ;
  version: number;
  enabled: boolean;
}

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

/** Tope de texto: corta sin lanzar; lo que no sea cadena queda vacío. */
function cappedString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Entero positivo y finito; null si no lo es. */
function positiveNumber(value: unknown): number | null {
  return isFiniteNumber(value) && value > 0 ? value : null;
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
 * Valida un mensaje recibido por el puerto privado. La confianza la da el
 * transporte (MessageChannel), no el contenido: aquí solo se comprueba forma.
 */
export function parseBridgeMessage(
  raw: unknown,
):
  | BridgeMessage
  | BridgeReadyMessage
  | BridgeResolutionAckMessage
  | BridgeSetReadMessage
  | BridgePositionToolsMessage
  | null {
  if (!isPlainRecord(raw)) return null;
  const type = raw.type;
  if (
    ![
      SWAL_DRAW,
      SWAL_CLEAR,
      SWAL_READY,
      SWAL_SET_RESOLUTION,
      SWAL_RESOLUTION_ACK,
      SWAL_SET_READ,
      SWAL_POSITION_TOOLS,
    ].includes(type as string)
  ) {
    return null;
  }
  if (raw.version !== SWAL_MESSAGE_VERSION) return null;
  if (type === SWAL_CLEAR) return { type: SWAL_CLEAR, version: SWAL_MESSAGE_VERSION };
  if (type === SWAL_SET_READ) {
    if (typeof raw.enabled !== 'boolean') return null;
    return { type: SWAL_SET_READ, version: SWAL_MESSAGE_VERSION, enabled: raw.enabled };
  }
  if (type === SWAL_POSITION_TOOLS) return parsePositionToolsMessage(raw);
  if (type === SWAL_SET_RESOLUTION) {
    const res = pickEnum(raw.resolution, ALLOWED_RESOLUTIONS);
    return res ? { type: SWAL_SET_RESOLUTION, version: SWAL_MESSAGE_VERSION, resolution: res } : null;
  }
  if (type === SWAL_RESOLUTION_ACK) {
    if (typeof raw.ok !== 'boolean') return null;
    const res = pickEnum(raw.resolution, ALLOWED_RESOLUTIONS);
    return res ? { type: SWAL_RESOLUTION_ACK, version: SWAL_MESSAGE_VERSION, ok: raw.ok, resolution: res, ...(typeof raw.error === 'string' ? { error: raw.error.slice(0, 128) } : {}) } : null;
  }
  if (type === SWAL_READY) {
    const reason = READY_REASONS.includes(raw.reason as BridgeReadyReason)
      ? (raw.reason as BridgeReadyReason)
      : 'absent';
    const ready: BridgeReadyMessage = {
      type: SWAL_READY,
      version: SWAL_MESSAGE_VERSION,
      ready: reason === 'ready',
      reason,
    };
    if (reason === 'mismatch' && isPlainRecord(raw.chart)) {
      const symbol = typeof raw.chart.symbol === 'string' ? raw.chart.symbol.slice(0, 32) : '';
      const tf = typeof raw.chart.tf === 'string' ? raw.chart.tf.slice(0, 8) : '';
      ready.chart = { symbol, tf };
    }
    return ready;
  }
  const shapes = coerceShapes(raw.shapes);
  const key = typeof raw.key === 'string' ? raw.key.slice(0, 64) : '';
  return { type: SWAL_DRAW, version: SWAL_MESSAGE_VERSION, key, shapes };
}

/** Construye el mensaje de dibujo para enviarlo por el puerto privado. */
export function buildDrawMessage(shapes: readonly BridgeShape[], key = ''): BridgeDrawMessage {
  return {
    type: SWAL_DRAW,
    version: SWAL_MESSAGE_VERSION,
    key,
    shapes: shapes.slice(0, SWAL_MAX_SHAPES),
  };
}

export function buildClearMessage(): BridgeClearMessage {
  return { type: SWAL_CLEAR, version: SWAL_MESSAGE_VERSION };
}

export function buildReadyMessage(
  reason: BridgeReadyReason,
  chart?: { symbol: string; tf: string },
): BridgeReadyMessage {
  const message: BridgeReadyMessage = {
    type: SWAL_READY,
    version: SWAL_MESSAGE_VERSION,
    ready: reason === 'ready',
    reason,
  };
  if (reason === 'mismatch' && chart) message.chart = chart;
  return message;
}

/**
 * Una herramienta suelta. Devuelve null si no cumple, sin lanzar: números
 * finitos (nada de cadenas numéricas ni NaN), id y nombre con texto, y los
 * cuatro precios/ticks positivos. Los campos de más se descartan.
 */
export function coercePositionTool(raw: unknown): BridgePositionTool | null {
  if (!isPlainRecord(raw)) return null;
  const id = cappedString(raw.id, MAX_POSITION_TOOL_ID);
  const name = cappedString(raw.name, MAX_POSITION_TOOL_NAME);
  if (!id || !name) return null;
  const entry = positiveNumber(raw.entry);
  const stopLevel = positiveNumber(raw.stopLevel);
  const profitLevel = positiveNumber(raw.profitLevel);
  if (entry === null || stopLevel === null || profitLevel === null) return null;
  return { id, name, entry, stopLevel, profitLevel };
}

/**
 * Valida el mensaje de herramientas de posición. Un símbolo válido con la lista
 * vacía SÍ pasa: así el panel sabe que el gráfico no tiene ningún dibujo de
 * posición y no se queda con datos viejos.
 */
export function parsePositionToolsMessage(raw: unknown): BridgePositionToolsMessage | null {
  if (!isPlainRecord(raw)) return null;
  if (raw.type !== SWAL_POSITION_TOOLS || raw.version !== SWAL_MESSAGE_VERSION) return null;
  const symbol = cappedString(raw.symbol, MAX_POSITION_SYMBOL).toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) return null;
  const minmov = positiveNumber(raw.minmov);
  const pricescale = positiveNumber(raw.pricescale);
  if (minmov === null || pricescale === null || pricescale > MAX_PRICESCALE) return null;
  if (!Array.isArray(raw.tools)) return null;
  const tools: BridgePositionTool[] = [];
  for (const entry of raw.tools) {
    const tool = coercePositionTool(entry);
    if (!tool) continue;
    tools.push(tool);
    if (tools.length >= SWAL_MAX_POSITION_TOOLS) break;
  }
  return { type: SWAL_POSITION_TOOLS, version: SWAL_MESSAGE_VERSION, symbol, minmov, pricescale, tools };
}

/** Construye el mensaje de herramientas recortando a los topes del contrato. */
export function buildPositionToolsMessage(
  symbol: string,
  minmov: number,
  pricescale: number,
  tools: readonly BridgePositionTool[],
): BridgePositionToolsMessage {
  return {
    type: SWAL_POSITION_TOOLS,
    version: SWAL_MESSAGE_VERSION,
    symbol: cappedString(symbol, MAX_POSITION_SYMBOL).toUpperCase(),
    minmov,
    pricescale,
    tools: tools.slice(0, SWAL_MAX_POSITION_TOOLS).map((tool) => ({ ...tool })),
  };
}

export const buildSetReadMessage = (enabled: boolean): BridgeSetReadMessage => ({ type: SWAL_SET_READ, version: SWAL_MESSAGE_VERSION, enabled });

export const buildSetResolutionMessage = (resolution: BridgeResolution): BridgeSetResolutionMessage => ({ type: SWAL_SET_RESOLUTION, version: SWAL_MESSAGE_VERSION, resolution });
export const buildResolutionAckMessage = (ok: boolean, resolution: BridgeResolution, error?: string): BridgeResolutionAckMessage => ({ type: SWAL_RESOLUTION_ACK, version: SWAL_MESSAGE_VERSION, ok, resolution, ...(error ? { error: error.slice(0, 128) } : {}) });
