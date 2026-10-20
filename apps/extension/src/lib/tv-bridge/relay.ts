/**
 * Relevo de las herramientas de posición desde la página hasta el panel.
 *
 * El content script valida el mensaje del puente, el background lo guarda por
 * PESTAÑA y símbolo en `storage.session` y el panel lee de ahí la entrada de la
 * pestaña activa. Este módulo es la parte pura: qué se guarda, cómo se fusiona y
 * cómo se lee. Nada de aquí toca el DOM ni la red, y nada de aquí modifica el
 * dibujo del usuario.
 *
 * La clave es `tabId:símbolo` porque dos pestañas pueden mostrar el mismo par
 * con dibujos distintos: guardar solo por símbolo hacía que la pestaña A viera
 * el dibujo de la pestaña B. Cada pestaña enseña un solo gráfico, así que al
 * recibir un mensaje de una pestaña se tiran sus entradas de otros símbolos.
 *
 * `storage.session` es correcto para esto: es el último estado de la pestaña
 * abierta, no una preferencia, y desaparece al cerrar el navegador.
 */

import type { BridgePositionTool, BridgePositionToolsMessage } from './schema';
import { parsePositionToolsMessage } from './schema';

/** Clave de `storage.session` con el último mensaje por pestaña y símbolo. */
export const POSITION_TOOLS_STORAGE_KEY = 'positionTools';
/** Tope de entradas guardadas: una pestaña abierta no cambia tanto. */
export const MAX_POSITION_TOOLS_SYMBOLS = 10;

export type PositionToolsStore = Record<string, BridgePositionToolsMessage>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Clave estable de una entrada: pestaña + símbolo. */
export function positionToolsKey(tabId: number, symbol: string): string {
  return `${tabId}:${symbol.toUpperCase()}`;
}

/** Pestaña de una clave; null si la clave no tiene la forma esperada. */
export function tabIdFromKey(key: string): number | null {
  const match = /^(\d+):/.exec(key);
  if (!match) return null;
  const tabId = Number(match[1]);
  return Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
}

/** Valida un almacén entero: lo que no pase el contrato se tira. */
export function parsePositionToolsStore(raw: unknown): PositionToolsStore {
  const out: PositionToolsStore = {};
  if (!isRecord(raw)) return out;
  for (const key of Object.keys(raw)) {
    const tabId = tabIdFromKey(key);
    if (tabId === null) continue;
    const message = parsePositionToolsMessage(raw[key]);
    if (!message) continue;
    out[positionToolsKey(tabId, message.symbol)] = message;
    if (Object.keys(out).length >= MAX_POSITION_TOOLS_SYMBOLS) break;
  }
  return out;
}

/** Entradas de una pestaña, sin las de otros símbolos (un gráfico por pestaña). */
function withoutTab(store: PositionToolsStore, tabId: number): PositionToolsStore {
  const out: PositionToolsStore = {};
  for (const [key, message] of Object.entries(store)) {
    if (tabIdFromKey(key) === tabId) continue;
    out[key] = message;
  }
  return out;
}

/**
 * Mete el mensaje en el almacén, bajo la pestaña que lo mandó. Devuelve
 * `changed: false` cuando es idéntico al que ya había: así el background no
 * escribe en `storage.session` (y no despierta al panel) por un dibujo que no
 * se ha movido. Sin `tabId` no se guarda: no sabríamos de qué pestaña es.
 */
export function mergePositionToolsStore(
  raw: unknown,
  incoming: unknown,
  tabId: number | null | undefined,
): { store: PositionToolsStore; changed: boolean } {
  const store = parsePositionToolsStore(raw);
  if (tabId === null || tabId === undefined || !Number.isInteger(tabId) || tabId < 0) {
    return { store, changed: false };
  }
  const message = parsePositionToolsMessage(incoming);
  if (!message) return { store, changed: false };
  const key = positionToolsKey(tabId, message.symbol);
  const previous = store[key];
  const sameTab = Object.keys(store).some((other) => tabIdFromKey(other) === tabId && other !== key);
  if (previous && !sameTab && samePositionTools(previous, message)) return { store, changed: false };
  const next = withoutTab(store, tabId);
  next[key] = message;
  return { store: next, changed: true };
}

/** Herramientas del símbolo pedido en la pestaña pedida, o null si no hay nada. */
export function toolsForTab(
  raw: unknown,
  tabId: number | null | undefined,
  symbol: string,
): BridgePositionToolsMessage | null {
  if (typeof symbol !== 'string' || tabId === null || tabId === undefined) return null;
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  const store = parsePositionToolsStore(raw);
  return store[positionToolsKey(tabId, symbol)] ?? null;
}

/** Tira las entradas de una pestaña cerrada o que cambió de página. */
export function dropTab(
  raw: unknown,
  tabId: number | null | undefined,
): { store: PositionToolsStore; changed: boolean } {
  const store = parsePositionToolsStore(raw);
  if (tabId === null || tabId === undefined || !Number.isInteger(tabId)) return { store, changed: false };
  const next = withoutTab(store, tabId);
  return { store: next, changed: Object.keys(next).length !== Object.keys(store).length };
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
