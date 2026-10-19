/**
 * Relevo de las herramientas de posición desde la página hasta el panel.
 *
 * El content script valida el mensaje del puente, el background lo guarda por
 * símbolo en `storage.session` y el panel lee de ahí. Este módulo es la parte
 * pura: qué se guarda, cómo se fusiona y cómo se lee. Nada de aquí toca el DOM
 * ni la red, y nada de aquí modifica el dibujo del usuario.
 *
 * `storage.session` es correcto para esto: es el último estado de la pestaña
 * abierta, no una preferencia, y desaparece al cerrar el navegador.
 */

import type { BridgePositionTool, BridgePositionToolsMessage } from './schema';
import { parsePositionToolsMessage } from './schema';

/** Clave de `storage.session` con el último mensaje por símbolo. */
export const POSITION_TOOLS_STORAGE_KEY = 'positionTools';
/** Tope de símbolos guardados: una pestaña abierta no cambia tanto. */
export const MAX_POSITION_TOOLS_SYMBOLS = 10;

export type PositionToolsStore = Record<string, BridgePositionToolsMessage>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Valida un almacén entero: lo que no pase el contrato se tira. */
export function parsePositionToolsStore(raw: unknown): PositionToolsStore {
  const out: PositionToolsStore = {};
  if (!isRecord(raw)) return out;
  const symbols = Object.keys(raw);
  for (const key of symbols) {
    const message = parsePositionToolsMessage(raw[key]);
    if (!message) continue;
    out[message.symbol] = message;
    if (Object.keys(out).length >= MAX_POSITION_TOOLS_SYMBOLS) break;
  }
  return out;
}

/**
 * Mete el mensaje en el almacén. Devuelve `changed: false` cuando es idéntico al
 * que ya había: así el background no escribe en `storage.session` (y no
 * despierta al panel) por un dibujo que no se ha movido.
 */
export function mergePositionToolsStore(
  raw: unknown,
  incoming: unknown,
): { store: PositionToolsStore; changed: boolean } {
  const store = parsePositionToolsStore(raw);
  const message = parsePositionToolsMessage(incoming);
  if (!message) return { store, changed: false };
  const previous = store[message.symbol];
  if (previous && samePositionTools(previous, message)) return { store, changed: false };
  store[message.symbol] = message;
  return { store, changed: true };
}

/** Herramientas del símbolo pedido, o null si no hay nada guardado. */
export function toolsForSymbol(raw: unknown, symbol: string): BridgePositionToolsMessage | null {
  if (typeof symbol !== 'string') return null;
  const store = parsePositionToolsStore(raw);
  return store[symbol.toUpperCase()] ?? null;
}

/** Igualdad estructural de dos mensajes del contrato (mismo orden de tools). */
export function samePositionTools(
  a: BridgePositionToolsMessage,
  b: BridgePositionToolsMessage,
): boolean {
  if (a.symbol !== b.symbol || a.minmov !== b.minmov || a.pricescale !== b.pricescale) return false;
  if (a.tools.length !== b.tools.length) return false;
  for (let i = 0; i < a.tools.length; i++) {
    const x = a.tools[i] as BridgePositionTool;
    const y = b.tools[i] as BridgePositionTool;
    if (x.id !== y.id || x.name !== y.name) return false;
    if (x.entry !== y.entry || x.stopLevel !== y.stopLevel || x.profitLevel !== y.profitLevel) return false;
  }
  return true;
}
