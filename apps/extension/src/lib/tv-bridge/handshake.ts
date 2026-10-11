/**
 * Saludo one-shot entre el content script aislado y el puente MAIN-world.
 *
 * El nonce que antes viajaba en un atributo de `<html>` lo podía leer cualquier
 * script de la página, así que servía de poco: con él, un script de la página
 * podía fabricar mensajes de dibujo con precios inventados. Este saludo lo
 * sustituye por un canal privado que la página no ve.
 *
 * Cómo funciona (todo en `document_start`, antes de que corra el primer script
 * de la página):
 *
 * 1. El content script aislado manda por `window` un `hello` con un `session`
 *    aleatorio y dice si el interruptor de pintar está encendido.
 * 2. El puente responde creando un `MessageChannel` y entregando UN puerto con
 *    `window.postMessage({type: 'swal-tv:port', session}, origen, [puerto])`.
 *    Ese `postMessage` es un suceso asíncrono, así que los dos content scripts
 *    (mundo aislado y MAIN) han terminado ya su arranque síncrono cuando se
 *    entrega: el aislado está escuchando y recoge el puerto.
 * 3. A partir de ahí, draw/clear/ready viajan SOLO por el puerto. La ventana
 *    queda fuera del juego: un script de la página que arranque más tarde no
 *    puede obtener el puerto porque la entrega ya ocurrió y ningún oyente suyo
 *    estaba puesto cuando cruzó el puerto (los content scripts de
 *    `document_start` corren antes que los scripts de la página).
 *
 * El `session` aleatorio ata la respuesta del puerto a nuestro `hello`, para
 * descartar respuestas que no sean de este saludo.
 */

import { SWAL_MAX_SHAPES, SWAL_MESSAGE_VERSION } from './schema';
import { randomHex } from './random';

/** aislado → puente: petición de canal privado. */
export const SWAL_HELLO = 'swal-tv:hello';
/** puente → aislado: entrega del puerto del canal. */
export const SWAL_PORT = 'swal-tv:port';

/** Token de un saludo. Sale de `crypto`: nadie más lo conoce. */
export function createSession(): string {
  return randomHex(16);
}

export interface HelloPayload {
  type: typeof SWAL_HELLO;
  version: number;
  session: string;
  /** Si el interruptor de pintar está encendido (F8: el puente no arranca si no). */
  enabled: boolean;
}

export interface PortPayload {
  type: typeof SWAL_PORT;
  version: number;
  session: string;
}

export function buildHello(session: string, enabled: boolean): HelloPayload {
  return { type: SWAL_HELLO, version: SWAL_MESSAGE_VERSION, session, enabled };
}

export function buildPort(session: string): PortPayload {
  return { type: SWAL_PORT, version: SWAL_MESSAGE_VERSION, session };
}

/** Valida un `hello`. Devuelve el `session` y `enabled`, o null. */
export function parseHello(raw: unknown): { session: string; enabled: boolean } | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as { type?: unknown; version?: unknown; session?: unknown; enabled?: unknown };
  if (record.type !== SWAL_HELLO) return null;
  if (record.version !== SWAL_MESSAGE_VERSION) return null;
  if (typeof record.session !== 'string' || record.session.length === 0) return null;
  return { session: record.session, enabled: record.enabled === true };
}

/**
 * true si `raw` es el mensaje `port` de NUESTRO `session` y trae un puerto real
 * en `ports` (los puertos transferidos llegan en `event.ports`, no en `data`).
 */
export function isPortFor(raw: unknown, session: string, ports: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const record = raw as { type?: unknown; version?: unknown; session?: unknown };
  if (record.type !== SWAL_PORT) return false;
  if (record.version !== SWAL_MESSAGE_VERSION) return false;
  if (record.session !== session) return false;
  const received = Array.isArray(ports) ? (ports[0] as { postMessage?: unknown } | undefined) : undefined;
  return received instanceof MessagePort || typeof received?.postMessage === 'function';
}

/**
 * Límite blando de mensajes de dibujo por segundo. Corta un bucle que spamee el
 * puerto: por encima del límite, `allow` devuelve false y el mensaje se descarta.
 * Ventana deslizante, con `now` inyectable para poder probarla.
 */
export class DrawRateLimit {
  private hits: number[] = [];
  constructor(private readonly limit = 4, private readonly windowMs = 1000) {}

  allow(now: number): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }
}

/**
 * Rechazo temprano por tamaño: si la carga trae más de `factor` veces el tope de
 * formas, se descarta el mensaje entero antes de validarla forma a forma.
 */
export const SHAPE_BUDGET_FACTOR = 4;

export function withinShapeBudget(count: number, factor = SHAPE_BUDGET_FACTOR): boolean {
  return count <= SWAL_MAX_SHAPES * factor;
}
